# SPDX-License-Identifier: LicenseRef-Proprietary

"""One Implementer turn from the instruction to the result (#764).

The prepared workspace (`git_workspace.py`, #762) and the egress setting (#763) come in; the model
proxy, the engine and the agent's session are started here, and everything is ended here. The flow:

1. The ledger and the passthrough proxy are made from the job's model entry and cost policy, as for
   a native Dynamic job (`native_job.build_native`); the clock of the ledger is the job's time limit
   less the grace kept for the end (`GRACE_SECONDS`).
2. The engine starts as the engine user in `/work/repo`, with the generated configuration and the
   closed environment; the push loop (`PushLoop`) ticks on a thread of its own, so a slow push never
   delays the watch on the limits.
3. The instruction is sent as the one user message. When the turn ends, a working tree that is
   still dirty gets **one** more message in the same session (a fixed text); what is dirty after
   that is committed by the system as the engine user, without a model call.
4. Whatever ended the turn (the agent, the cost limit, the clock, a crash of the engine), the
   engine and everything of its user are ended first, the leftover is committed, and the final push
   is made. The result reports what was committed and pushed, with the stable code of what ended
   the turn.

Nothing steers the agent: the cost limit (the proxy refuses the next call) and the clock are the
only brakes.
"""

import logging
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from code_reviewer_runner.dynamic_review.adapter import (
    PINNED_ENGINE_VERSION,
    EngineError,
    Transport,
    _http_request,  # pyright: ignore[reportPrivateUsage]
)
from code_reviewer_runner.dynamic_review.budget import (
    MAX_REQUEST_BYTES,
    BudgetLedger,
    DynamicLimits,
    LimitError,
)
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.job_model_entry import (
    native_model_reference,
    native_provider_config,
)
from code_reviewer_runner.dynamic_review.native_job import (
    NativeJob,
    UpstreamFactory,
    build_native,
)
from code_reviewer_runner.dynamic_review.netguard import IsolationError
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.passthrough.server import PassthroughServer
from code_reviewer_runner.dynamic_review.passthrough.upstream import HttpsUpstream
from code_reviewer_runner.dynamic_review.static_isolation import ImplementerNetwork
from code_reviewer_runner.job import ImplementerInput, JobError
from code_reviewer_runner.result import ErrorCode, Usage

from .agent import AgentTurn, ImplementerAgent
from .config import build_engine_config, implementer_environment
from .egress_config import EgressSettings, start_egress
from .egress_proxy import EgressProxy
from .git_workspace import (
    GitWorkspace,
    PushLoop,
    PushResult,
    RepositoryUnusable,
)
from .history import CommitInfo, FileChange
from .prompts import LEFTOVER_PROMPT, instructions_text
from .turn_result import TurnResult, clip_summary

_log = logging.getLogger(__name__)

# What is kept back from the job's time limit for the end of the turn: the commit of what is left
# and the final push (the plan: the last three minutes). A short limit keeps a third of it.
GRACE_SECONDS = 180.0
# How often the push loop looks at the agent's branch (the spool is a hint, the poll finds the
# rest); a push itself is batched by the loop.
TICK_SECONDS = 2.0
# The extra message for a dirty tree is only worth sending when this much of the clock is left.
MIN_EXTRA_TURN_SECONDS = 20.0
# What the ledger holds the results of tools to. There is no bound on a single result: the owner's
# rule is that the cost limit is the only brake, and a normal `grep` or `bash` result is larger than
# the 64 KiB a review is held to (a grep over 300 files answers 200 KB; the engine's own cut does
# not apply to it). The cumulative bound is a sanity bound above what any turn the cost limit allows
# can read; a single result cannot pass it either.
MAX_RETURNED_BYTES = 256 * 1024 * 1024
MAX_TOOL_RESULT_BYTES = MAX_RETURNED_BYTES
# A conversation of a coding agent is larger than a review's: the model's window bounds a request
# (`BudgetLedger.reserve_call`), this byte bound is only a backstop above it.
MAX_AGENT_REQUEST_BYTES = 8 * MAX_REQUEST_BYTES

# The name of the instruction file the runner writes for the engine.
INSTRUCTIONS_FILE = "implementer-instructions.md"

# The words of the ledger's refusals (`budget.py`). A test pins them against the ledger, so a
# change of its wording makes that test red instead of silently changing a code.
DEADLINE_DETAIL = "the whole-job deadline was reached"
COST_LIMIT_DETAIL = "the cost limit is used up"
TOKEN_CAP_DETAIL = "the token cap is used up"


def deadline_seconds(time_limit: int, elapsed: float) -> float:
    """The seconds the agent may work, counted from now: the job's time limit less what is spent
    since the job began and less the grace kept for the leftover commit and the final push (three
    minutes; a third of a short limit)."""
    return float(time_limit) - min(GRACE_SECONDS, time_limit / 3) - elapsed


def agent_limits(deadline: float, max_cost: Decimal, stop_reason: str) -> DynamicLimits:
    """The envelope of the ledger of one turn: the Dynamic one with the clock and cost limit of the
    turn and the bounds a coding agent needs (see the constants above)."""
    return DynamicLimits(
        deadline_seconds=deadline,
        max_cost_usd=max_cost,
        cost_stop_reason=stop_reason,
        max_tool_result_bytes=MAX_TOOL_RESULT_BYTES,
        max_returned_bytes=MAX_RETURNED_BYTES,
        max_request_bytes=MAX_AGENT_REQUEST_BYTES,
    )


@dataclass(frozen=True)
class SessionSeams:
    """What the tests of the session replace; production leaves the defaults."""

    upstream_for: UpstreamFactory = HttpsUpstream
    popen: Any = None
    transport: Transport = _http_request
    port_source: Callable[[], int] | None = None
    tick_seconds: float = TICK_SECONDS
    startup_seconds: float | None = None
    scratch_dir: str | None = None
    clock: Callable[[], float] = time.monotonic
    # Starts the egress proxy of a registries container (default `egress_config.start_egress`).
    start_egress: Callable[[EgressSettings], EgressProxy | None] | None = None


# What stops a turn when the push loop meets it: the provider or the branch refuses for good.
# Anything else the loop raises (a transient failure the loop did not take for one, a bug) is
# logged,
# waited out, and the final push still runs.
_REFUSALS = frozenset(
    {ErrorCode.BRANCH_VIOLATION, ErrorCode.PUSH_REJECTED, ErrorCode.BRANCH_EXISTS}
)
_UNEXPECTED_PAUSE_SECONDS = 30.0


class PushTicker:
    """Ticks the push loop on a thread of its own and keeps the first error that ends the turn.

    A `PushUnverified` (a look that failed, a push the provider could not take for now) is the
    loop's own business: it looks again after a back-off. A refusal of the provider or of the branch
    (`push_rejected`, `branch_exists`, `branch_violation`) ends the turn: `check()` raises it in the
    watch and `finish()` raises it instead of a push that could only be refused again. Anything else
    is not a reason to give up the commits: it is logged and the final push runs once.
    """

    def __init__(self, loop: PushLoop, interval: float) -> None:
        self._loop = loop
        self._interval = interval
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._error: JobError | None = None
        self._pause_until = 0.0
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            with self._lock:
                if self._stop.is_set() or self._error is not None:
                    return
                if time.monotonic() < self._pause_until:
                    continue
                try:
                    self._loop.tick()
                except JobError as error:
                    if error.code in _REFUSALS:
                        self._error = error
                        return
                    self._unexpected()
                except Exception:
                    self._unexpected()

    def _unexpected(self) -> None:
        _log.exception("the push loop failed; the final push still runs")
        self._pause_until = time.monotonic() + _UNEXPECTED_PAUSE_SECONDS

    @property
    def error(self) -> JobError | None:
        return self._error

    def check(self) -> None:
        if self._error is not None:
            raise self._error

    def finish(self) -> PushResult:
        """Stop ticking and make the last push, whatever the back-off. Waits for a tick in
        flight. A refusal the loop met is raised instead: the push would only be refused again."""
        self._stop.set()
        with self._lock:
            if self._error is not None:
                raise self._error
            return self._loop.finish()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5.0)


def classify(
    error: BaseException,
    *,
    used_model: bool = False,
    provider_error: ErrorCode | None = None,
) -> tuple[ErrorCode, str]:
    """The stable code of what ended a turn and a sentence of ours for it. Never the text of an
    exception that could carry a value.

    `used_model` is whether the model was really used: a call that was billed, or may have been
    (`BudgetLedger.model_used`), not a call that was merely reserved. `provider_error` is the code
    the proxy kept for the last call the provider failed (`llm_unavailable`, `llm_timeout`, ...).

    When the engine gives up, the cause is looked for first at the provider: an engine that ended
    its turn with an error while the last call to the model failed ended it because of the
    outage, and the outage is the code (it is not the engine's fault, nor the agent's). Otherwise
    the death of the engine and a bound of the audit are the runner's own failures: `runner_error`,
    free, before the model was used, and the charged `agent_gave_up` after it (the turn cost
    money)."""
    code, detail = _classified(error)
    if code is ErrorCode.RUNNER_ERROR:
        if provider_error is not None and _the_engine_gave_up(error):
            return provider_error, "the model provider was not available for the turn"
        if used_model:
            return ErrorCode.AGENT_GAVE_UP, detail
    return code, detail


def _the_engine_gave_up(error: BaseException) -> bool:
    """Whether the end was the engine's own (it died, its stream ended, it ended its turn with an
    error), and not a bound of ours or a refusal of the git layer."""
    return isinstance(error, EngineError | LimitError) and error.code in (
        ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
        ErrorCode.RUNNER_ERROR,
    )


def _classified(error: BaseException) -> tuple[ErrorCode, str]:
    if isinstance(error, LimitError):
        if error.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED:
            if error.detail == DEADLINE_DETAIL:
                return ErrorCode.TIME_LIMIT_REACHED, "the time limit of the turn was reached"
            if error.detail in (COST_LIMIT_DETAIL, TOKEN_CAP_DETAIL):
                return ErrorCode.COST_LIMIT_REACHED, "the cost limit of the turn was reached"
            return ErrorCode.RUNNER_ERROR, error.detail
        return _implementer_code(error.code), error.detail
    if isinstance(error, EngineError | JobError):
        return _implementer_code(error.code), error.detail
    if isinstance(error, IsolationError):
        return ErrorCode.SETUP_FAILED, error.detail
    return ErrorCode.RUNNER_ERROR, "the turn could not be run"


def _implementer_code(code: ErrorCode) -> ErrorCode:
    """The Dynamic codes the shared parts raise, in the Implementer's words: the engine is part of
    the runner for the app, and a model entry the proxy cannot serve is a config of the turn."""
    if code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE:
        return ErrorCode.RUNNER_ERROR
    if code is ErrorCode.DYNAMIC_CONFIG_INVALID:
        return ErrorCode.IMPLEMENTER_CONFIG_INVALID
    return code


def _not_kept(names: list[str]) -> str:
    """The sentence at the end of the summary when the agent touched the names the engine loads."""
    if not names:
        return ""
    return (
        f"[Not made: the agent created or changed {', '.join(names)}. These files are not "
        "available to the Implementer and cannot be changed in a run, so nothing of that change "
        "was kept.]"
    )


class ImplementerSession:
    """One turn. Build it with a prepared workspace; `run()` never raises for a failed turn (the
    result holds the code) and ends every process it started."""

    def __init__(
        self,
        job: ImplementerInput,
        *,
        workspace: GitWorkspace,
        command: Sequence[str],
        egress: EgressSettings,
        environment: Mapping[str, str],
        started: float | None = None,
        launch: EngineLaunch | None = None,
        ripgrep: Path | None = None,
        seams: SessionSeams = SessionSeams(),  # noqa: B008 - frozen, shared on purpose
    ) -> None:
        self.job = job
        self.workspace = workspace
        self.command = tuple(command)
        self.egress = egress
        self.environment = environment
        self.launch = launch
        self.ripgrep = ripgrep
        self.seams = seams
        self._clock = seams.clock
        self._started = self._clock() if started is None else started
        self._notes: list[str] = []
        self._summary = ""
        self._error: tuple[ErrorCode, str] | None = None
        self._session_id: str | None = None
        self._native: NativeJob | None = None
        self._pushed: PushResult | None = None

    @property
    def ledger(self) -> BudgetLedger | None:
        """The ledger of the turn (None before it was made): its limits are a fact tests pin."""
        return None if self._native is None else self._native.ledger

    # -- the limits -----------------------------------------------------------

    def _deadline_seconds(self) -> float:
        """The seconds the agent may work from now: the job's time limit less what is spent since
        the job began and less the grace kept for the end."""
        return deadline_seconds(
            self.job.implementer.limits.time_limit_seconds, self._clock() - self._started
        )

    # -- the turn -------------------------------------------------------------

    def run(self) -> TurnResult:
        agent: ImplementerAgent | None = None
        server: PassthroughServer | None = None
        ticker: PushTicker | None = None
        egress: EgressProxy | None = None
        try:
            native = self._native_job()
            self._native = native
            egress = self._start_egress()
            server = self._serve(native)
            agent = self._agent(native, server.url)
            agent.start()
            self._session_id = agent.session_id
            ticker = PushTicker(PushLoop(self.workspace), self.seams.tick_seconds)
            ticker.start()
            self._work(agent, ticker)
        except Exception as error:
            self._stopped_by(error)
        finally:
            ended = agent.stop() if agent is not None else True
            if not ended:
                self._note("the engine user's processes could not all be ended")
        try:
            self._finish(ticker)
        finally:
            if ticker is not None:
                ticker.close()
            if server is not None:
                server.stop(drain_seconds=0.0)
            if egress is not None:
                egress.stop()
        return self._result()

    def _native_job(self) -> NativeJob:
        spec = self.job.implementer
        deadline = self._deadline_seconds()
        return build_native(
            spec.model_entry,
            spec.cost,
            self.job.llm,
            deadline=deadline,
            environment=self.environment,
            upstream_for=self.seams.upstream_for,
            clock=self._clock,
            limits=lambda max_cost, reason: agent_limits(deadline, max_cost, reason),
        )

    def _start_egress(self) -> EgressProxy | None:
        """The allowlist proxy of a registries container (#763), listening before the engine's
        network is proven (the probe of `EngineLaunch.confine` reaches it). `none` starts
        nothing."""
        if self.egress.network is ImplementerNetwork.NONE:
            return None
        if self.launch is not None:
            self.launch.egress_port = self.egress.port
        starter = self.seams.start_egress or start_egress
        try:
            return starter(self.egress)
        except OSError:
            raise JobError(
                ErrorCode.SETUP_FAILED, "the egress proxy port of the slot is not free"
            ) from None

    def _serve(self, native: NativeJob) -> PassthroughServer:
        port = self.launch.proxy_port if self.launch is not None else 0
        try:
            return PassthroughServer(native.run.proxy, "127.0.0.1", port).start()
        except OSError:
            raise JobError(
                ErrorCode.SETUP_FAILED, "the model proxy port of the slot is not free"
            ) from None

    def _agent(self, native: NativeJob, proxy_url: str) -> ImplementerAgent:
        entry = native.entry
        family = WireFamily(entry.family)
        provider = native_provider_config(
            entry,
            base_url=spec_of(family).proxy_base_url(proxy_url),
            api_key=native.capability,
        )

        def make_config(instructions_path: str) -> dict[str, Any]:
            return build_engine_config(
                provider=provider,
                model_reference=native_model_reference(entry),
                family=family,
                proxy_url=proxy_url,
                capability=native.capability,
                instructions_path=instructions_path,
            )

        home = str(self.workspace.layout.agent_home)
        if self.launch is not None and self.launch.home != home:
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID,
                "the agent's home of the workspace is not the engine user's home",
            )
        options: dict[str, Any] = {}
        if self.seams.popen is not None:
            options["popen"] = self.seams.popen
        if self.seams.port_source is not None:
            options["port_source"] = self.seams.port_source
        if self.seams.startup_seconds is not None:
            options["startup_seconds"] = self.seams.startup_seconds
        scratch = self.seams.scratch_dir or (self.launch.tmpdir if self.launch else None)
        environment = implementer_environment(
            self.workspace.agent_environment(),
            home=home,
            scratch_dir=scratch or home,
            tools_dir=str(self.ripgrep.parent) if self.ripgrep is not None else None,
            egress=self.egress,
        )
        return ImplementerAgent(
            ledger=native.ledger,
            command=self.command,
            directory=str(self.workspace.repo),
            make_config=make_config,
            instructions=(INSTRUCTIONS_FILE, instructions_text(self.egress.network)),
            environment=environment,
            model=entry.model_id,
            provider_id=entry.provider_id,
            proxy_url=proxy_url,
            scratch_dir=self.seams.scratch_dir,
            launch=self.launch,
            ripgrep=self.ripgrep,
            transport=self.seams.transport,
            **options,
        )

    def _work(self, agent: ImplementerAgent, ticker: PushTicker) -> None:
        """The instruction, and the one extra message when the tree is still dirty."""
        ended = agent.turn(self.job.implementer.instruction, check=ticker.check)
        self._summary = ended.text
        self._note("the agent ended its turn")
        if not self.workspace.dirty() or not self._time_for_another_turn(agent):
            return
        self._note("the working tree is dirty: one extra message")
        again: AgentTurn = agent.turn(LEFTOVER_PROMPT, check=ticker.check)
        self._summary = self._summary or again.text

    def _time_for_another_turn(self, agent: ImplementerAgent) -> bool:
        return agent.ledger.remaining_seconds() >= MIN_EXTRA_TURN_SECONDS

    def _stopped_by(self, error: BaseException) -> None:
        native = self._native
        used = native is not None and native.ledger.model_used
        failed = None if native is None else native.run.proxy.last_upstream_error
        code, detail = classify(error, used_model=used, provider_error=failed)
        if self._error is None:
            self._error = (code, detail)
        self._note(f"the turn ended: {code.value}")

    # -- the end --------------------------------------------------------------

    def _finish(self, ticker: PushTicker | None) -> None:
        """The leftover commit and the final push, after the agent is gone. A failure here is the
        turn's error only when nothing ended the turn before."""
        try:
            if self.workspace.dirty():
                self.workspace.commit_all()
                self._note("uncommitted changes were committed by the system")
        except RepositoryUnusable as error:
            self._stopped_by(error)
        except JobError as error:
            self._stopped_by(error)
        try:
            if ticker is not None:
                self._pushed = ticker.finish()
            else:
                self._pushed = PushLoop(self.workspace).finish()
        except JobError as error:
            self._stopped_by(error)

    def _result(self) -> TurnResult:
        workspace = self.workspace
        commits: list[CommitInfo] = []
        files: list[FileChange] = []
        try:
            commits = workspace.commits_since_start()
            files = workspace.changed_files()
        except JobError:
            self._note("the commits and files of the branch could not be read")
        tip = workspace.agent_tip()
        head = tip if tip is not None and tip != workspace.start_commit else None
        pushed = head is not None and workspace.pushed_tip == head
        error = self._error
        if error is None and head is None:
            # No commit and nothing to commit: the agent did not do the task.
            error = (ErrorCode.AGENT_GAVE_UP, "the agent ended without a commit")
        elif error is None and not pushed:
            error = (ErrorCode.PUSH_REJECTED, "the work could not be pushed")
        usage = self._usage()
        touched = self._touched_engine_inputs()
        summary = clip_summary(self._summary, self._secrets(), tail=_not_kept(touched))
        return TurnResult(
            error_code=None if error is None else error[0],
            error_detail=None if error is None else error[1],
            base_commit=workspace.start_commit,
            head_commit=head,
            pushed=pushed,
            commits=tuple(commits),
            files_changed=tuple(files),
            summary=summary,
            opencode_session_id=self._session_id,
            opencode_version=PINNED_ENGINE_VERSION,
            usage=usage,
            notes=tuple(self._notes),
        )

    def _touched_engine_inputs(self) -> list[str]:
        """The names the engine loads that the agent created or changed: none of it is kept, and
        the person is told (a loss they do not hear about is a silent one)."""
        present = self.workspace.engine_inputs_present()
        if present:
            self._note("not kept, outside the sparse checkout: " + ", ".join(present))
        return present

    def _usage(self) -> Usage:
        if self._native is None:
            return Usage(None, 0, 0, 0, 0, False, None)
        return self._native.ledger.usage(self.job.llm.model)

    def _secrets(self) -> tuple[str, ...]:
        capability = () if self._native is None else (self._native.capability,)
        return (*self.job.secrets, *capability)

    def _note(self, text: str) -> None:
        self._notes.append(text)
