# SPDX-License-Identifier: LicenseRef-Proprietary

"""One Implementer job from the parsed input to the result line (#765).

The job process of an `implementer` job is the root supervisor of the container (as for Dynamic).
This module joins the pieces that already exist and are tested apart:

1. the engine is advertised (`implementer` in the engines the host handed over), or the job is
   refused with `implementer_engine_unavailable` before anything is touched;
2. the setup (`production_setup`): the engine user, its home and temporary directory in the work
   volume (the `chown` the container profile expects), the engine launch with its network proven,
   the git workspace with the lease gate in front of every push;
3. the turn (`ImplementerSession`, #764), in which a SIGTERM is a stop: the engine is ended at once,
   what is committed is pushed (if the lease is still held) and the turn ends `runner_shutdown`;
4. the result: the facts of the turn in a `JobResult`, the report held to the contract and to 4 MB
   (`report.py`), and no `implementer` key at all when no repository existed.

**The lease.** The job host owns the lease token and beats the heart; this process asks it over the
descriptor it was handed, before every push (`lease_gate`). Only `held` allows a push: a lost,
superseded or unconfirmed lease ends the turn `lease_lost` and nothing is pushed after it. That is
the `lease_check` rule of Dynamic, applied to the one write this kind makes.

**A turn that cost money never ends free.** An unexpected error after the agent ran is
`agent_gave_up`, not `runner_error`; the session classes `setup_failed` after the model was used as
`branch_violation` (a repository that cannot be committed or verified is `RepositoryUnusable`, the
same code).
"""

import logging
import os
import shlex
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from code_reviewer_runner.capabilities import (
    ENGINE_IMPLEMENTER,
    OPENCODE_COMMAND_VARIABLE,
    RIPGREP_PATH_VARIABLE,
    engines_from_environment,
)
from code_reviewer_runner.dynamic_review.budget import BudgetLedger
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch, sweep_user
from code_reviewer_runner.dynamic_review.limits import CheckoutError
from code_reviewer_runner.dynamic_review.netguard import (
    IsolationError,
    egress_mode_from_environment,
)
from code_reviewer_runner.dynamic_review.static_isolation import slot_ports
from code_reviewer_runner.dynamic_review.supervisor import engine_identity
from code_reviewer_runner.job import (
    IMPLEMENTER_WORK_DIR,
    IMPLEMENTER_WORK_DIR_VARIABLE,
    ImplementerInput,
    JobError,
)
from code_reviewer_runner.lease_check import LeaseCheck, LeaseState
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode, JobResult, Usage
from code_reviewer_runner.usage_probe import UsageProbe

from .egress_config import EgressConfigError, EgressSettings, egress_settings_from_environment
from .git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from .report import escaped_size, fit_block, valid_block
from .session import ImplementerSession, SessionSeams
from .startup import HOME_NAME, TMP_NAME, prepare_work_dir
from .turn_result import TurnResult

_log = logging.getLogger(__name__)

# A SIGTERM gives the job host `terminate_grace` (5 s) before it kills the group; the process
# leaves itself a second less, so that its own end comes first.
SIGTERM_BACKSTOP_SECONDS = 4.0
MAX_LOG_TAIL_CHARS = 4096
_ENGINE_DIRECTORY = "engine"


class TurnLike(Protocol):
    """What the job needs of a session: the turn, and the ledger it counted on."""

    @property
    def ledger(self) -> BudgetLedger | None: ...

    def run(self) -> TurnResult: ...

    def secrets(self) -> tuple[str, ...]:
        """Every value that must never appear in the result (the job's, the turn's capability)."""
        ...


@dataclass(frozen=True)
class TurnSetup:
    """What a turn needs, made from trusted configuration only. `launch` is None where there is no
    dedicated engine user (the tests of the glue)."""

    workspace: GitWorkspace
    launch: EngineLaunch | None
    command: tuple[str, ...]
    ripgrep: Path | None
    egress: EgressSettings


SetupFactory = Callable[[ImplementerInput, Mapping[str, str], Callable[[], None]], TurnSetup]


@dataclass(frozen=True)
class JobSeams:
    """What the tests of the glue replace; production leaves the defaults."""

    setup: SetupFactory | None = None
    session_seams: SessionSeams = field(default_factory=SessionSeams)
    # Makes the session; the default builds the real `ImplementerSession`.
    session: Callable[..., TurnLike] | None = None
    clock: Callable[[], float] = time.monotonic


def lease_gate(check: LeaseCheck) -> Callable[[], None]:
    """The gate before every push: it raises `lease_lost` unless the host says the job is still
    ours. Anything but `held` is a no (an app that cannot be reached confirms nothing)."""

    def gate() -> None:
        state = check()
        if state is LeaseState.HELD:
            return
        detail = (
            "the lease could not be confirmed, so nothing is pushed"
            if state is LeaseState.UNCONFIRMED
            else "the job is no longer held by this runner, so nothing is pushed"
        )
        raise JobError(ErrorCode.LEASE_LOST, detail)

    return gate


def identity_for(job: ImplementerInput) -> GitIdentity:
    """Who the agent's commits are by: `<bot> Implementer`, the name the product's App goes by."""
    bot = job.git.bot_login.removesuffix("[bot]") or "code-reviewer"
    return GitIdentity(name=f"{bot} Implementer", email="implementer@users.noreply.invalid")


def _setup_failed(detail: str) -> JobError:
    return JobError(ErrorCode.SETUP_FAILED, detail)


def production_setup(
    job: ImplementerInput, environment: Mapping[str, str], gate: Callable[[], None]
) -> TurnSetup:
    """The setup of a real container: the engine user, the work volume, the network. Raises
    `JobError` with a stable code; nothing of the job's credentials is read from the environment."""
    try:
        identity = engine_identity(environment)
        ports = slot_ports(environment)
        mode = egress_mode_from_environment(environment)
        egress = egress_settings_from_environment(environment)
    except CheckoutError:
        raise _setup_failed("the engine user is not usable") from None
    except IsolationError:
        raise _setup_failed("the slot of the engine is not usable") from None
    except EgressConfigError:
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID, "the network setting of the container is unusable"
        ) from None
    command = shlex.split(environment.get(OPENCODE_COMMAND_VARIABLE, ""))
    ripgrep = environment.get(RIPGREP_PATH_VARIABLE, "")
    if not command or not ripgrep:
        raise JobError(
            ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE, "no verified engine command was handed over"
        )
    if not sweep_user(identity.uid, identity.gid):
        # A survivor of an earlier job could read what this one makes: it does not start.
        raise _setup_failed("a process of the engine user from an earlier job cannot be ended")
    work_dir = Path(environment.get(IMPLEMENTER_WORK_DIR_VARIABLE) or IMPLEMENTER_WORK_DIR)
    try:
        # The `chown` the container profile expects of the Worker: the engine user's home and
        # temporary directory in the volume (the volume itself is root's).
        prepare_work_dir(work_dir, identity.uid, identity.gid)
    except OSError:
        raise _setup_failed(
            "the engine user's directories in the work volume cannot be made"
        ) from None
    layout = WorkspaceLayout(agent_home=work_dir / HOME_NAME, work_dir=work_dir)
    config_dir = layout.run_dir / _ENGINE_DIRECTORY
    try:
        # Root's, enterable but not listable by the engine user: the engine's config goes in.
        config_dir.mkdir(mode=0o711, parents=True, exist_ok=True)
        os.chmod(config_dir, 0o711)
    except OSError:
        raise _setup_failed("the directory of the engine's configuration cannot be made") from None
    spec = job.implementer
    workspace = GitWorkspace(
        WorkspaceSpec(
            clone_url=spec.repo.clone_url,
            token=job.git.token,
            base_branch=spec.base_branch,
            branch=spec.branch,
        ),
        layout,
        AgentUser(identity.uid, identity.gid),
        identity_for(job),
        before_push=gate,
    )
    launch = EngineLaunch(
        uid=identity.uid,
        gid=identity.gid,
        home=str(work_dir / HOME_NAME),
        tmpdir=str(work_dir / TMP_NAME),
        config_dir=config_dir,
        proxy_port=ports.proxy,
        engine_port=ports.engine,
        egress_port=ports.egress,
        egress_mode=mode,
    )
    return TurnSetup(workspace, launch, tuple(command), Path(ripgrep), egress)


# -- the result -----------------------------------------------------------------------------------


def _elapsed_ms(clock: Callable[[], float], started: float) -> int:
    return max(0, int((clock() - started) * 1000))


def failure(
    code: ErrorCode,
    detail: str,
    *,
    duration_ms: int,
    usage: Usage | None = None,
    block: dict[str, object] | None = None,
) -> JobResult:
    """A failed turn. The usage is reported only when the model was used; the code is never a free
    one for a turn that used it (`charged`)."""
    return JobResult(
        ok=False,
        duration_ms=duration_ms,
        comment_url=None,
        error_code=code,
        log_tail=f"{code.value}: {detail}",
        usage=usage if usage is not None and usage.used_the_model else None,
        implementer=_fitted(block, None),
    )


def _fitted(block: Mapping[str, object] | None, rest: JobResult | None) -> dict[str, object] | None:
    """The block held to the contract and to the body; None when there is none or it is not one
    the app could read (the report is then left out, never sent wrong)."""
    if block is None:
        return None
    other = 0 if rest is None else escaped_size(rest.to_json())
    fitted = fit_block(block, other)
    return fitted if valid_block(fitted) is not None else None


def result_of(turn: TurnResult, *, duration_ms: int, secrets: tuple[str, ...]) -> JobResult:
    """The result line of a finished turn."""
    redactor = Redactor(secrets)
    lines = list(turn.notes)
    if turn.error_code is not None:
        lines.append(f"{turn.error_code.value}: {turn.error_detail or ''}".rstrip(": "))
    tail = redactor.redact("\n".join(lines))[-MAX_LOG_TAIL_CHARS:]
    used = turn.usage.used_the_model
    bare = JobResult(
        ok=turn.ok,
        duration_ms=duration_ms,
        comment_url=None,
        error_code=turn.error_code,
        log_tail=tail,
        usage=turn.usage if used or turn.ok else None,
    )
    block = _fitted(turn.implementer_block(), bare)
    if block is None:
        # Our own report is not one the app can read: a bug, and not a success. It cost what it
        # cost, so it is a charged end.
        code = ErrorCode.AGENT_GAVE_UP if used else ErrorCode.RUNNER_ERROR
        return failure(
            code,
            "the report of the turn could not be made",
            duration_ms=duration_ms,
            usage=turn.usage,
        )
    return JobResult(
        ok=bare.ok,
        duration_ms=bare.duration_ms,
        comment_url=None,
        error_code=bare.error_code,
        log_tail=bare.log_tail,
        usage=bare.usage,
        implementer=block,
    )


def _early_block(workspace: GitWorkspace | None) -> dict[str, object] | None:
    """The report of a turn that failed after the repository was cloned but before the agent ran:
    where it started and nothing else. None when there is no repository to speak of."""
    if workspace is None:
        return None
    try:
        start = workspace.start_commit
    except JobError:
        return None
    return {
        "baseCommit": start,
        "headCommit": None,
        "pushed": False,
        "commits": [],
        "filesChanged": [],
        "summary": "",
        "opencode": None,
    }


# -- the job ------------------------------------------------------------------------


def run_implementer_job(
    job: ImplementerInput,
    started: float,
    environment: Mapping[str, str],
    *,
    lease_check: LeaseCheck | None,
    shutdown: threading.Event,
    engines: tuple[str, ...] | None = None,
    usage_probe: UsageProbe | None = None,
    seams: JobSeams = JobSeams(),  # noqa: B008 - frozen, shared on purpose
) -> JobResult:
    """Run one turn and return its result. Never raises for a turn that failed; whatever an
    unexpected error is, it is a result too (and a charged one when the model was used)."""
    clock = seams.clock
    advertised = engines_from_environment(environment) if engines is None else engines
    if ENGINE_IMPLEMENTER not in advertised:
        return failure(
            ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE,
            "this runner did not advertise the implementer engine",
            duration_ms=_elapsed_ms(clock, started),
        )
    # No answer is no lease: a process started without the channel never pushes.
    gate = lease_gate(lease_check or (lambda: LeaseState.UNCONFIRMED))
    setup: TurnSetup | None = None
    session: TurnLike | None = None
    try:
        factory = seams.setup or production_setup
        setup = factory(job, environment, gate)
        setup.workspace.prepare()
        session = _session(job, setup, started, environment, shutdown, seams)
        if usage_probe is not None:
            usage_probe.watch(lambda: _usage_of(session, job))
        turn = session.run()
    except JobError as error:
        # Before the agent ran: nothing was spent, and the code is the setup's own.
        return failure(
            error.code,
            error.detail,
            duration_ms=_elapsed_ms(clock, started),
            block=_early_block(setup.workspace if setup is not None else None),
        )
    except Exception:
        _log.exception("the turn failed unexpectedly")
        usage = _usage_of(session, job)
        used = usage is not None and usage.used_the_model
        # The money is spent: never the free code of a runner that failed before it began.
        return failure(
            ErrorCode.AGENT_GAVE_UP if used else ErrorCode.RUNNER_ERROR,
            "the turn could not be run to its end",
            duration_ms=_elapsed_ms(clock, started),
            usage=usage,
            block=_early_block(setup.workspace if setup is not None else None),
        )
    # The capability of the turn's model proxy is a secret of this turn too.
    return result_of(turn, duration_ms=_elapsed_ms(clock, started), secrets=session.secrets())


def _session(
    job: ImplementerInput,
    setup: TurnSetup,
    started: float,
    environment: Mapping[str, str],
    shutdown: threading.Event,
    seams: JobSeams,
) -> TurnLike:
    options: dict[str, object] = {
        "workspace": setup.workspace,
        "command": setup.command,
        "egress": setup.egress,
        "environment": environment,
        "started": started,
        "launch": setup.launch,
        "ripgrep": setup.ripgrep,
        "seams": seams.session_seams,
        "should_stop": shutdown.is_set,
    }
    if seams.session is not None:
        return seams.session(job, **options)
    return ImplementerSession(job, **options)  # type: ignore[arg-type]  # the keywords above


def _usage_of(session: TurnLike | None, job: ImplementerInput) -> Usage | None:
    """What the model was used for so far, read from the ledger of the turn (None before it)."""
    ledger = None if session is None else session.ledger
    return None if ledger is None else ledger.usage(job.llm.model)
