# SPDX-License-Identifier: LicenseRef-Proprietary

"""The refs a setup script made, as the standard input of `git update-ref --stdin -z` (#818).

The listing of the repository's branches and tags is streamed and the delete commands go to git as
they are read, so that the length of one name is not limited by the runner. The number of refs
(`MAX_REFS`) and the bytes of their delete commands (`MAX_REF_BYTES`) are (#827): `git update-ref
--stdin` in the reader holds what it was given, and a script that made millions of refs, or a few
with names of kilobytes each, would end the turn by the reader's memory limit, without a word of
why. Both end it `setup_failed` with a reason, the one family of failure.
`update-ref` removes a ref without asking where it is checked out, which `git branch -D`
does not (a branch a linked worktree of the script has checked out is the script's to lose too).
"""

import queue
import threading
from collections.abc import Callable, Collection, Generator
from dataclasses import dataclass, field
from typing import Final

from .git_process import Outcome

HEADS: Final = b"refs/heads/"
TAGS: Final = b"refs/tags/"
# How many chunks of the listing wait for git to take them; a full queue stops the listing.
QUEUE_CHUNKS: Final = 16
_WAIT_SECONDS: Final = 0.2
# How many branches and tags a setup script may leave: far more than any repository has (a monorepo
# with every release tag has tens of thousands). Not measured on a VM: a bound the reader (256 MiB)
# holds with a wide margin, not a measured edge. The count alone does not bound the memory (a ref
# name may be kilobytes long), `MAX_REF_BYTES` does.
MAX_REFS: Final = 100_000
# How many bytes of delete commands (the names plus a few bytes of syntax each) `update-ref` is fed:
# well above the names of any repository (100,000 names of 100 bytes are 10 MB) and a fraction of
# the reader's memory. Also not measured on a VM.
MAX_REF_BYTES: Final = 32 * 1024 * 1024


class RefListingFailed(Exception):
    """`git for-each-ref` ended with an error, or could not be run."""


class TooManyRefs(RefListingFailed):
    """The script made more branches and tags than `MAX_REFS`; the message is for the person who
    reads the setup failure."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"the script made more than {limit} branches and tags")


class TooManyRefBytes(RefListingFailed):
    """The names of the branches and tags the script made are longer together than
    `MAX_REF_BYTES`; the message is for the person who reads the setup failure."""

    def __init__(self, limit: int) -> None:
        super().__init__(
            f"the names of the branches and tags the script made are more than {limit} bytes"
        )


@dataclass
class RefDeletions:
    """Iterable of the `delete <ref>` commands of `update-ref --stdin -z` for every branch (but
    `keep`) and tag (but `keep_tags`) the listing names. `count` is how many it made once the
    iteration has ended. Iterating starts the listing in a thread of its own and raises
    `RefListingFailed` at the end of the listing when it failed, `TooManyRefs` as soon as more than
    `limit` refs would be deleted and `TooManyRefBytes` as soon as their commands would be more than
    `max_bytes` (nothing past either limit is sent on)."""

    listing: Callable[[Callable[[bytes], None]], Outcome]
    keep: Collection[str]
    keep_tags: Collection[str] = ()
    limit: int = MAX_REFS
    max_bytes: int = MAX_REF_BYTES
    count: int = field(default=0, init=False)

    def __iter__(self) -> Generator[bytes]:
        kept = {HEADS + name.encode() for name in self.keep} | {
            TAGS + name.encode() for name in self.keep_tags
        }
        chunks: queue.Queue[bytes | None] = queue.Queue(QUEUE_CHUNKS)
        stopped = threading.Event()
        failure: list[Outcome] = []
        overflow: list[RefListingFailed] = []
        self.count = 0
        sent = 0

        def put(item: bytes | None) -> bool:
            while not stopped.is_set():
                try:
                    chunks.put(item, timeout=_WAIT_SECONDS)
                except queue.Full:
                    continue
                return True
            return False

        def read() -> None:
            carry = bytearray()

            def take(chunk: bytes) -> None:
                nonlocal sent
                carry.extend(chunk)
                made = bytearray()
                while (end := carry.find(b"\0")) >= 0:
                    ref = bytes(carry[:end]).strip(b"\n")
                    del carry[: end + 1]
                    if ref in kept or not ref.startswith((HEADS, TAGS)):
                        continue
                    self.count += 1
                    if self.count > self.limit:
                        raise TooManyRefs(self.limit)
                    # `-z`: the command, a space, the ref, NUL, an empty old value, NUL. `no-deref`:
                    # a symbolic ref the script made goes itself, not the branch it points at.
                    made += b"option no-deref\0delete " + ref + b"\0\0"
                    if sent + len(made) > self.max_bytes:
                        raise TooManyRefBytes(self.max_bytes)
                if made and not put(bytes(made)):
                    raise RefListingFailed("the deletions are no longer read")
                sent += len(made)

            try:
                done = self.listing(take)
                if done.returncode != 0:
                    failure.append(done)
            except (TooManyRefs, TooManyRefBytes) as error:
                overflow.append(error)
            except RefListingFailed:
                return
            except Exception:  # the listing of a stream that broke: the same as a failed one
                failure.append(Outcome(255, "", "the listing broke"))
            put(None)

        reader = threading.Thread(target=read, name="ref-listing", daemon=True)
        reader.start()
        try:
            while (item := chunks.get()) is not None:
                yield item
            if overflow:
                raise overflow[0]
            if failure:
                raise RefListingFailed(
                    f"git for-each-ref ended with status {failure[0].returncode}"
                )
        finally:
            stopped.set()
            reader.join(timeout=5.0)
