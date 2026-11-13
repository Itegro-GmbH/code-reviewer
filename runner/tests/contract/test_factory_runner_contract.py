# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Factory-Runner as the writer of the registration and the runner API (#854, R1b; #974).

The local dispatcher's real client talks to a fake App on the loopback that checks every body it
receives against `contracts/runner-registration.v1.json` and `contracts/runner-api.v1.json` (the
fake keeps a body that does not fit in `violations`) and answers the claim as the contract says (the
split answer, `SplitClaimResponse`). The Worker it starts talks to the same fake over the Worker API
(`contracts/worker-api.v1.json`) with the credential of the claim. The app checks its own answers
against the same files, so a change of the format has to change both sides.
"""

import asyncio
import json
import re
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integration"))

from code_reviewer_runner.factory_runner.app_client import (
    Announcement,
    AppClient,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import BASE_VERSION
from code_reviewer_runner.factory_runner.config import Limits, RunnerConfig
from code_reviewer_runner.factory_runner.prepare import announcement_for
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.job import ImplementerInput, parse_runnable_job
from code_reviewer_runner.job_loop.worker_api import (
    WORKER_FEATURES,
    CredentialInvalid,
    HttpWorkerApi,
    JobEnded,
)
from runner_app import EXAMPLE_JOB, FakeRunnerApp

pytestmark = pytest.mark.contract

JOB = "00000000-0000-4000-8000-000000000001"
MANIFEST = {"harnesses": {"opencode": {"version": "1.19.0", "ready": True}}}
CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


@pytest.fixture
def app() -> Iterator[FakeRunnerApp]:
    fake = FakeRunnerApp().start()
    yield fake
    fake.stop()


def announcement() -> Announcement:
    return Announcement(("linux", "gpu"), BASE_VERSION, MANIFEST, {"cpus": 2, "parallelRuns": 1})


def registered(app: FakeRunnerApp) -> tuple[AppClient, str]:
    client = AppClient(app.url, credential=None)
    result = client.register(app.new_registration_token(), "build box", announcement())
    client.use_credential(result.credential)
    return client, result.credential


def test_the_registration_and_the_announcement_fit_the_contract(app: FakeRunnerApp) -> None:
    client, _ = registered(app)
    answer = client.announce(announcement())

    assert answer.update_needed is False
    assert app.violations == []
    assert app.announcements[0]["manifest"] == MANIFEST


def test_the_announcement_a_real_selftest_result_makes_fits_the_contract(
    app: FakeRunnerApp,
) -> None:
    client, _ = registered(app)
    result = SelfTestResult(
        (Check("docker", True), Check("agent-docker", True)), "sysbox-runc", "1.19.0"
    )
    config = RunnerConfig(
        url=app.url, labels=("linux",), limits=Limits(cpus=2, memory_mb=4096, disk_gb=50)
    )

    client.announce(announcement_for(config, result, 4096))

    assert app.violations == []
    assert app.announcements[-1]["manifest"]["capabilities"] == ["agent-docker"]


def test_the_claim_names_the_implementer_and_the_split_answer_and_only_features_the_contract_knows(
    app: FakeRunnerApp,
) -> None:
    client, _ = registered(app)
    app.queue_job(JOB)

    claimed = client.claim()

    assert claimed is not None and claimed.job_id == JOB
    assert app.violations == []
    body = next(r.body for r in app.requests if r.path.endswith("/claim"))
    assert body["engines"] == ["implementer"]
    schema = json.loads((CONTRACTS / "runner-api.v1.json").read_text())
    assert set(body["features"]) <= set(schema["$defs"]["KnownClaimFeature"]["enum"])
    # #974: the dispatcher asks for the credential of the job and nothing more: what a Worker reads
    # of a job (`WORKER_FEATURES`) is said by the Worker when it fetches the job.
    assert body["features"] == ["worker_credential"]
    assert {"openrouter", "anthropic"} <= set(body["llmProviders"])


# #974-T01
def test_the_claim_answer_is_the_split_one_and_holds_no_job_input(app: FakeRunnerApp) -> None:
    client, _ = registered(app)
    app.queue_job(
        JOB,
        access={"harness": "claude-code", "auth": "subscription", "model": "claude-sonnet-5-5"},
        labels=["linux"],
    )

    claimed = client.claim()

    assert claimed is not None and claimed.credential == app.job(JOB).credential
    assert claimed.credential.startswith("crj_")
    assert claimed.labels == ("linux",)
    assert claimed.access is not None and claimed.access.auth == "subscription"
    assert app.violations == []  # the fake validated the answer it gave against SplitClaimResponse
    # Nothing of the job's input is in what the dispatcher holds.
    assert "example-git" not in repr(claimed) and "example-llm" not in repr(claimed)


def test_a_claim_with_nothing_to_do_is_none(app: FakeRunnerApp) -> None:
    client, _ = registered(app)

    assert client.claim() is None


# #974-T02
def test_the_job_a_worker_fetches_with_the_credential_of_the_claim_is_one_the_job_host_runs(
    app: FakeRunnerApp,
) -> None:
    client, _ = registered(app)
    app.queue_job(JOB)
    claimed = client.claim()
    assert claimed is not None
    api = HttpWorkerApi(app.url, claimed.credential)

    async def go() -> None:
        await api.check_app(JOB)
        fetched = await api.fetch(JOB)
        assert isinstance(parse_runnable_job(json.dumps(fetched.input)), ImplementerInput)
        assert fetched.input == EXAMPLE_JOB

    asyncio.run(go())

    assert app.violations == []
    fetch = app.job(JOB).fetches[0]
    assert set(fetch["features"].split(",")) == set(WORKER_FEATURES)
    # The Worker's calls carry the credential of the claim and nothing else.
    assert all(
        r.authorization == f"Bearer {claimed.credential}"
        for r in app.requests
        if r.path.startswith("/api/workers/") or "version" in r.path
    )


# #974-T02
def test_the_worker_calls_fit_the_contract_and_end_the_job(app: FakeRunnerApp) -> None:
    client, _ = registered(app)
    app.queue_job(JOB)
    claimed = client.claim()
    assert claimed is not None
    api = HttpWorkerApi(app.url, claimed.credential)
    result = {
        "ok": True, "durationMs": 5, "commentUrl": None, "errorCode": None,
        "logTail": "done", "logTruncated": False, "usage": None,
    }  # fmt: skip

    async def go() -> None:
        await api.heartbeat(JOB, claimed.credential)
        records = json.loads((CONTRACTS / "examples" / "StepsRequest.json").read_text())["records"]
        await api.steps(JOB, json.dumps({"records": records}).encode())
        reply = await api.complete(JOB, claimed.credential, result)
        assert (reply.status, reply.already_completed) == ("succeeded", False)

    asyncio.run(go())

    assert app.violations == []
    assert app.completions == [result]
    assert client.job_state(JOB) == "succeeded"  # the dispatcher's own question about the job


def test_a_credential_that_is_not_the_claims_is_refused_by_the_worker_api(
    app: FakeRunnerApp,
) -> None:
    client, runner_credential = registered(app)
    app.queue_job(JOB)
    client.claim()

    async def go(credential: str) -> None:
        await HttpWorkerApi(app.url, credential).heartbeat(JOB, credential)

    # The runner's own credential is no proof of a claim: the Worker API takes the job's alone.
    with pytest.raises(CredentialInvalid):
        asyncio.run(go(runner_credential))
    with pytest.raises(CredentialInvalid):
        asyncio.run(go("crj_" + "Z" * 43))


# #974-T03
def test_the_state_of_a_job_is_asked_with_the_runner_credential_and_fits_the_contract(
    app: FakeRunnerApp,
) -> None:
    client, _ = registered(app)
    assert client.job_state(JOB) is None  # not there: not this runner's to know
    app.queue_job(JOB)
    client.claim()

    assert client.job_state(JOB) == "running"
    assert app.violations == []


def test_a_claim_given_back_with_the_credential_of_the_job_is_queued_again(
    app: FakeRunnerApp,
) -> None:
    client, _ = registered(app)
    app.queue_job(JOB)
    claimed = client.claim()
    assert claimed is not None

    assert client.release(JOB, claimed.credential, "launch_failed") == "released"
    assert client.release(JOB, claimed.credential, "launch_failed") == "not_holder"

    assert app.violations == []  # the body fits `ReleaseRequest`
    assert app.job(JOB).releases[0] == ("launch_failed", 200)
    assert client.claim() is not None  # and the job is there for the next claim


def test_a_renewed_credential_works_beside_the_old_one_until_used(app: FakeRunnerApp) -> None:
    client, old = registered(app)

    new = client.renew()
    assert new != old and new.startswith("crc_")

    other = AppClient(app.url, credential=old)
    assert other.claim() is None  # the old one still works
    client.use_credential(new)
    assert client.claim() is None
    assert app.violations == []


def test_a_revoked_credential_is_revoked_on_every_call(app: FakeRunnerApp) -> None:
    client, _ = registered(app)
    app.queue_job(JOB)
    claimed = client.claim()
    assert claimed is not None
    app.revoke_all()

    for call in (
        client.claim,
        client.renew,
        lambda: client.announce(announcement()),
        lambda: client.job_state(JOB),
        lambda: client.release(JOB, claimed.credential, "worker_exited"),
    ):
        with pytest.raises(Revoked):
            call()
    # The claim ended with the runner: the Worker's next call finds the job over.
    with pytest.raises(JobEnded):
        asyncio.run(HttpWorkerApi(app.url, claimed.credential).heartbeat(JOB, claimed.credential))


def test_a_base_below_the_minimum_gets_the_update_error_with_the_minimum(
    app: FakeRunnerApp,
) -> None:
    client, _ = registered(app)
    app.min_base_version = "9.0.0"

    with pytest.raises(UpdateNeeded) as needed:
        client.claim()

    assert needed.value.min_base_version == "9.0.0"
    assert client.announce(announcement()).update_needed is True


def test_the_base_version_has_the_shape_of_the_contract() -> None:
    schema = json.loads((CONTRACTS / "runner-registration.v1.json").read_text())
    assert re.fullmatch(schema["$defs"]["BaseVersion"]["pattern"], BASE_VERSION)
