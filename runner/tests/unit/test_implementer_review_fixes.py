# SPDX-License-Identifier: LicenseRef-Proprietary

"""The findings of the two reviews of #765: the texts of the report,
the deadline of the turn and the scrub of the line. Each test fails without its fix."""

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from loop_support import outcome
from support import API_KEY, TOKEN

from code_reviewer_runner import runner
from code_reviewer_runner.implementer.report import (
    MAX_SUBJECT_CHARS,
    clip_texts,
    valid_block,
)
from code_reviewer_runner.implementer.session import ImplementerSession, SessionSeams
from code_reviewer_runner.job import JobError, parse_implementer_input
from code_reviewer_runner.job_loop.reporting import fit_request, result_from_outcome
from code_reviewer_runner.redaction import REDACTED, Redactor
from code_reviewer_runner.result import ErrorCode, JobResult

EXAMPLE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "examples"
    / "implementer"
    / "RunnerJobInput.json"
)
BASE = "1" * 40
HEAD = "9" * 40


def block(**changes: Any) -> dict[str, Any]:
    return {
        "baseCommit": BASE,
        "headCommit": HEAD,
        "pushed": True,
        "branches": [{"name": "work/b", "head": HEAD, "result": "pushed", "reason": None}],
        "commits": [{"sha": HEAD, "subject": "Add it"}],
        "filesChanged": [{"path": "src/a.ts", "status": "added"}],
        "summary": "Done.",
        "opencode": {"sessionId": "ses_1", "version": "1.19.0"},
        **changes,
    }


def line(report: object, **changes: Any) -> bytes:
    document: dict[str, Any] = {
        "ok": True,
        "durationMs": 5,
        "commentUrl": None,
        "errorCode": None,
        "logTail": "done",
        "logTruncated": False,
        "usage": None,
        "implementer": report,
        **changes,
    }
    return json.dumps(document).encode() + b"\n"


# -- R3: a text that redaction made longer --------------------------------------------------------


# #765-R3
def test_a_subject_that_redaction_makes_longer_does_not_cost_the_result() -> None:
    secret = "xy123"
    hostile = secret * 98  # 490 characters; each becomes ten
    redactor = Redactor([secret])
    report = block(
        commits=[{"sha": HEAD, "subject": hostile}],
        filesChanged=[{"path": secret * 800, "status": "added"}],  # 4000 characters
    )

    result = result_from_outcome(outcome(stdout=line(report)), redactor, 5, implementer=True)
    body = fit_request(result)

    assert result["ok"] is True
    assert REDACTED in result["implementer"]["commits"][0]["subject"]
    assert len(result["implementer"]["commits"][0]["subject"]) == MAX_SUBJECT_CHARS
    assert len(result["implementer"]["filesChanged"][0]["path"]) == 4096
    assert valid_block(body["implementer"]) is not None
    assert body["implementer"]["summary"] == "Done."


# -- R4: what the app takes out of a path before it judges it -------------------------------------


# #765-R4
def test_a_file_the_app_would_refuse_is_left_out_and_the_rest_of_the_report_stays() -> None:
    files = [
        {"path": "\x01", "status": "added"},
        {"path": "\x00\x1f", "status": "modified"},
        {"path": "src/a.ts", "status": "added"},
        {"path": "\x85", "status": "added"},  # the app keeps it: it is no C0 control
        {"path": "tab\there", "status": "added"},
    ]
    report = block(filesChanged=files)

    assert valid_block(report) is None  # as sent, the app would refuse the whole result
    result = result_from_outcome(outcome(stdout=line(report)), Redactor([]), 5, implementer=True)

    assert result["ok"] is True
    assert [f["path"] for f in result["implementer"]["filesChanged"]] == [
        "src/a.ts",
        "\x85",
        "tab\there",
    ]
    assert result["implementer"]["summary"] == "Done."
    assert result["implementer"]["commits"] == report["commits"]


# #765-R4
def test_the_process_side_drops_them_too() -> None:
    cleaned = clip_texts(block(filesChanged=[{"path": "\x01", "status": "added"}]))

    assert cleaned["filesChanged"] == []
    assert valid_block(cleaned) is not None


# -- R5c: the deadline of the turn ----------------------------------------------------------------


def job() -> Any:
    document = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    document["git"]["token"] = TOKEN
    document["llm"]["apiKey"] = API_KEY
    document["implementer"]["limits"]["timeLimitSeconds"] = 3600
    return parse_implementer_input(json.dumps(document))


def session_with(max_seconds: float | None) -> ImplementerSession:
    return ImplementerSession(
        job(),
        workspace=None,  # type: ignore[arg-type]  # the deadline reads none of it
        command=("opencode",),
        egress=None,  # type: ignore[arg-type]
        environment={},
        started=0.0,
        seams=SessionSeams(clock=lambda: 100.0),
        max_seconds=max_seconds,
    )


# #765-R5c
def test_the_turn_is_held_to_the_smaller_of_its_limit_and_the_process_timeout() -> None:
    # 3600 s limit: 180 s kept back, 100 s spent.
    assert session_with(None)._deadline_seconds() == 3600 - 180 - 100  # pyright: ignore[reportPrivateUsage]
    # A timeout of 600 s leaves 600 - 180 - 100 for the agent, so the last push still happens.
    assert session_with(600)._deadline_seconds() == 600 - 180 - 100  # pyright: ignore[reportPrivateUsage]
    # A timeout above the limit changes nothing.
    assert session_with(7200)._deadline_seconds() == 3600 - 180 - 100  # pyright: ignore[reportPrivateUsage]


# -- R6: the scrub of the printed line ------------------------------------------------------------


def printed(report: dict[str, Any]) -> JobResult:
    return JobResult(
        ok=True,
        duration_ms=1,
        comment_url=None,
        error_code=None,
        log_tail="fine",
        implementer=report,
    )


# #765-R6: the second stage of `_ensure_clean`.
@pytest.mark.parametrize("field", ["summary", "subject", "path"])
def test_a_secret_left_in_a_text_of_the_report_is_replaced_and_the_report_stays_readable(
    field: str,
) -> None:
    secret = "cap-0123456789abcdef"
    report = block(
        summary=f"s {secret}" if field == "summary" else "s",
        commits=[{"sha": HEAD, "subject": f"c {secret}" if field == "subject" else "c"}],
        filesChanged=[{"path": f"{secret}.ts" if field == "path" else "a.ts", "status": "added"}],
    )

    cleaned = runner._ensure_clean(printed(report), [secret])  # pyright: ignore[reportPrivateUsage]

    assert secret not in cleaned.to_line()
    assert cleaned.implementer is not None
    assert valid_block(cleaned.implementer) is not None
    assert cleaned.implementer["headCommit"] == HEAD and cleaned.implementer["pushed"] is True
    assert cleaned.log_tail == REDACTED


# #765-R6
def test_a_result_without_a_secret_is_left_as_it_is() -> None:
    result = printed(block())

    assert runner._ensure_clean(result, ["nothing-like-it"]) is result  # pyright: ignore[reportPrivateUsage]
