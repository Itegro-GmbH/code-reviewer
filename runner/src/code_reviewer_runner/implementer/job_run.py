# SPDX-License-Identifier: LicenseRef-Proprietary

"""One Implementer job from the parsed input to the result line (#765).

The job process of an `implementer` job is the root supervisor of the container (as for Dynamic).
This module joins the pieces that already exist and are tested apart:

1. the engine is advertised (`implementer` in the engines the host handed over), or the job is
   refused with `implementer_engine_unavailable` before anything is touched;
2. the sandbox gate (`check_sandbox`, #745 step 4): the golden snapshot's Sysbox must be proven
   and the VM big enough for the agent's container, or the turn ends `sandbox_unproven` or
   `sandbox_size_unsupported`, free, before anything is touched;
3. the setup (`production_setup`): the reader and the git workspace with the lease gate in front
   of every push, and the agent's container as a thing the session makes when it needs it;
3b. the environment's setup script (#818, `environment_setup.py`), when the task has one: in the
   agent's own container, before the model door exists (#1009). A script that fails ends the turn
   `environment_setup_failed`, free, with its output on the Runs page; one that succeeds leaves the
   container, with everything it started, for the agent, which runs in that same container;
4. the turn (`ImplementerSession`, #764), in which a SIGTERM is a stop: the engine is ended at once,
   what is committed on all local branches is pushed (if the lease is still held) and the turn ends
   `runner_shutdown`;
5. the result: the facts of the turn in a `JobResult`, the report held to the contract and to 4 MB
   (`report.py`), and no `implementer` key at all when no repository existed.

**The lease.** The job host owns the lease token and beats the heart; this process asks it over the
descriptor it was handed, before the final push lists anything and before every `git push`
(`lease_gate`). Only `held` allows a push: a lost, superseded or unconfirmed lease ends the turn
`lease_lost` and nothing is pushed after it. That is the `lease_check` rule of Dynamic, applied to
the one write this kind makes.

**A turn that cost money never ends free.** An unexpected error after the agent ran is
`agent_gave_up`, not `runner_error`; the session classes `setup_failed` after the model was used as
`agent_gave_up` too.
"""

import logging
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from functools import partial
from pathlib import Path
from typing import Protocol

from code_reviewer_runner.capabilities import ENGINE_IMPLEMENTER, engines_from_environment
from code_reviewer_runner.dynamic_review.budget import BudgetLedger
from code_reviewer_runner.job import (
    HARNESS_CLAUDE_CODE,
    IMPLEMENTER_AGENT_MEMORY_VARIABLE,
    IMPLEMENTER_SANDBOX_PROOF_VARIABLE,
    IMPLEMENTER_WORK_DIR,
    IMPLEMENTER_WORK_DIR_VARIABLE,
    ImplementerInput,
    JobError,
)
from code_reviewer_runner.lease_check import LeaseCheck, LeaseState
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode, JobResult, Usage
from code_reviewer_runner.usage_probe import UsageProbe

from .agent_container import OPENCODE, Adopted, AgentContainer, AgentSeams
from .claude_code.gates import subscription_rule
from .claude_code.layer import LayerDaemon
from .claude_code.login import ClaudeLogin
from .claude_code.readiness import HarnessNotReady, ReadyHarness, ready_harness
from .docker_api import DockerApi
from .environment_setup import EnvironmentSetup, log_output, run_environment_setup
from .git_workspace import (
    GitIdentity,
    GitWorkspace,
    LeaseNotConfirmed,
    WorkspaceLayout,
    WorkspaceSpec,
)
from .network_rule import OFF
from .placement import placement_of
from .reader import ReaderAccess
from .report import clip_texts, escaped_size, fit_block, valid_block
from .result_channel import ResultReader, make_result_directory, redacted_value
from .resume_session import ResumeInput
from .runner_profile import agent_seams, outer_proxy_for_job, reader_seams, setup_seams
from .session import AgentPlace, ImplementerSession, SessionSeams
from .snapshot_pump import SnapshotPump
from .step_pump import StepPump
from .turn_result import TurnResult

_log = logging.getLogger(__name__)

# A SIGTERM gives the process `IMPLEMENTER_TERMINATE_GRACE_SECONDS` (120 s, `job_loop/host.py`)
# before the host kills the group; the process leaves itself five seconds less, so that its own
# end comes first. The container's `stopTimeoutSeconds` (150) is above both. The engine comes out of
# these 115 seconds, and so does the one final push (`session.STOP_PUSH_SECONDS`).
SIGTERM_BACKSTOP_SECONDS = 115.0
MAX_LOG_TAIL_CHARS = 4096
# The names the Dispatcher gives the container (`ImplementerEnvironmentName` of runner-api.v1.json).
SANDBOX_PROOF_VARIABLE = IMPLEMENTER_SANDBOX_PROOF_VARIABLE
SANDBOX_PROVEN = "proven"
AGENT_MEMORY_VARIABLE = IMPLEMENTER_AGENT_MEMORY_VARIABLE
# The least memory the agent's container is worth starting with: OpenCode, its own Docker daemon and
# the tools of a repository's tests do not fit in less (measured, `docs/implementer.md`). The
# Dispatcher computes the limit from the size of the VM and says 0 when it is below this.
MIN_AGENT_MEMORY_MB = 1024


class TurnLike(Protocol):
    """What the job needs of a session: the turn, and the ledger it counted on."""

    @property
    def ledger(self) -> BudgetLedger | None: ...

    def run(self) -> TurnResult: ...

    def secrets(self) -> tuple[str, ...]:
        """Every value that must never appear in the result (the job's, the turn's capability)."""
        ...


@dataclass(frozen=True)
class EnvironmentHost:
    """How a turn runs the environment's setup script and goes on in the same container (#818,
    #1009): `run` runs the script in the agent's container and returns that container (or the
    reason it did not), `place` makes the agent's container object that takes it over. A `TurnSetup`
    without one cannot run a task that names a script."""

    run: Callable[
        [ImplementerInput, Callable[[], float], Callable[[], bool], float], EnvironmentSetup
    ]
    place: Callable[[Adopted], Callable[[], AgentPlace]]


@dataclass(frozen=True)
class TurnSetup:
    """What a turn needs, made from trusted configuration only: the git workspace (whose reader is
    closed with `close`), what makes the agent's container, and the engine's command in it."""

    workspace: GitWorkspace
    place: Callable[[], AgentPlace]
    command: tuple[str, ...]
    close: Callable[[], None] = lambda: None
    environment: EnvironmentHost | None = None
    # #843: how the result file is read; None for a turn without a result schema.
    results: ResultReader | None = None


SetupFactory = Callable[[ImplementerInput, Mapping[str, str], Callable[[], None]], TurnSetup]


@dataclass(frozen=True)
class JobSeams:
    """What the tests of the glue replace; production leaves the defaults."""

    setup: SetupFactory | None = None
    session_seams: SessionSeams = field(default_factory=SessionSeams)
    # Makes the session; the default builds the real `ImplementerSession`.
    session: Callable[..., TurnLike] | None = None
    clock: Callable[[], float] = time.monotonic
    # #856: looks at the device again for a job that asks for Claude Code (the login, the layer);
    # nothing is built. The default asks the real daemon.
    harness: Callable[[Mapping[str, str]], ReadyHarness | HarnessNotReady] | None = None


# Where a job process finds the runner's home when its token is the default file there; the runner
# hands the path of the file itself (`FACTORY_RUNNER_CLAUDE_CODE_TOKEN_FILE`) when it has one.
RUNNER_HOME_VARIABLE = "FACTORY_RUNNER_HOME"


def device_daemon(environment: Mapping[str, str]) -> DockerApi:
    """The daemon that holds the agent image and the Claude Code layer: the VM's own Docker, and on
    the Incus backend (`placement.py`) **B's**, which is where the agent's container is made. The
    layer is built into the golden image there; instance A's Docker has neither."""
    return placement_of(environment).environment_api()


def device_harness(
    environment: Mapping[str, str],
    *,
    daemon: Callable[[Mapping[str, str]], LayerDaemon] = device_daemon,
) -> ReadyHarness | HarnessNotReady:
    """The default look at the device for a job that asks for Claude Code (#856). The login is the
    one the dispatcher handed this process (#980): the runner's own home exists only for a Worker
    that runs on the device itself."""
    home = Path(environment.get(RUNNER_HOME_VARIABLE) or "/nonexistent")
    try:
        return ready_harness(daemon(environment), environment, home)
    except JobError as error:
        return HarnessNotReady(error.detail)
    except Exception:
        return HarnessNotReady("the daemon could not be asked")


def lease_gate(check: LeaseCheck) -> Callable[[], None]:
    """The gate before every push: it raises `lease_lost` unless the host says the job is still
    ours. Nothing is pushed unless the answer is `held`. A lost or superseded lease is a no that
    ends the turn (`lease_lost`); an answer that could not be had (the app did not reply) is a
    "not now": the push loop asks again after its back-off and the last push asks within its
    window, and only when that stays unanswered does the turn end `lease_lost`."""

    def gate() -> None:
        state = check()
        if state is LeaseState.HELD:
            return
        if state is LeaseState.UNCONFIRMED:
            raise LeaseNotConfirmed
        raise JobError(
            ErrorCode.LEASE_LOST, "the job is no longer held by this runner, so nothing is pushed"
        )

    return gate


def identity_for(job: ImplementerInput) -> GitIdentity:
    """Who the agent's commits are by: `<bot> Implementer`, the name the product's App goes by."""
    bot = job.git.bot_login.removesuffix("[bot]") or "code-reviewer"
    return GitIdentity(name=f"{bot} Implementer", email="implementer@users.noreply.invalid")


def check_sandbox(environment: Mapping[str, str]) -> JobError | None:
    """The gate of #745, step 4, from what the Dispatcher says about this VM: the golden snapshot's
    Sysbox verdict must be `proven` and the VM must leave the agent's container enough memory.
    Anything else, an `unproven` verdict or a missing or unreadable value, is a free end, named,
    before any clone or container: the model was never used. The verdict is the fourth member of
    the snapshot pair (`SANDBOX_SYSBOX_PROOF`), so a Dispatcher that was never told one has said
    `unproven`."""
    if environment.get(SANDBOX_PROOF_VARIABLE, "").strip() != SANDBOX_PROVEN:
        return JobError(
            ErrorCode.SANDBOX_UNPROVEN,
            "the golden snapshot's Sysbox is not proven, so the agent's container does not start",
        )
    raw = environment.get(AGENT_MEMORY_VARIABLE, "").strip()
    memory = int(raw) if raw.isascii() and raw.isdigit() else 0
    if memory < MIN_AGENT_MEMORY_MB:
        return JobError(
            ErrorCode.SANDBOX_SIZE_UNSUPPORTED,
            f"this VM leaves the agent's container less than {MIN_AGENT_MEMORY_MB} MB",
        )
    return None


def production_setup(
    job: ImplementerInput,
    environment: Mapping[str, str],
    gate: Callable[[], None],
    harness: ReadyHarness | None = None,
) -> TurnSetup:
    """The setup of a real container: the reader, the work volume, the git workspace. Raises
    `JobError` with a stable code; nothing of the job's credentials is read from the environment.
    `harness` is the device's Claude Code for a job that asks for it (#856): its login is guarded
    in the push, its layer is the agent's image, and the agent's network is the forced rule."""
    work_dir = Path(environment.get(IMPLEMENTER_WORK_DIR_VARIABLE) or IMPLEMENTER_WORK_DIR)
    memory = int(environment.get(AGENT_MEMORY_VARIABLE, "0").strip())
    spec = job.implementer
    identity = identity_for(job)
    # #843: a turn with a result schema has the result directory in its containers and its readers.
    with_result = spec.result_schema is not None
    subscription = spec.subscription is not None
    if subscription and (harness is None or (spec.environment and spec.environment.has_script)):
        # The layer is built on the golden image; a script's image is not that (a follow-up).
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            "subscription_setup_script: a turn on the harness claude-code cannot run in an "
            "environment with a setup script yet"
            if harness is not None
            else "harness_not_ready: the device was not looked at for this job",
        )
    if subscription:
        environment_rule = OFF if spec.environment is None else spec.environment.network
        rule_of_turn = subscription_rule(environment_rule)
    else:
        rule_of_turn = OFF if spec.environment is None else spec.environment.network
    reader = ReaderAccess(
        {
            "GIT_AUTHOR_NAME": identity.name,
            "GIT_AUTHOR_EMAIL": identity.email,
            "GIT_COMMITTER_NAME": identity.name,
            "GIT_COMMITTER_EMAIL": identity.email,
        },
        reader_seams(environment),
        result=with_result,
    )
    if with_result:
        # Before the agent's container: its mount of the directory needs the directory.
        make_result_directory(work_dir)
    workspace = GitWorkspace(
        WorkspaceSpec(
            clone_url=spec.repo.clone_url,
            token=job.git.token,
            base_branch=spec.base_branch,
            branch=spec.branch,
            resume=spec.resume,
            start_branch=spec.start_branch,
        ),
        WorkspaceLayout(work_dir=work_dir),
        identity,
        reader,
        before_push=gate,
        guard_secrets=() if harness is None else (harness.login.secret,),
        # A VM on a customer's machine (#994): the clone, the fetch and the push go through the
        # host's outer-wall proxy and nowhere else.
        proxy=outer_proxy_for_job(environment),
    )

    def run_environment(
        turn: ImplementerInput,
        elapsed: Callable[[], float],
        should_stop: Callable[[], bool],
        time_limit: float,
    ) -> EnvironmentSetup:
        assert spec.environment is not None
        return run_environment_setup(
            spec.environment,
            workspace=workspace,
            memory_mb=memory,
            time_limit=time_limit,
            elapsed=elapsed,
            should_stop=should_stop,
            secrets=turn.secrets,
            seams=replace(setup_seams(environment), result=with_result),
        )

    rule = rule_of_turn
    claude = None if harness is None else AgentSeams(image=harness.image, no_new_privileges=True)

    def place_from(adopted: Adopted) -> Callable[[], AgentPlace]:
        return lambda: AgentContainer(
            memory,
            agent_seams(environment, AgentSeams()),
            rule,
            result=with_result,
            adopted=adopted,
        )

    return TurnSetup(
        workspace,
        lambda: AgentContainer(
            memory,
            agent_seams(environment, AgentSeams() if claude is None else claude),
            rule,
            result=with_result,
        ),
        (OPENCODE,),
        close=reader.close,
        environment=EnvironmentHost(run_environment, place_from),
        results=reader if with_result else None,
    )


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
    log_extra: str = "",
) -> JobResult:
    """A failed turn. The usage is reported only when the model was used; the code is never a free
    one for a turn that used it (`charged`). `log_extra` goes in front of the code line (the notes
    of the environment's setup)."""
    line = f"{code.value}: {detail}"
    return JobResult(
        ok=False,
        duration_ms=duration_ms,
        comment_url=None,
        error_code=code,
        log_tail=(f"{log_extra}\n{line}" if log_extra else line)[-MAX_LOG_TAIL_CHARS:],
        usage=usage if usage is not None and usage.used_the_model else None,
        implementer=_fitted(block, None),
    )


def _fitted(block: Mapping[str, object] | None, rest: JobResult | None) -> dict[str, object] | None:
    """The block held to the contract and to the body; None when there is none or it is not one
    the app could read (the report is then left out, never sent wrong)."""
    if block is None:
        return None
    other = 0 if rest is None else escaped_size(rest.to_json())
    fitted = fit_block(clip_texts(block), other)
    return fitted if valid_block(fitted) is not None else None


def result_of(turn: TurnResult, *, duration_ms: int, secrets: tuple[str, ...]) -> JobResult:
    """The result line of a finished turn."""
    redactor = Redactor(secrets)
    exact = redactor.redact_known
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
        # A turn on a login of the device (#856) was not billed through us, but what it was worth,
        # when it is known, is shown whatever its end.
        usage=turn.usage if used or turn.ok or turn.usage.estimated_cost_usd is not None else None,
    )
    # Every fact of the report is data the agent can shape (a branch name, a commit subject, a
    # path): the job's secrets are taken out of each text, exactly and in their spellings.
    block = _fitted(redacted_value(turn.implementer_block(), exact), bare)
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


def _early_block(
    workspace: GitWorkspace | None, setup: Mapping[str, object] | None = None
) -> dict[str, object] | None:
    """The report of a turn that failed after the repository was cloned but before the agent ran:
    where it started and nothing else (and what the environment's script did, when it ran). None
    when there is no repository to speak of."""
    if workspace is None:
        return None
    try:
        start = workspace.start_commit
    except JobError:
        return None
    return {
        **({} if setup is None else {"setup": dict(setup)}),
        "baseCommit": start,
        "headCommit": None,
        "pushed": False,
        "branches": [],
        "branchesDropped": {"invalid": 0, "overflow": 0},
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
    process_timeout: float | None = None,
    secrets_sink: list[str] | None = None,
    steps: StepPump | None = None,
    snapshot: SnapshotPump | None = None,
    resume: ResumeInput | None = None,
    seams: JobSeams = JobSeams(),  # noqa: B008 - frozen, shared on purpose
) -> JobResult:
    """Run one turn and return its result. Never raises for a turn that failed; whatever an
    unexpected error is, it is a result too (and a charged one when the model was used).

    `process_timeout` is the hard timeout of the process (`RUNNER_JOB_TIMEOUT_SECONDS`): the turn is
    held to the smaller of it and its own time limit, so a lowered timeout still leaves the time for
    the last push. `secrets_sink` receives the secrets the turn made up (the capability of its model
    proxy), for the scrub of the line that is printed. `steps` is the channel the step records of
    the turn go out over (#745); None records nothing. `snapshot` is the channel the engine's
    session leaves over at the end of the turn (#839); None takes no export. `resume` is what a
    follow-up turn has of its earlier conversation (#840): the checked snapshot the job host
    downloaded, or the reason there is none; None for a first turn."""
    clock = seams.clock
    advertised = engines_from_environment(environment) if engines is None else engines
    if ENGINE_IMPLEMENTER not in advertised:
        return failure(
            ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE,
            "this runner did not advertise the implementer engine",
            duration_ms=_elapsed_ms(clock, started),
        )
    if (
        job.implementer.subscription is None
        and job.llm.max_cost_usd is None
        and job.llm.operator_max_cost_usd is None
    ):
        # No limit in the job is no limit at all: the ledger would fall back to a default of the
        # operator's environment that an Implementer container does not have (1.00 USD, silently).
        return failure(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            "the job carries no cost limit, so the turn does not start",
            duration_ms=_elapsed_ms(clock, started),
        )
    refused = check_sandbox(environment)
    if refused is not None:
        return failure(refused.code, refused.detail, duration_ms=_elapsed_ms(clock, started))
    # #856: the manifest said the device can run Claude Code; it is looked at again for this job,
    # and a device that cannot refuses it. The job is never run with another harness.
    ready: ReadyHarness | None = None
    if (
        job.implementer.profile is not None
        and job.implementer.profile.harness == HARNESS_CLAUDE_CODE
    ):
        looked = (seams.harness or device_harness)(environment)
        if isinstance(looked, HarnessNotReady):
            return failure(
                ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE,
                f"harness_not_ready: {looked.text}",
                duration_ms=_elapsed_ms(clock, started),
            )
        ready = looked
        if secrets_sink is not None:
            secrets_sink.append(ready.login.secret)
    # No answer is no lease: a process started without the channel never pushes.
    gate = lease_gate(lease_check or (lambda: LeaseState.UNCONFIRMED))
    setup: TurnSetup | None = None
    session: TurnLike | None = None
    prepared: EnvironmentSetup | None = None
    try:
        factory = seams.setup or partial(production_setup, harness=ready)
        setup = factory(job, environment, gate)
        setup.workspace.prepare()
        if job.implementer.environment is not None and job.implementer.environment.has_script:
            prepared = _environment(job, setup, started, shutdown, seams, process_timeout)
            if prepared.error is not None:
                raise prepared.error
            assert prepared.adopted is not None and setup.environment is not None
            setup = replace(setup, place=setup.environment.place(prepared.adopted))
        session = _session(
            job,
            setup,
            started,
            environment,
            shutdown,
            seams,
            process_timeout,
            steps,
            snapshot,
            resume,
            None if ready is None else ready.login,
        )
        if usage_probe is not None:
            usage_probe.watch(lambda: _usage_of(session, job))
        turn = session.run()
    except JobError as error:
        # Before the agent ran: nothing was spent, and the code is the setup's own.
        return failure(
            error.code,
            error.detail,
            duration_ms=_elapsed_ms(clock, started),
            block=_early_block(
                setup.workspace if setup is not None else None,
                None if prepared is None else prepared.block,
            ),
            log_extra=_environment_log(prepared),
        )
    except Exception:
        _remember_secrets(session, secrets_sink)
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
    finally:
        if setup is not None:
            setup.close()
    # The capability of the turn's model proxy is a secret of this turn too.
    _remember_secrets(session, secrets_sink)
    if prepared is not None:
        turn = replace(turn, setup=prepared.block, notes=(*prepared.notes, *turn.notes))
    return result_of(turn, duration_ms=_elapsed_ms(clock, started), secrets=session.secrets())


def _environment(
    job: ImplementerInput,
    setup: TurnSetup,
    started: float,
    shutdown: threading.Event,
    seams: JobSeams,
    process_timeout: float | None,
) -> EnvironmentSetup:
    """The environment's script, run in its Setup container (#818). The time it takes is part of
    the turn's: the limit it is held to is the smaller of the job's and the process's, as the
    session's own deadline is."""
    if setup.environment is None:
        raise JobError(
            ErrorCode.IMPLEMENTER_CONFIG_INVALID,
            "this runner cannot run the setup script of an environment",
        )
    limit = float(job.implementer.limits.time_limit_seconds)
    if process_timeout is not None:
        limit = min(limit, process_timeout)
    clock = seams.clock
    return setup.environment.run(job, lambda: clock() - started, shutdown.is_set, limit)


def _environment_log(prepared: EnvironmentSetup | None) -> str:
    """The notes of the setup step and the end of the script's output, for the log line of a turn
    that ended there."""
    if prepared is None:
        return ""
    lines = list(prepared.notes)
    output = log_output(prepared)
    if output:
        lines.append("--- the end of the script's output ---")
        lines.append(output)
    return "\n".join(lines)


def _session(
    job: ImplementerInput,
    setup: TurnSetup,
    started: float,
    environment: Mapping[str, str],
    shutdown: threading.Event,
    seams: JobSeams,
    process_timeout: float | None,
    steps: StepPump | None = None,
    snapshot: SnapshotPump | None = None,
    resume: ResumeInput | None = None,
    login: ClaudeLogin | None = None,
) -> TurnLike:
    options: dict[str, object] = {
        "workspace": setup.workspace,
        "command": setup.command,
        "place": setup.place,
        "environment": environment,
        "started": started,
        "seams": seams.session_seams,
        "should_stop": shutdown.is_set,
        "max_seconds": process_timeout,
        "steps": steps,
        "snapshot": snapshot,
    }
    if resume is not None:
        options["resume"] = resume
    if login is not None:
        options["login"] = login
    if setup.results is not None:
        options["results"] = setup.results
    if seams.session is not None:
        return seams.session(job, **options)
    return ImplementerSession(job, **options)  # type: ignore[arg-type]  # the keywords above


def _remember_secrets(session: TurnLike | None, sink: list[str] | None) -> None:
    if session is not None and sink is not None:
        sink.extend(session.secrets())


def _usage_of(session: TurnLike | None, job: ImplementerInput) -> Usage | None:
    """What the model was used for so far, read from the ledger of the turn (None before it)."""
    ledger = None if session is None else session.ledger
    return None if ledger is None else ledger.usage(job.llm.model)
