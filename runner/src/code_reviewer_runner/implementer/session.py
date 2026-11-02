# SPDX-License-Identifier: LicenseRef-Proprietary

"""One Implementer turn from the instruction to the result (#764).

The prepared workspace (`git_workspace.py`, #762) and the egress setting (#763) come in; the model
proxy, the engine and the agent's session are started here, and everything is ended here. The flow:

1. The ledger and the passthrough proxy are made from the job's model entry and cost policy, as for
   a native Dynamic job (`native_job.build_native`); the clock of the ledger is the job's time limit
   less the grace kept for the end (`GRACE_SECONDS`).
2. The engine starts as the engine user in `/work/repo`, with the generated configuration and the
   closed environment. Nothing is pushed while it works: the agent may rewrite history, and the
   one push is at the end (a VM that dies mid-turn loses the work).
3. The instruction is sent as the one user message. When the turn ends, a working tree that is
   still dirty gets **one** more message in the same session (a fixed text); what is dirty after
   that is committed by the system as the engine user, without a model call.
4. Whatever ended the turn (the agent, the cost limit, the clock, a crash of the engine, a stop),
   the engine and everything of its user are ended first, the leftover is committed (not on a stop
   or a lost lease), and **all local branches of the agent's repository are pushed**
   (`GitWorkspace.push_all`; never after a lost lease). The result reports each branch with its
   outcome, and the commits and files of the form's branch, with the stable code of what ended the
   turn.

Nothing steers the agent: the cost limit (the proxy refuses the next call) and the clock are the
only brakes.
"""

import logging
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from code_reviewer_runner.dynamic_review.adapter import (
    PINNED_ENGINE_VERSION,
    EngineError,
    Transport,
    _http_request,  # pyright: ignore[reportPrivateUsage]
)
from code_reviewer_runner.dynamic_review.budget import (
    BudgetLedger,
    LimitError,
)
from code_reviewer_runner.dynamic_review.config import new_proxy_capability
from code_reviewer_runner.dynamic_review.engine_user import EngineLaunch
from code_reviewer_runner.dynamic_review.job_model_entry import (
    JobModelEntry,
    native_model_reference,
    native_provider_config,
)
from code_reviewer_runner.dynamic_review.model_door_route import (
    MODEL_DOOR_ADDRESS,
    MODEL_DOOR_MODE,
    MODEL_DOOR_VARIABLE,
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
from .door_launcher import DoorSeams, RunningDoor, start_door
from .door_model import build_door_ledger
from .egress_config import EgressSettings, start_egress
from .egress_proxy import EgressProxy
from .git_workspace import (
    CONFIRM_PAUSE_SECONDS,
    CONFIRM_SECONDS,
    LIST_TOO_LARGE,
    GitWorkspace,
    PushReport,
)
from .history import CommitInfo, FileChange

# The bounds are named here too: the tests and the model door read them from this module.
from .limits import MAX_AGENT_REQUEST_BYTES as MAX_AGENT_REQUEST_BYTES
from .limits import MAX_RETURNED_BYTES as MAX_RETURNED_BYTES
from .limits import MAX_TOOL_RESULT_BYTES as MAX_TOOL_RESULT_BYTES
from .limits import agent_limits
from .prompts import LEFTOVER_PROMPT, instructions_text
from .turn_result import TurnResult, clip_summary

_log = logging.getLogger(__name__)

# What is kept back from the job's time limit for the end of the turn: the commit of what is left
# and the final push (the plan: the last three minutes). A short limit keeps a third of it.
GRACE_SECONDS = 180.0
# How the grace is spent at a normal end: the rescue of a detached HEAD (three git commands of
# `RESCUE_STEP_TIMEOUT`), the look at the tree (`DIRTY_TIMEOUT`), the leftover commit of the system,
# the final push and the two reads of the report (`REPORT_READ_TIMEOUT` each), with
# `ENGINE_STOP_SECONDS` for the end of the engine before them; the sum stays below `GRACE_SECONDS`
# (a test holds it).
LEFTOVER_SECONDS = 40.0
FINAL_PUSH_SECONDS = 100.0
ENGINE_STOP_SECONDS = 5.0
# A stop (SIGTERM) leaves the process `SIGTERM_BACKSTOP_SECONDS` in all (`job_run.py`): the engine
# comes out of it, then the rescue of a detached HEAD, the final push (no leftover is committed) and
# the two reads of the report.
STOP_PUSH_SECONDS = 30.0
# How often the watch asks the job host whether the job is still ours while the agent works (a
# lost lease ends the turn at once; nothing is pushed in the meantime).
LEASE_POLL_SECONDS = 30.0
# The extra message for a dirty tree is only worth sending when this much of the clock is left.
MIN_EXTRA_TURN_SECONDS = 20.0
# The name of the instruction file the runner writes for the engine.
INSTRUCTIONS_FILE = "implementer-instructions.md"

# The words of the ledger's refusals (`budget.py`). A test pins them against the ledger, so a
# change of its wording makes that test red instead of silently changing a code.
DEADLINE_DETAIL = "the whole-job deadline was reached"
COST_LIMIT_DETAIL = "the cost limit is used up"
TOKEN_CAP_DETAIL = "the token cap is used up"


def deadline_seconds(time_limit: float, elapsed: float) -> float:
    """The seconds the agent may work, counted from now: the job's time limit less what is spent
    since the job began and less the grace kept for the leftover commit and the final push (three
    minutes; a third of a short limit)."""
    return time_limit - min(GRACE_SECONDS, time_limit / 3) - elapsed


@dataclass(frozen=True)
class SessionSeams:
    """What the tests of the session replace; production leaves the defaults."""

    upstream_for: UpstreamFactory = HttpsUpstream
    popen: Any = None
    transport: Transport = _http_request
    port_source: Callable[[], int] | None = None
    # How long, and how often, the final push asks a lease the host cannot confirm (a stop uses at
    # most `STOP_CONFIRM_SECONDS` of it).
    confirm_seconds: float = CONFIRM_SECONDS
    confirm_pause: float = CONFIRM_PAUSE_SECONDS
    # The seconds the final push may take at a normal end and at a stop.
    final_push_seconds: float = FINAL_PUSH_SECONDS
    stop_push_seconds: float = STOP_PUSH_SECONDS
    leftover_seconds: float = LEFTOVER_SECONDS
    lease_poll_seconds: float = LEASE_POLL_SECONDS
    startup_seconds: float | None = None
    scratch_dir: str | None = None
    clock: Callable[[], float] = time.monotonic
    # Starts the egress proxy of a registries container (default `egress_config.start_egress`).
    start_egress: Callable[[EgressSettings], EgressProxy | None] | None = None
    # How the model door is started and what it talks to (#745, step 3); the defaults are the VM's
    # Docker. A test brings a daemon of its own.
    door: DoorSeams = field(default_factory=DoorSeams)


# How long the last push of a stop asks a lease the host cannot confirm: a stop has a minute in
# all (`IMPLEMENTER_TERMINATE_GRACE_SECONDS`), and the engine and the push come out of it.
STOP_CONFIRM_SECONDS = 20.0

# The ends after which nothing is committed any more and nothing may be pushed that was not already
# committed: the job is not ours, or the runner is going away within seconds.
_NO_LEFTOVER = frozenset({ErrorCode.LEASE_LOST, ErrorCode.RUNNER_SHUTDOWN})


@dataclass
class TurnModel:
    """What a turn reaches the model through: the model entry, the ledger of the turn, the bearer
    the agent presents and where it presents it. The proxy is in this process (`door` is None, the
    Worker's own, as before step 3) or in a container of its own (the model door, #745)."""

    entry: JobModelEntry
    ledger: BudgetLedger
    capability: str
    url: str
    door: RunningDoor | None = None
    native: NativeJob | None = None
    server: PassthroughServer | None = None

    def upstream_error(self) -> ErrorCode | None:
        """The code of the provider's last failed call, as the proxy that made the call kept it."""
        if self.door is not None:
            return self.door.state.upstream_error
        return None if self.native is None else self.native.run.proxy.last_upstream_error

    def stop(self) -> None:
        if self.door is not None:
            self.door.stop()
        if self.server is not None:
            self.server.stop(drain_seconds=0.0)
            self.server = None


class ShutdownRequested(JobError):
    """The runner was told to stop (SIGTERM, #765). What is committed is pushed first; the job
    host gives the job back under this code."""

    def __init__(self) -> None:
        super().__init__(ErrorCode.RUNNER_SHUTDOWN, "the runner was told to stop")


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
    if code is ErrorCode.SETUP_FAILED and used_model:
        # Whatever is wrong with the set-up after the agent ran, the model budget is spent: the
        # charged class, never the free one a turn that never started has.
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


def _not_kept(
    names: list[str], leftover_lost: bool, rescued: str | None = None, unchecked: bool = False
) -> str:
    """The sentences at the end of the summary about what of the agent's work was not kept: the
    names the engine loads that it touched, and changes in the working tree that could not be
    committed."""
    parts: list[str] = []
    if names:
        parts.append(
            f"[Not made: the agent created or changed {', '.join(names)}. These files are not "
            "available to the Implementer and cannot be changed in a run, so nothing of that "
            "change was kept.]"
        )
    if rescued is not None:
        parts.append(
            "[Saved: work that was committed on no branch (a detached HEAD) is on the branch "
            f"{rescued}.]"
        )
    if unchecked:
        parts.append(
            "[Not checked: a process of the agent could not be ended, so changes in the working "
            "tree "
            "that were not committed were not looked for.]"
        )
    if leftover_lost:
        parts.append(
            "[Not kept: changes in the working tree were not committed and could not be "
            "committed by the system, so they are not on any branch.]"
        )
    return "\n".join(parts)


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
        should_stop: Callable[[], bool] = lambda: False,
        max_seconds: float | None = None,
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
        # True once the runner was told to stop (SIGTERM): the watch ends the turn at once.
        self._should_stop = should_stop
        # The hard timeout of the process: the turn is never given more (`_deadline_seconds`).
        self._max_seconds = max_seconds
        self._notes: list[str] = []
        self._summary = ""
        self._error: tuple[ErrorCode, str] | None = None
        self._session_id: str | None = None
        self._model: TurnModel | None = None
        self._leftover_lost = False
        # False when the sweep after the engine could not end every process of the engine user: then
        # nothing is run as that user for the leftover (a survivor could be racing the tree).
        self._engine_ended = True
        # The branch made for work committed on a detached HEAD, if there was such work.
        self._rescued: str | None = None
        self._unchecked = False

    @property
    def ledger(self) -> BudgetLedger | None:
        """The ledger of the turn (None before it was made): its limits are a fact tests pin."""
        return None if self._model is None else self._model.ledger

    # -- the limits -----------------------------------------------------------

    def _deadline_seconds(self) -> float:
        """The seconds the agent may work from now: the job's time limit less what is spent since
        the job began and less the grace kept for the end."""
        limit = float(self.job.implementer.limits.time_limit_seconds)
        if self._max_seconds is not None:
            limit = min(limit, self._max_seconds)
        return deadline_seconds(limit, self._clock() - self._started)

    # -- the turn -------------------------------------------------------------

    def run(self) -> TurnResult:
        agent: ImplementerAgent | None = None
        model: TurnModel | None = None
        egress: EgressProxy | None = None
        try:
            model = self._start_model()
            egress = self._start_egress()
            agent = self._agent(model)
            agent.start()
            self._session_id = agent.session_id
            self._work(agent)
        except Exception as error:
            self._stopped_by(error)
        finally:
            ended = agent.stop(quick=self._ends_quickly()) if agent is not None else True
            self._engine_ended = ended
            if not ended:
                self._note("the engine user's processes could not all be ended")
            if model is not None and model.door is not None:
                # No call can come any more: the door says its last word, the cost is final.
                model.stop()
        try:
            self._finish()
        finally:
            if model is not None:
                model.stop()
            if egress is not None:
                egress.stop()
        return self._result()

    def _door_wanted(self) -> bool:
        """The container may start a model door (the Dispatcher says so with the VM's Docker socket
        and `RUNNER_IMPLEMENTER_MODEL_DOOR`); otherwise the proxy runs in this process."""
        return self.environment.get(MODEL_DOOR_VARIABLE, "").strip() == MODEL_DOOR_MODE

    def _start_model(self) -> TurnModel:
        spec = self.job.implementer
        deadline = self._deadline_seconds()
        if self._door_wanted():
            return self._start_door(deadline)
        native = build_native(
            spec.model_entry,
            spec.cost,
            self.job.llm,
            deadline=deadline,
            environment=self.environment,
            upstream_for=self.seams.upstream_for,
            clock=self._clock,
            limits=lambda max_cost, reason: agent_limits(deadline, max_cost, reason),
        )
        model = TurnModel(spec.model_entry, native.ledger, native.capability, "", native=native)
        self._model = model
        model.url, model.server = self._serve(native)
        return model

    def _start_door(self, deadline: float) -> TurnModel:
        """The model door (#745, step 3): the key, the model pin and the cost limit go to a
        container of its own, and this process keeps a ledger that reads what the door counts."""
        spec = self.job.implementer
        access = self.job.model_access
        if access is None:
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID, "the job has no model access to hand over"
            )
        ledger = build_door_ledger(
            spec.model_entry,
            spec.cost,
            self.job.llm,
            deadline=deadline,
            environment=self.environment,
            clock=self._clock,
        )
        capability = new_proxy_capability()
        model = TurnModel(spec.model_entry, ledger, capability, "")
        self._model = model
        port = self.launch.proxy_port if self.launch is not None else 10180
        running = start_door(
            model_access=access,
            capability=capability,
            deadline_seconds=self._deadline_seconds(),
            port=port,
            environment={
                name: value
                for name, value in self.environment.items()
                if name == "RUNNER_DYNAMIC_MAX_COST_USD"
            },
            seams=self.seams.door,
        )
        ledger.attach(running.state)
        model.door, model.url = running, running.url
        return model

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

    def _serve(self, native: NativeJob) -> tuple[str, PassthroughServer]:
        port = self.launch.proxy_port if self.launch is not None else 0
        try:
            server = PassthroughServer(native.run.proxy, "127.0.0.1", port).start()
            return server.url, server
        except OSError:
            raise JobError(
                ErrorCode.SETUP_FAILED, "the model proxy port of the slot is not free"
            ) from None

    def _agent(self, model: TurnModel) -> ImplementerAgent:
        entry, proxy_url = model.entry, model.url
        door_host = MODEL_DOOR_ADDRESS if model.door is not None else None
        family = WireFamily(entry.family)
        provider = native_provider_config(
            entry,
            base_url=spec_of(family).proxy_base_url(proxy_url),
            api_key=model.capability,
            door_host=door_host,
        )

        def make_config(instructions_path: str) -> dict[str, Any]:
            return build_engine_config(
                provider=provider,
                model_reference=native_model_reference(entry),
                family=family,
                proxy_url=proxy_url,
                capability=model.capability,
                instructions_path=instructions_path,
                door_host=door_host,
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
            ledger=model.ledger,
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

    def _ends_quickly(self) -> bool:
        """Whether this end has seconds to spare, not minutes: the runner was told to stop, or the
        job is not ours any more."""
        return self._error is not None and self._error[0] in _NO_LEFTOVER

    def _watch(self) -> Callable[[], None]:
        last = time.monotonic()

        def check() -> None:
            nonlocal last
            if self._should_stop():
                raise ShutdownRequested
            now = time.monotonic()
            if now - last >= self.seams.lease_poll_seconds:
                last = now
                self.workspace.check_lease()

        return check

    def _work(self, agent: ImplementerAgent) -> None:
        """The instruction, and the one extra message when the tree is still dirty."""
        check = self._watch()
        ended = agent.turn(self.job.implementer.instruction, check=check)
        self._summary = ended.text
        self._note("the agent ended its turn")
        if not self.workspace.dirty() or not self._time_for_another_turn(agent):
            return
        self._note("the working tree is dirty: one extra message")
        again: AgentTurn = agent.turn(LEFTOVER_PROMPT, check=check)
        self._summary = self._summary or again.text

    def _time_for_another_turn(self, agent: ImplementerAgent) -> bool:
        return agent.ledger.remaining_seconds() >= MIN_EXTRA_TURN_SECONDS

    def _stopped_by(self, error: BaseException) -> None:
        model = self._model
        used = model is not None and model.ledger.model_used
        failed = None if model is None else model.upstream_error()
        code, detail = classify(error, used_model=used, provider_error=failed)
        if self._error is None:
            self._error = (code, detail)
        self._note(f"the turn ended: {code.value}")

    # -- the end --------------------------------------------------------------

    def _finish(self) -> None:
        """The leftover commit and the final push of all local branches, after the agent is gone.
        A failure of the push is the turn's error only when nothing ended the turn before; a
        leftover that cannot be committed is a note (the branches that are committed are pushed
        all the same)."""
        quick = self._ends_quickly()
        if not self._engine_ended:
            self._unchecked = True
            self._note("nothing was committed or rescued: a process of the engine user is left")
        else:
            try:
                self._rescued = self.workspace.rescue_detached_head()
                if self._rescued is not None:
                    self._note(f"work on a detached HEAD was saved on the branch {self._rescued}")
            except Exception:
                self._note("work on a detached HEAD could not be saved on a branch")
            try:
                if not quick and self.workspace.dirty():
                    self.workspace.commit_all(seconds=self.seams.leftover_seconds)
                    self._note("uncommitted changes were committed by the system")
            except Exception:
                self._leftover_lost = True
                self._note("uncommitted changes could not be committed")
        try:
            seconds = self.seams.stop_push_seconds if quick else self.seams.final_push_seconds
            window = (
                min(STOP_CONFIRM_SECONDS, self.seams.confirm_seconds)
                if quick
                else self.seams.confirm_seconds
            )
            self.workspace.push_all(
                seconds=seconds, confirm_seconds=window, confirm_pause=self.seams.confirm_pause
            )
        except Exception as error:
            self._stopped_by(error)
        self._note_branches(self.workspace.push_report())

    def _note_branches(self, report: PushReport) -> None:
        for branch in report.branches:
            outcome = "pushed" if branch.pushed else f"rejected ({branch.reason})"
            self._note(f"branch {branch.name}: {outcome}")
        if not report.listed:
            if report.list_problem == LIST_TOO_LARGE:
                self._note(
                    "the list of local branches of the agent's repository is too long to read"
                )
            else:
                self._note("the local branches of the agent's repository could not be read")
        if report.sweeps_failed:
            self._note(
                f"{report.sweeps_failed} pushes were made while a process of the engine user "
                "was left"
            )
        if report.invalid:
            self._note(f"{report.invalid} local branches have names that are not pushed")
        if report.overflow:
            self._note(f"{report.overflow} further branches were not pushed (limit)")

    def _result(self) -> TurnResult:
        workspace = self.workspace
        report = workspace.push_report()
        commits: list[CommitInfo] = workspace.commits_since_start()
        files: list[FileChange] = workspace.changed_files()
        head = report.form_head
        form = next((b for b in report.branches if b.name == self.job.implementer.branch), None)
        pushed = form is not None and form.pushed
        error = self._error
        if error is None and not report.listed:
            error = (
                ErrorCode.PUSH_REJECTED,
                "the repository of the agent could not be read"
                + (
                    ": its list of branches is too long"
                    if report.list_problem == LIST_TOO_LARGE
                    else ""
                )
                + ", so nothing was pushed",
            )
        elif error is None and not report.branches:
            # No commit and nothing to commit, on no branch: the agent did not do the task.
            error = (ErrorCode.AGENT_GAVE_UP, "the agent ended without a commit")
        elif error is None and (
            not report.pushed_any
            or (form is not None and not form.pushed)
            or (form is None and not report.form_listed)
        ):
            # The task's branch has an entry only when it has work or could not be looked at (one
            # that is verifiably empty, at the base commit, has none): an entry that was not pushed
            # is work that did not arrive, and a branch that is gone is not verifiably empty. Not a
            # success, whatever else was pushed.
            error = (ErrorCode.PUSH_REJECTED, "the work could not be pushed")
        usage = self._usage()
        touched = self._touched_engine_inputs()
        summary = clip_summary(
            self._summary,
            self.secrets(),
            tail=_not_kept(touched, self._leftover_lost, self._rescued, self._unchecked),
        )
        return TurnResult(
            error_code=None if error is None else error[0],
            error_detail=None if error is None else error[1],
            base_commit=workspace.start_commit,
            head_commit=head,
            pushed=pushed,
            branches=report.branches,
            branches_dropped=(report.invalid, report.overflow),
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
        if self._model is None:
            return Usage(None, 0, 0, 0, 0, False, None)
        return self._model.ledger.usage(self.job.llm.model)

    def secrets(self) -> tuple[str, ...]:
        capability = () if self._model is None else (self._model.capability,)
        return (*self.job.secrets, *capability)

    def _note(self, text: str) -> None:
        self._notes.append(text)
