# SPDX-License-Identifier: LicenseRef-Proprietary

"""The runner's snapshot calls against `contracts/runner-api.v1.json` (#879): the real client on
the real HTTP, against the fake App, which holds every query to `RunnerSessionPartQuery` /
`RunnerResumeSessionQuery`, the lease token to `RunnerLeaseTokenHeader` and its own answers to
`RunnerSessionPartResponse` / `RunnerResumeSessionHeaders` (a request or answer that does not fit is
in `violations`). The client's answers to every status of the app are the unit level's; here the
wire: the routes, the headers, a file of one part and a file of three, and the feature switch."""

import asyncio
import hashlib
from collections.abc import Iterator

import pytest

from code_reviewer_runner.factory_runner.app_client import Announcement, AppClient
from code_reviewer_runner.factory_runner.base import BASE_VERSION
from code_reviewer_runner.factory_runner.job_api import RunnerJobApi
from code_reviewer_runner.job_loop.api import LeaseLost
from code_reviewer_runner.job_loop.resume_download import ResumeUnavailable
from code_reviewer_runner.job_loop.snapshot_sender import SnapshotPart
from code_reviewer_runner.job_loop.worker_api import CredentialInvalid
from code_reviewer_runner.resume_wire import ResumeReason
from code_reviewer_runner.snapshot_wire import CHUNK_BYTES, parts_of
from runner_app import FakeRunnerApp

pytestmark = pytest.mark.contract

JOB = "00000000-0000-4000-8000-000000000001"
NEXT_JOB = "00000000-0000-4000-8000-000000000002"


@pytest.fixture
def app() -> Iterator[FakeRunnerApp]:
    fake = FakeRunnerApp().start()
    yield fake
    fake.stop()


class Claim:
    """A registered runner that holds JOB, and the API of its calls."""

    def __init__(self, app: FakeRunnerApp, job: str = JOB) -> None:
        client = AppClient(app.url, credential=None)
        registered = client.register(app.new_registration_token(), "box", announcement())
        client.use_credential(registered.credential)
        app.queue_job(job)
        claimed = client.claim()
        assert claimed is not None
        self.credential = registered.credential
        self.lease_token = claimed.lease_token
        self.api = RunnerJobApi(app.url, registered.credential, request_timeout=5)
        self.api.hold(job, claimed.lease_token)
        self.job = job

    def switch_on(self) -> None:
        asyncio.run(self.api.check_app(self.job))
        assert self.api.supports_snapshot


def announcement() -> Announcement:
    manifest = {"harnesses": {"opencode": {"version": "1.19.0", "ready": True}}}
    return Announcement(("linux",), BASE_VERSION, manifest, {"cpus": 1, "parallelRuns": 1})


def put_whole(api: RunnerJobApi, job: str, data: bytes) -> None:
    digest = hashlib.sha256(data).hexdigest()
    count = parts_of(len(data))

    async def go() -> None:
        for index in range(count):
            body = data[index * CHUNK_BYTES : (index + 1) * CHUNK_BYTES]
            await api.snapshot(
                job, SnapshotPart(index, count, len(data), digest, 4 * len(data), "1.19.0", body)
            )

    asyncio.run(go())


# #879-T07
@pytest.mark.parametrize("size", [1234, CHUNK_BYTES, 2 * CHUNK_BYTES + 77, 8 * 1024 * 1024])
def test_a_snapshot_goes_in_parts_through_the_runner_route_and_comes_back_whole(
    app: FakeRunnerApp, size: int
) -> None:
    claim = Claim(app)
    claim.switch_on()
    data = (b"session-bytes-" * (size // 14 + 1))[:size]

    put_whole(claim.api, JOB, data)
    received = asyncio.run(claim.api.resume_session(JOB))

    assert received.data == data
    assert received.header.size == size and received.header.version == "1.19.0"
    assert app.violations == []
    calls = [(c.method, c.status) for c in app.session_calls]
    assert calls == [("PUT", 200)] * parts_of(size) + [("GET", 200)] * parts_of(size)
    # Only the runner's routes, with the runner's credential and the lease token of the claim.
    sent = [r for r in app.requests if "/session" in r.path or "/resume-session" in r.path]
    assert {tuple(r.path.split("/")[1:4]) for r in sent} == {("api", "runners", "v1")}
    assert {r.authorization for r in sent} == {f"Bearer {claim.credential}"}
    assert {c.lease_token for c in app.session_calls} == {claim.lease_token}


# #879-T07
def test_a_session_without_a_stored_snapshot_answers_204_and_says_so(app: FakeRunnerApp) -> None:
    claim = Claim(app)
    claim.switch_on()

    with pytest.raises(ResumeUnavailable) as unavailable:
        asyncio.run(claim.api.resume_session(JOB))

    assert unavailable.value.reason is ResumeReason.NO_SNAPSHOT
    assert [c.status for c in app.session_calls] == [204]
    assert app.violations == []


# #879-T07
def test_a_later_turn_of_the_session_reads_what_an_earlier_one_stored(app: FakeRunnerApp) -> None:
    first = Claim(app)
    first.switch_on()
    put_whole(first.api, JOB, b"the conversation of turn one")
    second = Claim(app, NEXT_JOB)
    second.switch_on()

    received = asyncio.run(second.api.resume_session(NEXT_JOB))

    assert received.data == b"the conversation of turn one"
    assert app.violations == []


# #879-T07
def test_an_upload_that_broke_off_leaves_the_stored_snapshot_and_the_next_upload_alone(
    app: FakeRunnerApp,
) -> None:
    first = Claim(app)
    first.switch_on()
    put_whole(first.api, JOB, b"the conversation of turn one")
    session = app.jobs[0].session
    stored = app.snapshots[session]
    # Turn two sends two of the three parts of its file and then loses its lease.
    broken = Claim(app, NEXT_JOB)
    broken.switch_on()
    data = (b"turn-two-" * CHUNK_BYTES)[: 2 * CHUNK_BYTES + 77]
    digest = hashlib.sha256(data).hexdigest()

    def part(index: int) -> SnapshotPart:
        body = data[index * CHUNK_BYTES : (index + 1) * CHUNK_BYTES]
        return SnapshotPart(index, 3, len(data), digest, 4 * len(data), "1.19.0", body)

    async def upload_until_the_lease_is_lost() -> None:
        await broken.api.snapshot(NEXT_JOB, part(0))
        await broken.api.snapshot(NEXT_JOB, part(1))
        broken.api.hold(NEXT_JOB, "not-the-lease-token")
        await broken.api.snapshot(NEXT_JOB, part(2))

    with pytest.raises(LeaseLost):
        asyncio.run(upload_until_the_lease_is_lost())

    assert app.snapshots[session] == stored  # the old one is untouched
    # The next turn's file of two parts is judged on its own parts, not mixed with the two left
    # behind (which would make it whole after its first part and fail the digest).
    later = Claim(app, "00000000-0000-4000-8000-000000000003")
    later.switch_on()
    put_whole(later.api, later.job, (b"turn-three-" * CHUNK_BYTES)[: CHUNK_BYTES + 5])
    received = asyncio.run(later.api.resume_session(later.job))
    assert received.data == (b"turn-three-" * CHUNK_BYTES)[: CHUNK_BYTES + 5]
    assert app.violations == []


# #879-T08
def test_a_lease_token_that_is_not_the_claims_is_a_lost_lease(app: FakeRunnerApp) -> None:
    claim = Claim(app)
    claim.switch_on()
    claim.api.hold(JOB, "not-the-lease-token")

    with pytest.raises(LeaseLost):
        put_whole(claim.api, JOB, b"x")
    with pytest.raises(ResumeUnavailable) as unavailable:
        asyncio.run(claim.api.resume_session(JOB))

    assert unavailable.value.reason is ResumeReason.DOWNLOAD_FAILED
    assert [c.status for c in app.session_calls] == [409, 409]
    assert app.snapshots == {}


# #879-T08
def test_a_job_the_app_does_not_know_is_a_lost_lease(app: FakeRunnerApp) -> None:
    claim = Claim(app)
    claim.switch_on()
    claim.api.hold(NEXT_JOB, claim.lease_token)

    with pytest.raises(LeaseLost):
        put_whole(claim.api, NEXT_JOB, b"x")

    assert [c.status for c in app.session_calls] == [404]


# #879-T08
def test_a_revoked_credential_is_a_credential_the_app_does_not_accept(app: FakeRunnerApp) -> None:
    claim = Claim(app)
    claim.switch_on()
    app.revoke_all()

    with pytest.raises(CredentialInvalid):
        put_whole(claim.api, JOB, b"x")

    assert [c.status for c in app.session_calls] == [401]


# #879-T09
@pytest.mark.parametrize(
    "features",
    [
        ["worker_api", "implementer_steps", "implementer_snapshot"],  # the Worker routes only
        ["worker_api", "implementer_steps"],
        [],
    ],
)
def test_an_app_without_the_feature_gets_no_session_call_at_all(
    app: FakeRunnerApp, features: list[str]
) -> None:
    app.features = features
    claim = Claim(app)
    asyncio.run(claim.api.check_app(JOB))

    assert claim.api.supports_snapshot is False
    with pytest.raises(Exception, match="does not list"):
        put_whole(claim.api, JOB, b"x")
    with pytest.raises(ResumeUnavailable):
        asyncio.run(claim.api.resume_session(JOB))

    assert app.session_calls == []
    assert app.violations == []
