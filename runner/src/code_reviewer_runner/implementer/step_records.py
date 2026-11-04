# SPDX-License-Identifier: LicenseRef-Proprietary

"""The step records of an Implementer turn (#745): what the agent thinks and does, in our own shape.

The engine's events are converted into one record per part of its messages, so that a person can
follow the turn while it runs. The record is ours, not the engine's: a document that followed the
engine's parts would make the contract follow the engine.

- `reasoning`: a finished reasoning part, with the text the provider returned (often a summary);
- `text`: a finished assistant text part;
- `tool`: a tool part, with tool name, status, title, the input as JSON text and the error text;
- `step`: a `step-finish` part, with the tokens and the cost of one model call.

A part is reported again when it changes (a tool part: running, then completed), with the same
`partId` and a higher `seq`; whoever stores the records keeps the highest `seq` per part.

**The output of a tool is never recorded.** What the live view shows is the call, not what the
repository answered; the output stays in the engine's own session.

**Bounds.** Text of reasoning and answer parts is cut at 16 KiB, a tool input at 4 KiB, an error at
4 KiB and a title at 512 bytes, always on a UTF-8 boundary, with a `[N bytes cut]` mark and the
true size (`bytes`). A turn keeps at most 5,000 records and 2 MiB of text. After that only the
tool calls go on, as name and status (at most 10,000 more records), and `shortened` is set.

**Secrets.** Every text is redacted with the job's `Redactor` before it is put in a record, and the
cut is made after it, so that a cut cannot leave the front half of a secret. The repository itself
is the exposure the redactor cannot know (a committed `.env` the agent printed); the page shows
plain text only and the docs say that a member can read what the agent read.

The converter is pure: it keeps a few counters and small tables, and it does no I/O. The events are
the engine's report and untrusted data; a shape it does not know is skipped, never evaluated.
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, Final

from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.redaction import Redactor

PART_EVENT: Final = "message.part.updated"
MESSAGE_EVENT: Final = "message.updated"

REASONING: Final = "reasoning"
TEXT: Final = "text"
TOOL: Final = "tool"
STEP: Final = "step"

MAX_TEXT_BYTES: Final = 16 * 1024
MAX_INPUT_BYTES: Final = 4 * 1024
MAX_ERROR_BYTES: Final = 4 * 1024
MAX_TITLE_BYTES: Final = 512
MAX_NAME_CHARS: Final = 128
MAX_ID_CHARS: Final = 256
MAX_RECORDS: Final = 5_000
MAX_TEXT_TOTAL_BYTES: Final = 2 * 1024 * 1024
MAX_SHORT_RECORDS: Final = 10_000
# The converter holds one status per tool part and one role per message, and both are bounded: an
# engine that reports without end cannot make the runner hold without end.
MAX_TRACKED_PARTS: Final = 20_000
MAX_TRACKED_MESSAGES: Final = 2_000
# How much more than the cap is redacted before the cut, so that a text of megabytes costs no more
# than a text of kilobytes; a secret that begins before the cut is whole within this margin.
_MARGIN: Final = 1024
_PENDING: Final = "pending"


@dataclass(frozen=True)
class StepRecord:
    """One record. `as_json` is the document that leaves the process; `weight` is what the record
    holds in memory, for the bounds of whoever queues it."""

    kind: str
    part_id: str
    seq: int
    started_at: int | None = None
    ended_at: int | None = None
    text: str | None = None
    size: int | None = None
    tool: str | None = None
    status: str | None = None
    title: str | None = None
    input: str | None = None
    error: str | None = None
    reason: str | None = None
    tokens: Mapping[str, int] | None = None
    cost: float | None = None
    weight: int = 0

    def as_json(self) -> dict[str, Any]:
        document: dict[str, Any] = {"kind": self.kind, "partId": self.part_id, "seq": self.seq}
        optional: dict[str, Any] = {
            "startedAt": self.started_at,
            "endedAt": self.ended_at,
            "text": self.text,
            "bytes": self.size,
            "tool": self.tool,
            "status": self.status,
            "title": self.title,
            "input": self.input,
            "error": self.error,
            "reason": self.reason,
            "tokens": None if self.tokens is None else dict(self.tokens),
            "cost": self.cost,
        }
        document.update({key: value for key, value in optional.items() if value is not None})
        return document


class StepConverter:
    """Turns the events of one session into records, in the order they arrive. Not thread-safe: one
    reader feeds it."""

    def __init__(self, session_id: str, redactor: Redactor) -> None:
        self._session = session_id
        self._redactor = redactor
        self._guard = max(redactor.longest, 64)
        self._seq = 0
        self._full = 0
        self._short = 0
        self._text_total = 0
        self.shortened = False
        self._roles: dict[str, str] = {}
        self._tool_status: dict[str, str] = {}

    def convert(self, event: Mapping[str, Any]) -> StepRecord | None:
        """The record this event makes, or None. Raises on nothing it was given except a bug."""
        kind = event.get("type")
        if kind not in (PART_EVENT, MESSAGE_EVENT):
            return None
        properties = as_object(event.get("properties"))
        if properties is None or properties.get("sessionID") != self._session:
            return None
        if kind == MESSAGE_EVENT:
            self._note_message(properties)
            return None
        part = as_object(properties.get("part"))
        part_id = None if part is None else part.get("id")
        if part is None or not isinstance(part_id, str) or not 0 < len(part_id) <= MAX_ID_CHARS:
            return None
        record = self._record(part, part_id, _ms(properties.get("time")))
        return None if record is None else self._admit(record)

    # -- the parts ------------------------------------------------------------

    def _record(self, part: Mapping[str, Any], part_id: str, at: int | None) -> StepRecord | None:
        kind = part.get("type")
        if kind == TOOL:
            return self._tool(part, part_id)
        if self.shortened:
            return None  # only the tool calls go on
        if kind == REASONING or (
            kind == TEXT and self._roles.get(_text(part, "messageID")) == "assistant"
        ):
            return self._words(part, part_id, kind)
        if kind == "step-finish":
            return self._step(part, part_id, at)
        return None

    def _words(self, part: Mapping[str, Any], part_id: str, kind: str) -> StepRecord | None:
        text = part.get("text")
        if not isinstance(text, str) or not text.strip():
            return None
        time = as_object(part.get("time"))
        ended = None if time is None else _ms(time.get("end"))
        if time is not None and ended is None:
            return None  # still being written: the part is reported again when it ends
        shown, size, held = self._cut(text, MAX_TEXT_BYTES)
        return StepRecord(
            kind=kind,
            part_id=part_id,
            seq=0,
            started_at=None if time is None else _ms(time.get("start")),
            ended_at=ended,
            text=shown,
            size=size,
            weight=held,
        )

    def _tool(self, part: Mapping[str, Any], part_id: str) -> StepRecord | None:
        state = as_object(part.get("state"))
        status = None if state is None else state.get("status")
        if state is None or not isinstance(status, str) or status == _PENDING:
            return None
        if self._tool_status.get(part_id) == status:
            return None  # a running tool is reported again and again as its metadata changes
        if part_id not in self._tool_status and len(self._tool_status) >= MAX_TRACKED_PARTS:
            return None
        self._tool_status[part_id] = status
        time = as_object(state.get("time"))
        name = self._redactor.redact(_text(part, "tool"))[:MAX_NAME_CHARS]
        record = StepRecord(
            kind=TOOL,
            part_id=part_id,
            seq=0,
            started_at=None if time is None else _ms(time.get("start")),
            ended_at=None if time is None else _ms(time.get("end")),
            tool=name,
            status=status[:32],
            weight=64 + len(name),
        )
        if self.shortened:
            return record
        return self._tool_detail(record, state)

    def _tool_detail(self, record: StepRecord, state: Mapping[str, Any]) -> StepRecord:
        title, _, titled = self._cut(_text(state, "title"), MAX_TITLE_BYTES)
        arguments = json.dumps(
            as_object(state.get("input")) or {}, ensure_ascii=False, separators=(",", ":")
        )
        shown, _, held = self._cut(arguments, MAX_INPUT_BYTES)
        error, weight = None, record.weight + titled + held
        if record.status == "error":
            error, _, errored = self._cut(_text(state, "error"), MAX_ERROR_BYTES)
            weight += errored
        return replace(record, title=title or None, input=shown, error=error, weight=weight)

    def _step(self, part: Mapping[str, Any], part_id: str, at: int | None) -> StepRecord:
        tokens = as_object(part.get("tokens")) or {}
        cache = as_object(tokens.get("cache")) or {}
        cost = _number(part.get("cost"), 1e9)
        return StepRecord(
            kind=STEP,
            part_id=part_id,
            seq=0,
            ended_at=at,
            reason=_text(part, "reason")[:64] or None,
            tokens={
                "input": _count(tokens.get("input")),
                "output": _count(tokens.get("output")),
                "reasoning": _count(tokens.get("reasoning")),
                "cacheRead": _count(cache.get("read")),
                "cacheWrite": _count(cache.get("write")),
            },
            cost=cost,
            weight=64,
        )

    def _note_message(self, properties: Mapping[str, Any]) -> None:
        info = as_object(properties.get("info"))
        identity = None if info is None else info.get("id")
        role = None if info is None else info.get("role")
        if (
            not isinstance(identity, str)
            or not isinstance(role, str)
            or len(identity) > MAX_ID_CHARS
        ):
            return
        self._roles.pop(identity, None)
        self._roles[identity] = role[:16]
        if len(self._roles) > MAX_TRACKED_MESSAGES:
            del self._roles[next(iter(self._roles))]  # the oldest: a message long done

    # -- the bounds of the turn -----------------------------------------------

    def _admit(self, record: StepRecord) -> StepRecord | None:
        if not self.shortened and (
            self._full >= MAX_RECORDS or self._text_total + record.weight > MAX_TEXT_TOTAL_BYTES
        ):
            self.shortened = True
            if record.kind == TOOL:
                record = replace(record, title=None, input=None, error=None, weight=64)
        if self.shortened:
            if record.kind != TOOL or self._short >= MAX_SHORT_RECORDS:
                return None
            self._short += 1
        else:
            self._full += 1
            self._text_total += record.weight
        self._seq += 1
        return replace(record, seq=self._seq)

    # -- text -----------------------------------------------------------------

    def _cut(self, text: str, cap: int) -> tuple[str, int, int]:
        """`text` redacted and cut to `cap` bytes on a character boundary, with the mark when
        something is cut. Returns the text, the true size in bytes and the bytes held."""
        raw = text.encode("utf-8", errors="replace")
        size = len(raw)
        before_cut = size > cap + _MARGIN
        head = raw[: cap + _MARGIN] if before_cut else raw
        shown = self._redactor.redact(head.decode("utf-8", errors="ignore"))
        if before_cut:
            # The end of a text that was cut may be the front half of a secret: it is not shown.
            shown = shown[: max(len(shown) - self._guard, 0)]
        data = shown.encode("utf-8")
        if len(data) > cap:
            shown = data[:cap].decode("utf-8", errors="ignore")
        elif not before_cut:
            return shown, size, len(data)
        kept = len(shown.encode("utf-8"))
        shown = f"{shown}\n[{max(size - kept, 1)} bytes cut]"
        return shown, size, len(shown.encode("utf-8"))


def _text(source: Mapping[str, Any], key: str) -> str:
    value = source.get(key)
    return value if isinstance(value, str) else ""


def _number(value: Any, below: float) -> float | None:
    """`value` when it is a number from zero up to `below`, else None (a bool is not one)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if 0 <= value < below else None


def _count(value: Any) -> int:
    number = _number(value, 1e12)
    return 0 if number is None else int(number)


def _ms(value: Any) -> int | None:
    """An epoch time in milliseconds, or None for anything that is not one."""
    number = _number(value, 1e15)
    return None if number is None else int(number)
