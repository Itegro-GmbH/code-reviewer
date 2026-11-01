# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Implementer's result says about the branch: its commits and the files that differ from
the start commit (#764, `ImplementerResult` of the contract).

Git prints these lists from the agent's repository, so everything in them is the agent's: a subject
of any length and any bytes, as many files as it likes. Nothing here trusts the size or the shape:
subjects lose control characters and are cut at the contract's bound, lines are capped as they are
read, the lists have the contract's maximum, and a record that does not parse is skipped.
"""

import re
from dataclasses import dataclass
from enum import StrEnum

# The bounds of `ImplementerResult` in contracts/runner-api.v1.json.
MAX_COMMITS = 200
MAX_FILES = 500
MAX_SUBJECT_CHARS = 500
MAX_PATH_CHARS = 4096
# How many commits git is asked for (the newest), and how much of a line or of the whole output the
# runner keeps while it reads the stream.
READ_COMMITS = 1000
MAX_LINE_BYTES = 2048
MAX_FILE_LIST_BYTES = 4 * 1024 * 1024

_COMMIT_LINE = re.compile(r"([0-9a-f]{40}) (.*)", re.DOTALL)
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class ChangeKind(StrEnum):
    """`ImplementerFileStatus` of the contract."""

    ADDED = "added"
    MODIFIED = "modified"
    DELETED = "deleted"
    RENAMED = "renamed"
    COPIED = "copied"
    TYPECHANGE = "typechange"


@dataclass(frozen=True)
class CommitInfo:
    sha: str
    subject: str


@dataclass(frozen=True)
class FileChange:
    path: str
    kind: ChangeKind


class StopReading(Exception):
    """The reader has what it keeps; the rest of git's output is not wanted."""


class CappedLines:
    """Collects the output of `git log --format=%H %s` keeping at most `MAX_LINE_BYTES` of a line
    and `MAX_FILE_LIST_BYTES` in all; the rest of a long line is dropped as it passes."""

    def __init__(self) -> None:
        self.data = bytearray()
        self._line = 0
        self._dropping = False

    def feed(self, chunk: bytes) -> None:
        for piece in chunk.splitlines(keepends=True):
            ends = piece.endswith(b"\n")
            if not self._dropping:
                room = MAX_LINE_BYTES - self._line
                self.data += piece[:room].rstrip(b"\n")
                self._line += min(len(piece.rstrip(b"\n")), room)
                self._dropping = len(piece.rstrip(b"\n")) > room
            if ends:
                self.data += b"\n"
                self._line = 0
                self._dropping = False
            if len(self.data) > MAX_FILE_LIST_BYTES:
                raise StopReading


class CappedBytes:
    """Collects at most `MAX_FILE_LIST_BYTES` of the output and then ends the reading."""

    def __init__(self) -> None:
        self.data = bytearray()

    def feed(self, chunk: bytes) -> None:
        self.data += chunk
        if len(self.data) > MAX_FILE_LIST_BYTES:
            raise StopReading


def _subject(text: str) -> str:
    return _CONTROL.sub(" ", text).strip()[:MAX_SUBJECT_CHARS]


def parse_commits(raw: bytes) -> list[CommitInfo]:
    """The commits of `git log --format=%H %s` (the newest first) as the contract has them: oldest
    first, at most `MAX_COMMITS`; when there are more, the oldest `MAX_COMMITS - 1` of those read
    and the head commit, which is always the last."""
    commits: list[CommitInfo] = []
    for line in raw.decode("utf-8", errors="replace").split("\n"):
        found = _COMMIT_LINE.fullmatch(line)
        if found is not None:
            commits.append(CommitInfo(found[1], _subject(found[2])))
    commits.reverse()
    if len(commits) > MAX_COMMITS:
        commits = [*commits[: MAX_COMMITS - 1], commits[-1]]
    return commits


_KINDS = {
    "A": ChangeKind.ADDED,
    "M": ChangeKind.MODIFIED,
    "D": ChangeKind.DELETED,
    "T": ChangeKind.TYPECHANGE,
    "R": ChangeKind.RENAMED,
    "C": ChangeKind.COPIED,
}


def parse_name_status(raw: bytes) -> list[FileChange]:
    """The files of `git diff --name-status -z`: a renamed or copied file under its new path, a
    status the contract has no word for skipped, at most `MAX_FILES`."""
    tokens = raw.decode("utf-8", errors="replace").split("\0")
    files: list[FileChange] = []
    position = 0
    while position < len(tokens) and len(files) < MAX_FILES:
        status = tokens[position]
        position += 1
        if not status:
            continue
        paths = 2 if status[0] in "RC" else 1
        if position + paths > len(tokens):
            break  # a record cut off at the end
        path = tokens[position + paths - 1]
        position += paths
        kind = _KINDS.get(status[0])
        if kind is not None and 0 < len(path) <= MAX_PATH_CHARS:
            files.append(FileChange(path, kind))
    return files
