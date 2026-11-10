# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the job host runs a turn of the Implementer (#765): refuses it on a Worker that did not
advertise the engine, starts the process with what only it needs, asks the lease before a push and
delivers the report within 4 MB; a stop is reported `runner_shutdown`."""

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from loop_support import Harness, make_claim, outcome, run, settle
from support import API_KEY, TOKEN

from code_reviewer_runner.capabilities import (
    ALL_ENGINES,
    ENGINE_DIFF,
    ENGINE_IMPLEMENTER,
    ENGINES_VARIABLE,
    OPENCODE_COMMAND_VARIABLE,
    RIPGREP_PATH_VARIABLE,
)
from code_reviewer_runner.job import ImplementerInput, JobError, parse_job, parse_runnable_job
from code_reviewer_runner.job_loop import host as host_module
from code_reviewer_runner.job_loop.api import ClaimedJob, HeartbeatReply, LeaseLost
from code_reviewer_runner.job_loop.host import (
    IMPLEMENTER_STDOUT_KEEP_BYTES,
    IMPLEMENTER_TERMINATE_GRACE_SECONDS,
    JobEnd,
)
from code_reviewer_runner.job_loop.process import STDOUT_KEEP_BYTES
from code_reviewer_runner.lease_check import LeaseState
from code_reviewer_runner.result import ErrorCode

EXAMPLE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "examples"
    / "implementer"
    / "RunnerJobInput.json"
)
ALL_THREE = (*ALL_ENGINES, ENGINE_IMPLEMENTER)
USERS = {"diff_job_user": (10001, 10001), "dynamic_engine_user": (10101, 10101)}
PROFILE = {
    "RUNNER_DYNAMIC_ENGINE_UID": "10101",
    "RUNNER_DYNAMIC_ENGINE_GID": "10101",
    "RUNNER_DYNAMIC_PROXY_PORT": "10180",
    "RUNNER_DYNAMIC_ENGINE_PORT": "10181",
    "RUNNER_DYNAMIC_MAX_COST_USD": "0.50",
    "RUNNER_DYNAMIC_CAPABILITIES": '{"tool_choice_required": true}',
    "RUNNER_IMPLEMENTER_WORK_DIR": "/work",
    "RUNNER_IMPLEMENTER_MODEL_DOOR": "docker",
    "RUNNER_IMPLEMENTER_SANDBOX_PROOF": "proven",
    "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB": "2560",
}
HEAD = "9" * 40


def implementer_input() -> dict[str, Any]:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    document["git"]["token"] = TOKEN
    document["llm"]["apiKey"] = API_KEY
    return document


def implementer_claim(number: int = 1) -> ClaimedJob:
    return ClaimedJob(
        id=make_claim(number).id,
        lease_token=make_claim(number).lease_token,
        heartbeat_interval=30.0,
        input=implementer_input(),
    )


def advertising_harness(**settings: Any) -> Harness:
    return Harness(
        **USERS,
        engines=ALL_THREE,
        dynamic_command=("/usr/local/bin/opencode",),
        dynamic_ripgrep="/usr/local/bin/rg",
        environment={**PROFILE, "OPENAI_API_KEY": "must-not-pass"},
        **settings,
    )


def report(**changes: Any) -> dict[str, Any]:
    return {
        "baseCommit": "1" * 40,
        "headCommit": HEAD,
        "pushed": True,
        "branches": [{"name": "work/b", "head": HEAD, "result": "pushed", "reason": None}],
        "commits": [{"sha": HEAD, "subject": "Add it"}],
        "filesChanged": [{"path": "a.ts", "status": "added"}],
        "summary": "Done.",
        "opencode": {"sessionId": "ses_1", "version": "1.19.0"},
        **changes,
    }


def line(**changes: Any) -> bytes:
    document: dict[str, Any] = {
        "ok": True,
        "durationMs": 5,
        "commentUrl": None,
        "errorCode": None,
        "logTail": "pushed",
        "logTruncated": False,
        "usage": None,
        "implementer": report(),
    }
    document.update(changes)
    return json.dumps(document).encode() + b"\n"


# -- T03 ------------------------------------------------------------------------------------------


# #765-T03
def test_a_worker_that_did_not_advertise_the_engine_refuses_the_job_with_its_code() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS, engines=ALL_ENGINES, environment=PROFILE)
        harness.api.claims = [implementer_claim()]

        await harness.start()

        assert harness.launcher.processes == []
        assert harness.end is JobEnd.FAILED
        result = harness.api.completions[0][2]
        assert result["ok"] is False
        assert result["errorCode"] == ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE.value
        assert "implementer" not in result
        assert TOKEN not in json.dumps(result)

    run(scenario)


# #765-T03
def test_a_diff_only_worker_refuses_it_too() -> None:
    async def scenario() -> None:
        harness = Harness(engines=(ENGINE_DIFF,))
        harness.api.claims = [implementer_claim()]

        await harness.start()

        assert harness.launcher.processes == []
        assert harness.api.completions[0][2]["errorCode"] == "implementer_engine_unavailable"

    run(scenario)


# #765-T03
def test_the_review_path_still_refuses_the_kind_and_the_runnable_path_reads_it() -> None:
    raw = json.dumps(implementer_input())

    try:
        parse_job(raw)
    except JobError as refused:
        assert refused.code is ErrorCode.IMPLEMENTER_ENGINE_UNAVAILABLE
    else:
        raise AssertionError("the review path ran an implementer job")
    assert parse_runnable_job(raw).implementer.branch == "implementer/a1b2c3"  # type: ignore[union-attr]


# -- the process of an advertised engine ----------------------------------------------------------


# #765-T04
def test_a_turn_starts_as_the_root_supervisor_with_what_only_it_needs() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]

        await harness.start()

        spec = harness.launcher.processes[0].spec
        assert spec.run_as is None  # root: it drops the engine to its own user
        assert spec.lease_check is not None
        assert spec.stdout_keep_bytes == IMPLEMENTER_STDOUT_KEEP_BYTES > 4_500_000
        # A stopped turn has the time to end its engine and push (#765-R5b).
        assert spec.terminate_grace == IMPLEMENTER_TERMINATE_GRACE_SECONDS == 120.0
        assert spec.env[ENGINES_VARIABLE] == ",".join(ALL_THREE)
        assert spec.env[OPENCODE_COMMAND_VARIABLE] == "/usr/local/bin/opencode"
        assert spec.env[RIPGREP_PATH_VARIABLE] == "/usr/local/bin/rg"
        assert spec.env["RUNNER_IMPLEMENTER_WORK_DIR"] == "/work"
        assert spec.env["RUNNER_IMPLEMENTER_MODEL_DOOR"] == "docker"
        assert spec.env["RUNNER_IMPLEMENTER_SANDBOX_PROOF"] == "proven"
        assert spec.env["RUNNER_IMPLEMENTER_AGENT_MEMORY_MB"] == "2560"
        assert spec.env["RUNNER_DYNAMIC_ENGINE_UID"] == "10101"
        # The Dynamic Review's own settings and the operator's other variables stay out.
        assert "RUNNER_DYNAMIC_MAX_COST_USD" not in spec.env
        assert "RUNNER_DYNAMIC_CAPABILITIES" not in spec.env
        assert "OPENAI_API_KEY" not in spec.env
        # The credentials go in on stdin only.
        assert TOKEN not in json.dumps(spec.env) and API_KEY not in json.dumps(spec.env)
        assert TOKEN.encode() in spec.stdin
        await harness.stop()

    run(scenario)


# #765-T04
def test_a_turn_gets_the_environment_control_of_its_sandbox() -> None:
    # #975-T02: the session of the job process reads the transport; without it a configured vsock
    # control would fall through to "no transport" and the agent would start under the wide rule.
    async def scenario() -> None:
        harness = Harness(
            **USERS,
            engines=ALL_THREE,
            dynamic_command=("/usr/local/bin/opencode",),
            dynamic_ripgrep="/usr/local/bin/rg",
            environment={**PROFILE, "RUNNER_ENVIRONMENT_CONTROL": "vsock"},
        )
        harness.api.claims = [implementer_claim()]

        await harness.start()

        assert harness.launcher.processes[0].spec.env["RUNNER_ENVIRONMENT_CONTROL"] == "vsock"
        await harness.stop()

    run(scenario)


def test_the_engine_user_is_swept_after_a_turn() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

        assert harness.sweeps == [(10101, 10101)]

    run(scenario)


# #765-T04
def test_the_other_kinds_keep_the_small_stdout_and_their_users() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS, engines=ALL_ENGINES, environment=PROFILE)
        harness.api.claims = [make_claim(1)]
        await harness.start()

        spec = harness.launcher.processes[0].spec
        assert spec.stdout_keep_bytes == STDOUT_KEEP_BYTES
        assert spec.terminate_grace is None  # the launcher's own
        assert spec.run_as == (10001, 10001)
        assert spec.lease_check is None
        assert ENGINES_VARIABLE not in spec.env
        await harness.stop()

    run(scenario)


# -- the report -----------------------------------------------------------------------------------


# #765-T04
def test_a_finished_turn_is_delivered_once_with_its_report() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()

        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

        assert harness.end is JobEnd.OK
        assert len(harness.api.completions) == 1
        delivered = harness.api.completions[0][2]
        assert delivered["ok"] is True
        assert delivered["implementer"] == report()

    run(scenario)


# #765-T04
def test_a_failed_turn_without_a_repository_is_delivered_without_the_key() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        failed = json.loads(line(ok=False, errorCode="clone_failed", implementer=None))
        del failed["implementer"]

        harness.launcher.processes[0].finish(outcome(1, json.dumps(failed).encode() + b"\n"))
        await settle()

        delivered = harness.api.completions[0][2]
        assert delivered["errorCode"] == "clone_failed"
        assert "implementer" not in delivered

    run(scenario)


# #765-T04
def test_a_report_that_is_too_big_is_delivered_under_4_mb() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        wide = "\U0001f600"
        files = [{"path": f"{n:04d}" + wide * 4092, "status": "added"} for n in range(500)]
        big = report(filesChanged=files)

        harness.launcher.processes[0].finish(outcome(stdout=line(implementer=big)))
        await settle()

        delivered = harness.api.completions[0][2]
        assert len(json.dumps(delivered, separators=(",", ":")).encode("ascii")) < 4_000_000
        assert delivered["implementer"]["commits"] == big["commits"]
        assert 0 < len(delivered["implementer"]["filesChanged"]) < 500

    run(scenario)


# -- the lease and a stop -------------------------------------------------------------------------


# #765-T05
def test_the_process_is_confirmed_while_the_lease_is_held_and_refused_once_it_is_lost() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        spec = harness.launcher.processes[0].spec
        assert spec.lease_check is not None

        assert await spec.lease_check() is LeaseState.HELD
        harness.api.heartbeat_errors = [LeaseLost("not held", 409)]
        assert await spec.lease_check() is LeaseState.LOST
        await harness.stop()

    run(scenario)


# #765-T05
def test_a_lost_lease_ends_the_process_and_delivers_nothing() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        harness.api.heartbeat_errors = [LeaseLost("not held", 409)]

        await harness.clock.advance(31)

        assert harness.launcher.processes[0].terminated
        assert harness.end is JobEnd.LEASE_LOST
        assert harness.api.completions == []

    run(scenario)


# #765-T06
def test_a_stop_ends_the_process_and_reports_runner_shutdown() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()

        harness.loop.request_force()
        await settle()

        assert harness.launcher.processes[0].terminated
        assert harness.end is JobEnd.GIVEN_BACK
        result = harness.api.completions[0][2]
        assert result["errorCode"] == "runner_shutdown"
        # The process printed nothing before it went: the result is the bare one.
        assert "implementer" not in result and result["usage"] is None

    run(scenario)


USAGE = {
    "model": "m",
    "promptTokens": 100,
    "completionTokens": 10,
    "totalTokens": 110,
    "aiCalls": 3,
    "fallbackUsed": False,
    "costUsd": 0.0123,
}


# #765-R1: the job pushed and printed its result when it was stopped; the host gives it on.
def test_a_stopped_turn_reports_what_it_pushed_and_what_it_cost() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        # Printed by the job process on SIGTERM: runner_shutdown, the block, the usage. It even says
        # something else about the code than the host will: the host decides what a stop is.
        printed = line(ok=False, errorCode="lease_lost", usage=USAGE, implementer=report())
        harness.launcher.processes[0].printed_on_terminate = printed

        harness.loop.request_force()
        await settle()

        result = harness.api.completions[0][2]
        assert harness.end is JobEnd.GIVEN_BACK
        assert result["ok"] is False and result["errorCode"] == "runner_shutdown"
        assert result["implementer"] == report()
        assert result["usage"]["aiCalls"] == 3 and result["usage"]["costUsd"] == 0.0123

    run(scenario)


# #765-R1
def test_a_stop_keeps_no_report_that_is_not_one_and_no_secret() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        broken = report(baseCommit="main", summary=f"key {API_KEY}")
        harness.launcher.processes[0].printed_on_terminate = line(
            ok=False, errorCode="runner_shutdown", usage=USAGE, implementer=broken
        )

        harness.loop.request_force()
        await settle()

        result = harness.api.completions[0][2]
        assert result["errorCode"] == "runner_shutdown"
        assert "implementer" not in result
        assert result["usage"]["aiCalls"] == 3
        assert API_KEY not in json.dumps(result)

    run(scenario)


# #765-R1: only a turn of the Implementer may carry the report; a Diff job's stop stays bare.
def test_the_stop_of_another_kind_stays_bare() -> None:
    async def scenario() -> None:
        harness = Harness(**USERS, engines=ALL_ENGINES, environment=PROFILE)
        harness.api.claims = [make_claim(1)]
        await harness.start()
        harness.launcher.processes[0].printed_on_terminate = line(
            ok=False, errorCode="runner_shutdown", usage=USAGE
        )

        harness.loop.request_force()
        await settle()

        result = harness.api.completions[0][2]
        assert result["errorCode"] == "runner_shutdown"
        assert "implementer" not in result and result["usage"] is None

    run(scenario)


# #765-R5b: how long one lease question of an Implementer turn may take. The budget is the loop's
# own clock, so the tests shorten the constants; the real ones are checked against each other below.
def _slow_app(harness: Harness, seconds: float) -> None:
    async def answers_late(job_id: str, token: str) -> Any:
        await asyncio.sleep(seconds)
        return HeartbeatReply(superseded=False, lease_expires_at=None)

    harness.api.heartbeat = answers_late  # type: ignore[method-assign]


# #765: at a normal end an app that answers slowly (15 s in real life) lets the last push through.
def test_a_slow_app_does_not_cost_a_good_turn_its_last_push_at_a_normal_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        monkeypatch.setattr(host_module, "IMPLEMENTER_LEASE_CHECK_BUDGET_SECONDS", 1.5)
        monkeypatch.setattr(host_module, "IMPLEMENTER_STOP_LEASE_CHECK_BUDGET_SECONDS", 0.2)
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        spec = harness.launcher.processes[0].spec
        assert spec.lease_check is not None
        _slow_app(harness, 0.6)  # slower than a stop allows, inside the normal budget

        answer = await asyncio.wait_for(spec.lease_check(), 5)

        assert answer is LeaseState.HELD
        await harness.stop()

    run(scenario)


# #765: while the runner is stopped the question keeps its short bound.
def test_the_same_slow_app_is_not_waited_for_while_the_runner_is_stopped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        monkeypatch.setattr(host_module, "IMPLEMENTER_LEASE_CHECK_BUDGET_SECONDS", 1.5)
        monkeypatch.setattr(host_module, "IMPLEMENTER_STOP_LEASE_CHECK_BUDGET_SECONDS", 0.2)
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()
        spec = harness.launcher.processes[0].spec
        assert spec.lease_check is not None
        _slow_app(harness, 0.6)
        harness.host.request_hard_stop()

        answer = await asyncio.wait_for(spec.lease_check(), 5)

        assert answer is LeaseState.UNCONFIRMED
        await harness.stop()

    run(scenario)


# #765: the real numbers. The last push of a normal end fits the grace it keeps, a stop its minute.
def test_the_lease_budgets_fit_the_grace_of_the_end_and_of_the_stop() -> None:
    from code_reviewer_runner.implementer.git_workspace import CONFIRM_SECONDS
    from code_reviewer_runner.implementer.session import GRACE_SECONDS, STOP_CONFIRM_SECONDS

    normal = host_module.IMPLEMENTER_LEASE_CHECK_BUDGET_SECONDS
    stop = host_module.IMPLEMENTER_STOP_LEASE_CHECK_BUDGET_SECONDS
    assert normal == 25.0 and stop == 10.0 and host_module.LEASE_CHECK_BUDGET_SECONDS > 10.0
    # Asked again inside the window, the last push of a normal end takes one question past it.
    assert CONFIRM_SECONDS + normal < GRACE_SECONDS
    # A stop: the question and its window inside half the two minutes; the rest is the engine,
    # the readers and the push.
    assert STOP_CONFIRM_SECONDS + stop <= host_module.IMPLEMENTER_TERMINATE_GRACE_SECONDS / 2


# -- T01: the parse ---------------------------------------------------------------------------


def _edit(path: tuple[str, ...], value: Any) -> dict[str, Any]:
    document = implementer_input()
    target: Any = document
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value
    return document


# #765-T01
def test_a_valid_implementer_job_is_parsed_into_its_own_type() -> None:
    parsed = parse_runnable_job(json.dumps(implementer_input()))

    assert isinstance(parsed, ImplementerInput)
    assert parsed.implementer.repo.full_name == "acme/widgets"
    assert parsed.git.token == TOKEN


# #765-T01: unknown fields, missing fields and values of the wrong type are refused with the name
# of the field, and the refusal names no value (the strings below must not come back).
def test_a_refusal_names_the_field_and_echoes_no_value() -> None:
    cases: list[tuple[dict[str, Any], str]] = [
        (_edit(("implementer", "surprise-value-1"), "echo-me-1"), "implementer"),
        (_edit(("implementer", "branch"), 42), "implementer.branch"),
        (_edit(("implementer", "limits", "timeLimitSeconds"), "echo-me-2"), "timeLimitSeconds"),
        (_edit(("surprise-top-2",), "echo-me-3"), "surprise-top-2"),
    ]
    missing = implementer_input()
    del missing["implementer"]["instruction"]
    cases.append((missing, "implementer.instruction"))

    for document, field in cases:
        with pytest.raises(JobError) as refused:
            parse_runnable_job(json.dumps(document))
        text = f"{refused.value} {refused.value.detail}"
        assert refused.value.code is ErrorCode.INVALID_JOB
        assert field in text, text
        assert "echo-me" not in text
        assert TOKEN not in text and API_KEY not in text
