"""The start-up self-check of the Implementer engine (#765, #745 step 4).

`implementer` is advertised only after the Dynamic self-check passed (root supervisor, the
container's rules, the probe: `dynamic_review/self_check.py`) and this one holds as well:

* git is installed (Control makes the mirror and pushes with it);
* the container has the VM's Docker (`RUNNER_IMPLEMENTER_MODEL_DOOR=docker` puts its socket in the
  profile): the socket answers a ping, the daemon has the `sysbox-runc` runtime registered, and the
  agent image of the golden snapshot is in the VM. Control starts the model door, the agent's
  container and the reader through it;
* the engine user, probed as that user at every start, cannot open that socket (Control is root on
  the VM through it). Nothing runs as that user for the Implementer any more; the check stays
  because the user still exists in the container;
* the work directory is the volume of the container profile (the mirror and the repository live in
  it).

That the Sysbox of the snapshot is **proven** is not asked here: this check decides what the
container can do, and the deploy canary relies on it; an unproven snapshot must not take
`implementer` away from a deployment (reviews would wait behind it, #797). It is the job's gate
(`job_run.check_sandbox`): the turn ends `sandbox_unproven`, free.

Each failure is a `SelfCheckReason` of its own that the startup logs and the probe verdict names.
None carries a value.
"""

import os
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from code_reviewer_runner.dynamic_review.self_check import SelfCheckFailed, SelfCheckReason
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts

from .agent_container import AGENT_IMAGE_REFERENCE, AGENT_RUNTIME
from .docker_api import DOCKER_SOCKET, DockerApi, DockerError
from .git_process import TRUSTED_PATH


def _failed(reason: SelfCheckReason, detail: str) -> SelfCheckFailed:
    return SelfCheckFailed(reason, detail)


def _agent_runtime_present() -> bool:
    return AGENT_RUNTIME in DockerApi().runtimes()


def _agent_image_present() -> bool:
    try:
        DockerApi().inspect_image(AGENT_IMAGE_REFERENCE)
    except DockerError:
        return False
    return True


# Runs as the engine user: one `connect()` to the Docker socket. Fixed text, no input but the path
# and the seconds. Only two answers are a refusal: the kernel said "permission denied" or the path
# is not there. Anything else (a timeout, too many open files, a socket nobody listens on) proves
# nothing about the user's rights and is printed as `unknown:`, read by the caller as "can open".
_DOCKER_PROBE = r"""
import socket, sys
try:
    with socket.socket(socket.AF_UNIX) as probe:
        probe.settimeout(float(sys.argv[2]))
        probe.connect(sys.argv[1])
    print("connected")
except (PermissionError, FileNotFoundError) as error:
    print("refused:" + type(error).__name__)
except BaseException as error:
    print("unknown:" + type(error).__name__)
"""
_DOCKER_PROBE_REFUSALS = ("refused:PermissionError", "refused:FileNotFoundError")
_DOCKER_PROBE_CONNECT_SECONDS = 5.0
_DOCKER_PROBE_SECONDS = 20.0


def engine_user_can_open(
    uid: int,
    gid: int,
    socket_path: Path = Path(DOCKER_SOCKET),
    *,
    probe_seconds: float = _DOCKER_PROBE_CONNECT_SECONDS,
) -> bool:
    """Whether the engine user can `connect()` to the Docker socket. Asked by running a probe as
    that user, as root can open anything and would say nothing. Only a probe that ran and was
    refused for its permission (or found no socket at the path) says no: one that could not run
    (no interpreter, the user cannot be switched to), timed out or failed in any other way says
    yes, so the check fails closed."""
    python = shutil.which("python3", path=TRUSTED_PATH)
    if python is None:
        return True
    # The runner is root and becomes the engine user; a process that already is that user
    # (a test) changes nothing.
    switch: dict[str, Any] = (
        {"user": uid, "group": gid, "extra_groups": ()} if uid != os.geteuid() else {}
    )
    try:
        done: subprocess.CompletedProcess[str] = subprocess.run(
            [python, "-I", "-c", _DOCKER_PROBE, str(socket_path), str(probe_seconds)],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=_DOCKER_PROBE_SECONDS,
            check=False,
            env={"PATH": TRUSTED_PATH},
            **switch,
        )
    except (OSError, subprocess.SubprocessError):
        return True
    return done.returncode != 0 or done.stdout.strip() not in _DOCKER_PROBE_REFUSALS


@dataclass(frozen=True)
class ImplementerSeams:
    """What the tests of the check replace; production leaves the defaults."""

    which: Callable[[str, str], str | None] = lambda name, path: shutil.which(name, path=path)
    is_directory: Callable[[Path], bool] = lambda path: path.is_dir() and not path.is_symlink()
    docker_answers: Callable[[], bool] = lambda: DockerApi().ping()
    sysbox_registered: Callable[[], bool] = _agent_runtime_present
    agent_image_present: Callable[[], bool] = _agent_image_present
    engine_reaches_docker: Callable[[int, int], bool] = engine_user_can_open


def check_implementer_runner(
    *,
    work_dir: Path,
    user: tuple[int, int] | None,
    ports: SlotPorts | None,
    seams: ImplementerSeams = ImplementerSeams(),  # noqa: B008 - frozen, shared on purpose
) -> None:
    """Raise `SelfCheckFailed` unless every property of the Implementer holds. The Dynamic
    self-check (the rules, the pins) has passed before this runs. Cheap checks first."""
    if seams.which("git", TRUSTED_PATH) is None:
        raise _failed(SelfCheckReason.IMPLEMENTER_GIT_MISSING, "git is not installed")
    if ports is None or ports.door is None or not seams.docker_answers():
        raise _failed(
            SelfCheckReason.IMPLEMENTER_DOCKER_UNAVAILABLE,
            "the container has no Docker of the VM that answers",
        )
    if not seams.sysbox_registered():
        raise _failed(
            SelfCheckReason.IMPLEMENTER_SYSBOX_MISSING,
            "the VM's Docker has no sysbox-runc runtime",
        )
    if not seams.agent_image_present():
        raise _failed(
            SelfCheckReason.IMPLEMENTER_AGENT_IMAGE_MISSING,
            "the agent image of the golden snapshot is not in the VM",
        )
    if user is None:
        raise _failed(SelfCheckReason.NOT_A_DYNAMIC_RUNNER, "no engine user is configured")
    if not seams.is_directory(work_dir):
        raise _failed(
            SelfCheckReason.IMPLEMENTER_WORK_DIR_MISSING, "the work directory is not there"
        )
    uid, gid = user
    if seams.engine_reaches_docker(uid, gid):
        raise _failed(
            SelfCheckReason.IMPLEMENTER_DOCKER_SOCKET_OPEN,
            "the engine user can open the VM's Docker socket",
        )
