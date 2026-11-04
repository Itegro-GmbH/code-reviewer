# SPDX-License-Identifier: LicenseRef-Proprietary

"""The steps channel with real processes and a real HTTP client (#745, live view).

The job host (`JobHost`) starts a real job process (`SubprocessLauncher`), hands it the steps
descriptor, posts what it sends to a fake app on loopback with the real Worker API client
(`HttpWorkerApi`) and delivers its result. The job process is a small script that does what the
Implementer's process does with the channel: build the feeder and the pump from the environment,
queue records the way the engine's events make them, run `finish` before it prints its result.
What is proven: the records arrive in order, and the outcome of the job is the same whether the
app takes the steps, answers 500 or hangs.
"""

import asyncio
import json
import os
import sys
import textwrap
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from worker_api_fake import CREDENTIAL, FakeWorkerApp, Scripted, example

from code_reviewer_runner.capabilities import ENGINE_IMPLEMENTER
from code_reviewer_runner.job_loop.api import ClaimedJob
from code_reviewer_runner.job_loop.host import JobEnd, JobHost
from code_reviewer_runner.job_loop.masking import SecretMasker
from code_reviewer_runner.job_loop.process import ProcessSpec, SubprocessLauncher
from code_reviewer_runner.job_loop.settings import WorkerSettings
from code_reviewer_runner.job_loop.worker_api import HttpWorkerApi
from code_reviewer_runner.step_wire import STEPS_FD_VARIABLE

JOB_ID: str = example("WorkerJobDetailsResponse")["job"]["id"]
ROOT = Path(__file__).resolve().parents[3]
EXAMPLE = ROOT / "contracts" / "examples" / "implementer" / "RunnerJobInput.json"
HEAD = "9" * 40
RECORDS = 130
REPORT = {
    "baseCommit": "1" * 40,
    "headCommit": HEAD,
    "pushed": True,
    "branches": [{"name": "work/b", "head": HEAD, "result": "pushed", "reason": None}],
    "commits": [{"sha": HEAD, "subject": "Add it"}],
    "filesChanged": [{"path": "a.ts", "status": "added"}],
    "summary": "Done.",
    "opencode": {"sessionId": "ses_1", "version": "1.19.0"},
}

# What the Implementer's job process does with the channel, in a process of its own.
CHILD = textwrap.dedent(
    """
    import json, os, sys, time
    from code_reviewer_runner.implementer.step_feed import StepFeeder
    from code_reviewer_runner.implementer.step_pump import step_pump_from_environment
    from code_reviewer_runner.redaction import Redactor

    pump = step_pump_from_environment(os.environ)
    notes = ()
    if pump is not None:
        feeder = StepFeeder("ses_1", Redactor([]))
        feeder.feed({"type": "message.updated", "properties": {
            "sessionID": "ses_1", "info": {"id": "msg_a", "role": "assistant"}}})
        pump.start(feeder)
        for number in range(%(records)d):
            feeder.feed({"type": "message.part.updated", "properties": {
                "sessionID": "ses_1", "time": 1000, "part": {
                    "id": "prt_%%06d" %% number, "sessionID": "ses_1", "messageID": "msg_a",
                    "type": "text", "text": "step %%d" %% number, "time": {"start": 1, "end": 2}}}})
            if number %% 40 == 0:
                time.sleep(0.05)
        notes = pump.finish(float(os.environ.get("CHILD_FLUSH", "4")))
    print(json.dumps({"ok": True, "durationMs": 5, "commentUrl": None, "errorCode": None,
        "logTail": "\\n".join(notes) or "pushed", "logTruncated": False, "usage": None,
        "implementer": json.loads(%(report)s)}))
    """
)


@pytest.fixture
def app() -> Iterator[FakeWorkerApp]:
    fake = FakeWorkerApp().start()
    fake.features = ["worker_api", "implementer_steps"]
    yield fake
    fake.stop()


def implementer_input() -> dict[str, Any]:
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    document["git"]["token"] = "ghs_dummy-installation-token-0123456789"
    document["llm"]["apiKey"] = "dummy-openrouter-key-0123456789"
    return document


def run_job(app: FakeWorkerApp, env_flush: str = "4") -> tuple[JobEnd, float]:
    script = CHILD % {"records": RECORDS, "report": repr(json.dumps(REPORT))}
    settings = WorkerSettings(
        job_command=(sys.executable, "-c", script),
        engines=(ENGINE_IMPLEMENTER,),
        request_timeout=5.0,
    )

    async def go() -> tuple[JobEnd, float]:
        api = HttpWorkerApi(app.url, CREDENTIAL, request_timeout=5.0)
        await api.check_app(JOB_ID)
        host = JobHost(
            settings,
            api,
            SubprocessLauncher(1.0),
            masker=SecretMasker([CREDENTIAL]),
            environment={"PATH": os.environ["PATH"], "CHILD_FLUSH": env_flush},
        )
        claimed = ClaimedJob(
            id=JOB_ID, lease_token=CREDENTIAL, heartbeat_interval=30.0, input=implementer_input()
        )
        began = time.monotonic()
        end = await asyncio.wait_for(host.run_job(claimed), 60)
        return end, time.monotonic() - began

    return asyncio.run(go())


def sent_records(app: FakeWorkerApp) -> list[dict[str, Any]]:
    return [
        record
        for request in app.requests
        if request["kind"] == "steps"
        for record in request["body"]["records"]
    ]


def outcome_of(app: FakeWorkerApp) -> dict[str, Any]:
    """What the app was told the job came to, without the time and the log (the log may hold the
    live view's note)."""
    (completion,) = app.completions
    result = dict(completion["result"])
    for volatile in ("durationMs", "logTail"):
        result.pop(volatile)
    return result


# #745-L32
def test_the_records_arrive_in_order_before_the_result_and_the_job_is_unchanged_by_them(
    app: FakeWorkerApp,
) -> None:
    end, took = run_job(app)

    assert end is JobEnd.OK
    records = sent_records(app)
    assert [record["seq"] for record in records] == list(range(1, RECORDS + 1))
    assert [record["text"] for record in records][:3] == ["step 0", "step 1", "step 2"]
    steps = [r for r in app.requests if r["kind"] == "steps"]
    assert all(len(r["body"]["records"]) <= 50 for r in steps)
    kinds = [r["kind"] for r in app.requests]
    assert kinds.index("result") > max(i for i, kind in enumerate(kinds) if kind == "steps")
    (completion,) = app.completions
    assert completion["result"]["ok"] is True
    assert completion["result"]["logTail"] == "pushed", "nothing was lost, so no note"
    assert took < 15


# #745-L32
def test_an_app_that_answers_500_changes_nothing_about_the_outcome(app: FakeWorkerApp) -> None:
    healthy = FakeWorkerApp().start()
    healthy.features = ["worker_api", "implementer_steps"]
    try:
        run_job(healthy)
        expected = outcome_of(healthy)
    finally:
        healthy.stop()
    app.script(
        "steps",
        *[Scripted(500, {"error": {"code": "INTERNAL", "message": "m"}}) for _ in range(500)],
    )

    end, took = run_job(app, env_flush="3")

    assert end is JobEnd.OK
    assert outcome_of(app) == expected
    attempts = [r for r in app.requests if r["kind"] == "steps"]
    assert 1 <= len(attempts) < 60, "it tried, and it did not hammer"
    (completion,) = app.completions
    assert "the live view could not send" in completion["result"]["logTail"]
    assert took < 15


# #745-L32
def test_an_app_that_hangs_changes_nothing_about_the_outcome_and_costs_only_the_flush(
    app: FakeWorkerApp,
) -> None:
    healthy = FakeWorkerApp().start()
    healthy.features = ["worker_api", "implementer_steps"]
    try:
        run_job(healthy)
        expected = outcome_of(healthy)
    finally:
        healthy.stop()
    app.steps_delay = 30.0

    end, took = run_job(app, env_flush="3")

    assert end is JobEnd.OK
    assert outcome_of(app) == expected
    (completion,) = app.completions
    assert "the live view could not send" in completion["result"]["logTail"]
    assert took < 15, "the hung steps calls were not waited for"


# #745-L27
def test_an_app_that_says_the_lease_is_lost_stops_the_steps_and_the_job_goes_on(
    app: FakeWorkerApp,
) -> None:
    app.script("steps", Scripted(409, {"error": {"code": "RUNNER_LEASE_LOST", "message": "m"}}))

    end, _ = run_job(app, env_flush="3")

    assert end is JobEnd.OK
    steps = [r for r in app.requests if r["kind"] == "steps"]
    assert len(steps) == 1, "nothing is posted after the 409"
    assert app.completions[0]["result"]["ok"] is True


# #745-L26
def test_an_app_without_the_feature_gets_no_steps_and_the_process_records_nothing(
    app: FakeWorkerApp,
) -> None:
    app.features = ["worker_api"]

    end, _ = run_job(app)

    assert end is JobEnd.OK
    assert [r for r in app.requests if r["kind"] == "steps"] == []
    (completion,) = app.completions
    assert completion["result"]["logTail"] == "pushed", "no channel, so no note either"


# -- the descriptor itself -----------------------------------------------------------------------


def test_a_process_is_handed_the_steps_descriptor_only_when_the_spec_names_a_handler() -> None:
    probe = (
        "import os; fd = os.environ.get('RUNNER_STEPS_FD'); "
        "print(fd is not None and os.get_inheritable(int(fd)))"
    )
    seen: list[bytes] = []

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        seen.append(await reader.read())

    async def go(steps: Any) -> tuple[str, list[bytes]]:
        spec = ProcessSpec(argv=(sys.executable, "-c", probe), env={}, stdin=b"", steps=steps)
        process = await SubprocessLauncher(1.0).start(spec)
        return (await process.wait()).stdout.decode().strip(), seen

    with_handler, _ = asyncio.run(go(handler))
    without, _ = asyncio.run(go(None))

    assert STEPS_FD_VARIABLE == "RUNNER_STEPS_FD"
    # The child's descriptor is inheritable as handed over (it must be, to reach the process); the
    # job process makes it private to itself at once (`step_pump_from_environment`).
    assert with_handler == "True"
    assert without == "False"
