# SPDX-License-Identifier: LicenseRef-Proprietary

"""The `implementer` block of a result (#765): its bounds, the 4 MB the body is held to, what a
body without a repository looks like, and what the job host lets through."""

import json
from typing import Any

import pytest
from loop_support import outcome
from support import API_KEY, TOKEN

from code_reviewer_runner.implementer.history import MAX_COMMITS, MAX_FILES
from code_reviewer_runner.implementer.report import (
    BODY_BUDGET_BYTES,
    MAX_BRANCHES,
    MAX_SUMMARY_CHARS,
    escaped_size,
    fit_block,
    valid_block,
)
from code_reviewer_runner.job_loop.reporting import (
    MAX_REQUEST_BYTES,
    fit_request,
    minimal,
    result_from_outcome,
)
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.result import ErrorCode, JobResult, Usage

REDACTOR = Redactor([TOKEN, API_KEY])
BASE = "1" * 40
HEAD = "9" * 40
# Outside the Basic Multilingual Plane: two escapes, twelve bytes, for one character.
WIDE = "\U0001f600"


def commit(number: int, subject: str = "A change") -> dict[str, str]:
    return {"sha": f"{number:040x}", "subject": subject}


def block(commits: list[dict[str, str]] | None = None, **changes: Any) -> dict[str, Any]:
    listed = [commit(1)] if commits is None else commits
    head = listed[-1]["sha"] if listed else None
    return {
        "baseCommit": BASE,
        "headCommit": head,
        "pushed": head is not None,
        "branches": []
        if head is None
        else [{"name": "work/b", "head": head, "result": "pushed", "reason": None}],
        "commits": listed,
        "filesChanged": [{"path": "src/a.ts", "status": "added"}],
        "summary": "Done.",
        "opencode": {"sessionId": "ses_1", "version": "1.19.0"},
        **changes,
    }


def pushed_branch(**changes: Any) -> dict[str, Any]:
    return {"name": "work/b", "head": HEAD, "result": "pushed", "reason": None, **changes}


def rejected_branch(**changes: Any) -> dict[str, Any]:
    return {
        "name": "other",
        "head": HEAD,
        "result": "rejected",
        "reason": "non_fast_forward",
        **changes,
    }


def worst_case() -> dict[str, Any]:
    """Every list at the contract's maximum and every character the widest the escaping makes it."""
    commits = [commit(number, WIDE * 500) for number in range(1, MAX_COMMITS + 1)]
    files = [{"path": f"{number:04d}" + WIDE * 4092, "status": "added"} for number in range(500)]
    return block(commits, filesChanged=files, summary=WIDE * MAX_SUMMARY_CHARS)


def result_with(report: dict[str, Any] | None) -> dict[str, Any]:
    wide_tail = WIDE * 1000
    document: dict[str, Any] = {
        "ok": True,
        "durationMs": 1,
        "commentUrl": None,
        "errorCode": None,
        "logTail": wide_tail,
        "logTruncated": False,
        "usage": {
            "model": "m",
            "promptTokens": 1,
            "completionTokens": 1,
            "totalTokens": 2,
            "aiCalls": 1,
            "fallbackUsed": False,
            "costUsd": 0.1,
        },
    }
    if report is not None:
        document["implementer"] = report
    return document


# -- the body is held under 4 MB, files first and then commits ------------------------------------


# #765-T04
def test_the_worst_case_report_is_over_the_platforms_limit_before_it_is_fitted() -> None:
    assert escaped_size(result_with(worst_case())) > 4_500_000 * 5


# #765-T04
def test_the_worst_case_body_is_under_4_mb_as_it_is_sent() -> None:
    body = fit_request(result_with(worst_case()))

    sent = json.dumps(body, separators=(",", ":")).encode("ascii")
    assert len(sent) < 4_000_000
    assert len(json.dumps(body)) <= BODY_BUDGET_BYTES


# #765-T04
def test_the_files_are_given_up_before_any_commit() -> None:
    body = fit_request(result_with(worst_case()))

    fitted = body["implementer"]
    assert len(fitted["commits"]) == MAX_COMMITS
    assert 0 < len(fitted["filesChanged"]) < MAX_FILES
    assert fitted["filesChanged"] == worst_case()["filesChanged"][: len(fitted["filesChanged"])]
    assert valid_block(fitted) is not None


# #765-T04
def test_when_the_files_do_not_help_enough_the_commits_go_too_and_the_head_stays_last() -> None:
    commits = [commit(number, WIDE * 500) for number in range(1, 101)]
    report = block(commits, filesChanged=worst_case()["filesChanged"])
    other = escaped_size(result_with(None))
    budget = other + 2_000 + 20 * 6_100  # room for about twenty commits and no file

    fitted = fit_block(report, other, budget)

    assert fitted["filesChanged"] == []
    assert 2 <= len(fitted["commits"]) < len(commits)
    assert fitted["commits"][-1] == commits[-1]
    assert fitted["headCommit"] == commits[-1]["sha"]
    assert fitted["commits"][:-1] == commits[: len(fitted["commits"]) - 1]
    assert other + escaped_size(fitted) <= budget
    assert valid_block(fitted) is not None


# #765-T04
def test_more_than_the_contract_allows_is_cut_to_it_even_when_it_would_fit() -> None:
    commits = [commit(number) for number in range(1, MAX_COMMITS + 51)]
    files = [{"path": f"f{number}", "status": "modified"} for number in range(MAX_FILES + 50)]

    fitted = fit_block(block(commits, filesChanged=files), 1_000)

    assert len(fitted["commits"]) == MAX_COMMITS
    assert fitted["commits"][-1] == commits[-1]
    assert len(fitted["filesChanged"]) == MAX_FILES
    assert fitted["headCommit"] == commits[-1]["sha"]


# #765-T04
def test_a_small_report_is_left_as_it_is() -> None:
    small = block()

    assert fit_block(small, 1_000) == small
    assert fit_request(result_with(small))["implementer"] == small


# #765-T04
def test_the_rest_of_the_result_is_still_held_to_its_48_kib() -> None:
    result = result_with(block())
    result["logTail"] = "x" * 100_000
    result["usage"]["callTrace"] = {"calls": ["y" * 200_000]}

    body = fit_request(result)

    assert escaped_size({k: v for k, v in body.items() if k != "implementer"}) <= MAX_REQUEST_BYTES
    assert body["implementer"] == result["implementer"]


# -- no repository: no key ------------------------------------------------------------------------


# #765-T04
def test_a_result_without_a_repository_has_no_implementer_key_and_never_a_null() -> None:
    result = JobResult(
        ok=False,
        duration_ms=1,
        comment_url=None,
        error_code=ErrorCode.CLONE_FAILED,
        log_tail="clone_failed",
    )

    assert "implementer" not in result.to_json()
    assert "implementer" not in json.loads(result.to_line())
    assert "null" not in json.dumps(result.to_json().get("implementer", 1))


# #765-T04
def test_a_result_with_a_report_carries_it_whole() -> None:
    report = block()
    result = JobResult(
        ok=True,
        duration_ms=1,
        comment_url=None,
        error_code=None,
        log_tail="",
        usage=Usage("m", 1, 1, 2, 1, False, 0.1),
        implementer=report,
    )

    assert json.loads(result.to_line())["implementer"] == report


# -- what the host lets through -------------------------------------------------------------------


def line_of(report: object, **changes: Any) -> bytes:
    document = {**result_with(None), "logTail": "done", "implementer": report, **changes}
    if report is None:
        del document["implementer"]
    return json.dumps(document).encode()


def reported(raw: bytes, *, implementer: bool = True, code: int = 0) -> dict[str, Any]:
    return result_from_outcome(
        outcome(stdout=raw + b"\n", exit_code=code), REDACTOR, 5, implementer=implementer
    )


# #765-T04
def test_the_host_passes_a_valid_report_on() -> None:
    result = reported(line_of(block()))

    assert result["ok"] is True
    assert result["implementer"] == block()


# #765-T04
def test_a_report_on_a_job_that_is_not_an_implementer_turn_is_never_passed_on() -> None:
    result = reported(line_of(block()), implementer=False)

    assert "implementer" not in result


# #765-T04
@pytest.mark.parametrize(
    "broken",
    [
        {**block(), "somethingNew": 1},
        {**block(), "baseCommit": "main"},
        {**block(), "pushed": "yes"},
        {**block(), "headCommit": None, "pushed": True},
        {**block(), "headCommit": "a" * 40},  # not the last commit
        {**block(), "commits": [{"sha": "A" * 40, "subject": "s"}]},
        {**block(), "commits": [{**commit(1), "extra": 1}]},
        {**block(), "filesChanged": [{"path": "a", "status": "moved"}]},
        {**block(), "filesChanged": [{"path": "", "status": "added"}]},
        {**block(), "summary": "x" * (MAX_SUMMARY_CHARS + 1)},
        {**block(), "opencode": {"sessionId": "s"}},
        {**block(), "branches": "main"},
        {**block(), "branches": [{"name": "a", "head": HEAD, "result": "pushed"}]},
        {**block(), "branches": [{**pushed_branch(), "extra": 1}]},
        {**block(), "branches": [{**pushed_branch(), "name": ""}]},
        {**block(), "branches": [{**pushed_branch(), "head": None}]},
        {**block(), "branches": [{**pushed_branch(), "reason": "non_fast_forward"}]},
        {**block(), "branches": [{**pushed_branch(), "result": "maybe"}]},
        {**block(), "branches": [rejected_branch(reason=None)]},
        {**block(), "branches": [rejected_branch(reason="Not Fast Forward")]},
        {**block(), "branches": [rejected_branch(reason="x" * 41)]},
        {**block(), "branches": [pushed_branch(name=f"b{n}") for n in range(MAX_BRANCHES + 1)]},
        {**block(), "commits": [commit(n) for n in range(MAX_COMMITS + 1)]},
        {**block(), "filesChanged": [{"path": "a", "status": "added"}] * (MAX_FILES + 1)},
        "not a block",
    ],
)
def test_a_report_the_app_would_refuse_is_not_passed_on(broken: object) -> None:
    assert valid_block(broken) is None


# #765-T04
def test_a_success_without_a_usable_report_becomes_a_failure_that_keeps_its_usage() -> None:
    result = reported(line_of({**block(), "baseCommit": "main"}))

    assert result["ok"] is False
    assert result["errorCode"] == "runner_error"
    assert result["errorReason"] == "no_result_from_process"
    assert result["usage"]["aiCalls"] == 1
    assert "implementer" not in result


# #765-T04
def test_a_failed_turn_with_no_report_is_a_plain_failure() -> None:
    raw = line_of(None, ok=False, errorCode="clone_failed")

    result = reported(raw, code=1)

    assert result["ok"] is False
    assert result["errorCode"] == "clone_failed"
    assert "implementer" not in result


# #765-T07
def test_the_host_takes_the_secrets_out_of_every_text_of_the_report() -> None:
    report = block(
        [commit(1, f"uses {TOKEN}")],
        summary=f"key {API_KEY} and token {TOKEN}",
        filesChanged=[{"path": f"{TOKEN}.txt", "status": "added"}],
    )

    result = reported(line_of(report))
    text = json.dumps(result)

    assert TOKEN not in text
    assert API_KEY not in text
    assert result["implementer"]["commits"][0]["sha"] == commit(1)["sha"]


# #765-T04
def test_a_refused_whole_result_is_replaced_by_a_short_report_never_by_none() -> None:
    result = result_with(worst_case())

    short = minimal(result)

    assert short["ok"] is True
    assert valid_block(short["implementer"]) is not None
    assert short["implementer"]["filesChanged"] == []
    assert short["implementer"]["summary"] == ""
    assert short["implementer"]["commits"] == [worst_case()["commits"][-1]]
    assert short["implementer"]["headCommit"] == worst_case()["headCommit"]
    assert escaped_size(short) < MAX_REQUEST_BYTES


# The git model of the owner: every pushed branch is reported with its outcome.
def test_a_report_with_pushed_and_rejected_branches_is_valid() -> None:
    report = block(
        branches=[
            pushed_branch(),
            rejected_branch(),
            rejected_branch(name="third", head=None, reason="unreadable"),
        ]
    )

    assert valid_block(report) == report


def test_a_report_with_no_branch_at_all_is_valid_for_a_turn_that_pushed_nothing() -> None:
    assert valid_block(block(commits=[], branches=[], filesChanged=[])) is not None


def test_the_branches_stay_in_a_report_that_is_fitted_to_the_body() -> None:
    report = worst_case()
    report["branches"] = [pushed_branch(name=f"b{n}") for n in range(MAX_BRANCHES)]

    fitted = fit_block(report, 0)

    assert fitted["branches"] == report["branches"]
    assert escaped_size(fitted) <= BODY_BUDGET_BYTES
