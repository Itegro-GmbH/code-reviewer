# SPDX-License-Identifier: LicenseRef-Proprietary

"""The engine of one Implementer turn (#764): the pinned OpenCode server, driven over its HTTP API,
with the write tools.

It has the skeleton of the Dynamic Review's adapter (`dynamic_review/adapter.py`) and reuses its
parts: the HTTP client, the event stream that feeds the tool audit, and the ledger behind the model
door. What is different is *where* the engine runs (#745, step 4): in the agent's container
(`agent_container.py`), as root, with its own Docker. Control starts it and reaches its port through
the Docker daemon only (`EngineRuntime`); the engine has no address of Control's. What it does not
have is anything review-shaped: no structured answer, no findings, no wrap-up above the wire. The
agent works until it ends its turn; the ledger refuses the next model call when the cost limit or
the clock is reached, and that is what ends it.

Nothing here steers the agent: no step limit, no plan. The cost limit and the clock are the brakes.
Prompt caching is whatever the stock engine and the model door do for Dynamic; nothing here sets,
removes or rewrites a cache marker.
"""

import json
import logging
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from code_reviewer_runner.dynamic_review.adapter import (
    DEADLINE_TOLERANCE_SECONDS,
    EVENTS_CONNECT_SECONDS,
    PINNED_ENGINE_VERSION,
    REASON_EXITED,
    STARTUP_SECONDS,
    TURN_TIMEOUT_MARGIN_SECONDS,
    WATCH_INTERVAL_SECONDS,
    EngineClient,
    EngineError,
    Transport,
    _http_request,  # pyright: ignore[reportPrivateUsage]
    answer_text,
    turn_end_note,
)
from code_reviewer_runner.dynamic_review.budget import BudgetLedger
from code_reviewer_runner.dynamic_review.engine_events import EventFeeder, EventReader
from code_reviewer_runner.dynamic_review.tool_part_audit import ToolPartAudit
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode
from code_reviewer_runner.resume_wire import ResumeReason

from .config import IMPLEMENTER_AGENT, SESSION_TITLE
from .preface import ResumeMode
from .resume_session import ResumeInput, ResumeSnapshot
from .session_export import EngineFetch, ExportFailed, ExportReason, SessionSnapshot, take_snapshot
from .step_feed import StepFeeder

_log = logging.getLogger(__name__)

# How long a failed call to the engine waits for the place to say that it ended.
SETTLE_SECONDS = 3.0
# Where the engine's configuration goes in the agent's container, and the port it serves on.
CONFIG_DIRECTORY = "/etc/code-reviewer"
CONFIG_NAME = "opencode.json"
# Where the stored conversation of a follow-up turn is written before the engine imports it (#840):
# next to the config, owner-only.
RESUME_NAME = "resume.json"
# The most the import may take, and the least left of the clock to try it at all. Measured 1.5 to
# 2.3 s on a real VM, 306 to 385 MiB, so a minute is about 25 times the largest; it counts against
# the turn's own time (the work window), not against the grace kept for its end.
IMPORT_SECONDS = 60.0
MIN_IMPORT_SECONDS = 5.0


class EngineRuntime(Protocol):
    """Where the engine runs and how Control reaches it: the agent's container
    (`agent_container.AgentContainer`), or a process of a test."""

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None:
        """Put files (name -> (bytes, mode)) into the engine's configuration directory."""
        ...

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> "CommandOutcome":
        """Run a command to its end in the place and say how it ended (the import of a stored
        conversation, #840). Never raises for a command that fails or does not answer."""
        ...

    def start_engine(self, argv: list[str], environment: Mapping[str, str]) -> str:
        """Start the engine and return the address Control reaches its HTTP port at."""
        ...

    def engine_running(self) -> bool: ...

    def settle(self, seconds: float) -> None:
        """Wait up to `seconds` for the place to say how it ended, when the engine just failed: a
        connection that breaks is seen before the daemon reports the container's end, and the
        outcome should name the end, not the broken connection."""
        ...

    def engine_end_note(self) -> str | None:
        """What is known of how the engine's place ended by itself (None: it did not)."""
        ...

    def stop(self) -> bool:
        """End the engine and everything of the agent's, and say whether nothing is left."""
        ...


@dataclass(frozen=True)
class CommandOutcome:
    """How a command run in the place ended: its exit status and what it printed (clipped), or
    `unanswered` when it could not be run or did not end in time (nothing is concluded from it)."""

    returncode: int
    output: str
    unanswered: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.unanswered


@dataclass(frozen=True)
class ResumeOutcome:
    """How the follow-up turn got its earlier conversation: imported, or from a summary and why."""

    mode: ResumeMode
    reason: ResumeReason | None = None


@dataclass(frozen=True)
class AgentTurn:
    """How a turn ended: the text the model closed it with (the agent's own words, untrusted)."""

    text: str
    note: str


class ImplementerAgent:
    """One engine, one session. `start()`, any number of `turn()`s, `stop()`.

    `check` of a turn is called every watch interval and may raise: the caller's own reasons to end
    the turn at once (a push the provider refused, a branch the agent rewrote).
    """

    def __init__(
        self,
        *,
        ledger: BudgetLedger,
        runtime: EngineRuntime,
        command: Sequence[str],
        directory: str,
        make_config: Callable[[str], Mapping[str, Any]],
        instructions: tuple[str, str],
        environment: Mapping[str, str],
        model: str,
        provider_id: str,
        startup_seconds: float = STARTUP_SECONDS,
        events_connect_seconds: float = EVENTS_CONNECT_SECONDS,
        transport: Transport = _http_request,
        redactor: Redactor | None = None,
        files: Mapping[str, tuple[bytes, int]] | None = None,
    ) -> None:
        self.ledger = ledger
        self.command = tuple(command)
        self.directory = directory
        self.model = model
        self.session_id: str | None = None
        # The configuration the engine was given (set by `start`).
        self.config: dict[str, Any] = {}
        self._runtime = runtime
        # The configuration as a function of the path of the instruction file, which is only known
        # where the file is written (the engine's configuration directory).
        self._make_config = make_config
        # (file name, text): the runner's addition to the stock prompt, written next to the config.
        self._instructions = instructions
        # #843: further files for the engine's configuration directory (the finish tool).
        self._files = dict(files or {})
        self._environment = dict(environment)
        self._provider_id = provider_id
        self._startup_seconds = startup_seconds
        self._events_connect_seconds = events_connect_seconds
        self._transport = transport
        self._client: EngineClient | None = None
        self._events: EventReader | None = None
        self._feeder_errors = 0
        # The step records of the turn (#745), made when the session is open: only with a redactor,
        # so no record exists that was not redacted.
        self._redactor = redactor
        self.steps: StepFeeder | None = None
        # How long each message call took, in seconds on the ledger's clock.
        self.turn_seconds: list[float] = []
        # #840: set by `start` on a follow-up turn; None on a first turn.
        self.resume: ResumeOutcome | None = None

    # -- process --------------------------------------------------------------

    def start(self, port: int, resume: ResumeInput | None = None) -> None:
        """Write the trusted config, start the engine, wait for it to be healthy and open the one
        session. Raises `EngineError` or `LimitError`; the caller calls `stop()`.

        A follow-up turn (`resume`, #840) first imports the stored conversation, before the engine
        starts (the engine reads its database when it opens, and the import is a second process of
        it), and continues in that session. Anything that goes wrong with that, the file, the
        import or the session it should have made, is a fresh session and a reason in
        `self.resume`: the turn goes on from a summary and is never failed by it."""
        self.ledger.check_deadline()
        name, text = self._instructions
        config = dict(self._make_config(f"{CONFIG_DIRECTORY}/{name}"))
        self.config = config
        self._runtime.write_files(
            {
                name: (text.encode("utf-8"), 0o644),
                # The config carries the job's bearer for the model door: owner-only.
                CONFIG_NAME: (json.dumps(config).encode("utf-8"), 0o600),
                **self._files,
            }
        )
        environment = dict(self._environment)
        # The one file the engine reads its configuration from; `OPENCODE_CONFIG_DIR` is never set
        # (it makes the engine install a plugin package from the registry).
        environment["OPENCODE_CONFIG"] = f"{CONFIG_DIRECTORY}/{CONFIG_NAME}"
        imported = None if resume is None else self._import(resume, environment)
        url = self._runtime.start_engine(
            [
                *self.command,
                "serve",
                "--hostname",
                "127.0.0.1",
                "--port",
                str(port),
                "--print-logs",
            ],
            environment,
        )
        client = EngineClient(
            url,
            self.directory,
            transport=self._transport,
            provider_id=self._provider_id,
            agent=IMPLEMENTER_AGENT,
            session_title=SESSION_TITLE,
        )
        client.wait_healthy(self._startup_seconds, self._is_running)
        self._client = client
        self.session_id = self._open_session(client, resume, imported)
        self._open_audit(client, self.session_id)

    def _import(self, resume: ResumeInput, environment: Mapping[str, str]) -> str | None:
        """Write the stored conversation into the place and have the engine import it, with the
        environment the engine runs in. Returns the id of the imported session, or None with the
        reason in `self.resume`. Time boxed, and never longer than the turn has left."""
        snapshot = resume.snapshot
        if snapshot is None:
            self.resume = ResumeOutcome(
                ResumeMode.SUMMARY_ONLY, resume.reason or ResumeReason.DOWNLOAD_FAILED
            )
            return None
        seconds = min(IMPORT_SECONDS, self.ledger.remaining_seconds())
        if seconds < MIN_IMPORT_SECONDS:
            self.resume = ResumeOutcome(ResumeMode.SUMMARY_ONLY, ResumeReason.IMPORT_FAILED)
            return None
        try:
            self._runtime.write_files({RESUME_NAME: (snapshot.data, 0o600)})
            done = self._runtime.run_command(
                [*self.command, "import", f"{CONFIG_DIRECTORY}/{RESUME_NAME}"],
                environment,
                seconds,
            )
        except Exception as error:  # the runtime raises its own errors; none of them ends the turn
            _log.warning("the stored conversation could not be imported (%s)", type(error).__name__)
            done = None
        if done is None or not done.ok:
            self.resume = ResumeOutcome(ResumeMode.SUMMARY_ONLY, self._import_failure(snapshot))
            return None
        self.resume = ResumeOutcome(ResumeMode.IMPORTED)
        return snapshot.session_id

    @staticmethod
    def _import_failure(snapshot: ResumeSnapshot) -> ResumeReason:
        """A conversation written by another engine version than the one that reads it is the likely
        reason an import fails after a pin moved; any other is the import's."""
        if snapshot.version != PINNED_ENGINE_VERSION:
            return ResumeReason.VERSION_CHANGED
        return ResumeReason.IMPORT_FAILED

    def _open_session(
        self, client: EngineClient, resume: ResumeInput | None, imported: str | None
    ) -> str:
        """The imported session when the engine knows it, a fresh one otherwise."""
        if imported is not None:
            if client.has_session(imported):
                return imported
            snapshot = None if resume is None else resume.snapshot
            reason = (
                ResumeReason.IMPORT_FAILED if snapshot is None else self._import_failure(snapshot)
            )
            self.resume = ResumeOutcome(ResumeMode.SUMMARY_ONLY, reason)
        return client.create_session()

    def _open_audit(self, client: EngineClient, session_id: str) -> None:
        """The audit of the engine's tool parts runs on its event stream beside the turns: it
        counts tool calls and result bytes into the ledger (the call trace, the per-result and
        the cumulative bound). The step feeder rides on the same stream after it and is best effort
        (`step_feed.py`); the audit stays first and fails closed."""
        audit = ToolPartAudit(self.ledger, session_id, export_root=self.directory)
        feeders: list[EventFeeder] = [audit]
        if self._redactor is not None:
            self.steps = StepFeeder(session_id, self._redactor)
            feeders.append(self.steps)
        events = EventReader(client.open_events, feeders, self.ledger)
        events.start(self._events_connect_seconds)
        self._events = events

    def _is_running(self) -> bool:
        return self._runtime.engine_running()

    def stop(self) -> bool:
        """End the audit and the agent's place with everything in it. True when nothing is left.
        Safe to call twice. The commit of leftovers and the push come after this: no process of the
        agent can change the repository from here on."""
        if self._events is not None:
            self._events.stop()
            self._feeder_errors = self._events.feeder_errors
            self._events = None
        return self._runtime.stop()

    def export_session(self, redactor: Redactor, seconds: float) -> SessionSnapshot:
        """The engine's session as the file a follow-up turn imports (#839), within `seconds`, with
        the secrets of the turn taken out. Taken over the engine's HTTP API, so it needs the engine
        to be running: call it before `stop()`. Raises `ExportFailed`."""
        client, session_id = self._client, self.session_id
        if client is None or session_id is None:
            raise ExportFailed(ExportReason.UNREACHABLE)
        fetch = EngineFetch(client.base_url, client.directory)
        try:
            return take_snapshot(
                fetch, session_id, redactor=redactor, seconds=seconds, abort=fetch.close
            )
        finally:
            fetch.close()

    def step_notes(self) -> tuple[str, ...]:
        """What the live view lost in the turn (#745), for the turn's notes: events the step
        feeder could not convert and records it pushed out of its full queue. Empty when nothing
        was lost. Read after `stop()`, when the counts are final."""
        errors = self._feeder_errors if self._events is None else self._events.feeder_errors
        dropped = 0 if self.steps is None else self.steps.dropped
        notes: list[str] = []
        if errors:
            notes.append(f"the live view could not convert {errors} engine events")
        if dropped:
            notes.append(
                f"the live view dropped {dropped} step records that were not taken in time"
            )
        return tuple(notes)

    @property
    def running(self) -> bool:
        return self._is_running()

    # -- a turn ---------------------------------------------------------------

    def abort(self) -> None:
        if self._client is not None and self.session_id is not None:
            self._client.abort(self.session_id)

    def turn(
        self,
        text: str | Sequence[Mapping[str, Any]],
        *,
        check: Callable[[], None] = lambda: None,
    ) -> AgentTurn:
        """Send `text` (or the list of text parts, the first message of a follow-up turn) as one
        user message and wait for the end of the turn.

        The message call blocks until the engine is done, so it runs beside a watch that ends the
        turn the moment the proxy records a limit or a provider refusal, the clock runs out, the
        caller's `check` raises or the engine dies. Raises `LimitError`, `EngineError` or whatever
        `check` raises; the caller decides what a stop means.
        """
        client, session_id = self._client, self.session_id
        if client is None or session_id is None:
            raise EngineError(ErrorCode.RUNNER_ERROR, "the engine is not started")
        parts: list[dict[str, Any]] = (
            [{"type": "text", "text": text}] if isinstance(text, str) else [dict(p) for p in text]
        )
        outcome: list[Exception] = []
        finished = threading.Event()

        def post() -> None:
            try:
                client.send_message(
                    session_id,
                    model=self.model,
                    parts=parts,
                    schema=None,
                    timeout=self.ledger.remaining_seconds() + TURN_TIMEOUT_MARGIN_SECONDS,
                )
            except Exception as error:  # re-raised below, in the caller's thread
                outcome.append(error)
            finally:
                finished.set()

        started = self.ledger.elapsed_seconds()
        worker = threading.Thread(target=post, daemon=True)
        worker.start()
        try:
            while not finished.wait(WATCH_INTERVAL_SECONDS):
                self._watch(check)
            self._raise_recorded_failure()
            if outcome:
                # A call that ran into its timeout at the deadline is the deadline, not an
                # unreachable engine: both end at the same moment and the order must not matter.
                self.ledger.check_deadline(tolerance=DEADLINE_TOLERANCE_SECONDS)
                failure = outcome[0]
                if isinstance(failure, EngineError):
                    self._runtime.settle(SETTLE_SECONDS)
                    if not self._is_running():
                        raise self._exited()
                raise failure
        finally:
            self.turn_seconds.append(self.ledger.elapsed_seconds() - started)
            # A call that is still open when the turn ends early (a limit, a stop) only ends with
            # the engine, which is ended right after: there is nothing to wait for.
            worker.join(timeout=5.0 if finished.is_set() else 0.2)
        return self._ended(client.last_message)

    def _watch(self, check: Callable[[], None]) -> None:
        self._raise_recorded_failure()
        check()
        self.ledger.check_deadline()
        if not self._is_running():
            raise self._exited()

    def _raise_recorded_failure(self) -> None:
        """A limit or provider refusal the proxy recorded is the turn's result."""
        failure = self.ledger.failure
        if failure is None:
            return
        if failure.code is ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE:
            # The engine's stream or connection went away. If its place ended, say how: a stream
            # that ended is the symptom, the container's death (or its memory kill) the cause.
            self._runtime.settle(SETTLE_SECONDS)
            note = self._runtime.engine_end_note()
            if note is not None:
                raise EngineError(ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE, note)
        raise failure

    def _exited(self) -> EngineError:
        note = self._runtime.engine_end_note()
        return EngineError(
            ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
            note or f"{REASON_EXITED}: the engine process ended during its turn",
        )

    @staticmethod
    def _ended(message: bytes) -> AgentTurn:
        """The turn's end. An error of the engine itself that the ledger did not record (the proxy
        records every refusal) is the engine's own failure: it names an identifier, never text."""
        try:
            document = as_object(json.loads(message))
        except ValueError:
            document = None
        info = as_object(document.get("info")) if document else None
        if info is not None and info.get("error") is not None:
            raise EngineError(
                ErrorCode.DYNAMIC_ENGINE_UNAVAILABLE,
                f"the engine ended its turn with an error ({turn_end_note(message)})",
            )
        return AgentTurn(text=answer_text(message), note=turn_end_note(message))
