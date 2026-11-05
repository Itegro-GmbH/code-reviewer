# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the HTTP client of the Worker API against a real server on loopback: how it tells the
answers apart, and that the credential goes nowhere but to the app."""

import asyncio
import json
import socket
from collections.abc import Iterator
from typing import Any

import pytest
from worker_api_fake import CREDENTIAL, FakeWorkerApp, RawServer, Scripted, example

from code_reviewer_runner.job_loop.api import parse_heartbeat
from code_reviewer_runner.job_loop.http import ApiRejected, ApiUnavailable, LeaseLost, Reply
from code_reviewer_runner.job_loop.snapshot_sender import SnapshotPart
from code_reviewer_runner.job_loop.worker_api import (
    CredentialInvalid,
    HttpWorkerApi,
    JobEnded,
    JobGivenBack,
)
from code_reviewer_runner.job_loop.worker_errors import WorkerFailure, WorkerSetupError

JOB_ID: str = example("WorkerJobDetailsResponse")["job"]["id"]
RESULT: dict[str, Any] = example("WorkerResultRequest")["result"]


@pytest.fixture
def app() -> Iterator[FakeWorkerApp]:
    fake = FakeWorkerApp().start()
    yield fake
    fake.stop()


def client(url: str, credential: str = CREDENTIAL) -> HttpWorkerApi:
    return HttpWorkerApi(url, credential, request_timeout=5)


def test_a_complete_answer_with_the_status_queued_is_understood(app: FakeWorkerApp) -> None:
    app.complete_status = "queued"

    reply = asyncio.run(client(app.url).complete(JOB_ID, CREDENTIAL, RESULT))

    assert reply.status == "queued" and reply.already_completed is False


@pytest.mark.parametrize("status", [500, 502, 503, 429, 408])
def test_an_answer_that_may_pass_is_unavailable_and_keeps_the_retry_after(
    app: FakeWorkerApp, status: int
) -> None:
    app.script(
        "heartbeat",
        Scripted(status, {"error": {"code": "X", "message": "m"}}, {"Retry-After": "7"}),
    )

    with pytest.raises(ApiUnavailable) as error:
        asyncio.run(client(app.url).heartbeat(JOB_ID, CREDENTIAL))

    assert (error.value.status, error.value.retry_after) == (status, 7)


def test_a_conflict_or_an_unknown_job_means_the_lease_is_lost(app: FakeWorkerApp) -> None:
    api = client(app.url)
    app.script("heartbeat", Scripted(409, {"error": {"code": "RUNNER_LEASE_LOST", "message": "m"}}))
    app.script("result", Scripted(404, {"error": {"code": "RUNNER_JOB_NOT_FOUND", "message": "m"}}))

    with pytest.raises(LeaseLost):
        asyncio.run(api.heartbeat(JOB_ID, CREDENTIAL))
    with pytest.raises(LeaseLost):
        asyncio.run(api.complete(JOB_ID, CREDENTIAL, RESULT))


def test_the_app_ending_the_job_and_giving_it_back_are_told_apart(app: FakeWorkerApp) -> None:
    app.script("heartbeat", Scripted(409, {"error": {"code": "RUNNER_JOB_ENDED", "message": "m"}}))
    app.script(
        "fetch", Scripted(503, {"error": {"code": "RUNNER_GIT_ACCESS_UNAVAILABLE", "message": "m"}})
    )
    api = client(app.url)

    with pytest.raises(JobEnded):
        asyncio.run(api.heartbeat(JOB_ID, CREDENTIAL))
    with pytest.raises(JobGivenBack):
        asyncio.run(api.fetch(JOB_ID))


@pytest.mark.parametrize("status", [400, 413])
def test_a_refusal_of_the_request_is_rejected_with_the_error_code(
    app: FakeWorkerApp, status: int
) -> None:
    app.script(
        "result", Scripted(status, {"error": {"code": "RUNNER_BODY_TOO_LARGE", "message": "m"}})
    )

    with pytest.raises(ApiRejected) as error:
        asyncio.run(client(app.url).complete(JOB_ID, CREDENTIAL, RESULT))

    assert (error.value.status, error.value.code) == (status, "RUNNER_BODY_TOO_LARGE")


def test_a_route_the_app_does_not_have_is_an_unsupported_app_but_a_contract_404_is_not(
    app: FakeWorkerApp,
) -> None:
    app.script("fetch", Scripted(404, None))
    app.script("fetch", Scripted(404, {"error": {"code": "RUNNER_JOB_NOT_FOUND", "message": "m"}}))
    api = client(app.url)

    with pytest.raises(WorkerSetupError) as setup:
        asyncio.run(api.fetch(JOB_ID))
    with pytest.raises(LeaseLost):
        asyncio.run(api.fetch(JOB_ID))

    assert setup.value.code == WorkerFailure.APP_UNSUPPORTED


def test_a_wrong_credential_is_not_accepted_and_the_error_does_not_show_it(
    app: FakeWorkerApp,
) -> None:
    wrong = "crj_wrong-0123456789-abcdef-0123456789"

    with pytest.raises(CredentialInvalid) as error:
        asyncio.run(client(app.url, wrong).heartbeat(JOB_ID, wrong))

    assert error.value.status == 401
    assert wrong not in str(error.value)


def test_an_app_that_cannot_be_reached_is_unavailable() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]

    with pytest.raises(ApiUnavailable) as error:
        asyncio.run(client(f"http://127.0.0.1:{port}").heartbeat(JOB_ID, CREDENTIAL))

    assert error.value.status is None
    assert str(port) not in str(error.value)


def test_a_job_details_answer_that_breaks_the_contract_is_unavailable(app: FakeWorkerApp) -> None:
    broken = example("WorkerJobDetailsResponse")
    broken["job"]["heartbeatIntervalSeconds"] = 0
    app.script("fetch", Scripted(200, broken))

    with pytest.raises(ApiUnavailable):
        asyncio.run(client(app.url).fetch(JOB_ID))


def test_a_job_id_that_is_not_a_uuid_is_never_put_into_a_url(app: FakeWorkerApp) -> None:
    with pytest.raises(ApiRejected):
        asyncio.run(client(app.url).heartbeat("../../etc/passwd", CREDENTIAL))

    assert app.requests == []


def test_a_heartbeat_interval_longer_than_the_lease_allows_is_shortened(
    app: FakeWorkerApp,
) -> None:
    long = example("WorkerJobDetailsResponse")
    long["job"]["heartbeatIntervalSeconds"] = 600
    app.script("fetch", Scripted(200, long))

    job = asyncio.run(client(app.url).fetch(JOB_ID))

    assert job.heartbeat_interval == 60


@pytest.mark.parametrize("call", ["fetch", "heartbeat", "result"])
def test_a_redirect_is_not_followed_so_the_credential_never_goes_elsewhere(
    app: FakeWorkerApp, call: str
) -> None:
    other = FakeWorkerApp().start()
    try:
        app.script(call, Scripted(302, None, {"Location": f"{other.url}/api/workers/v1/jobs/x"}))
        api = client(app.url)
        calls = {
            "fetch": lambda: api.fetch(JOB_ID),
            "heartbeat": lambda: api.heartbeat(JOB_ID, CREDENTIAL),
            "result": lambda: api.complete(JOB_ID, CREDENTIAL, RESULT),
        }

        with pytest.raises(ApiUnavailable) as error:
            asyncio.run(calls[call]())

        assert error.value.status == 302
        assert other.requests == []
    finally:
        other.stop()


GARBAGE = [
    pytest.param(b"GARBAGE\r\n\r\n", id="not an HTTP answer"),
    pytest.param(b"HTTP/1.1 2", id="status line cut off"),
    pytest.param(b"", id="closed without an answer"),
]


@pytest.mark.parametrize("answer", GARBAGE)
def test_an_answer_that_is_not_http_is_unavailable_for_every_call(answer: bytes) -> None:
    server = RawServer(answer)
    try:
        api = client(server.url)

        with pytest.raises(ApiUnavailable):
            asyncio.run(api.fetch(JOB_ID))
        with pytest.raises(ApiUnavailable):
            asyncio.run(api.heartbeat(JOB_ID, CREDENTIAL))
        with pytest.raises(ApiUnavailable):
            asyncio.run(api.complete(JOB_ID, CREDENTIAL, RESULT))
    finally:
        server.close()


def test_a_job_details_answer_that_is_cut_off_is_unavailable() -> None:
    server = RawServer(b'HTTP/1.1 200 OK\r\nContent-Length: 500\r\n\r\n{"version": 1, ')
    try:
        with pytest.raises(ApiUnavailable):
            asyncio.run(client(server.url).fetch(JOB_ID))
    finally:
        server.close()


def test_a_text_with_a_lone_surrogate_is_sent_as_an_escape_and_arrives(
    app: FakeWorkerApp,
) -> None:
    result = {**RESULT, "logTail": "broken \ud800 text"}

    asyncio.run(client(app.url).complete(JOB_ID, CREDENTIAL, result))

    assert app.completions[0]["result"]["logTail"] == "broken \ud800 text"


def _answer_200(body: bytes) -> bytes:
    return (
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
        + str(len(body)).encode()
        + b"\r\nConnection: close\r\n\r\n"
        + body
    )


# #260: a 200 only means "held" when it is the answer of the contract for this very job. A gateway
# or captive portal that answers 200 to everything must not authorize a write.
@pytest.mark.parametrize(
    "body",
    [
        pytest.param(b"OK", id="not JSON"),
        pytest.param(b"{}", id="an empty object"),
        pytest.param(b'{"version": 1}', id="no job"),
        pytest.param(b'{"version": 2, "job": {"id": "' + JOB_ID.encode() + b'"}}', id="version"),
        pytest.param(
            b'{"version": 1, "job": {"id": "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b11"}}',
            id="another job",
        ),
        pytest.param(b'{"version": 1, "job": {"id": 7}}', id="id is not text"),
    ],
)
def test_a_200_that_is_not_the_heartbeat_answer_of_the_job_is_unavailable(body: bytes) -> None:
    server = RawServer(_answer_200(body))
    try:
        with pytest.raises(ApiUnavailable):
            asyncio.run(client(server.url).heartbeat(JOB_ID, CREDENTIAL))
    finally:
        server.close()


# #396-T01
def test_a_heartbeat_answer_says_whether_the_run_was_superseded(app: FakeWorkerApp) -> None:
    api = client(app.url)

    assert asyncio.run(api.heartbeat(JOB_ID, CREDENTIAL)).superseded is False
    app.superseded.add(JOB_ID)
    assert asyncio.run(api.heartbeat(JOB_ID, CREDENTIAL)).superseded is True


# #396-T01
@pytest.mark.parametrize("value", ["true", 1, None, "yes", [True]])
def test_only_the_boolean_true_means_superseded(value: object) -> None:
    body = {"version": 1, "job": {"id": JOB_ID, "superseded": value}}
    reply = Reply(200, {"content-type": "application/json"}, json.dumps(body).encode())

    assert parse_heartbeat(reply, JOB_ID).superseded is False


# -- #745: the steps call -----------------------------------------------------------------------

BATCH = b'{"records":[{"kind":"text","partId":"prt_1","seq":1,"text":"hi"}]}'


# #745-L26
def test_the_client_offers_steps_only_to_an_app_that_lists_the_feature(app: FakeWorkerApp) -> None:
    api = client(app.url)
    assert api.supports_steps is False, "before the version call nothing is known"

    app.features = ["worker_api", "pool_cap"]
    asyncio.run(api.check_app(JOB_ID))
    assert api.supports_steps is False

    app.features = ["worker_api", "implementer_steps"]
    asyncio.run(api.check_app(JOB_ID))
    assert api.supports_steps is True


# #745-L26
def test_an_app_that_does_not_answer_the_version_call_gets_no_steps(app: FakeWorkerApp) -> None:
    api = client(app.url)  # the fake does not serve the version call: 404

    asyncio.run(api.check_app(JOB_ID))

    assert api.supports_steps is False


# #745-L22
def test_a_batch_is_posted_as_it_is_with_the_credential_and_nothing_else(
    app: FakeWorkerApp,
) -> None:
    asyncio.run(client(app.url).steps(JOB_ID, BATCH))

    (sent,) = [r for r in app.requests if r["kind"] == "steps"]
    assert sent["body"] == json.loads(BATCH)
    assert sent["headers"]["Authorization"] == f"Bearer {CREDENTIAL}"


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (409, LeaseLost),
        (404, LeaseLost),
        (401, CredentialInvalid),
        (400, ApiRejected),
        (413, ApiRejected),
        (500, ApiUnavailable),
        (429, ApiUnavailable),
    ],
)
# #745-L27
def test_the_answers_to_a_steps_call_are_told_apart_as_for_every_other_call(
    app: FakeWorkerApp, status: int, expected: type[Exception]
) -> None:
    app.script("steps", Scripted(status, {"error": {"code": "X", "message": "m"}}))

    with pytest.raises(expected):
        asyncio.run(client(app.url).steps(JOB_ID, BATCH))


# #745-L30
def test_a_hung_steps_call_leaves_the_other_calls_free_and_is_not_piled_up(
    app: FakeWorkerApp,
) -> None:
    app.steps_delay = 1.5
    api = client(app.url)

    async def scenario() -> tuple[float, float]:
        loop = asyncio.get_running_loop()
        began = loop.time()
        first = asyncio.ensure_future(api.steps(JOB_ID, BATCH))
        await asyncio.sleep(0.2)
        beat_began = loop.time()
        await api.heartbeat(JOB_ID, CREDENTIAL)  # not held up by the steps call in flight
        beat = loop.time() - beat_began
        with pytest.raises(ApiUnavailable):  # a second call does not queue behind the first
            await api.steps(JOB_ID, BATCH)
        await first
        return beat, loop.time() - began

    beat, whole = asyncio.run(scenario())

    assert beat < 1.0
    assert whole >= 1.4


# -- #839: the snapshot call --------------------------------------------------------------------

DIGEST = "c" * 64


def part_of(data: bytes, *, index: int = 0, count: int = 1) -> SnapshotPart:
    return SnapshotPart(index, count, len(data) * count, DIGEST, 9_999, "1.19.0", data)


# #839-T15
def test_the_client_offers_the_snapshot_only_to_an_app_that_lists_the_feature(
    app: FakeWorkerApp,
) -> None:
    api = client(app.url)
    assert api.supports_snapshot is False, "before the version call nothing is known"

    app.features = ["worker_api", "implementer_steps"]
    asyncio.run(api.check_app(JOB_ID))
    assert api.supports_snapshot is False

    app.features = ["worker_api", "implementer_snapshot"]
    asyncio.run(api.check_app(JOB_ID))
    assert api.supports_snapshot is True


# #839-T15
def test_a_part_is_put_as_bytes_with_its_description_in_the_query(app: FakeWorkerApp) -> None:
    data = bytes(range(256)) * 40  # not text

    asyncio.run(client(app.url).snapshot(JOB_ID, part_of(data, index=1, count=3)))

    (sent,) = [r for r in app.requests if r["kind"] == "session"]
    assert sent["method"] == "PUT"
    assert sent["raw"] == data
    assert sent["headers"]["Authorization"] == f"Bearer {CREDENTIAL}"
    assert sent["headers"]["Content-Type"] == "application/octet-stream"
    assert sent["query"] == {
        "part": ["1"],
        "parts": ["3"],
        "bytes": [str(len(data) * 3)],
        "rawBytes": ["9999"],
        "sha256": [DIGEST],
        "opencodeVersion": ["1.19.0"],
    }


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (409, LeaseLost),
        (404, LeaseLost),
        (401, CredentialInvalid),
        (400, ApiRejected),
        (413, ApiRejected),
        (500, ApiUnavailable),
        (429, ApiUnavailable),
    ],
)
# #839-T15
def test_the_answers_to_a_snapshot_call_are_told_apart_as_for_every_other_call(
    app: FakeWorkerApp, status: int, expected: type[Exception]
) -> None:
    app.script("session", Scripted(status, {"error": {"code": "X", "message": "m"}}))

    with pytest.raises(expected):
        asyncio.run(client(app.url).snapshot(JOB_ID, part_of(b"x")))


# #839-T15
def test_a_hung_snapshot_call_leaves_the_other_calls_free_and_is_not_piled_up(
    app: FakeWorkerApp,
) -> None:
    app.steps_delay = 1.0  # the fake's delay of the steps and the snapshot calls
    api = client(app.url)

    async def scenario() -> float:
        loop = asyncio.get_running_loop()
        first = asyncio.ensure_future(api.snapshot(JOB_ID, part_of(b"x")))
        await asyncio.sleep(0.2)
        began = loop.time()
        await api.heartbeat(JOB_ID, CREDENTIAL)  # not held up by the snapshot call in flight
        beat = loop.time() - began
        with pytest.raises(ApiUnavailable):  # a second part does not queue behind the first
            await api.snapshot(JOB_ID, part_of(b"y"))
        await first
        return beat

    assert asyncio.run(scenario()) < 0.8
