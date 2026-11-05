# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a runner that lives longer than one job has to clean up itself (#854, R1b).

A hosted turn has a VM of its own that is thrown away; a runner's turns follow each other on one
daemon and one `/work` volume. Two things of a turn have fixed names and must be gone before the
next one starts:

- **The work volume.** `reserve` (the git mirror), `repo` (the agent's tree) and `result` (the
  finish tool's file) are created by the turn and refused when they exist (`setup_failed ... exists
  already`). Only these three are touched, and a link in the way is removed, never followed.
- **The containers and the networks of Control**, found by the label `code-reviewer.role` that
  every one of them carries (the door, the rule helpers, the agent, the reader, the setup, the model
  network). A runner that was killed leaves them; the door's container holds the workspace's own
  key, and their fixed names would make every later turn fail with a 409.

Both run at the start of the service, before a claim whenever the last turn ended or the last tidy
failed, and after every turn. A failure is a list of problems, not an exception: the caller decides.
"""

import contextlib
import json
import logging
import os
import re
import shutil
import stat
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final
from urllib.parse import quote

from code_reviewer_runner.implementer.docker_api import DockerApi, DockerError
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR

_log = logging.getLogger(__name__)

ROLE_LABEL: Final = "code-reviewer.role"
# The folders of the work volume a turn creates (`git_workspace.RESERVE_DIRECTORY`, the agent's
# repository, `result_channel.RESULT_SUBPATH`). Nothing else in `/work` is the runner's to remove.
WORK_SUBDIRECTORIES: Final = ("reserve", "repo", "result")
_IDENTIFIER: Final = re.compile(r"[0-9a-f]{12,64}")


@dataclass(frozen=True)
class TidySeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    work_dir: Path = Path(IMPLEMENTER_WORK_DIR)


# -- the work volume -------------------------------------------------------------------------------


def clear_work(work_dir: Path) -> list[str]:
    """Empty `reserve`, `repo` and `result` in `work_dir`. The problems, by folder name (empty: all
    gone). A folder that is a link or a file is removed itself; a folder is removed with what is in
    it, links inside unlinked and not followed."""
    problems: list[str] = []
    for name in WORK_SUBDIRECTORIES:
        try:
            _remove(work_dir / name)
        except OSError as error:
            problems.append(f"{name} ({error.strerror or type(error).__name__})")
    return problems


def _remove(path: Path) -> None:
    try:
        status = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(status.st_mode):
        path.unlink()
        return
    _make_removable(path)
    failures: list[OSError] = []

    def onexc(_function: Callable[..., object], _target: str, error: BaseException) -> None:
        if isinstance(error, OSError):
            failures.append(error)

    shutil.rmtree(path, onexc=onexc)
    if failures:
        raise failures[0]


def _make_removable(root: Path) -> None:
    """Give the owner every right on the folders below `root` (git writes read-only objects, an
    agent may chmod what it likes), without following a link."""
    pending = [str(root)]
    while pending:
        directory = pending.pop()
        with contextlib.suppress(OSError):
            os.chmod(directory, 0o700)
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        pending.extend(entry.path for entry in entries if entry.is_dir(follow_symlinks=False))


# -- the daemon ------------------------------------------------------------------------------------


def remove_leftovers(api: DockerApi) -> list[str]:
    """Remove every container and every network that carries the role label, the containers first
    (a network with a member stays). Returns the problems (empty: none left)."""
    problems: list[str] = []
    selector = quote(json.dumps({"label": [ROLE_LABEL]}))
    for kind, listing, remove in (
        ("container", f"/containers/json?all=1&filters={selector}", api.remove_container),
        ("network", f"/networks?filters={selector}", api.remove_network),
    ):
        try:
            found = api.request("GET", listing)
        except DockerError as error:
            problems.append(f"the {kind}s cannot be listed ({error.status})")
            continue
        for identifier in _identifiers(found):
            try:
                remove(identifier)
            except DockerError as error:
                problems.append(f"a {kind} cannot be removed ({error.status})")
            else:
                _log.info("removed a leftover %s of an earlier run (%s)", kind, identifier[:12])
    return problems


def _identifiers(answer: object) -> list[str]:
    if not isinstance(answer, list):
        return []
    found: list[str] = []
    for item in answer:  # pyright: ignore[reportUnknownVariableType]
        identifier = item.get("Id") if isinstance(item, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
        if isinstance(identifier, str) and _IDENTIFIER.fullmatch(identifier):
            found.append(identifier)
    return found


def tidy(seams: TidySeams = TidySeams()) -> list[str]:  # noqa: B008
    """The containers and networks first (nothing mounts the work volume then), then the work
    volume. The problems of both, empty when the machine is clean."""
    problems = [f"docker: {problem}" for problem in remove_leftovers(seams.api())]
    problems += [f"work volume: {problem}" for problem in clear_work(seams.work_dir)]
    return problems
