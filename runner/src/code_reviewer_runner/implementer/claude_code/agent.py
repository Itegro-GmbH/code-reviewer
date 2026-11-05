# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Claude Code agent of one Implementer turn (#856, R3): the harness adapter that
`ImplementerAgent` is for OpenCode, with the same surface (`start`, `turn`, `stop`, `abort`,
`session_id`, `steps`, `resume`, `step_notes`) so that the session can drive either.

What is different from OpenCode is the shape of the engine. OpenCode is a server the runner talks
to over a tunnel; Claude Code is **one process per message**: `claude -p` is started in the agent's
container as an exec (as the unprivileged user, `command.py`), reads the prompt on its standard
input, prints one JSON object per line and ends. The runner reads the lines as they come
(`events.py`), feeds the live view, and takes the end of the turn from the `result` event. The next
message of the same session is another `claude -p --resume <id>` in the same container, so Claude
Code's own session store (`CLAUDE_CONFIG_DIR`, in the container) carries the conversation.

What guards what: the clock is the job's (`remaining_seconds`, `check_deadline`); the money of a
subscription turn is Claude Code's own `--max-budget-usd` (there is no model door, so no ledger);
the exits and the key are the container's network and the device's login (`login.py`). Nothing here
steers the agent: no step limit, no plan.

A turn whose conversation cannot be resumed (an empty session volume: Claude Code answers "No
conversation found" without a model call) starts a fresh session under the same id and says so
(`resume`); a follow-up is never failed by it.
"""

import threading
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal
from typing import Any, Final, Protocol

from code_reviewer_runner.dynamic_review.adapter import EngineError
from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.implementer.agent import AgentTurn, CommandOutcome, ResumeOutcome
from code_reviewer_runner.implementer.preface import ResumeMode
from code_reviewer_runner.implementer.result_channel import (
    AGENT_RESULT_DIRECTORY,
    finish_files,
    finish_server_command,
)
from code_reviewer_runner.implementer.step_feed import StepFeeder
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode
from code_reviewer_runner.resume_wire import ResumeReason

from .command import AGENT_PATH, AGENT_USER, ClaudeCommand, SessionChoice, claude_environment
from .events import ClaudeEvents, ClaudeResult, LineSplitter, parse_result
from .login import ClaudeLogin

AGENT_REPO: Final = "/work/repo"
WATCH_INTERVAL_SECONDS: Final = 0.05
# The exec outlives the clock by this much, so that the clock's own limit is what ends a turn.
TIMEOUT_MARGIN_SECONDS: Final = 30.0
# Hands the repository and the result directory (made by the runner, as root) to the user Claude
# Code runs as. Constants only; the user is the argument.
_HAND_OVER: Final = (
    'chown -R "$0" /work/repo && { [ ! -d /work/result ] || chown -R "$0" /work/result; }'
)
HAND_OVER_SECONDS: Final = 120.0


class ClaudePlace(Protocol):
    """What the agent needs of the container (`AgentContainer` has it)."""

    def write_files(self, files: Mapping[str, tuple[bytes, int]]) -> None: ...

    def run_command(
        self, argv: list[str], environment: Mapping[str, str], timeout: float
    ) -> CommandOutcome:
        """As root, in the repository, to its end. Never raises for a command that fails."""
        ...

    def run_streaming(
        self,
        argv: list[str],
        environment: Mapping[str, str],
        *,
        user: str,
        stdin: bytes,
        timeout: float,
        consume: Callable[[bytes], None],
    ) -> CommandOutcome:
        """As `user`, in the repository: `stdin` in, the standard output to `consume` as it comes.
        Never raises for a command that fails or does not answer."""
        ...

    def engine_end_note(self) -> str | None: ...

    def stop(self) -> bool: ...


class ClaudeCodeAgent:
    """One session of Claude Code. `start()`, any number of `turn()`s, `stop()`."""

    def __init__(
        self,
        *,
        place: ClaudePlace,
        login: ClaudeLogin,
        model: str | None,
        session_id: str,
        secrets: Sequence[str],
        remaining_seconds: Callable[[], float],
        check_deadline: Callable[[], None],
        instructions: str | None = None,
        result_schema: Mapping[str, Any] | None = None,
        max_budget_usd: str | None = None,
        resume_from: str | None = None,
        base_url: str | None = None,
    ) -> None:
        self._place = place
        self._login = login
        self._model = model
        self._remaining = remaining_seconds
        self._check_deadline = check_deadline
        self._instructions = instructions
        self._schema = result_schema
        self._budget = max_budget_usd
        self._base_url = base_url
        # A follow-up turn resumes the stored session under its own id.
        self.session_id = resume_from or session_id
        self._resumes = resume_from is not None
        self._started = False
        self._redactor = Redactor((login.secret, *secrets))
        self.steps: StepFeeder | None = StepFeeder(self.session_id, self._redactor)
        self.resume: ResumeOutcome | None = (
            ResumeOutcome(ResumeMode.IMPORTED) if resume_from is not None else None
        )
        self.turn_seconds: list[float] = []
        self._cost = Decimal(0)
        self._cost_known = True
        self._ignored_lines = 0
        self._events = ClaudeEvents(self.session_id)

    # -- the estimate ---------------------------------------------------------

    @property
    def cost_known(self) -> bool:
        """Whether every turn so far was priced by Claude Code from its list."""
        return self._cost_known

    @property
    def estimated_cost_usd(self) -> Decimal | None:
        """The cost of the session at API prices: an estimate for the display "≈ ... through a
        subscription", never billed, never added to our totals. None when a turn was not priced."""
        return self._cost if self._cost_known else None

    # -- process --------------------------------------------------------------

    def start(self) -> None:
        """Bring the finish tool into the container and hand the work directories to Claude Code's
        user. Raises `EngineError`."""
        files: dict[str, tuple[bytes, int]] = {}
        if self._schema is not None:
            files.update(finish_files(self._schema))
        if files:
            self._place.write_files(files)
        done = self._place.run_command(
            ["/bin/sh", "-c", _HAND_OVER, AGENT_USER], {"PATH": AGENT_PATH}, HAND_OVER_SECONDS
        )
        if not done.ok:
            raise EngineError(
                ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE,
                "the work directories could not be handed to the agent's user",
            )
        self._started = True

    def stop(self) -> bool:
        """End the container and everything in it. True when nothing is left."""
        return self._place.stop()

    def abort(self) -> None:
        """Nothing to ask of a process that is ended by ending its container (`stop`)."""

    def step_notes(self) -> tuple[str, ...]:
        notes: list[str] = []
        if self._ignored_lines:
            notes.append(f"the live view could not read {self._ignored_lines} lines of the agent")
        dropped = 0 if self.steps is None else self.steps.dropped
        if dropped:
            notes.append(
                f"the live view dropped {dropped} step records that were not taken in time"
            )
        return tuple(notes)

    # -- a turn ---------------------------------------------------------------

    def turn(
        self,
        text: str | Sequence[Mapping[str, Any]],
        *,
        check: Callable[[], None] = lambda: None,
    ) -> AgentTurn:
        """Send `text` (or the text parts of a follow-up's first message) as one message and wait
        for the end of the turn. Raises `LimitError`, `EngineError` or what `check` raises."""
        if not self._started:
            raise EngineError(ErrorCode.RUNNER_ERROR, "the agent is not started")
        prompt = text if isinstance(text, str) else "\n\n".join(_text_of(part) for part in text)
        result = self._run(prompt, check)
        if result is not None and result.missing_conversation and self._resumes:
            # Nothing to continue from: a fresh session under the same id, once.
            self._resumes = False
            self.resume = ResumeOutcome(ResumeMode.SUMMARY_ONLY, ResumeReason.IMPORT_FAILED)
            result = self._run(prompt, check)
        self._resumes = True
        return self._ended(result)

    def _run(self, prompt: str, check: Callable[[], None]) -> ClaudeResult | None:
        self._check_deadline()
        remaining = self._remaining()
        if remaining <= 0:
            self._check_deadline()
            raise LimitError(ErrorCode.TIME_LIMIT_REACHED, "no time is left for the turn")
        argv = ClaudeCommand(
            model=self._model,
            session=SessionChoice.resume(self.session_id)
            if self._resumes
            else SessionChoice.new(self.session_id),
            finish_command=None if self._schema is None else finish_server_command(),
            max_budget_usd=self._budget,
            instructions=self._instructions,
        ).argv()
        environment = claude_environment(self._login, base_url=self._base_url)
        splitter = LineSplitter()
        ended: list[ClaudeResult] = []
        outcome: list[CommandOutcome] = []
        failure: list[BaseException] = []
        finished = threading.Event()

        def consume(chunk: bytes) -> None:
            for event in splitter.feed(chunk):
                self._take(event, ended)

        def run() -> None:
            try:
                outcome.append(
                    self._place.run_streaming(
                        argv,
                        environment,
                        user=AGENT_USER,
                        stdin=prompt.encode("utf-8"),
                        timeout=remaining + TIMEOUT_MARGIN_SECONDS,
                        consume=consume,
                    )
                )
                for event in splitter.finish():
                    self._take(event, ended)
            except BaseException as error:  # re-raised below, in the caller's thread
                failure.append(error)
            finally:
                finished.set()

        began = remaining
        worker = threading.Thread(target=run, daemon=True)
        worker.start()
        try:
            while not finished.wait(WATCH_INTERVAL_SECONDS):
                check()
                self._check_deadline()
        finally:
            # A process still running when the turn ends early only ends with its container, which
            # is ended right after: there is nothing to wait for.
            worker.join(timeout=5.0 if finished.is_set() else 0.2)
            self.turn_seconds.append(max(began - self._remaining(), 0.0))
            self._ignored_lines += splitter.ignored
        if failure:
            raise failure[0]
        self._check_deadline()
        if ended:
            return ended[-1]
        code = outcome[0].returncode if outcome else None
        note = self._place.engine_end_note() or f"Claude Code ended without a result (exit {code})"
        raise EngineError(ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE, note)

    def _take(self, event: dict[str, Any], ended: list[ClaudeResult]) -> None:
        if event.get("type") == "result":
            ended.append(parse_result(event, self._events.take_api_error()))
            return
        feeder = self.steps
        if feeder is None:
            return
        for engine_event in self._events.convert(event):
            feeder.feed(engine_event)

    def _ended(self, result: ClaudeResult | None) -> AgentTurn:
        assert result is not None
        if result.estimated_cost_usd is None:
            self._cost_known = False
        else:
            self._cost += result.estimated_cost_usd
        if result.budget_exhausted:
            raise LimitError(ErrorCode.COST_LIMIT_REACHED, "the turn reached its budget")
        if result.not_logged_in:
            raise EngineError(
                ErrorCode.LLM_AUTH,
                "Claude Code has no valid login on this device (none, expired, revoked: login.py)",
            )
        if result.usage_limit:
            raise LimitError(ErrorCode.LLM_QUOTA, "the subscription's usage limit is reached")
        if not result.ok:
            reason = result.terminal_reason or result.subtype or "unknown"
            raise EngineError(
                ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE,
                f"Claude Code ended its turn with an error ({reason})",
            )
        # The login is in the environment of the agent's tools, so the agent can print it: nothing
        # it said leaves this object with it in (the session redacts again with the job's secrets).
        note = result.terminal_reason or result.subtype
        return AgentTurn(text=self._redactor.redact(result.text), note=self._redactor.redact(note))


def _text_of(part: Mapping[str, Any]) -> str:
    text = part.get("text")
    return text if isinstance(text, str) else ""


__all__ = ["AGENT_REPO", "AGENT_RESULT_DIRECTORY", "ClaudeCodeAgent", "ClaudePlace"]
