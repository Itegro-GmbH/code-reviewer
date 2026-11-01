# SPDX-License-Identifier: LicenseRef-Proprietary

"""Turns what a job process did into the `result` of a `complete` request.

The job process prints one line of JSON (`JobResult`) and exits with 0 or 1. The loop does not
trust it blindly: the line is checked field by field against the contract, the log tail is
redacted again with the secrets of this job and cut to the limit, and a process that did not
produce a usable line (it crashed, was killed, printed nothing) becomes a failure with a stable
code and the end of its stderr. The request must stay under the 64 KiB the app accepts, so the
result is shrunk before it is sent, never after a 413.
"""

import json
import logging
import math
import re
from collections.abc import Mapping
from enum import StrEnum
from typing import Any, Protocol

from code_reviewer_runner.dynamic_review.call_trace import valid_call_trace
from code_reviewer_runner.implementer.report import (
    clip_texts,
    escaped_size,
    fit_block,
    valid_block,
)
from code_reviewer_runner.job_loop.jsonvalues import as_object
from code_reviewer_runner.job_loop.process import ProcessOutcome
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import NO_RESULT_REASON, ErrorCode

MAX_LOG_TAIL_CHARS = 4096
MAX_ERROR_MESSAGE_CHARS = 500
MAX_COMMENT_URL_CHARS = 2048
MAX_DURATION_MS = 604_800_000
# The app refuses a body over 65,536 bytes; stay well under it (the lease token is in the body too).
MAX_REQUEST_BYTES = 48 * 1024
# The most findings the app accepts in a count (`MAX_FINDING_COUNT`, runner API contract).
MAX_FINDING_COUNT = 100_000
_FINDING_PRIORITIES = ("P0", "P1", "P2", "P3")
RUNNER_SHUTDOWN = "runner_shutdown"
# The finer names (`errorReason`) of the failures the loop makes itself for a job process that held
# the job (#273). The model may have been used and nobody can say how much, so the app counts the
# run with an unknown cost instead of voiding it. `no_result_from_process`: a process that left no
# usable result (ended by the loop's hard timeout, killed by a signal, no result line).
# `unreadable_usage`: a failed result whose usage could not be read.
UNREADABLE_USAGE_REASON = "unreadable_usage"
_ERROR_CODE = re.compile(r"[a-z][a-z0-9_]{0,63}")
# The finer name of a failure (a checkout reason): the same shape as a code, never free text.
_ERROR_REASON = _ERROR_CODE
_COMMENT_URL = re.compile(r"https?://\S+")
_ESCAPE_SEQUENCE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")

# Why a wrapped-up run stopped: the values of `RunnerUsage.stoppedEarly` in the runner API
# contract. The app never approves a review that carries one.
STOPPED_EARLY_REASONS = ("cost_limit", "project_cost_limit", "time_limit", "token_limit")

Result = dict[str, Any]

_log = logging.getLogger("code_reviewer_runner.loop.reporting")


class DroppedValue(StrEnum):
    """The stable codes of the log line for a malformed value of a result line that was dropped."""

    FINDINGS_INVALID = "RESULT_FINDINGS_INVALID"
    STOPPED_EARLY_INVALID = "RESULT_STOPPED_EARLY_INVALID"
    CALL_TRACE_INVALID = "RESULT_CALL_TRACE_INVALID"
    IMPLEMENTER_INVALID = "RESULT_IMPLEMENTER_INVALID"


def _log_dropped(code: DroppedValue) -> None:
    # The code only: what a job process printed is untrusted and may hold anything.
    _log.warning("%s", code.value)


class TextRedactor(Protocol):
    def redact(self, text: str) -> str: ...


def clean_text(text: str, redactor: TextRedactor, limit: int) -> str:
    """Printable, redacted text, the newest `limit` characters of it."""
    text = _ESCAPE_SEQUENCE.sub("", text.replace("\r\n", "\n"))
    text = _CONTROL.sub(" ", text)
    # A lone surrogate (from a broken byte sequence) cannot be encoded; it must not poison the body.
    text = text.encode("utf-8", errors="replace").decode("utf-8")
    text = redactor.redact(text)
    return text[-limit:] if len(text) > limit else text


def failure_result(
    code: str,
    message: str,
    *,
    duration_ms: int,
    log_tail: str = "",
    log_truncated: bool = False,
    redactor: TextRedactor | None = None,
    reason: str | None = None,
) -> Result:
    """A failure the loop itself reports (invalid job, timeout, shutdown, crashed process).

    `reason` is the stable finer name of a failure of a job process that held the job and left no
    usable result (`NO_RESULT_REASON`); a failure before the process started has none.
    """
    redactor = redactor or Redactor(())
    result: Result = {
        "ok": False,
        "durationMs": _duration(duration_ms),
        "commentUrl": None,
        "errorCode": code,
        "errorMessage": clean_text(message, redactor, MAX_ERROR_MESSAGE_CHARS),
        "logTail": clean_text(log_tail, redactor, MAX_LOG_TAIL_CHARS),
        "logTruncated": log_truncated,
        "usage": None,
    }
    if reason is not None:
        result["errorReason"] = reason
    return result


def _duration(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return 0
    return max(0, min(int(value), MAX_DURATION_MS))


def _last_line(raw: bytes) -> str | None:
    for line in reversed(raw.decode("utf-8", errors="replace").splitlines()):
        if line.strip():
            return line
    return None


def _parse_line(raw: bytes) -> dict[str, Any] | None:
    line = _last_line(raw)
    if line is None:
        return None
    try:
        value = as_object(json.loads(line))
    except (ValueError, RecursionError):
        return None
    return value if value is not None and isinstance(value.get("ok"), bool) else None


def _count(usage: Mapping[str, Any], name: str) -> int | None:
    item = usage.get(name)
    return item if isinstance(item, int) and not isinstance(item, bool) and item >= 0 else None


def _usage(value: object) -> dict[str, Any] | None:
    usage = as_object(value)
    if usage is None:
        return None
    model = usage.get("model")
    cost = usage.get("costUsd")
    fallback = usage.get("fallbackUsed")
    names = ("promptTokens", "completionTokens", "totalTokens", "aiCalls")
    numbers = [_count(usage, name) for name in names]
    cost_ok = cost is None or (
        isinstance(cost, (int, float))
        and not isinstance(cost, bool)
        and math.isfinite(cost)
        and cost >= 0
    )
    # What the app decides `APPROVE` from: it never approves a review that stopped early, and it
    # refuses a reason that is none of the contract's. A usage that does not say it fails closed:
    # left out whole, the app sees no model work behind the run and never approves.
    stopped = usage.get("stoppedEarly")
    if stopped is not None and not (isinstance(stopped, str) and stopped in STOPPED_EARLY_REASONS):
        _log_dropped(DroppedValue.STOPPED_EARLY_INVALID)
        return None
    if (
        any(number is None for number in numbers)
        or not isinstance(fallback, bool)
        or not (model is None or (isinstance(model, str) and len(model) <= 200))
        or not cost_ok
    ):
        return None
    document: dict[str, Any] = {
        "model": model,
        "promptTokens": numbers[0],
        "completionTokens": numbers[1],
        "totalTokens": numbers[2],
        "aiCalls": numbers[3],
        "fallbackUsed": fallback,
        "costUsd": cost,
    }
    if stopped is not None:
        document["stoppedEarly"] = stopped
    # By how much the run passed its cost limit (#540): a fact, so a malformed value is left out
    # and the rest of the usage is still reported.
    excess = usage.get("limitExceededBy")
    if (
        isinstance(excess, (int, float))
        and not isinstance(excess, bool)
        and math.isfinite(excess)
        and excess > 0
    ):
        document["limitExceededBy"] = excess
    # The per-call trace (#541) is observability: one that is not the contract's is left out, and
    # the usage, the cost and the verdict stay.
    raw_trace = usage.get("callTrace")
    if raw_trace is not None:
        trace = valid_call_trace(raw_trace)
        if trace is None:
            _log_dropped(DroppedValue.CALL_TRACE_INVALID)
        else:
            document["callTrace"] = trace
    return document


def _finding_count(value: object) -> bool:
    return (
        isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_FINDING_COUNT
    )


def _findings(value: object) -> dict[str, Any] | None:
    """The findings a successful review left open (#405), checked against the contract.

    The app decides the review verdict from them, so they are passed on exactly or not at all: a
    shape the app would refuse (and with it the whole result) is left out, and the app then submits
    no verdict, as for a runner that does not say.
    """
    findings = as_object(value)
    if findings is None or not set(findings) <= {"open", "bySeverity", "incomplete"}:
        return None
    if not _finding_count(findings.get("open")) or "bySeverity" not in findings:
        return None
    severities = findings["bySeverity"]
    if severities is not None:
        counts = as_object(severities)
        if counts is None or set(counts) != set(_FINDING_PRIORITIES):
            return None
        if not all(_finding_count(count) for count in counts.values()):
            return None
        severities = {priority: counts[priority] for priority in _FINDING_PRIORITIES}
    document: dict[str, Any] = {"open": findings["open"], "bySeverity": severities}
    incomplete = findings.get("incomplete")
    if incomplete is not None and not isinstance(incomplete, bool):
        return None
    if incomplete is True:
        document["incomplete"] = True
    return document


def _redacted_block(block: Mapping[str, Any], redactor: TextRedactor) -> Result:
    """The block with the secrets of the job gone from every text in it. The agent wrote the
    summary, the subjects and (by naming files) the paths; the runner redacted them once, and this
    is the second look of the host."""
    redacted = {
        **block,
        "summary": redactor.redact(block["summary"]),
        "commits": [
            {"sha": commit["sha"], "subject": redactor.redact(commit["subject"])}
            for commit in block["commits"]
        ],
        "filesChanged": [
            {"path": redactor.redact(file["path"]), "status": file["status"]}
            for file in block["filesChanged"]
        ],
    }
    # Redaction can make a text longer: a text the bound now refuses would cost the whole result.
    return clip_texts(redacted)


def _sanitize(
    line: Mapping[str, Any],
    redactor: TextRedactor,
    measured_ms: int,
    *,
    implementer: bool = False,
) -> Result:
    ok = line["ok"] is True
    code: Any = line.get("errorCode")
    error_code: str | None = None
    if not ok:
        error_code = code if isinstance(code, str) and _ERROR_CODE.fullmatch(code) else "unknown"
    url: Any = line.get("commentUrl")
    comment_url: str | None = None
    if (
        isinstance(url, str)
        and len(url) <= MAX_COMMENT_URL_CHARS
        and _COMMENT_URL.fullmatch(url)
        and redactor.redact(url) == url
    ):
        comment_url = url
    tail: Any = line.get("logTail")
    result: Result = {
        "ok": ok,
        "durationMs": _duration(line.get("durationMs", measured_ms)),
        "commentUrl": comment_url,
        "errorCode": error_code,
        "logTail": clean_text(tail if isinstance(tail, str) else "", redactor, MAX_LOG_TAIL_CHARS),
        "logTruncated": line.get("logTruncated") is True,
        "usage": _usage(line.get("usage")),
    }
    if ok and (sent := line.get("findings")) is not None:
        if (findings := _findings(sent)) is None:
            _log_dropped(DroppedValue.FINDINGS_INVALID)
        else:
            result["findings"] = findings
    reason: Any = line.get("errorReason")
    if not ok and isinstance(reason, str) and _ERROR_REASON.fullmatch(reason):
        result["errorReason"] = reason
    elif not ok and result["usage"] is None and line.get("usage") is not None:
        # A usage was sent but cannot be read: the run did reach the model (#273).
        result["errorReason"] = UNREADABLE_USAGE_REASON
    if implementer:
        return _with_implementer_block(result, line, redactor, measured_ms)
    return result


def _cleaned(sent: object) -> object:
    block = as_object(sent)
    return sent if block is None else clip_texts(block)


def _with_implementer_block(
    result: Result, line: Mapping[str, Any], redactor: TextRedactor, measured_ms: int
) -> Result:
    """The block of a turn: checked against the contract, or left out. A failed turn may have none
    (no repository existed yet). A turn that says it succeeded without a usable block did not do its
    job: the app would refuse the result, so it becomes a failure that keeps its usage."""
    sent = line.get("implementer")
    # The files the app would refuse are left out first: one odd path must not cost the report.
    block = None if sent is None else valid_block(_cleaned(sent))
    redacted = None if block is None else valid_block(_redacted_block(block, redactor))
    if sent is not None and redacted is None:
        _log_dropped(DroppedValue.IMPLEMENTER_INVALID)
    if redacted is not None:
        result["implementer"] = redacted
        return result
    if result["ok"]:
        failed = failure_result(
            ErrorCode.RUNNER_ERROR.value,
            "the job process reported a turn without a usable report",
            duration_ms=measured_ms,
            redactor=redactor,
            reason=NO_RESULT_REASON,
        )
        failed["usage"] = result["usage"]
        return failed
    return result


def result_from_outcome(
    outcome: ProcessOutcome,
    redactor: TextRedactor,
    measured_ms: int,
    *,
    implementer: bool = False,
) -> Result:
    """The result of a process that ended by itself. `implementer`: the job was a turn of the
    Implementer, whose result carries the block (and no other kind's may)."""
    line = _parse_line(outcome.stdout)
    stderr_tail = outcome.stderr.decode("utf-8", errors="replace")
    if line is not None and outcome.exit_code in (0, 1) and (outcome.exit_code == 0) == line["ok"]:
        return _sanitize(line, redactor, measured_ms, implementer=implementer)
    # No usable line, or a line and an exit code that disagree: the process did not do its job.
    if outcome.exit_code < 0:
        message = f"the job process was ended by signal {-outcome.exit_code}"
    elif line is None:
        message = f"the job process exited with code {outcome.exit_code} without a result"
    else:
        message = "the job process result and exit code disagree"
    return failure_result(
        ErrorCode.RUNNER_ERROR.value,
        message,
        duration_ms=measured_ms,
        log_tail=stderr_tail,
        log_truncated=outcome.stderr_truncated,
        redactor=redactor,
        reason=NO_RESULT_REASON,
    )


def stopped_result(
    outcome: ProcessOutcome | None,
    redactor: TextRedactor,
    measured_ms: int,
    *,
    implementer: bool,
) -> Result:
    """The result of a job the host ended because the runner was stopped: always `runner_shutdown`.

    A turn of the Implementer that was stopped has pushed what was committed and printed its result
    before it went (`runner_shutdown`, the block with the head and the summary, and what the model
    cost): those are kept, because the app records them on the session of the turn when it gives
    the job back and the person finds the branch there. Whatever else the process printed (a
    different code, a success) is not: the host stopped it. Without a usable line, or for any other
    kind, the result is the bare one.
    """
    stderr = "" if outcome is None else outcome.stderr.decode("utf-8", errors="replace")
    result = failure_result(
        RUNNER_SHUTDOWN,
        "the runner was shut down before the job finished",
        duration_ms=measured_ms,
        log_tail=stderr,
        redactor=redactor,
    )
    line = _parse_line(outcome.stdout) if outcome is not None and implementer else None
    if line is None:
        return result
    kept = _sanitize(
        {**line, "ok": False, "errorCode": RUNNER_SHUTDOWN}, redactor, measured_ms, implementer=True
    )
    for name in ("usage", "implementer"):
        if kept.get(name) is not None:
            result[name] = kept[name]
    return result


def _without_trace(result: Mapping[str, Any]) -> Result:
    """The result without `usage.callTrace` (#541): the part that is given up first."""
    usage = as_object(result.get("usage"))
    if usage is None or "callTrace" not in usage:
        return dict(result)
    return {
        **result,
        "usage": {name: value for name, value in usage.items() if name != "callTrace"},
    }


def fit_request(result: Result) -> Result:
    """Shrink the `complete` body until it is small enough; never loses the verdict.

    The per-call trace (#541) goes first, whole: it is observability, and the usage and the log are
    what the app needs. Only when the body is still too large does the log tail lose its older half.

    The report of a turn of the Implementer (#765) is the exception to the 48 KiB: the rest of the
    result is shrunk to them as above, and the report gets what is left of 4 MB, the most a
    platform lets through (files are given up first, then commits: `implementer/report.py`).
    """
    block = result.get("implementer")
    if block is not None:
        rest = {name: value for name, value in result.items() if name != "implementer"}
        shrunk = fit_request(rest)
        return {**shrunk, "implementer": fit_block(block, escaped_size(shrunk))}
    current = dict(result)
    if len(json.dumps(current)) > MAX_REQUEST_BYTES:
        current = dict(_without_trace(current))
    while len(json.dumps(current)) > MAX_REQUEST_BYTES:
        tail = current["logTail"]
        if not tail:
            current["errorMessage"] = ""
            current["usage"] = None
            break
        current["logTail"] = tail[(len(tail) + 1) // 2 :]
        current["logTruncated"] = True
    return current


def _short_block(block: Mapping[str, Any]) -> Result:
    """The report of a turn when even the whole result was refused: where it ended and the head
    commit, no file list and no summary."""
    return {
        **block,
        "commits": list(block["commits"])[-1:],
        "filesChanged": [],
        "summary": "",
    }


def minimal(result: Mapping[str, Any], *, keep_usage: bool = True) -> Result:
    """Only the verdict: the fallback when the app refuses the full result (400 or 413).

    A failure keeps its stable code and reason, and says them in one line of log, so the Runs view
    still shows why the run failed. It keeps its usage too: what the run cost does not depend on the
    size of the log, and a failure the app could not count would be spend nobody sees (#273). When
    the usage itself is what the app refuses, `keep_usage=False` sends the verdict without it, so
    the verdict is never lost.
    """
    reason = result.get("errorReason")
    verdict: Result = {
        "ok": result["ok"],
        "durationMs": result["durationMs"],
        "commentUrl": result.get("commentUrl"),
        "errorCode": result["errorCode"],
        "logTail": "",
        "logTruncated": True,
        "usage": None,
    }
    if "implementer" in result:
        # A turn's verdict is its short report: the app refuses a success without one.
        verdict["implementer"] = _short_block(result["implementer"])
    if result["ok"]:
        # What the app decides the review verdict from is part of the verdict of a success (#517).
        if "findings" in result:
            verdict["findings"] = result["findings"]
        return verdict
    verdict["usage"] = _without_trace(result).get("usage") if keep_usage else None
    verdict["logTail"] = f"{result['errorCode']}" + (f" [{reason}]" if reason else "")
    if reason:
        verdict["errorReason"] = reason
    return verdict
