# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the job host runs a turn of the Implementer (#765): refuses it on a Worker that did not
advertise the engine, starts the process with what only it needs, asks the lease before a push and
delivers the report within 4 MB; a stop is reported `runner_shutdown`."""

import json
from pathlib import Path
from typing import Any

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
from code_reviewer_runner.job import JobError, parse_job, parse_runnable_job
from code_reviewer_runner.job_loop.api import ClaimedJob, LeaseLost
from code_reviewer_runner.job_loop.host import (
    IMPLEMENTER_STDOUT_KEEP_BYTES,
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
    "RUNNER_IMPLEMENTER_NETWORK": "registries",
    "RUNNER_IMPLEMENTER_EGRESS_PORT": "10182",
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
        assert spec.env[ENGINES_VARIABLE] == ",".join(ALL_THREE)
        assert spec.env[OPENCODE_COMMAND_VARIABLE] == "/usr/local/bin/opencode"
        assert spec.env[RIPGREP_PATH_VARIABLE] == "/usr/local/bin/rg"
        assert spec.env["RUNNER_IMPLEMENTER_WORK_DIR"] == "/work"
        assert spec.env["RUNNER_IMPLEMENTER_EGRESS_PORT"] == "10182"
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
        assert "implementer" not in result

    run(scenario)
