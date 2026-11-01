# SPDX-License-Identifier: LicenseRef-Proprietary

"""Reading only the header block of every commit in `git log -z --format=raw` (#764).

The push check (`GitWorkspace._check_committers`) needs the stored header lines of each commit
(`author`, `committer`) and nothing of its message. The message is the agent's and can be as large
as the object database allows; read whole, a 100 MB message cost about 234 MB of runner memory on
every push. This parser takes the output in chunks, keeps the header block of the entry it is in
and drops the rest of the entry as it goes by, so its memory is bounded by `MAX_HEADER_BYTES`
whatever the messages hold. A header block larger than that is refused (`HeaderTooLarge`): a real
one is a few hundred bytes, a signature a few kilobytes.
"""

from collections.abc import Callable

# The longest header block the check reads. A commit header of a real turn is far below this.
MAX_HEADER_BYTES = 256 * 1024
_ENTRY_END = b"\0"
_HEADER_END = b"\n\n"


class HeaderTooLarge(Exception):
    """A commit's header block passed `MAX_HEADER_BYTES`. Names no value."""


class CommitHeaderReader:
    """Feeds the chunks of `log -z --format=raw` and hands each commit's header lines to
    `on_commit`, in order. `finish()` must be called once after the last chunk."""

    def __init__(self, on_commit: Callable[[list[str]], None]) -> None:
        self._on_commit = on_commit
        self._header = bytearray()
        # True from the end of a header block to the NUL that ends the entry: the message.
        self._in_message = False

    def feed(self, chunk: bytes) -> None:
        position = 0
        while position < len(chunk):
            end = chunk.find(_ENTRY_END, position)
            piece = chunk[position:] if end < 0 else chunk[position:end]
            if not self._in_message:
                self._take(piece)
            if end < 0:
                return
            # The NUL ends the entry; one that ended before a blank line has no message at all.
            if not self._in_message:
                self._emit()
            self._in_message = False
            position = end + 1

    def finish(self) -> None:
        """The output ended: an entry that has a header but no terminating NUL is complete."""
        if not self._in_message:
            self._emit()

    def _take(self, piece: bytes) -> None:
        before = len(self._header)
        if not self._header:
            piece = piece.lstrip(b"\n")  # the separator of the last entry's message, if any
        self._header += piece
        marker = self._header.find(_HEADER_END, max(before - 1, 0))
        if marker < 0:
            if len(self._header) > MAX_HEADER_BYTES:
                raise HeaderTooLarge
            return
        if marker > MAX_HEADER_BYTES:
            raise HeaderTooLarge
        del self._header[marker:]
        self._emit()
        self._in_message = True

    def _emit(self) -> None:
        block = bytes(self._header).strip(b"\n")
        self._header.clear()
        if block:
            self._on_commit(block.decode("utf-8", errors="replace").split("\n"))
