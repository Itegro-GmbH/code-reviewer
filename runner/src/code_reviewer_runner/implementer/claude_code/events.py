# SPDX-License-Identifier: LicenseRef-Proprietary

"""What Claude Code prints, read for the runner (#856): `claude -p --output-format stream-json
--verbose --include-partial-messages` writes one JSON object per line.

* `LineSplitter` cuts the bytes the exec channel delivers into whole JSON lines, bounded;
* `ClaudeEvents` turns each event into the engine-shaped event (`message.updated`,
  `message.part.updated`) that `StepConverter` already reads, so that the bounds (16 KiB of text,
  4 KiB of tool input, 5,000 records), the redaction and the rule that a tool's output is never
  recorded stay where they are, and `StepFeeder` does not change;
* `parse_result` reads the `result` event that ends a turn: how it ended, the text, the session and
  the cost figure, which is an **estimate**.

The shapes are those of Claude Code 2.1.311 (R0 spike, `docs/runner.md`, "Spikes R0"). Nothing here
runs a process or reaches a network.
"""

import json
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any, Final, cast

from .command import FINISH_TOOL

# The longest line taken. A tool result is in a `user` event whole (a file read, a command's
# output), so a line may be large; one over this is dropped and counted, the stream goes on.
MAX_LINE_BYTES: Final = 8 * 1024 * 1024

# What `result.modelUsage.<model>.costBasis` says of a price that comes from Anthropic's list.
COST_BASIS_LIST: Final = "list"
# What the step record says of a tool that failed (a command's output is never recorded).
TOOL_FAILED: Final = "failed"
SUBTYPE_SUCCESS: Final = "success"
SUBTYPE_BUDGET: Final = "error_max_budget_usd"
# `claude --resume <id>` with nothing at that id (an empty session volume) fails without a model
# call; the runner starts a fresh session instead.
_NO_CONVERSATION: Final = "no conversation found"
_NOT_LOGGED_IN: Final = "not logged in"
# The `error` field Claude Code puts on the assistant message of a failed API call (the SDK's
# `SDKAssistantMessageError`), and the HTTP statuses of the same call (`result.api_error_status`).
# These are structured fields; the text of a result is what the agent said, or what Claude Code
# prints for a person at a terminal, and is never read for a meaning.
API_ERROR_AUTH: Final = "authentication_failed"
API_ERRORS_LIMIT: Final = ("rate_limit", "billing_error")
STATUSES_AUTH: Final = (401,)
STATUSES_LIMIT: Final = (402, 429)
# The model is unknown to the account, or the subscription does not include it (#980): Anthropic
# answers 404 for a model the caller may not use. `invalid_request` alone (a 400) is any bad
# request and says nothing of the model.
STATUSES_MODEL: Final = (404,)
# What Claude Code itself prints in `errors` when the selected model is refused. Only its own
# `errors` field is read for it, as for the other sentences; never the agent's text.
_MODEL_REFUSED: Final = "issue with the selected model"


class LineSplitter:
    """Whole JSON objects out of chunks of bytes. A line that is not a JSON object (a warning
    Claude Code printed to standard output) or is longer than the bound is counted in `ignored`."""

    def __init__(self, max_line_bytes: int = MAX_LINE_BYTES) -> None:
        self._max = max_line_bytes
        self._carry = bytearray()
        self._skipping = False
        self.ignored = 0

    def feed(self, chunk: bytes) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        data = chunk
        while data:
            newline = data.find(b"\n")
            part = data if newline < 0 else data[:newline]
            data = b"" if newline < 0 else data[newline + 1 :]
            if not self._skipping:
                self._carry += part
                if len(self._carry) > self._max:
                    self._skipping = True
                    self._carry.clear()
            if newline < 0:
                break
            self._end_line(found)
        return found

    def finish(self) -> list[dict[str, Any]]:
        """The last line, when the output ended without a newline."""
        found: list[dict[str, Any]] = []
        if self._carry or self._skipping:
            self._end_line(found)
        return found

    def _end_line(self, found: list[dict[str, Any]]) -> None:
        line, skipped = bytes(self._carry).strip(), self._skipping
        self._carry.clear()
        self._skipping = False
        if skipped:
            self.ignored += 1
            return
        if not line:
            return
        try:
            parsed: Any = json.loads(line)
        except ValueError:
            self.ignored += 1
            return
        if isinstance(parsed, dict):
            found.append(cast("dict[str, Any]", parsed))
        else:
            self.ignored += 1


def _ms(stamp: Any) -> int | None:
    """An ISO time stamp (`2026-11-04T21:35:55.880Z`) in epoch milliseconds."""
    if not isinstance(stamp, str):
        return None
    try:
        return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _object(value: Any) -> dict[str, Any]:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else {}


def _blocks(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        cast("dict[str, Any]", item) for item in cast("list[Any]", value) if isinstance(item, dict)
    ]


class ClaudeEvents:
    """The adapter of Claude Code's `stream-json` for the live view. Needs
    `--include-partial-messages`: only its `message_delta` carries the final token counts of a
    model call (`output_tokens` of an `assistant` event is 1, the count of `message_start`).

    * `assistant` event (one per content block, all blocks of one model call share `message.id`):
      `thinking` -> a `reasoning` part, `text` -> a `text` part (both finished: the event comes
      when the block ended), `tool_use` -> a `tool` part, status `running`, part id = the
      `tool_use` id;
    * `user` event with a `tool_result` block -> the same tool part again, `completed`, or `error`.
      The text of a failing result is **not** recorded (`TOOL_FAILED` instead): Claude Code puts a
      failing command's whole output into it, and a tool's output is never recorded. The one
      exception is the finish tool, whose refusal says what is wrong with the result the agent
      handed in, which the agent and the page need;
    * `stream_event` `message_delta` -> a `step-finish` part with the call's tokens (no price: a
      per-call cost is in no event; `result.total_cost_usd` is the turn's total). It ends a model
      call, so the call's message and its blocks are forgotten there, as a tool is at its result:
      a session of thousands of calls holds nothing it has finished with;
    * `system`, `result` and the rest -> nothing here (`parse_result` reads the end).
    """

    def __init__(self, session_id: str) -> None:
        self.session = session_id
        self._messages: set[str] = set()
        self._blocks: Counter[str] = Counter()
        self._tools: dict[str, tuple[str, Any, int | None, str]] = {}
        self._current = ""
        self._api_error: str | None = None

    def take_api_error(self) -> str | None:
        """The `error` of the failed API call seen since the last time, once."""
        found, self._api_error = self._api_error, None
        return found

    @property
    def tracked(self) -> int:
        """How many tools, messages and blocks are held (zero between calls of a long session)."""
        return len(self._tools) + len(self._messages) + len(self._blocks)

    def _event(self, kind: str, **properties: Any) -> dict[str, Any]:
        return {"type": kind, "properties": {"sessionID": self.session, **properties}}

    def _part(self, part: dict[str, Any], at: int | None) -> dict[str, Any]:
        return self._event("message.part.updated", part=part, time=at)

    def convert(self, event: Mapping[str, Any]) -> list[dict[str, Any]]:
        kind = event.get("type")
        at = _ms(event.get("timestamp"))
        if kind == "assistant":
            return self._assistant(event, _object(event.get("message")), at)
        if kind == "user":
            return self._results(_object(event.get("message")), at)
        if kind == "stream_event":
            inner = _object(event.get("event"))
            if inner.get("type") == "message_start":
                self._current = str(_object(inner.get("message")).get("id"))
            if inner.get("type") == "message_delta":
                found = self._step(inner, at)
                self._messages.discard(self._current)
                self._blocks.pop(self._current, None)
                return found
        return []

    def _assistant(
        self, event: Mapping[str, Any], message: dict[str, Any], at: int | None
    ) -> list[dict[str, Any]]:
        error = event.get("error")
        if isinstance(error, str) and error:
            self._api_error = error
        identifier = str(message.get("id"))
        found: list[dict[str, Any]] = []
        if identifier not in self._messages:
            self._messages.add(identifier)
            found.append(
                self._event("message.updated", info={"id": identifier, "role": "assistant"})
            )
        for block in _blocks(message.get("content")):
            self._blocks[identifier] += 1
            part_id = f"{identifier}.{self._blocks[identifier]}"
            kind = block.get("type")
            if kind in ("thinking", "text"):
                found.append(
                    self._part(
                        {
                            "id": part_id,
                            "type": "reasoning" if kind == "thinking" else "text",
                            "messageID": identifier,
                            "text": block.get("thinking" if kind == "thinking" else "text"),
                            "time": {"start": at, "end": at},
                        },
                        at,
                    )
                )
            if kind == "tool_use":
                call = str(block.get("id"))
                self._tools[call] = (str(block.get("name")), block.get("input"), at, identifier)
                found.append(self._tool_part(call, "running", at, None))
        return found

    def _tool_part(
        self, call: str, status: str, at: int | None, error: str | None
    ) -> dict[str, Any]:
        name, arguments, started, message = self._tools[call]
        state: dict[str, Any] = {
            "status": status,
            "input": arguments,
            "time": {"start": started, **({"end": at} if status != "running" else {})},
        }
        if error is not None:
            state["error"] = error
        return self._part(
            {
                "id": call,
                "type": "tool",
                "tool": name,
                "callID": call,
                "messageID": message,
                "state": state,
            },
            at,
        )

    def _results(self, message: dict[str, Any], at: int | None) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        for block in _blocks(message.get("content")):
            call = str(block.get("tool_use_id"))
            if block.get("type") != "tool_result" or call not in self._tools:
                continue
            failed = bool(block.get("is_error"))
            found.append(
                self._tool_part(
                    call,
                    "error" if failed else "completed",
                    at,
                    self._failure(self._tools[call][0], block) if failed else None,
                )
            )
            del self._tools[call]
        return found

    @staticmethod
    def _failure(tool: str, block: dict[str, Any]) -> str:
        if tool != FINISH_TOOL:
            return TOOL_FAILED
        text: Any = block.get("content")
        if isinstance(text, list):
            text = " ".join(str(b.get("text", "")) for b in _blocks(text))
        return str(text)

    def _step(self, inner: dict[str, Any], at: int | None) -> list[dict[str, Any]]:
        usage = _object(inner.get("usage"))
        part = {
            "id": f"{self._current}.step",
            "type": "step-finish",
            "messageID": self._current,
            "reason": _object(inner.get("delta")).get("stop_reason"),
            "tokens": {
                "input": usage.get("input_tokens"),
                "output": usage.get("output_tokens"),
                "reasoning": 0,
                "cache": {
                    "read": usage.get("cache_read_input_tokens"),
                    "write": usage.get("cache_creation_input_tokens"),
                },
            },
        }
        return [self._part(part, at)]


@dataclass(frozen=True)
class ClaudeResult:
    """How a turn ended, from the `result` event."""

    subtype: str
    is_error: bool
    text: str
    session_id: str | None
    terminal_reason: str | None
    permission_denials: int
    # The sentences of `errors` (an empty session volume is only said there, not in `result`).
    errors: tuple[str, ...]
    # The turn's cost at Anthropic's list prices, only when Claude Code priced **every** model of
    # the turn from its list (`costBasis: list`). Otherwise None: unknown. It is an estimate for
    # the display "≈ ... through a subscription"; it is never billed and never added to our totals.
    estimated_cost_usd: Decimal | None
    # How the last API call of the turn failed: the `error` of its assistant message (read by
    # `ClaudeEvents`) and the HTTP status of the result; None when neither says.
    api_error: str | None = None
    api_error_status: int | None = None

    @property
    def ok(self) -> bool:
        return self.subtype == SUBTYPE_SUCCESS and not self.is_error

    @property
    def budget_exhausted(self) -> bool:
        return self.subtype == SUBTYPE_BUDGET

    def _says(self, sentence: str) -> bool:
        """Whether Claude Code's own `errors` or `subtype` say it. Never `text`: that is what the
        agent wrote, and an agent that says "not logged in" has not failed the login."""
        return self.is_error and any(
            sentence in words.lower() for words in (self.subtype, *self.errors)
        )

    @property
    def missing_conversation(self) -> bool:
        return self._says(_NO_CONVERSATION)

    @property
    def not_logged_in(self) -> bool:
        """No login, or one that is expired or revoked (Claude Code answers 401)."""
        return self.is_error and (
            self.api_error == API_ERROR_AUTH
            or self.api_error_status in STATUSES_AUTH
            or self._says(_NOT_LOGGED_IN)
        )

    @property
    def model_refused(self) -> bool:
        """The call was refused because of the model: it does not exist for this login, or the
        subscription does not include it (#980). Not measured against the real program yet (the
        spike did not provoke it): the structured status 404 and Claude Code's own sentence."""
        return self.is_error and (
            self.api_error_status in STATUSES_MODEL or self._says(_MODEL_REFUSED)
        )

    @property
    def usage_limit(self) -> bool:
        """The subscription's usage limit (or a billing refusal) ended the call."""
        return self.is_error and (
            self.api_error in API_ERRORS_LIMIT or self.api_error_status in STATUSES_LIMIT
        )


def estimated_cost(result: Mapping[str, Any]) -> Decimal | None:
    total = result.get("total_cost_usd")
    if isinstance(total, bool) or not isinstance(total, (int, float)):
        return None
    usage = _object(result.get("modelUsage"))
    if not usage:
        return None
    if any(_object(model).get("costBasis") != COST_BASIS_LIST for model in usage.values()):
        return None
    amount = Decimal(str(total))
    # JSON that Python reads takes `NaN` and `Infinity`; neither, nor a negative, is a cost.
    return amount if amount.is_finite() and amount >= 0 else None


def parse_result(event: Mapping[str, Any], api_error: str | None = None) -> ClaudeResult:
    """The end of a turn. Reads what is there and trusts nothing: a missing or odd field is a
    failed turn with no text and no cost, never an exception. `api_error` is what
    `ClaudeEvents.take_api_error` saw of the turn."""
    status = event.get("api_error_status")
    text, session = event.get("result"), event.get("session_id")
    denials = event.get("permission_denials")
    reason = event.get("terminal_reason")
    errors = event.get("errors")
    return ClaudeResult(
        subtype=str(event.get("subtype") or ""),
        is_error=event.get("is_error") is not False,
        text=text if isinstance(text, str) else "",
        session_id=session if isinstance(session, str) and session else None,
        terminal_reason=reason if isinstance(reason, str) else None,
        permission_denials=len(cast("list[Any]", denials)) if isinstance(denials, list) else 0,
        errors=tuple(e for e in cast("list[Any]", errors) if isinstance(e, str))
        if isinstance(errors, list)
        else (),
        api_error=api_error,
        api_error_status=status
        if isinstance(status, int) and not isinstance(status, bool)
        else None,
        estimated_cost_usd=estimated_cost(event),
    )
