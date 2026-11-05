# SPDX-License-Identifier: LicenseRef-Proprietary

"""The refs a setup script made, as the standard input of `git update-ref --stdin -z` (#818).

The listing of the repository's branches and tags is streamed and the delete commands go to git as
they are read, so that the length of their names is not limited by the runner. The number of refs
is (`MAX_REFS`, #827): `git update-ref --stdin` in the reader holds what it was given, and a script
that made millions of refs would end the turn by the reader's memory limit, without a word of why.
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
# with every release tag has tens of thousands), and few enough for the reader (256 MiB) to delete
# in one `update-ref`. Not measured on a VM: a bound the reader holds with a wide margin, not a
# measured edge.
MAX_REFS: Final = 100_000


class RefListingFailed(Exception):
    """`git for-each-ref` ended with an error, or could not be run."""


class TooManyRefs(RefListingFailed):
    """The script made more branches and tags than `MAX_REFS`; the message is for the person who
    reads the setup failure."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"the script made more than {limit} branches and tags")


@dataclass
class RefDeletions:
    """Iterable of the `delete <ref>` commands of `update-ref --stdin -z` for every branch (but
    `keep`) and tag the listing names. `count` is how many it made once the iteration has ended.
    Iterating starts the listing in a thread of its own and raises `RefListingFailed` at the end
    of the listing when it failed, and `TooManyRefs` as soon as more than `limit` refs would be
    deleted (nothing past the limit is sent on)."""

    listing: Callable[[Callable[[bytes], None]], Outcome]
    keep: Collection[str]
    limit: int = MAX_REFS
    count: int = field(default=0, init=False)

    def __iter__(self) -> Generator[bytes]:
        kept = {HEADS + name.encode() for name in self.keep}
        chunks: queue.Queue[bytes | None] = queue.Queue(QUEUE_CHUNKS)
        stopped = threading.Event()
        failure: list[Outcome] = []
        overflow: list[bool] = []
        self.count = 0

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
                if made and not put(bytes(made)):
                    raise RefListingFailed("the deletions are no longer read")

            try:
                done = self.listing(take)
                if done.returncode != 0:
                    failure.append(done)
            except TooManyRefs:
                overflow.append(True)
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
                raise TooManyRefs(self.limit)
            if failure:
                raise RefListingFailed(
                    f"git for-each-ref ended with status {failure[0].returncode}"
                )
        finally:
            stopped.set()
            reader.join(timeout=5.0)
