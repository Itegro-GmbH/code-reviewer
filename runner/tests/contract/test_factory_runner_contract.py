# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Factory-Runner as the writer of the registration and the runner API (#854, R1b).

The runner's real client talks to a fake App on the loopback that checks every body it receives
against `contracts/runner-registration.v1.json` and `contracts/runner-api.v1.json` (the fake keeps a
body that does not fit in `violations`). The app checks its own answers against the same files, so a
change of the format has to change both sides.
"""

import asyncio
import json
import re
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "integration"))
from runner_app import EXAMPLE_JOB, FakeRunnerApp

from code_reviewer_runner.factory_runner.app_client import (
    Announcement,
    AppClient,
    Revoked,
    UpdateNeeded,
)
from code_reviewer_runner.factory_runner.base import BASE_VERSION
from code_reviewer_runner.factory_runner.config import Limits, RunnerConfig
from code_reviewer_runner.factory_runner.job_api import RunnerJobApi
from code_reviewer_runner.factory_runner.prepare import announcement_for
from code_reviewer_runner.factory_runner.selftest import Check, SelfTestResult
from code_reviewer_runner.job import ImplementerInput, parse_runnable_job
from code_reviewer_runner.job_loop.api import LeaseLost
from code_reviewer_runner.job_loop.worker_api import WORKER_FEATURES

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


def test_the_claim_names_the_implementer_and_only_features_the_contract_knows(
    app: FakeRunnerApp,
) -> None:
    client, _ = registered(app)
    app.queue_job(JOB)

    claimed = client.claim()

    assert claimed is not None and claimed.id == JOB
    assert app.violations == []
    body = next(r.body for r in app.requests if r.path.endswith("/claim"))
    assert body["engines"] == ["implementer"]
    schema = json.loads((CONTRACTS / "runner-api.v1.json").read_text())
    assert set(body["features"]) <= set(schema["$defs"]["KnownClaimFeature"]["enum"])
    assert set(body["features"]) == set(WORKER_FEATURES)


def test_the_job_a_claim_hands_over_is_one_the_job_host_runs(app: FakeRunnerApp) -> None:
    client, _ = registered(app)
    app.queue_job(JOB)

    claimed = client.claim()

    assert claimed is not None
    assert isinstance(parse_runnable_job(json.dumps(claimed.input)), ImplementerInput)
    assert claimed.input == EXAMPLE_JOB


def test_a_claim_with_nothing_to_do_is_none(app: FakeRunnerApp) -> None:
    client, _ = registered(app)

    assert client.claim() is None


def test_the_job_calls_carry_the_lease_token_and_fit_the_contract(app: FakeRunnerApp) -> None:
    client, credential = registered(app)
    app.queue_job(JOB)
    claimed = client.claim()
    assert claimed is not None
    api = RunnerJobApi(app.url, credential)
    api.hold(JOB, claimed.lease_token)
    result = {
        "ok": True, "durationMs": 5, "commentUrl": None, "errorCode": None,
        "logTail": "done", "logTruncated": False, "usage": None,
    }  # fmt: skip

    async def go() -> None:
        await api.heartbeat(JOB, claimed.lease_token)
        records = json.loads((CONTRACTS / "examples" / "StepsRequest.json").read_text())["records"]
        await api.steps(JOB, json.dumps({"records": records}).encode())
        reply = await api.complete(JOB, claimed.lease_token, result)
        assert (reply.status, reply.already_completed) == ("succeeded", False)

    asyncio.run(go())

    assert app.violations == []
    assert app.steps[0]["leaseToken"] == claimed.lease_token
    assert [r.authorization for r in app.requests[-3:]] == [f"Bearer {credential}"] * 3


def test_steps_without_a_held_job_are_refused_before_anything_is_sent(app: FakeRunnerApp) -> None:
    _, credential = registered(app)
    api = RunnerJobApi(app.url, credential)

    async def go() -> None:
        await api.steps(JOB, b'{"records":[]}')

    sent = len(app.requests)
    with pytest.raises(Exception, match="does not hold"):
        asyncio.run(go())
    assert len(app.requests) == sent


def test_a_wrong_lease_token_is_a_lost_lease(app: FakeRunnerApp) -> None:
    client, credential = registered(app)
    app.queue_job(JOB)
    client.claim()
    api = RunnerJobApi(app.url, credential)

    with pytest.raises(LeaseLost):
        asyncio.run(api.heartbeat(JOB, "not-the-lease-token"))


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
    client, credential = registered(app)
    app.revoke_all()

    for call in (client.claim, client.renew, lambda: client.announce(announcement())):
        with pytest.raises(Revoked):
            call()
    api = RunnerJobApi(app.url, credential)
    app.queue_job(JOB).claimed = True
    with pytest.raises(LeaseLost):
        api.hold(JOB, "x")
        asyncio.run(api.heartbeat(JOB, "x"))


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
