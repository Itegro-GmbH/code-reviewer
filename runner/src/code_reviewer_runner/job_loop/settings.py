# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Worker reads from its environment (`worker-once`, `probe` and `worker-reap`).

| Variable                     | Meaning                                         | Default |
|------------------------------|-------------------------------------------------|---------|
| `RUNNER_JOB_TIMEOUT_SECONDS` | Hard timeout of one job                         | 1200 |
| `RUNNER_DIFF_JOB_USER`       | `uid:gid` of the Diff job process (root Worker) | none |
| `RUNNER_DYNAMIC_*`           | Engine user and ports of the Dynamic slot       | supervisor.py |
| `RUNNER_IMPLEMENTER_*`       | Work dir, network, egress port (Implementer)    | none |
| `PR_AGENT_COMMAND`           | Command that runs one job (test stacks only)    | run-job |

The app address and the per-job credential are not settings: they come on stdin (`worker.py`). A
refusal names the variable and never the value.
"""

import shlex
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from code_reviewer_runner.capabilities import ENGINE_DIFF
from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_DOOR_MODE,
    MODEL_DOOR_VARIABLE,
)
from code_reviewer_runner.dynamic_review.netguard import EgressMode, IsolationError
from code_reviewer_runner.dynamic_review.static_isolation import SlotPorts, slot_ports
from code_reviewer_runner.dynamic_review.supervisor import (
    DEFAULT_ENGINE_ID,
    ENGINE_GID_VARIABLE,
    ENGINE_UID_VARIABLE,
)
from code_reviewer_runner.job import IMPLEMENTER_WORK_DIR_VARIABLE

DEFAULT_JOB_TIMEOUT_SECONDS = 20 * 60.0
MAX_JOB_TIMEOUT_SECONDS = 6 * 60 * 60.0


class SettingsError(Exception):
    """A variable is missing or unusable. The message names the variable, never its value."""


def default_job_command() -> tuple[str, ...]:
    """One PR-Agent process per job: the entry point of CR-10 (`code-reviewer-run-job`)."""
    return (sys.executable, "-m", "code_reviewer_runner.runner")


@dataclass(frozen=True)
class WorkerSettings:
    """What a Worker (`code-reviewer-worker --once`, #323) reads from its environment.

    The job-process settings: no token, no app URL (the start document has the URL and the per-job
    credential), no slots, no polling.
    """

    job_timeout: float = DEFAULT_JOB_TIMEOUT_SECONDS
    kill_margin: float = 10.0
    terminate_grace: float = 5.0
    backoff_max: float = 60.0
    request_timeout: float = 30.0
    complete_retry_window: float = 600.0
    engines: tuple[str, ...] = (ENGINE_DIFF,)
    dynamic_command: tuple[str, ...] | None = None
    dynamic_ripgrep: str | None = None
    job_command: tuple[str, ...] = field(default_factory=default_job_command)
    diff_job_user: tuple[int, int] | None = None
    dynamic_engine_user: tuple[int, int] | None = None
    dynamic_ports: SlotPorts | None = None
    # Which ruleset confines the engine user, as the startup step found the kernel (#345). Set by
    # the startup after it, never read from the environment; the Worker hands it to the Dynamic job
    # process, which proves the matching properties again.
    dynamic_egress_mode: EgressMode = EgressMode.FULL
    # The work volume of an Implementer container (`RUNNER_IMPLEMENTER_WORK_DIR`, #765); None in
    # every other container, which never advertises `implementer`.
    implementer_work_dir: Path | None = None
    # The container carries the VM's Docker socket (`RUNNER_IMPLEMENTER_MODEL_DOOR=docker`, set by
    # the Dispatcher for the Implementer's profile): Control starts the model door, the agent's
    # container and the reader through it (#745).
    implementer_docker: bool = False


def _number(
    environment: Mapping[str, str], name: str, default: float, low: float, high: float
) -> float:
    raw = environment.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        raise SettingsError(f"{name} must be a number") from None
    if not low <= value <= high:
        raise SettingsError(f"{name} must be between {low:g} and {high:g}")
    return value


def _job_command(environment: Mapping[str, str]) -> tuple[str, ...]:
    """`PR_AGENT_COMMAND` replaces the job entry point, for test stacks with a fake PR-Agent."""
    raw = environment.get("PR_AGENT_COMMAND", "").strip()
    if not raw:
        return default_job_command()
    try:
        parts = shlex.split(raw)
    except ValueError:
        raise SettingsError("PR_AGENT_COMMAND is not a valid command line") from None
    return tuple(parts)


def _diff_job_user(environment: Mapping[str, str]) -> tuple[int, int] | None:
    """`RUNNER_DIFF_JOB_USER` as `uid:gid` (numeric, neither root)."""
    raw = environment.get("RUNNER_DIFF_JOB_USER", "").strip()
    if not raw:
        return None
    uid, separator, gid = raw.partition(":")
    if not separator or not (uid.isascii() and uid.isdigit() and gid.isascii() and gid.isdigit()):
        raise SettingsError("RUNNER_DIFF_JOB_USER must be uid:gid, both numbers")
    if int(uid) == 0 or int(gid) == 0:
        raise SettingsError("RUNNER_DIFF_JOB_USER must not be root")
    return int(uid), int(gid)


def _dynamic_engine_user(
    environment: Mapping[str, str], diff_job_user: tuple[int, int] | None
) -> tuple[int, int] | None:
    """The engine user of a root Worker; it must be nobody a Diff job runs as."""
    if diff_job_user is None:
        return None
    uid, gid = (
        _identifier(environment, ENGINE_UID_VARIABLE),
        _identifier(environment, ENGINE_GID_VARIABLE),
    )
    # One user for both would make the drop of Diff jobs and the engine's boundary meaningless.
    if uid == diff_job_user[0] or gid == diff_job_user[1]:
        raise SettingsError(
            f"{ENGINE_UID_VARIABLE} and {ENGINE_GID_VARIABLE} must differ from RUNNER_DIFF_JOB_USER"
        )
    return uid, gid


def _dynamic_ports(
    environment: Mapping[str, str], diff_job_user: tuple[int, int] | None
) -> SlotPorts | None:
    if diff_job_user is None:
        return None
    try:
        return slot_ports(environment)
    except IsolationError as error:
        raise SettingsError(error.detail) from None


def _implementer_work_dir(environment: Mapping[str, str]) -> Path | None:
    """The work volume of an Implementer container: an absolute path without `..`, not `/`."""
    raw = environment.get(IMPLEMENTER_WORK_DIR_VARIABLE, "").strip()
    if not raw:
        return None
    path = PurePosixPath(raw)
    if not path.is_absolute() or ".." in path.parts or path == PurePosixPath("/"):
        raise SettingsError(f"{IMPLEMENTER_WORK_DIR_VARIABLE} must be an absolute directory")
    return Path(path)


def _implementer_docker(environment: Mapping[str, str]) -> bool:
    raw = environment.get(MODEL_DOOR_VARIABLE, "").strip()
    if raw and raw != MODEL_DOOR_MODE:
        raise SettingsError(f"{MODEL_DOOR_VARIABLE} must be {MODEL_DOOR_MODE}")
    return raw == MODEL_DOOR_MODE


def _identifier(environment: Mapping[str, str], name: str) -> int:
    raw = environment.get(name, "").strip()
    if not raw:
        return DEFAULT_ENGINE_ID
    if not raw.isascii() or not raw.isdigit() or int(raw) == 0:
        raise SettingsError(f"{name} must be a number other than 0")
    return int(raw)


def worker_settings_from_environment(environment: Mapping[str, str]) -> WorkerSettings:
    """The Worker's settings: `RUNNER_JOB_TIMEOUT_SECONDS`, `PR_AGENT_COMMAND` (test stacks only),
    `RUNNER_DIFF_JOB_USER` and the Dynamic slot's variables."""
    diff_job_user = _diff_job_user(environment)
    return WorkerSettings(
        job_command=_job_command(environment),
        diff_job_user=diff_job_user,
        dynamic_engine_user=_dynamic_engine_user(environment, diff_job_user),
        dynamic_ports=_dynamic_ports(environment, diff_job_user),
        implementer_work_dir=_implementer_work_dir(environment),
        implementer_docker=_implementer_docker(environment),
        job_timeout=_number(
            environment,
            "RUNNER_JOB_TIMEOUT_SECONDS",
            DEFAULT_JOB_TIMEOUT_SECONDS,
            1,
            MAX_JOB_TIMEOUT_SECONDS,
        ),
    )
