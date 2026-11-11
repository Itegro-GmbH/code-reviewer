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
  later turn fail with a 409. What carries another runner's id is not touched, and any container
  (running or not) or network of another runner, or of one without an id, is found at the start
  (`foreign_object`): the names are fixed, so one daemon serves one runner until R2 makes them
  unique. A lock container with a fixed name (`take_lock`) makes two runners that start at the same
  moment, with nothing on the daemon yet, meet as well. A runner with no identity sweeps nothing:
  the role label alone is never a selector.

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
from code_reviewer_runner.job_loop.jsonvalues import as_object

_log = logging.getLogger(__name__)

# The folders of the work volume a turn creates (`git_workspace.RESERVE_DIRECTORY`, the agent's
# repository, `result_channel.RESULT_SUBPATH`). Nothing else in `/work` is the runner's to remove.
WORK_SUBDIRECTORIES: Final = ("reserve", "repo", "result")
_IDENTIFIER: Final = re.compile(r"[0-9a-f]{12,64}")
# The image a setup container's result is committed as (`setup_container.py`); the golden agent
# image has the same repository and another tag.
# The image a setup container's result was committed as before #1009 (the setup now runs in the
# agent's own container and nothing is committed): a machine that was updated may still hold one.
ENVIRONMENT_IMAGE: Final = "code-reviewer-agent:environment"


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
_OPEN_PATH: Final = os.O_PATH | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
# Deeper than any tree a turn makes; below it the walk stops and `rmtree` reports what it cannot do.
_MAX_DEPTH: Final = 200


def _make_removable(root: Path, device: int) -> bool:
    """Give the owner every right on `root` and the folders below it (git writes read-only objects,
    an agent may chmod what it likes, even to mode 000). Every folder is opened without following a
    link and changed by its descriptor, so a link put in the way after the look cannot send a change
    of rights outside `root`. False when a folder on another device than `device` (a mount point)
    is below."""
    try:
        parent = os.open(root.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except OSError:
        return True
    try:
        descriptor = _open_folder(parent, root.name)
    except OSError:
        return True
    finally:
        os.close(parent)
    return _open_up(descriptor, device, 0)


def _open_folder(parent: int, name: str) -> int:
    """Open the folder `name` of `parent`, a link refused. A folder the owner may not enter (mode
    000) gets its rights back first, so that one job cannot stop the runner from ever taking
    another by chmod-ing a folder in its tree."""
    try:
        return os.open(name, _OPEN_DIRECTORY, dir_fd=parent)
    except PermissionError:
        pass
    _grant(parent, name)
    return os.open(name, _OPEN_DIRECTORY, dir_fd=parent)


def _grant(parent: int, name: str) -> None:
    """Mode 0700 for the folder `name` of `parent`, never for what a link in its place points at."""
    try:
        os.chmod(name, 0o700, dir_fd=parent, follow_symlinks=False)
    except NotImplementedError:
        pass
    except OSError as error:
        if error.errno not in (errno.ENOTSUP, errno.ENOSYS):
            raise
    else:
        return
    # Linux has no chmod that refuses a link: hold the folder itself (a link is refused by
    # `O_NOFOLLOW`) and change it through the descriptor's entry in /proc.
    held = os.open(name, _OPEN_PATH, dir_fd=parent)
    try:
        os.chmod(f"/proc/self/fd/{held}", 0o700)
    finally:
        os.close(held)


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
                child = _open_folder(descriptor, entry.name)
            except OSError:
                continue
            handed_on = False
            try:
                if os.fstat(child).st_dev != device:
                    clean = False
                else:
                    handed_on = True
                    if not _open_up(child, device, depth + 1):
                        clean = False
            finally:
                if not handed_on:
                    os.close(child)
    finally:
        os.close(descriptor)
    return clean


# -- the daemon ------------------------------------------------------------------------------------


NO_IDENTITY: Final = "this runner has no identity: nothing is swept by the role label alone"
# The lock: a container of this name is created (never started) from the agent image, and only one
# can exist. It carries the id of the runner that holds it and no role label, so no sweep takes it.
LOCK_CONTAINER: Final = "code-reviewer-runner-lock"
LOCK_LABEL: Final = "code-reviewer.runner-lock"
_MAX_SHOWN: Final = 64


def container_filters(runner_id: str) -> list[str]:
    """The label filters that select this runner's containers and networks."""
    return [ROLE_LABEL, f"{RUNNER_LABEL}={runner_id}"]


def _shown(value: object) -> str:
    """A name or label from the daemon as one safe, short piece of a log line."""
    text = value if isinstance(value, str) else ""
    return "".join(char for char in text if char.isprintable())[:_MAX_SHOWN] or "none"


def foreign_object(api: DockerApi, runner_id: str) -> str | None:
    """The first container (in any state: running, exited, paused, restarting ...) or network of
    Control on the daemon that is not this runner's own, described for the log; None when there is
    none. Not own is another runner's id or none at all, the role label being there. A daemon that
    cannot be asked has none: the tidy that follows finds that out."""
    selector = quote(json.dumps({"label": [ROLE_LABEL]}))
    for kind, listing in (
        ("container", f"/containers/json?all=1&filters={selector}"),
        ("network", f"/networks?filters={selector}"),
    ):
        try:
            found = api.request("GET", listing)
        except DockerError:
            continue
        if not isinstance(found, list):
            continue
        for entry in found:  # pyright: ignore[reportUnknownVariableType]
            item = as_object(entry)  # pyright: ignore[reportUnknownArgumentType]
            labels = as_object(item.get("Labels")) if item else None
            if item is None or labels is None or labels.get(RUNNER_LABEL) == runner_id:
                continue
            names = item.get("Names")
            name = names[0] if isinstance(names, list) and names else item.get("Name")  # pyright: ignore[reportUnknownVariableType]
            shown = _shown(name.lstrip("/") if isinstance(name, str) else None)
            return (
                f"{kind} {shown} (role {_shown(labels.get(ROLE_LABEL))}, "
                f"runner {_shown(labels.get(RUNNER_LABEL))})"
            )
    return None


def _lock_holder(api: DockerApi) -> str | None:
    """The id on the lock container: "" for one without an id, None when there is none or the
    daemon does not say."""
    try:
        held = api.inspect_container(LOCK_CONTAINER)
    except DockerError:
        return None
    config = held.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    holder = labels.get(LOCK_LABEL) if isinstance(labels, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
    return holder if isinstance(holder, str) else ""


def take_lock(api: DockerApi, runner_id: str, image: str) -> str | None:
    """Create the lock container. None when this runner holds it (made now, or left by an earlier
    start of the same runner that ended without removing it); otherwise the holder, described for
    the log. A daemon that refuses for another reason than the name holds no one else: the checks
    that follow find a broken daemon out."""
    document = {"Image": image, "Labels": {LOCK_LABEL: runner_id}, "Cmd": ["true"]}
    try:
        api.create_container(document, LOCK_CONTAINER)
    except DockerError as error:
        if error.status != 409:
            return None
        holder = _lock_holder(api)
        if holder == runner_id:
            return None
        if holder is None:
            return f"container {LOCK_CONTAINER} (holder unknown)"
        return f"container {LOCK_CONTAINER} (held by runner {_shown(holder)})"
    return None


def release_lock(api: DockerApi, runner_id: str) -> None:
    """Remove the lock container if it is this runner's: never another runner's."""
    if _lock_holder(api) != runner_id:
        return
    with contextlib.suppress(DockerError):
        api.remove_container(LOCK_CONTAINER)


def remove_leftovers(api: DockerApi, runner_id: str) -> list[str]:
    """Remove every container and every network that carries the role label and this runner's id,
    the containers first (a network with a member stays). The problems (empty: none left). Without
    an id the role label alone would take another runner's: nothing is removed."""
    if not runner_id:
        return [NO_IDENTITY]
    problems: list[str] = []
    selector = quote(json.dumps({"label": container_filters(runner_id)}))
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


def remove_environment_image(api: DockerApi) -> None:
    """Drop the name of the image an earlier version committed a setup container's result as, so the
    daemon frees its layers: a machine keeps what a job made until somebody removes it."""
    with contextlib.suppress(DockerError):
        api.remove_image(ENVIRONMENT_IMAGE)


def tidy(seams: TidySeams = TidySeams()) -> list[str]:  # noqa: B008
    """The containers and networks first (nothing mounts the work volume then), then the image an
    earlier version committed a setup result as, then the work volume, unless the daemon could not
    be cleaned: a container that stays may still have the volume mounted. The problems, empty when
    the machine is clean."""
    api = seams.api()
    problems = [f"docker: {problem}" for problem in remove_leftovers(api, seams.runner_id)]
    if problems:
        return problems
    # What a hosted VM loses with the VM: layers of an environment image of an earlier version.
    remove_environment_image(api)
    return [f"work volume: {problem}" for problem in clear_work(seams.work_dir)]
