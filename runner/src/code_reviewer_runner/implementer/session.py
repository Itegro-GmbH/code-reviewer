# SPDX-License-Identifier: LicenseRef-Proprietary

"""One Implementer turn from the instruction to the result (#764).

The prepared workspace (`git_workspace.py`, #762) comes in; the model door, the agent's container
and the engine are started here, and everything is ended here. The flow:

1. The **model door** starts (`door_launcher.py`): the key, the model pin and the cost limit are in
   a container of their own. The ledger here reads what the door counts (`door_model.py`); the
   clock of the ledger is the job's time limit less the grace kept for the end (`GRACE_SECONDS`).
2. The **agent's container** starts (`agent_container.py`, #745 step 4): OpenCode as root, with its
   own Docker, on the network whose only other member is the door. Control starts the engine in it
   and drives it only outward, through the Docker daemon. Nothing is pushed while it works: the
   agent may rewrite history, and the one push is at the end (a VM that dies mid-turn loses the
   work).
3. The instruction is sent as the one user message. When the turn ends, a working tree that is
   still dirty gets **one** more message in the same session (a fixed text); what is dirty after
   that is committed by the system in the reader, without a model call.
4. Whatever ended the turn (the agent, the cost limit, the clock, a crash or the memory kill of the
   agent's container, a stop), the agent's container is killed first (everything in it is gone),
   the leftover is committed (not on a stop or a lost lease), and **all local branches of the
   agent's repository are pushed** (`GitWorkspace.push_all`; never after a lost lease). The result
   reports each branch with its outcome, and the commits and files of the form's branch, with the
   stable code of what ended the turn.

Nothing steers the agent: the cost limit (the door refuses the next call) and the clock are the
only brakes.
"""

import contextlib
import logging
import threading
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol, cast

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
from code_reviewer_runner.dynamic_review.job_model_entry import (
    JobModelEntry,
    native_model_reference,
    native_provider_config,
)
from code_reviewer_runner.dynamic_review.model_door_route import MODEL_DOOR_ADDRESS
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.static_isolation import slot_ports
from code_reviewer_runner.job import (
    ImplementerInput,
    JobError,
)
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import COST_BASIS_SUBSCRIPTION, ErrorCode, Usage
from code_reviewer_runner.resume_wire import ResumeReason

from . import finish_tool
from .agent import AgentTurn, EngineRuntime, ImplementerAgent, ResumeOutcome
from .agent_container import (
    AGENT_HOME,
    AGENT_REPO,
    AGENT_TMP,
    ENGINE_PORT,
    KILL_SECONDS,
    STOP_SECONDS,
    SYSTEM_ROOTS_PATH,
    TRUST_BUNDLE_NAME,
    TRUST_CA_NAME,
)
from .claude_code.agent import ClaudeCodeAgent
from .claude_code.gates import ANTHROPIC_HOST, subscription_rule
from .claude_code.login import ClaudeLogin
from .config import build_engine_config, implementer_environment
from .door_launcher import DoorSeams, RunningDoor, start_door
from .door_model import build_door_ledger
from .environment_control import (
    NARROW_SECONDS,
    Connect,
    control_from_environment,
    vsock_connect,
)
from .git_workspace import (
    CONFIRM_PAUSE_SECONDS,
    CONFIRM_SECONDS,
    LIST_TOO_LARGE,
    REASON_LOGIN_SECRET,
    REASON_OUT_OF_SPACE,
    REASON_UNCHECKED,
    BranchPush,
    GitWorkspace,
    PushReport,
)
from .history import CommitInfo, FileChange

# The bounds are named here too: the tests and the model door read them from this module.
from .limits import MAX_AGENT_REQUEST_BYTES as MAX_AGENT_REQUEST_BYTES
from .limits import MAX_RETURNED_BYTES as MAX_RETURNED_BYTES
from .limits import MAX_TOOL_RESULT_BYTES as MAX_TOOL_RESULT_BYTES
from .netdoor.registries import rule_has_registries
from .netdoor_launcher import NetDoorSeams, RunningNetDoor, start_network_door
from .network_report import (
    VM_POLICY_NARROWED,
    VM_POLICY_NOT_CONFIGURED,
    VM_POLICY_UNCHANGED,
    network_report,
)
from .network_rule import MODE_OFF, MODE_OPEN, OFF, NetworkRule
from .network_switch import Post, model_host_of, urllib_post
from .preface import MovedBranch, PrefaceFacts, ResumeMode, first_turn_parts, message_parts
from .prompts import LEFTOVER_PROMPT, RESULT_REMINDER_PROMPT, instructions_text
from .reader import RESET_SECONDS as READER_RESET_SECONDS
from .report import agent_ask_ok, agent_result_ok
from .result_channel import (
    CONFIG_DIRECTORY,
    ResultReader,
    finish_files,
    finish_server_command,
    redacted_value,
)
from .resume_session import ResumeInput
from .session_export import ExportFailed
from .snapshot_pump import SnapshotPump
from .step_pump import FLUSH_SECONDS as STEPS_FLUSH_SECONDS
from .step_pump import STOP_FLUSH_SECONDS as STOP_STEPS_FLUSH_SECONDS
from .step_pump import StepPump
from .turn_result import TurnResult, clip_summary

_log = logging.getLogger(__name__)

# What is kept back from the job's time limit for the end of the turn: the commit of what is left
# and the final push (the plan: the last three minutes; four and a half since the readers are made
# quiet twice and the container's end got its measured ceilings). A short limit keeps a third of it.
GRACE_SECONDS = 270.0
# How the grace is spent at a normal end, every step at its ceiling: the export of the engine's
# session for a follow-up turn (`SNAPSHOT_SECONDS`, #839: before the container is killed, because it
# is read from the running engine; the fetch, the redaction, the gzip and the hand-over to the job
# host, all inside the budget), the end of the agent's container (`ENGINE_STOP_SECONDS`: the kill
# call and the wait until the daemon says it is gone; its removal comes after the push, `remove()`,
# and is in no sum), the first reset of the readers
# (`READER_RESET_SECONDS`), the rescue of a detached HEAD (three git commands of
# `RESCUE_STEP_TIMEOUT`), the look at the tree (`DIRTY_TIMEOUT`), the leftover commit of the system,
# the second reset of the readers (the commit ran the repository's filters in a reader that can
# write), the final push, the two reads of the report (`REPORT_READ_TIMEOUT` each) and the last
# flush of the live view (`STEPS_FLUSH_SECONDS`, #745: after the push, before the result, bounded in
# all of its parts). The sum is 227 s of the 270, 229.5 s with the read of the agent's result
# (`RESULT_READ_SECONDS`, #843); a test holds it, and holds the slack. The upload
# of the snapshot to the app is not in the sum: the job host does it beside the push and before the
# result is delivered (`job_loop/snapshot_sender.py`).
SNAPSHOT_SECONDS = 5.0
STOP_SNAPSHOT_SECONDS = 2.0
LEFTOVER_SECONDS = 40.0
FINAL_PUSH_SECONDS = 100.0
ENGINE_STOP_SECONDS = KILL_SECONDS + STOP_SECONDS
# A stop (SIGTERM) leaves the process `SIGTERM_BACKSTOP_SECONDS` in all (`job_run.py`): the engine
# comes out of it, then the reset of the readers, the rescue of a detached HEAD, the final push (no
# leftover is committed, so no second reset), the two reads of the report and the shorter last
# flush of the live view (`STOP_STEPS_FLUSH_SECONDS`), and the shorter export of the session
# (`STOP_SNAPSHOT_SECONDS`): 86 s of the 115.
STOP_PUSH_SECONDS = 25.0
# How often the watch asks the job host whether the job is still ours while the agent works (a
# lost lease ends the turn at once; nothing is pushed in the meantime).
LEASE_POLL_SECONDS = 30.0
# Below this much free space on the VM's disk at the end, the outcome says so.
LOW_DISK_BYTES = 1024 * 1024 * 1024
# The extra message for a dirty tree is only worth sending when this much of the clock is left.
MIN_EXTRA_TURN_SECONDS = 20.0
# The name of the instruction file the runner writes for the engine.
INSTRUCTIONS_FILE = "implementer-instructions.md"

# The words of the ledger's refusals (`budget.py`). A test pins them against the ledger, so a
# change of its wording makes that test red instead of silently changing a code.
DEADLINE_DETAIL = "the whole-job deadline was reached"
COST_LIMIT_DETAIL = "the cost limit is used up"
TOKEN_CAP_DETAIL = "the token cap is used up"
# #840: a follow-up turn that imported a long conversation can be refused by the model door before
# any call reaches the provider: the door reserves the cost of a call first, and the history alone
# (the first call reads all of it again) is more than the limit (measured: 18.4 MB at 5 USD). The
# code is the same as for any cost limit; the sentence says why this one came before any work.
HISTORY_OVER_LIMIT_DETAIL = (
    "the cost limit of the turn was reached before the first model call: the imported conversation "
    "of the earlier turns alone costs more than the limit, because the first call reads all of it "
    "again"
)


def deadline_seconds(time_limit: float, elapsed: float) -> float:
    """The seconds the agent may work, counted from now: the job's time limit less what is spent
    since the job began and less the grace kept for the leftover commit and the final push (three
    minutes; a third of a short limit)."""
    return time_limit - min(GRACE_SECONDS, time_limit / 3) - elapsed


@dataclass(frozen=True)
class SessionSeams:
    """What the tests of the session replace; production leaves the defaults."""

    transport: Transport = _http_request
    # How long, and how often, the final push asks a lease the host cannot confirm (a stop uses at
    # most `STOP_CONFIRM_SECONDS` of it).
    confirm_seconds: float = CONFIRM_SECONDS
    confirm_pause: float = CONFIRM_PAUSE_SECONDS
    # The seconds the final push may take at a normal end and at a stop.
    final_push_seconds: float = FINAL_PUSH_SECONDS
    stop_push_seconds: float = STOP_PUSH_SECONDS
    leftover_seconds: float = LEFTOVER_SECONDS
    reader_reset_seconds: float = READER_RESET_SECONDS
    lease_poll_seconds: float = LEASE_POLL_SECONDS
    # The last flush of the live view (#745), at a normal end and at a stop.
    steps_flush_seconds: float = STEPS_FLUSH_SECONDS
    stop_steps_flush_seconds: float = STOP_STEPS_FLUSH_SECONDS
    # The export of the engine's session (#839), at a normal end and at a stop.
    snapshot_seconds: float = SNAPSHOT_SECONDS
    stop_snapshot_seconds: float = STOP_SNAPSHOT_SECONDS
    startup_seconds: float | None = None
    clock: Callable[[], float] = time.monotonic
    # How the model door is started and what it talks to (#745, step 3); the defaults are the VM's
    # Docker. A test brings a daemon of its own.
    door: DoorSeams = field(default_factory=DoorSeams)
    # The network door and the call that narrows the VM's network policy (#745, step 7).
    netdoor: NetDoorSeams = field(default_factory=NetDoorSeams)
    switch_post: Post = urllib_post
    switch_pause_seconds: float = 2.0
    # The connection of the vsock environment control (#975); a test brings a socket of its own.
    control_connect: Connect = vsock_connect
    control_narrow_seconds: float = NARROW_SECONDS
    # The system's root certificates, which the agent's trust bundle (#784) starts with: this
    # container has the agent's image's roots (the same Debian bundle); a test brings its own.
    system_roots: Callable[[], bytes] = lambda: Path(SYSTEM_ROOTS_PATH).read_bytes()


class AgentPlace(EngineRuntime, Protocol):
    """The agent's container: made before the engine starts, killed with everything in it (`stop`)
    and taken away after the push (`remove`)."""

    def create(self) -> tuple[str, ...]:
        """Make the container; the notes for the report (a check that did not hold)."""
        ...

    def remove(self) -> None: ...


# How long the last push of a stop asks a lease the host cannot confirm: a stop has two minutes
# in all (`IMPLEMENTER_TERMINATE_GRACE_SECONDS`), and the engine and the push come out of it.
STOP_CONFIRM_SECONDS = 20.0

# The ends after which nothing is committed any more and nothing may be pushed that was not already
# committed: the job is not ours, or the runner is going away within seconds.
_NO_LEFTOVER = frozenset({ErrorCode.LEASE_LOST, ErrorCode.RUNNER_SHUTDOWN})


@dataclass
class TurnModel:
    """What a turn reaches the model through: the model entry, the ledger of the turn (which reads
    what the door counts), the bearer the agent presents and where it presents it."""

    entry: JobModelEntry
    ledger: BudgetLedger
    capability: str
    url: str
    door: RunningDoor | None = None

    def upstream_error(self) -> ErrorCode | None:
        """The code of the provider's last failed call, as the door's proxy kept it."""
        return None if self.door is None else self.door.state.upstream_error

    def stop(self) -> None:
        if self.door is not None:
            self.door.stop()


def forget_model_access(access: dict[str, Any]) -> None:
    """Empty the dict the model door was handed (`ImplementerInput.model_access`). It shares its
    `llm` section with the parsed job document, which is emptied with it. What this cannot reach:
    `job.llm.api_key`, kept on purpose so that the key is scrubbed from every output of the turn,
    the text the job was read from, and the interpreter's memory (strings are not wiped)."""
    llm = access.get("llm")
    if isinstance(llm, dict):
        cast("dict[str, Any]", llm).clear()
    access.clear()


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
    return ErrorCode.RUNNER_ERROR, "the turn could not be run"


def _implementer_code(code: ErrorCode) -> ErrorCode:
    """The Dynamic codes the shared parts raise, in the Implementer's words: the engine is part of
    the runner for the app, and a model entry the proxy cannot serve is a config of the turn."""
    if code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE:
        return ErrorCode.RUNNER_ERROR
    if code is ErrorCode.DYNAMIC_CONFIG_INVALID:
        return ErrorCode.IMPLEMENTER_CONFIG_INVALID
    return code


def _push_failure(form: BranchPush | None) -> str:
    """The sentence for a task branch that did not arrive. A branch the push guard stopped (#856)
    says so, in words: the device's login was found in it, or it could not be read to its end."""
    if form is not None and form.reason == REASON_LOGIN_SECRET:
        return "the work holds the login of this device (login_secret) and was not pushed"
    if form is not None and form.reason == REASON_UNCHECKED:
        return (
            "the work could not be checked for the login of this device (unchecked), "
            "so it was not pushed"
        )
    return "the work could not be pushed"


def _not_kept(leftover_lost: bool, rescued: str | None = None, unchecked: bool = False) -> str:
    """The sentences at the end of the summary about what of the agent's work was not kept: work
    saved from a detached HEAD, and changes in the working tree that could not be committed."""
    parts: list[str] = []
    if rescued is not None:
        parts.append(
            "[Saved: work that was committed on no branch (a detached HEAD) is on the branch "
            f"{rescued}.]"
        )
    if unchecked:
        parts.append(
            "[Not checked: the agent's container could not be confirmed gone, so changes in the "
            "working tree that were not committed were not looked for.]"
        )
    if leftover_lost:
        parts.append(
            "[Not kept: changes in the working tree were not committed and could not be "
            "committed by the system, so they are not on any branch.]"
        )
    return "\n".join(parts)


class ImplementerSession:
    """One turn. Build it with a prepared workspace; `run()` never raises for a failed turn (the
    result holds the code) and ends everything it started."""

    def __init__(
        self,
        job: ImplementerInput,
        *,
        workspace: GitWorkspace,
        command: Sequence[str],
        place: Callable[[], AgentPlace],
        environment: Mapping[str, str],
        started: float | None = None,
        seams: SessionSeams = SessionSeams(),  # noqa: B008 - frozen, shared on purpose
        should_stop: Callable[[], bool] = lambda: False,
        max_seconds: float | None = None,
        steps: StepPump | None = None,
        results: ResultReader | None = None,
        snapshot: SnapshotPump | None = None,
        resume: ResumeInput | None = None,
        login: ClaudeLogin | None = None,
    ) -> None:
        self.job = job
        # #856: a turn on the harness claude-code has no model door and no ledger; it runs on the
        # login of the device, which the job host read from the device's file (`login`).
        self._subscription = job.implementer.subscription
        self._login = login
        self._claude: ClaudeCodeAgent | None = None
        # #843: the profile version the turn started with. A turn without one pushes, as before.
        profile = job.implementer.profile
        self._can_push = profile is None or profile.can_push
        self._profile_instructions = "" if profile is None else profile.instructions
        # #843: the result schema of the turn (None: no finish tool, the turn is what it was before
        # result schemas), where the result file is read, and what was read from it.
        self._schema = job.implementer.result_schema
        self._results = results
        self._agent_result: dict[str, Any] | None = None
        self._result_problem = "no result file"
        # #920: whether the turn may end with a question, and the question it ended with.
        self._can_ask = (
            self._schema is not None
            and job.implementer.can_ask
            and finish_tool.ask_possible(self._schema, enabled=True)
        )
        self._agent_ask: dict[str, Any] | None = None
        self.workspace = workspace
        self.command = tuple(command)
        self._place_factory = place
        self.environment = environment
        self.seams = seams
        self._clock = seams.clock
        self._started = self._clock() if started is None else started
        # True once the runner was told to stop (SIGTERM): the watch ends the turn at once.
        self._should_stop = should_stop
        # The hard timeout of the process: the turn is never given more (`_deadline_seconds`).
        self._max_seconds = max_seconds
        # The channel the step records of the turn leave over (#745): None records nothing.
        self._steps = steps
        # The channel the engine's session leaves over at the end (#839): None takes no export.
        self._snapshot = snapshot
        # #840: the stored conversation of a follow-up turn (or the reason there is none), and how
        # the engine got it once it started. A follow-up that was handed none has no conversation.
        follow_up = job.implementer.resume
        self._resume_input: ResumeInput | None = None
        if follow_up is not None:
            self._resume_input = resume or ResumeInput.without(
                ResumeReason.DOWNLOAD_FAILED if follow_up.snapshot else ResumeReason.NO_SNAPSHOT
            )
        self._resume_outcome: ResumeOutcome | None = None
        self._notes: list[str] = []
        self._summary = ""
        self._error: tuple[ErrorCode, str] | None = None
        self._session_id: str | None = None
        self._model: TurnModel | None = None
        # The rule the agent's network was started with (#856: a subscription turn's is forced).
        self._effective_rule: NetworkRule | None = None
        self._leftover_lost = False
        # False when the agent's container could not be confirmed gone: then nothing is run in the
        # repository for the leftover (a survivor could be racing the tree).
        self._engine_ended = True
        # The branch made for work committed on a detached HEAD, if there was such work.
        self._rescued: str | None = None
        self._unchecked = False
        # The thread that removes the agent's container after the push (None before it).
        self._removal: threading.Thread | None = None
        # #745, step 7: the network door (None for `off`) and what the second wall did.
        self._netdoor: RunningNetDoor | None = None
        self._net_log: dict[str, Any] | None = None
        self._vm_policy = VM_POLICY_NOT_CONFIGURED
        # Whether the turn got as far as the network (one that failed before says nothing of it).
        self._network_reached = False

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
        agent: ImplementerAgent | ClaudeCodeAgent | None = None
        model: TurnModel | None = None
        place: AgentPlace | None = None
        try:
            if self._subscription is None:
                model = self._start_model()
            self._start_network(model)
            place = self._place_factory()
            for note in place.create():
                self._note(note)
            self._install_registry_trust(place)
            if self._subscription is not None:
                agent = self._start_claude(place)
            else:
                assert model is not None
                agent = self._agent(model, place)
                if self._resume_input is None:
                    agent.start(ENGINE_PORT)
                else:
                    agent.start(ENGINE_PORT, self._resume_input)
            self._session_id = None if self._subscription is not None else agent.session_id
            if self._resume_input is not None:
                self._note_resume(agent.resume)
            self._start_steps(agent)
            self._work(agent)
        except Exception as error:
            self._stopped_by(error)
        finally:
            # The agent's container is killed, everything in it with it: no process of the agent
            # can change the repository or call the door from here on.
            ended = True
            if agent is not None:
                # The engine must still be running for the export: it is read over its API.
                self._save_session(agent)
                ended = agent.stop()
            elif place is not None:
                ended = place.stop()
            self._engine_ended = ended
            if not ended:
                self._note("the agent's container could not be confirmed gone")
            # No connection can come any more: the network door says its last word. It goes before
            # the model door, whose network it is a member of.
            self._stop_network()
            if model is not None:
                # No call can come any more: the door says its last word, the cost is final.
                model.stop()
            if agent is not None:
                # What the live view lost, after both doors are closed: best effort, so a fault in
                # it never replaces the turn's outcome.
                with contextlib.suppress(Exception):
                    for note in agent.step_notes():
                        self._note(note)
        try:
            self._finish()
        finally:
            self._stop_network()
            if model is not None:
                model.stop()
            # The last flush of the live view, after the push and before the result: it hands over
            # what is left, is bounded in time and best effort, so the push never waits for it.
            self._finish_steps()
            if self._snapshot is not None:
                self._snapshot.close()
        result = self._result()
        self._remove_place(place)
        return result

    def _start_claude(self, place: AgentPlace) -> ClaudeCodeAgent:
        """The Claude Code agent of a subscription turn (#856): the device's login, the model name
        and the budget of the job, the job's clock. No ledger, no door."""
        subscription = self._subscription
        login = self._login
        if subscription is None or login is None:
            raise JobError(
                ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE,
                "harness_not_ready: this runner has no Claude Code login for the turn",
            )

        def check_deadline() -> None:
            if self._deadline_seconds() <= 0:
                raise LimitError(
                    ErrorCode.TIME_LIMIT_REACHED, "the time limit of the turn was reached"
                )

        agent = ClaudeCodeAgent(
            place=cast("Any", place),
            login=login,
            model=subscription.model,
            session_id=str(uuid.uuid4()),
            secrets=self.secrets(),
            remaining_seconds=self._deadline_seconds,
            check_deadline=check_deadline,
            instructions=instructions_text(
                with_setup=self._has_script(),
                can_push=self._can_push,
                profile_instructions=self._profile_instructions,
                with_result=self._schema is not None,
                with_ask=self._can_ask,
            ),
            result_schema=self._schema,
            can_ask=self._can_ask,
            max_budget_usd=subscription.max_budget_usd,
        )
        self._claude = agent
        agent.start()
        if self._resume_input is not None:
            # No stored conversation of this harness yet (a follow-up): the summary of the earlier
            # turns carries it.
            agent.resume = ResumeOutcome(
                ResumeMode.SUMMARY_ONLY, self._resume_input.reason or ResumeReason.NO_SNAPSHOT
            )
        return agent

    def _note_resume(self, outcome: ResumeOutcome | None) -> None:
        """How the follow-up turn got its earlier conversation, as a line of the log."""
        self._resume_outcome = outcome
        if outcome is None:
            return
        if outcome.mode is ResumeMode.IMPORTED:
            self._note("the conversation of the earlier turns was imported")
        else:
            reason = "" if outcome.reason is None else f": {outcome.reason.value}"
            self._note(f"the turn continues from a summary of the earlier turns{reason}")

    def _resume_block(self) -> dict[str, Any] | None:
        """`ImplementerResumeResult`: set once the engine started on a follow-up turn."""
        outcome = self._resume_outcome
        if outcome is None:
            return None
        if outcome.mode is ResumeMode.IMPORTED:
            return {"mode": outcome.mode.value}
        reason = outcome.reason or ResumeReason.IMPORT_FAILED
        return {"mode": outcome.mode.value, "reason": reason.value}

    def _first_message(
        self, agent: ImplementerAgent | ClaudeCodeAgent
    ) -> str | list[dict[str, Any]]:
        """The first message of the turn: the instruction behind the note about the repository
        (#909), and on a follow-up turn the preface (what happened to the sandbox, the same note
        in it) in front of it, as a part of its own."""
        instruction = self.job.implementer.instruction
        resume = self.job.implementer.resume
        workspace = self.workspace
        base, session = self.job.implementer.base_branch, self.job.implementer.branch
        if resume is None:
            return first_turn_parts(
                instruction, base=base, start=workspace.start_source, session=session
            )
        outcome = agent.resume or ResumeOutcome(ResumeMode.SUMMARY_ONLY, ResumeReason.IMPORT_FAILED)
        tips = workspace.start_tips
        # The session branch first, then the base, then the others in alphabetical order.
        names = sorted(tips, key=lambda name: (name != session, name != base, name))
        checkout = workspace.start_checkout or session
        facts = PrefaceFacts(
            turn=resume.turn,
            mode=outcome.mode,
            branches=[(name, tips[name]) for name in names],
            checkout=checkout,
            moved=[MovedBranch(m.name, m.was, m.now) for m in workspace.resume_moved],
            missing=workspace.resume_missing,
            setup_ran=self._has_script(),
            base=base,
            start=workspace.start_source,
            session=session,
        )
        return message_parts(
            facts, instruction, previous_summary=resume.previous_summary, digest=resume.digest
        )

    def _save_session(self, agent: ImplementerAgent | ClaudeCodeAgent) -> None:
        """Take the engine's session and hand it to the job host, which uploads it (#839).
        Best effort, inside a budget, and never the turn's: no failure here changes the outcome,
        the push or the bill, it is a line in the notes and the next turn starts from a summary.

        Skipped without a channel (an app that does not list the feature) and after a lost lease
        (the app would refuse it)."""
        pump = self._snapshot
        if isinstance(agent, ClaudeCodeAgent):
            # #856: no stored conversation of this harness yet (the session volume is a follow-up):
            # nothing is exported, and the next turn continues from the summary.
            if pump is not None:
                pump.close()
            return
        if pump is None or agent.session_id is None:
            return
        lost = self._error is not None and self._error[0] is ErrorCode.LEASE_LOST
        if lost:
            pump.close()
            return
        quick = self._should_stop() or self._ends_quickly()
        seconds = self.seams.stop_snapshot_seconds if quick else self.seams.snapshot_seconds
        began = self._clock()
        try:
            snapshot = agent.export_session(Redactor(self.secrets()), seconds)
            sent = pump.send(
                snapshot, PINNED_ENGINE_VERSION, max(seconds - (self._clock() - began), 0.2)
            )
        except ExportFailed as error:
            self._note(f"the session was not saved for a follow-up turn: {error.reason.value}")
            pump.close()
            return
        except Exception:
            self._note("the session was not saved for a follow-up turn: export_failed")
            pump.close()
            return
        if not sent:
            self._note("the session was not saved for a follow-up turn: not handed to the host")

    def _start_steps(self, agent: ImplementerAgent | ClaudeCodeAgent) -> None:
        """Begin to send the step records of the open session. Best effort: a fault here is the
        live view's, never the turn's."""
        feeder = getattr(agent, "steps", None)
        if self._steps is None or feeder is None:
            return
        with contextlib.suppress(Exception):
            self._steps.start(feeder)

    def _finish_steps(self) -> None:
        """The last flush, so that a finished run shows all its steps: it runs at every end, a stop
        included (with less time), and leaves a line in the notes for what could not be sent."""
        if self._steps is None:
            return
        seconds = (
            self.seams.stop_steps_flush_seconds
            if self._should_stop()
            else self.seams.steps_flush_seconds
        )
        with contextlib.suppress(Exception):
            for note in self._steps.finish(seconds):
                self._note(note)

    def _remove_place(self, place: AgentPlace | None) -> None:
        """Take the killed container away, after the push and the reads: nothing waits for it (the
        VM goes with the turn), so it is done on a thread of its own and never delays the result.

        Two limits, both on purpose. It happens only on a normal return of `run()`: a turn that
        raises, or a process that is stopped (SIGTERM) before it gets here, leaves the killed
        container for the VM to take with it. And the thread is a daemon: the process may exit
        before the removal ends. Both are fine because one VM runs one turn (the Launcher makes a
        VM per job and deletes it after the result); they would not be if a VM ran a second turn,
        which would find the name of the old container taken (`AGENT_CONTAINER_NAME`)."""
        if place is None:
            return

        def remove() -> None:
            try:
                place.remove()
            except Exception:
                _log.warning("the agent's container could not be removed")

        self._removal = threading.Thread(target=remove, daemon=True)
        self._removal.start()

    # -- the network ----------------------------------------------------------

    @property
    def rule(self) -> NetworkRule:
        """The rule the agent's network runs under: the environment's (a task without one is
        `off`), and for a subscription turn (#856) the forced one, once it was made."""
        if self._effective_rule is not None:
            return self._effective_rule
        environment = self.job.implementer.environment
        return OFF if environment is None else environment.network

    def _has_script(self) -> bool:
        environment = self.job.implementer.environment
        return environment is not None and environment.has_script

    def _start_network(self, model: TurnModel | None) -> None:
        """The environment's rule (#745, step 7), in force before the agent exists: the network
        door for `list` and `open` (none for `off`), then the second wall, the VM's network policy,
        narrowed to GitHub, the model provider, the app and the rule. `open` leaves the policy as
        it is. The switch ends the connections that are open, so nothing the agent could have is
        in flight yet. A door or a switch that fails ends the turn `setup_failed`, free."""
        if self._subscription is not None:
            # #856: the login is in the agent's container, so the exit is the guard: the door lets
            # through api.anthropic.com and nothing else, whatever the environment says (and an
            # environment that says more refuses the turn, free).
            self._effective_rule = subscription_rule(self.rule)
            model_host = ANTHROPIC_HOST
        else:
            assert model is not None
            model_host = model_host_of(model.entry.upstream_base_url)
        self._network_reached = True
        rule = self.rule
        if rule.mode != MODE_OFF:
            self._netdoor = start_network_door(
                rule, deadline_seconds=self._deadline_seconds(), seams=self.seams.netdoor
            )
        # The environment control (#975) is the one way to the second wall: https for the hosted
        # Dispatcher, vsock for a VM on a customer's machine, none for a runner without one.
        control = control_from_environment(
            self.environment,
            post=self.seams.switch_post,
            pause_seconds=self.seams.switch_pause_seconds,
            connect=self.seams.control_connect,
            narrow_seconds=self.seams.control_narrow_seconds,
            token=self.job.control_token,
        )
        if rule.mode == MODE_OPEN:
            self._vm_policy = VM_POLICY_UNCHANGED
        elif control is None:
            # For every mode, `off` included: a second wall that is not there is said.
            self._note("the VM's network policy was not changed: this runner has no way to do it")
            _log.warning(
                "environment control: none configured, so the outer network wall is not narrowed "
                "and the job runs with the network door only"
            )
        else:
            control.narrow(rule, model_host)
            self._vm_policy = VM_POLICY_NARROWED

    def _install_registry_trust(self, place: AgentPlace) -> None:
        """The door's certificate authority into the agent's container (#784), before anything runs
        in it: the variables of `agent_container.trust_environment` point at these two files, and a
        tool that cannot read its roots fails every connection, so a rule that names a registry
        without them ends the turn `setup_failed`, free."""
        if not rule_has_registries(self.rule):
            return
        door = self._netdoor
        ca = None if door is None else door.registry_ca
        if ca is None:
            raise JobError(
                ErrorCode.SETUP_FAILED,
                "network_door_unavailable: the door sent no certificate for the package registries",
            )
        try:
            roots = self.seams.system_roots()
        except OSError:
            raise JobError(
                ErrorCode.SETUP_FAILED,
                "network_door_unavailable: the system's root certificates could not be read",
            ) from None
        place.write_files(
            {
                TRUST_CA_NAME: (ca, 0o644),
                TRUST_BUNDLE_NAME: (roots.rstrip(b"\n") + b"\n" + ca, 0o644),
            }
        )

    def _stop_network(self) -> None:
        """End the network door and keep its log. Safe to call twice."""
        door, self._netdoor = self._netdoor, None
        if door is None:
            return
        if door.end is not None and door.end.unexpected:
            self._note("the network door ended during the turn; the agent had no network after it")
        self._net_log = door.stop()

    def _network_block(self) -> dict[str, Any] | None:
        """`ImplementerNetworkReport`: one for every turn that got as far as the network, whatever
        its mode and whatever the second wall did (`vmPolicy` says, `not_configured` included)."""
        rule = self.rule
        if not self._network_reached:
            return None
        return network_report(
            rule,
            self._net_log,
            door=rule.mode != MODE_OFF,
            vm_policy=self._vm_policy,
        )

    def _start_model(self) -> TurnModel:
        """The model door (#745, step 3): the key, the model pin and the cost limit go to a
        container of its own, and this process keeps a ledger that reads what the door counts."""
        spec = self.job.implementer
        access = self.job.model_access
        if access is None or spec.model_entry is None or spec.cost is None:
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID, "the job has no model access to hand over"
            )
        deadline = self._deadline_seconds()
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
        try:
            running = start_door(
                model_access=access,
                capability=capability,
                deadline_seconds=self._deadline_seconds(),
                port=slot_ports(self.environment).proxy,
                environment={
                    name: value
                    for name, value in self.environment.items()
                    if name == "RUNNER_DYNAMIC_MAX_COST_USD"
                },
                seams=self.seams.door,
            )
        finally:
            # The door has the key (or the turn ends without one): Control's copy of the hand-off,
            # and the `llm` section of the job document it shares, are emptied.
            forget_model_access(access)
        ledger.attach(running.state)
        model.door, model.url = running, running.url
        return model

    def _agent(self, model: TurnModel, place: AgentPlace) -> ImplementerAgent:
        entry, proxy_url = model.entry, model.url
        family = WireFamily(entry.family)
        provider = native_provider_config(
            entry,
            base_url=spec_of(family).proxy_base_url(proxy_url),
            api_key=model.capability,
            door_host=MODEL_DOOR_ADDRESS,
        )

        def make_config(instructions_path: str) -> dict[str, Any]:
            return build_engine_config(
                provider=provider,
                model_reference=native_model_reference(entry),
                family=family,
                proxy_url=proxy_url,
                capability=model.capability,
                instructions_path=instructions_path,
                door_host=MODEL_DOOR_ADDRESS,
                finish_command=None if self._schema is None else finish_server_command(),
            )

        options: dict[str, Any] = {}
        if self.seams.startup_seconds is not None:
            options["startup_seconds"] = self.seams.startup_seconds
        return ImplementerAgent(
            ledger=model.ledger,
            runtime=place,
            command=self.command,
            directory=AGENT_REPO,
            make_config=make_config,
            instructions=(
                INSTRUCTIONS_FILE,
                instructions_text(
                    with_setup=self._has_script(),
                    can_push=self._can_push,
                    profile_instructions=self._profile_instructions,
                    with_result=self._schema is not None,
                    with_ask=self._can_ask,
                ),
            ),
            environment=implementer_environment(
                home=AGENT_HOME,
                scratch_dir=AGENT_TMP,
                config_directory=None if self._schema is None else CONFIG_DIRECTORY,
            ),
            model=entry.model_id,
            provider_id=entry.provider_id,
            transport=self.seams.transport,
            # Without a channel nothing is recorded, so nothing is queued to be "not taken in time".
            redactor=Redactor(self.secrets()) if self._steps is not None else None,
            files=None
            if self._schema is None
            else finish_files(self._schema, can_ask=self._can_ask),
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

    def _work(self, agent: ImplementerAgent | ClaudeCodeAgent) -> None:
        """The instruction, and the one extra message when the tree is still dirty. A profile that
        may not push gets no extra message: nothing is collected from the tree, so a second paid
        turn would only ask for a commit that nobody takes (#843)."""
        check = self._watch()
        ended = agent.turn(self._first_message(agent), check=check)
        self._summary = ended.text
        self._note("the agent ended its turn")
        if self._schema is not None:
            self._remind_for_result(agent, check)
        if not self._can_push:
            return
        if not self.workspace.dirty() or not self._time_for_another_turn(agent):
            return
        self._note("the working tree is dirty: one extra message")
        again: AgentTurn = agent.turn(LEFTOVER_PROMPT, check=check)
        self._summary = self._summary or again.text

    def _remind_for_result(
        self, agent: ImplementerAgent | ClaudeCodeAgent, check: Callable[[], None]
    ) -> None:
        """A turn with a result schema whose agent ended without a result that fits gets one more
        message, like the extra message for a dirty tree and for the same reason: the model is
        asked once. What is read now is a first look (the container is still up); the result the
        turn is judged by is read after the container is gone (`_collect_result`)."""
        if self._read_agent_result() is not None or self._read_agent_ask() is not None:
            return
        if not self._time_for_another_turn(agent):
            self._note("no valid result was handed in, and there is no time for a reminder")
            return
        self._note("no valid result was handed in: one reminder")
        again: AgentTurn = agent.turn(RESULT_REMINDER_PROMPT, check=check)
        self._summary = self._summary or again.text

    def _read_agent_result(self) -> dict[str, Any] | None:
        """The result file as the schema judges it: bounded before it is parsed, then checked
        (`finish_tool.parse_result`). None when there is no file, it cannot be read, or it does not
        fit; `_result_problem` says which, in a word (never a value of the file)."""
        schema = self._schema
        if schema is None or self._results is None:
            return None
        try:
            raw = self._results.read_result(finish_tool.MAX_RESULT_BYTES + 1)
        except Exception:
            raw = None
        if raw is None:
            self._result_problem = "no result file"
            return None
        parsed = finish_tool.parse_result(schema, raw)
        if parsed.value is None:
            self._result_problem = parsed.problem or "invalid"
            if parsed.problem == "invalid":
                self._result_problem = f"invalid: {len(parsed.issues)} problems"
        return parsed.value

    def _read_agent_ask(self) -> dict[str, Any] | None:
        """#920: the question file as `finish_tool.parse_ask` judges it. None when the turn may not
        ask, there is no file, it cannot be read or it does not fit."""
        if not self._can_ask or self._results is None:
            return None
        try:
            raw = self._results.read_ask(finish_tool.MAX_ASK_BYTES + 1)
        except Exception:
            raw = None
        if raw is None:
            return None
        return finish_tool.parse_ask(raw).value

    def _time_for_another_turn(self, agent: ImplementerAgent | ClaudeCodeAgent) -> bool:
        if isinstance(agent, ClaudeCodeAgent):
            return self._deadline_seconds() >= MIN_EXTRA_TURN_SECONDS and agent.has_budget_left()
        return agent.ledger.remaining_seconds() >= MIN_EXTRA_TURN_SECONDS

    def _stopped_by(self, error: BaseException) -> None:
        model = self._model
        used = model is not None and model.ledger.model_used
        failed = None if model is None else model.upstream_error()
        code, detail = classify(error, used_model=used, provider_error=failed)
        if code is ErrorCode.COST_LIMIT_REACHED and not used and self._history_imported():
            detail = HISTORY_OVER_LIMIT_DETAIL
        if self._error is None:
            self._error = (code, detail)
        self._note(f"the turn ended: {code.value}")

    def _history_imported(self) -> bool:
        outcome = self._resume_outcome
        return outcome is not None and outcome.mode is ResumeMode.IMPORTED

    # -- the end --------------------------------------------------------------

    def _finish(self) -> None:
        """The leftover commit and the final push of all local branches, after the agent is gone.
        A failure of the push is the turn's error only when nothing ended the turn before; a
        leftover that cannot be committed is a note (the branches that are committed are pushed
        all the same)."""
        self._collect_result()
        if not self._can_push:
            # #843: a profile without the right to push. Nothing leaves the container, so nothing
            # is rescued, committed, listed or pushed, and the repository is not read after it.
            self._note("this profile may not push: nothing was pushed")
            self._note_disk()
            return
        quick = self._ends_quickly()
        if not self._engine_ended:
            self._unchecked = True
            self._note(
                "nothing was committed or rescued: the agent's container is not confirmed gone"
            )
        else:
            self._quiet()
            try:
                self._rescued = self.workspace.rescue_detached_head()
                if self._rescued is not None:
                    self._note(f"work on a detached HEAD was saved on the branch {self._rescued}")
            except Exception:
                self._note("work on a detached HEAD could not be saved on a branch")
            try:
                if not quick and self.workspace.dirty():
                    try:
                        self.workspace.commit_all(seconds=self.seams.leftover_seconds)
                        self._note("uncommitted changes were committed by the system")
                    finally:
                        # The commit ran the repository's filters in a reader that can write.
                        self._quiet()
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
        self._note_disk()

    def _collect_result(self) -> None:
        """The result of the agent, once its container is gone: nothing in it can change the file
        now. Read in a reader, bounded, parsed and checked against the schema of the turn; that is
        the one the turn is judged by, whatever the first look said. A turn without a result that
        fits ends `no_result` (the model was used, so it is the charged code), unless something
        ended it before. Not read when the end is quick (a lost lease, a stop) or the container is
        not confirmed gone."""
        if self._schema is None or self._ends_quickly():
            return
        if not self._engine_ended:
            self._result_problem = "the agent's container is not confirmed gone"
            self._note("the result was not read: the agent's container is not confirmed gone")
        else:
            read = self._read_agent_result()
            if read is not None:
                # The agent wrote it, and anything it was shown can be in it: the job's secrets
                # are taken out of every text before the result leaves this process.
                cleaned = redacted_value(read, Redactor(self.secrets()).redact)
                # Taking secrets out can make the texts longer. A result over the bounds now would
                # cost the whole report, so it is the result that is left out.
                if agent_result_ok(cleaned):
                    self._agent_result = cleaned
                else:
                    self._result_problem = "too_large once the secrets were taken out"
                    self._note("the result was left out: it is over the bounds without its secrets")
        if self._agent_result is None and self._engine_ended:
            self._collect_ask()
        if self._agent_result is None and self._agent_ask is None and self._error is None:
            self._error = (
                ErrorCode.NO_RESULT,
                f"the agent ended without a result that fits the schema ({self._result_problem})",
            )
            self._note("the turn ended: no_result")

    def _collect_ask(self) -> None:
        """#920: a turn that handed in no result may have ended with a question. Read like the
        result,
        once the container is gone; the job's secrets are taken out of every text of it. A question
        over the bounds without its secrets is left out, and the turn ends `no_result`."""
        read = self._read_agent_ask()
        if read is None:
            return
        cleaned = redacted_value(read, Redactor(self.secrets()).redact)
        if agent_ask_ok(cleaned):
            self._agent_ask = cleaned
            self._note("the turn ended with a question")
        else:
            self._result_problem = "the question was over the bounds without its secrets"
            self._note("the question was left out: it is over the bounds without its secrets")

    def _quiet(self) -> None:
        """Kill what runs in the readers and start them again (`GitWorkspace.quiet_readers`):
        before anything is read or committed after the agent, and before the push. A reader that
        cannot be had back fails the commands that need it, and the push says so."""
        try:
            quiet = self.workspace.quiet_readers(seconds=self.seams.reader_reset_seconds)
        except Exception:
            quiet = False
        if not quiet:
            self._note("the readers could not be made quiet: what ran in them may still run")

    def _note_disk(self) -> None:
        """Say so when the VM's disk is nearly full at the end: the agent filled it, or the work is
        large. The work that is on the reserve disk is not affected; what the agent wrote since the
        disk was full may be."""
        free = self.workspace.volume_free_bytes()
        if free is not None and free < LOW_DISK_BYTES:
            self._note(f"the VM's disk had {free // (1024 * 1024)} MB left at the end")

    def _note_branches(self, report: PushReport) -> None:
        for branch in report.branches:
            outcome = "pushed" if branch.pushed else f"rejected ({branch.reason})"
            self._note(f"branch {branch.name}: {outcome}")
        if any(branch.reason == REASON_OUT_OF_SPACE for branch in report.branches):
            self._note(
                "the disk of the workspace had no room left to take every branch over, "
                "so what is listed as out_of_space did not arrive"
            )
        if not report.listed:
            if report.list_problem == LIST_TOO_LARGE:
                self._note(
                    "the list of local branches of the agent's repository is too long to read"
                )
            else:
                self._note("the local branches of the agent's repository could not be read")
        if report.invalid:
            self._note(f"{report.invalid} local branches have names that are not pushed")
        if report.overflow:
            self._note(f"{report.overflow} further branches were not pushed (limit)")

    def _result(self) -> TurnResult:
        workspace = self.workspace
        if not self._can_push:
            # #843: no branch, no head, no commits and no files: nothing was pushed, so there is
            # nothing Control vouches for. A turn that ended well is a success whether the agent
            # changed anything or not.
            return self._turn_result(self._error, None, False, (), (0, 0), (), ())
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
            # No commit and nothing to commit, on no branch: the agent did not do the task, unless
            # it ended the turn with a question (#920), which it may ask before changing anything.
            if self._agent_ask is None:
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
            error = (ErrorCode.PUSH_REJECTED, _push_failure(form))
        return self._turn_result(
            error,
            head,
            pushed,
            report.branches,
            (report.invalid, report.overflow),
            tuple(commits),
            tuple(files),
        )

    def _turn_result(
        self,
        error: tuple[ErrorCode, str] | None,
        head: str | None,
        pushed: bool,
        branches: tuple[BranchPush, ...],
        dropped: tuple[int, int],
        commits: tuple[CommitInfo, ...],
        files: tuple[FileChange, ...],
    ) -> TurnResult:
        workspace = self.workspace
        usage = self._usage()
        summary = clip_summary(
            self._summary,
            self.secrets(),
            tail=_not_kept(self._leftover_lost, self._rescued, self._unchecked),
        )
        return TurnResult(
            error_code=None if error is None else error[0],
            error_detail=None if error is None else error[1],
            base_commit=workspace.start_commit,
            head_commit=head,
            pushed=pushed,
            branches=branches,
            branches_dropped=dropped,
            commits=commits,
            files_changed=files,
            summary=summary,
            opencode_session_id=self._session_id,
            opencode_version=PINNED_ENGINE_VERSION,
            usage=usage,
            notes=tuple(self._notes),
            network=self._network_block(),
            checked_out=workspace.checked_out,
            agent_result=self._agent_result,
            agent_ask=self._agent_ask,
            resume=self._resume_block(),
        )

    def _usage(self) -> Usage:
        subscription = self._subscription
        if subscription is not None:
            # #856: nothing was billed through us. What Claude Code says the turn is worth at API
            # prices is an estimate (None when it did not price every model), shown as such.
            claude = self._claude
            estimate = None if claude is None else claude.estimated_cost_usd
            return Usage(
                subscription.model,
                0,
                0,
                0,
                0,
                False,
                None,
                cost_basis=COST_BASIS_SUBSCRIPTION,
                estimated_cost_usd=None if estimate is None else float(estimate),
            )
        if self._model is None:
            return Usage(None, 0, 0, 0, 0, False, None)
        return self._model.ledger.usage(self.job.llm.model)

    def secrets(self) -> tuple[str, ...]:
        capability = () if self._model is None else (self._model.capability,)
        login = () if self._login is None else (self._login.secret,)
        return (*self.job.secrets, *capability, *login)

    def _note(self, text: str) -> None:
        self._notes.append(text)
