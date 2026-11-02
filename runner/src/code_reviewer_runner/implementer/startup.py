# SPDX-License-Identifier: LicenseRef-Proprietary

"""The start-up self-check of the Implementer engine and the work directory it needs (#765).

`implementer` is advertised only after the Dynamic self-check passed (root supervisor, engine user,
slot ports, network rules, pinned OpenCode and `rg`, the probe as the engine user:
`dynamic_review/self_check.py`) and this one holds as well:

* git is installed and `setpriv` is (the final push reads the agent's repository through
  `setpriv ... git upload-pack`);
* a container whose network is `registries` has the egress port in its rules;
* a container that starts the model door (`RUNNER_IMPLEMENTER_MODEL_DOOR`, #745) reaches the VM's
  Docker: its socket answers a ping;
* the work directory is the volume of the container profile: present, prepared for the engine user
  (its home and its temporary directory in it, the CHOWN the profile expects of the Worker) and
  exec-capable (the agent runs the repository's own scripts there, and a `noexec` mount would fail
  every one of them).

Each failure is a `SelfCheckReason` of its own that the startup logs and the probe verdict names.
None carries a value.
"""

import contextlib
import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from code_reviewer_runner.dynamic_review.self_check import SelfCheckFailed, SelfCheckReason
from code_reviewer_runner.dynamic_review.static_isolation import ImplementerNetwork, SlotPorts

from .docker_api import DockerApi
from .git_process import TRUSTED_PATH

# The engine user's home and temporary directory live in the work volume: the agent installs a
# repository's dependencies and runs their scripts, and the root file system is read-only while the
# other tmpfs are `noexec`.
HOME_NAME = "home"
TMP_NAME = "tmp"
_EXEC_PROBE_NAME = ".exec-probe.sh"
_EXEC_PROBE_SECONDS = 20.0


def _failed(reason: SelfCheckReason, detail: str) -> SelfCheckFailed:
    return SelfCheckFailed(reason, detail)


def prepare_work_dir(work_dir: Path, uid: int, gid: int) -> None:
    """Make the engine user's home and temporary directory in the work volume (idempotent). The
    volume itself stays root's: the repository and the mirror are made by the git workspace. A
    directory that is a link, or owned by somebody else, is refused (`OSError`)."""
    for name in (HOME_NAME, TMP_NAME):
        directory = work_dir / name
        with contextlib.suppress(FileExistsError):
            directory.mkdir(mode=0o700)
        descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fchown(descriptor, uid, gid)
            os.fchmod(descriptor, 0o700)
        finally:
            os.close(descriptor)


def runs_scripts_as(work_dir: Path, uid: int, gid: int) -> bool:
    """Whether the engine user can execute a script that lies in the work directory. A `noexec`
    mount refuses it for everybody; the permission of the directories can refuse the user."""
    script = work_dir / TMP_NAME / _EXEC_PROBE_NAME
    try:
        script.write_text("#!/bin/sh\nexit 0\n", encoding="ascii")
        os.chown(script, uid, gid)
        os.chmod(script, 0o700)
        # The runner is root and becomes the engine user; a process that already is that user
        # (a test) changes nothing.
        switch: dict[str, Any] = (
            {"user": uid, "group": gid, "extra_groups": ()} if uid != os.geteuid() else {}
        )
        done = cast(
            "subprocess.CompletedProcess[bytes]",
            subprocess.run(
                [str(script)],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=_EXEC_PROBE_SECONDS,
                check=False,
                cwd=work_dir / HOME_NAME,
                env={"PATH": TRUSTED_PATH},
                **switch,
            ),
        )
    except (OSError, subprocess.SubprocessError):
        return False
    finally:
        with contextlib.suppress(OSError):
            script.unlink()
    return done.returncode == 0


@dataclass(frozen=True)
class ImplementerSeams:
    """What the tests of the check replace; production leaves the defaults."""

    which: Callable[[str, str], str | None] = lambda name, path: shutil.which(name, path=path)
    prepare_work_dir: Callable[[Path, int, int], None] = prepare_work_dir
    runs_scripts_as: Callable[[Path, int, int], bool] = runs_scripts_as
    is_directory: Callable[[Path], bool] = lambda path: path.is_dir() and not path.is_symlink()
    docker_answers: Callable[[], bool] = lambda: DockerApi().ping()


def check_implementer_runner(
    *,
    work_dir: Path,
    user: tuple[int, int] | None,
    ports: SlotPorts | None,
    network: ImplementerNetwork,
    seams: ImplementerSeams = ImplementerSeams(),  # noqa: B008 - frozen, shared on purpose
) -> None:
    """Raise `SelfCheckFailed` unless every property of the Implementer holds. The Dynamic
    self-check (the engine user, the rules, the pins) has passed before this runs. Cheap checks
    first, the work directory last (it changes the volume)."""
    if seams.which("git", TRUSTED_PATH) is None:
        raise _failed(SelfCheckReason.IMPLEMENTER_GIT_MISSING, "git is not installed")
    if seams.which("setpriv", TRUSTED_PATH) is None:
        raise _failed(SelfCheckReason.IMPLEMENTER_SETPRIV_MISSING, "setpriv is not installed")
    if network is ImplementerNetwork.REGISTRIES and (ports is None or ports.egress is None):
        raise _failed(
            SelfCheckReason.IMPLEMENTER_EGRESS_RULES_MISSING,
            "the egress proxy port is not in the network rules",
        )
    if ports is not None and ports.door is not None and not seams.docker_answers():
        raise _failed(
            SelfCheckReason.IMPLEMENTER_DOCKER_UNAVAILABLE,
            "the container may start the model door and the VM's Docker does not answer",
        )
    if user is None:
        raise _failed(SelfCheckReason.NOT_A_DYNAMIC_RUNNER, "no engine user is configured")
    if not seams.is_directory(work_dir):
        raise _failed(
            SelfCheckReason.IMPLEMENTER_WORK_DIR_MISSING, "the work directory is not there"
        )
    uid, gid = user
    try:
        seams.prepare_work_dir(work_dir, uid, gid)
    except OSError:
        raise _failed(
            SelfCheckReason.IMPLEMENTER_WORK_DIR_NOT_PREPARED,
            "the engine user's directories in the work directory cannot be made",
        ) from None
    if not seams.runs_scripts_as(work_dir, uid, gid):
        raise _failed(
            SelfCheckReason.IMPLEMENTER_WORK_DIR_NOT_EXEC,
            "the engine user cannot run a script in the work directory",
        )
