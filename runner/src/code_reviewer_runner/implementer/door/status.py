# SPDX-License-Identifier: LicenseRef-Proprietary

"""The status line of the door, written and read (`protocol.py`). The reader does not trust the
line: a status that is not exactly the shape is no status."""

import math
from typing import Any

from code_reviewer_runner.dynamic_review.call_trace import valid_call_trace
from code_reviewer_runner.job_loop.jsonvalues import as_object

from .protocol import MESSAGE_STATUS, DoorFailure, DoorStatus

_KEYS = frozenset(
    {
        "t",
        "seq",
        "final",
        "modelUsed",
        "openCalls",
        "failure",
        "upstreamError",
        "usage",
        "modelCalls",
        "truncated",
    }
)
_USAGE_KEYS = frozenset(
    {
        "model",
        "promptTokens",
        "completionTokens",
        "totalTokens",
        "aiCalls",
        "fallbackUsed",
        "costUsd",
        "stoppedEarly",
        "limitExceededBy",
    }
)
_USAGE_REQUIRED = frozenset(
    {"promptTokens", "completionTokens", "totalTokens", "aiCalls", "costUsd"}
)
_MAX_COUNT = 10**12
_MAX_TEXT = 512


def status_line(status: DoorStatus) -> dict[str, Any]:
    """The object the door prints for `status`."""
    return {
        "t": MESSAGE_STATUS,
        "seq": status.seq,
        "final": status.final,
        "modelUsed": status.model_used,
        "openCalls": status.open_calls,
        "failure": None
        if status.failure is None
        else {"code": status.failure.code, "detail": status.failure.detail},
        "upstreamError": status.upstream_error,
        "usage": status.usage,
        "modelCalls": status.model_calls,
        "truncated": status.truncated,
    }


def _count(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= _MAX_COUNT


def _text(value: object) -> bool:
    return isinstance(value, str) and len(value) <= _MAX_TEXT


def _number(value: object) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value >= 0
    )


def _usage_of(value: object) -> dict[str, Any] | None:
    usage = as_object(value)
    if usage is None or not usage.keys() <= _USAGE_KEYS:
        return None
    if not usage.keys() >= _USAGE_REQUIRED:
        return None
    for name in ("promptTokens", "completionTokens", "totalTokens", "aiCalls"):
        if not _count(usage[name]):
            return None
    cost: Any = usage["costUsd"]
    if cost is not None and not _number(cost):
        return None
    for name in ("model", "stoppedEarly"):
        if usage.get(name) is not None and not _text(usage[name]):
            return None
    excess: Any = usage.get("limitExceededBy")
    if excess is not None and not _number(excess):
        return None
    return dict(usage)


def parse_status(line: object) -> DoorStatus | None:
    """The status a line says, or None for a line that is not exactly one."""
    document = as_object(line)
    if document is None or document.keys() != _KEYS or document["t"] != MESSAGE_STATUS:
        return None
    seq, final, used, opened = (
        document["seq"],
        document["final"],
        document["modelUsed"],
        document["openCalls"],
    )
    if (
        not _count(seq)
        or not isinstance(final, bool)
        or not isinstance(used, bool)
        or not _count(opened)
        or not isinstance(document["truncated"], bool)
    ):
        return None
    failure: DoorFailure | None = None
    raw_failure: Any = document["failure"]
    if raw_failure is not None:
        given = as_object(raw_failure)
        if given is None or given.keys() != {"code", "detail"}:
            return None
        if not _text(given["code"]) or not _text(given["detail"]):
            return None
        failure = DoorFailure(given["code"], given["detail"])
    upstream: Any = document["upstreamError"]
    if upstream is not None and not _text(upstream):
        return None
    usage = _usage_of(document["usage"])
    calls: Any = document["modelCalls"]
    if usage is None or not isinstance(calls, list):
        return None
    # The same check the loop makes of a trace: exactly the contract's model calls, or none.
    candidate: dict[str, Any] = {
        "truncated": document["truncated"],
        "modelCalls": calls,
        "toolCalls": [],
    }
    trace = valid_call_trace(candidate)
    if trace is None:
        return None
    return DoorStatus(
        seq=seq,
        final=final,
        model_used=used,
        open_calls=opened,
        failure=failure,
        upstream_error=upstream,
        usage=usage,
        model_calls=list(trace["modelCalls"]),
        truncated=document["truncated"],
    )
