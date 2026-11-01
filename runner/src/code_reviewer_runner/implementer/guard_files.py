# SPDX-License-Identifier: LicenseRef-Proprietary

"""The files that switch the branch guard on for one turn (#762) and the spool the guard writes to.

The hook (`runner/guard/reference-transaction`, installed read-only and root-owned in the image by
#761) reads its configuration from a file: `BRANCH`, `START`, `SPOOL` and `REPO`, sourced by bash.
It is written here, quoted, so that a branch name can never be more than a value. `REPO` is the
agent's repository: `core.hooksPath` comes through the system config, so the hook runs for every
repository of the job (a fixture's `git init`, a clone, a git dependency), and without `REPO` it
would guard all of them. A second file, named by `GIT_CONFIG_SYSTEM`, is the system git config of
the agent's git: the hook directory as `core.hooksPath` and the repository as `safe.directory`.
Both live under /run (the root file system is read-only) and only root can change them.

The spool is a hint, never evidence: the agent's user appends `<time> <sha>` for every tip update,
and may write anything else. The runner verifies every push anyway, so a forged line costs one
verification.
"""

import os
import re
import shlex
from collections.abc import Iterable
from pathlib import Path

SPOOL_MODE = 0o622  # root's file that every user can append to (and truncate; it is only a hint)
CONFIG_MODE = 0o644
# What the runner reads of the spool in one look, and how large it may grow before it is cut.
READ_BYTES = 64 * 1024
MAX_SPOOL_BYTES = 1024 * 1024

_ENTRY = re.compile(r"(\d+(?:\.\d+)?) ([0-9a-f]{40})")


def guard_conf_text(*, branch: str, start: str, spool: str, repo: str) -> str:
    """The configuration of the hook. Sourced by bash, so every value is single-quoted."""
    return (
        f"BRANCH={shlex.quote(branch)}\nSTART={shlex.quote(start)}\n"
        f"SPOOL={shlex.quote(spool)}\nREPO={shlex.quote(repo)}\n"
    )


def _git_quoted(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def system_gitconfig_text(hooks_path: Path, safe_directories: Iterable[Path]) -> str:
    lines = ["[core]", f"\thooksPath = {_git_quoted(str(hooks_path))}", "[safe]"]
    lines.extend(f"\tdirectory = {_git_quoted(str(directory))}" for directory in safe_directories)
    return "\n".join(lines) + "\n"


def parse_spool(text: str) -> list[tuple[float, str]]:
    """The lines that look like a tip update, `<time> <40 hex>`. Anything else is ignored."""
    entries: list[tuple[float, str]] = []
    for line in text.splitlines():
        found = _ENTRY.fullmatch(line.strip())
        if found is not None:
            entries.append((float(found.group(1)), found.group(2)))
    return entries


def write_file(path: Path, text: str, mode: int) -> None:
    """A new regular file of root's. An old one is replaced, never followed."""
    if path.is_symlink() or path.exists():
        path.unlink()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.write(text)
        os.fchmod(stream.fileno(), mode)


class SpoolWatcher:
    """Reads the spool from where it stopped and says whether a tip update was signalled."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._offset = 0

    def signalled(self) -> bool:
        try:
            descriptor = os.open(self._path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            return False
        try:
            size = os.fstat(descriptor).st_size
            if size > MAX_SPOOL_BYTES:
                # More than any agent's commits can write: cut it, and let one verification look.
                os.truncate(self._path, 0)
                self._offset = 0
                return True
            if size < self._offset:
                self._offset = 0  # the agent's user truncated it
            chunk = os.pread(descriptor, READ_BYTES, self._offset)
        finally:
            os.close(descriptor)
        end = chunk.rfind(b"\n") + 1
        self._offset += end if end else len(chunk)
        return bool(parse_spool(chunk[: end or len(chunk)].decode("utf-8", errors="replace")))
