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
  network) and by `code-reviewer.runner`, the id of this runner. A runner that was killed leaves
  them; the door's container holds the workspace's own key, and their fixed names would make every
  later turn fail with a 409. What carries another runner's id is not touched, and a running
  container of another runner is found at the start (`foreign_runner`): the names are fixed, so one
  daemon serves one runner until R2 makes them unique.

Both run at the start of the service, before a claim whenever the last turn ended or the last tidy
failed, and after every turn. The work volume is emptied only when the daemon is clean (a container
that could not be removed may still mount it). A failure is a list of problems, not an exception:
the caller decides.
"""

import contextlib
import errno
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
from code_reviewer_runner.implementer.role_labels import ROLE_LABEL, RUNNER_LABEL
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR

_log = logging.getLogger(__name__)

# The folders of the work volume a turn creates (`git_workspace.RESERVE_DIRECTORY`, the agent's
# repository, `result_channel.RESULT_SUBPATH`). Nothing else in `/work` is the runner's to remove.
WORK_SUBDIRECTORIES: Final = ("reserve", "repo", "result")
_IDENTIFIER: Final = re.compile(r"[0-9a-f]{12,64}")


@dataclass(frozen=True)
class TidySeams:
    """What the tests replace; production leaves the defaults."""

    api: Callable[[], DockerApi] = DockerApi
    work_dir: Path = Path(IMPLEMENTER_WORK_DIR)
    # The id on the labels of this runner's containers (`implementer/role_labels.py`); empty: the
    # role label alone is the selector.
    runner_id: str = ""


# -- the work volume -------------------------------------------------------------------------------


def clear_work(work_dir: Path) -> list[str]:
    """Empty `reserve`, `repo` and `result` in `work_dir`. The problems, by folder name (empty: all
    gone). A folder that is a link or a file is removed itself; a folder is removed with what is in
    it, links inside unlinked and not followed. A folder with a mount point below it (another
    device than `work_dir`) is left alone and reported: removing through a mount would delete what
    the mount shows."""
    problems: list[str] = []
    try:
        device = work_dir.stat().st_dev
    except OSError:
        device = None
    for name in WORK_SUBDIRECTORIES:
        try:
            _remove(work_dir / name, device)
        except OSError as error:
            problems.append(f"{name} ({error.strerror or type(error).__name__})")
    return problems


def _remove(path: Path, device: int | None) -> None:
    try:
        status = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(status.st_mode):
        path.unlink()
        return
    if device is not None and status.st_dev != device:
        raise OSError(errno.EBUSY, "it is a mount point")
    if not _make_removable(path, status.st_dev):
        raise OSError(errno.EBUSY, "a mount point is below it")
    failures: list[OSError] = []

    def onexc(_function: Callable[..., object], _target: str, error: BaseException) -> None:
        if isinstance(error, OSError):
            failures.append(error)

    shutil.rmtree(path, onexc=onexc)
    if failures:
        raise failures[0]


_OPEN_DIRECTORY: Final = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
# Deeper than any tree a turn makes; below it the walk stops and `rmtree` reports what it cannot do.
_MAX_DEPTH: Final = 200


def _make_removable(root: Path, device: int) -> bool:
    """Give the owner every right on the folders below `root` (git writes read-only objects, an
    agent may chmod what it likes). Every folder is opened without following a link and changed by
    its descriptor, so a link put in the way after the look cannot send a change of rights outside
    `root`. False when a folder on another device than `device` (a mount point) is below."""
    try:
        descriptor = os.open(root, _OPEN_DIRECTORY)
    except OSError:
        return True
    return _open_up(descriptor, device, 0)


def _open_up(descriptor: int, device: int, depth: int) -> bool:
    """Takes `descriptor` and closes it."""
    clean = True
    try:
        with contextlib.suppress(OSError):
            os.fchmod(descriptor, 0o700)
        if depth >= _MAX_DEPTH:
            return True
        try:
            entries = list(os.scandir(descriptor))
        except OSError:
            return True
        for entry in entries:
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                child = os.open(entry.name, _OPEN_DIRECTORY, dir_fd=descriptor)
            except OSError:
                continue
            if os.fstat(child).st_dev != device:
                os.close(child)
                clean = False
            elif not _open_up(child, device, depth + 1):
                clean = False
    finally:
        os.close(descriptor)
    return clean


# -- the daemon ------------------------------------------------------------------------------------


def _labels(runner_id: str) -> list[str]:
    return [ROLE_LABEL, f"{RUNNER_LABEL}={runner_id}"] if runner_id else [ROLE_LABEL]


def foreign_runner(api: DockerApi, runner_id: str) -> bool:
    """Does a running container of Control that is not this runner's own exist on the daemon? Its
    role label is there and its runner label is another id, or none. A daemon that cannot be asked
    is not "foreign": the tidy that follows finds that out."""
    selector = quote(json.dumps({"label": [ROLE_LABEL], "status": ["running"]}))
    try:
        found = api.request("GET", f"/containers/json?filters={selector}")
    except DockerError:
        return False
    if not isinstance(found, list):
        return False
    for item in found:  # pyright: ignore[reportUnknownVariableType]
        labels = item.get("Labels") if isinstance(item, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
        if isinstance(labels, dict) and labels.get(RUNNER_LABEL) != runner_id:  # pyright: ignore[reportUnknownMemberType]
            return True
    return False


def remove_leftovers(api: DockerApi, runner_id: str = "") -> list[str]:
    """Remove every container and every network that carries the role label and this runner's id,
    the containers first (a network with a member stays). The problems (empty: none left)."""
    problems: list[str] = []
    selector = quote(json.dumps({"label": _labels(runner_id)}))
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
    volume, unless the daemon could not be cleaned: a container that stays may still have the
    volume mounted. The problems, empty when the machine is clean."""
    problems = [f"docker: {problem}" for problem in remove_leftovers(seams.api(), seams.runner_id)]
    if problems:
        return problems
    return [f"work volume: {problem}" for problem in clear_work(seams.work_dir)]
