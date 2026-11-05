# SPDX-License-Identifier: LicenseRef-Proprietary

"""The session snapshot of a customer's runner on the client's side (#879): the two calls go to the
runner API's routes with the lease token in a header, the feature that switches them on is
`runner_session_snapshot` read per job, and the answers of the app are mapped as the Worker's are.

The app is a scripted opener (no socket): a test says what the next calls answer and reads what the
client sent. The wire against the fake App is the contract level's, a whole turn the loopback's.
"""

import asyncio
import hashlib
import io
import json
import logging
import urllib.request
from collections.abc import Callable
from email.message import Message
from typing import Any
from urllib.error import HTTPError

import pytest

from code_reviewer_runner.factory_runner.job_api import RunnerJobApi
from code_reviewer_runner.job_loop.http import ApiRejected, ApiUnavailable, LeaseLost
from code_reviewer_runner.job_loop.resume_download import ResumeUnavailable
from code_reviewer_runner.job_loop.snapshot_sender import SnapshotApi, SnapshotPart
from code_reviewer_runner.job_loop.worker_api import CredentialInvalid
from code_reviewer_runner.resume_wire import ResumeReason
from code_reviewer_runner.snapshot_wire import CHUNK_BYTES

pytestmark = pytest.mark.unit

JOB = "00000000-0000-4000-8000-000000000001"
OTHER_JOB = "00000000-0000-4000-8000-000000000002"
CREDENTIAL = "crc_" + "Q" * 43
LEASE = "lease-0123456789abcdef"
SECRET_PARTS = (CREDENTIAL, LEASE)
FILE = b"gzip bytes of the session"
DIGEST = hashlib.sha256(FILE).hexdigest()
PART = SnapshotPart(0, 1, len(FILE), DIGEST, 4 * len(FILE), "1.19.0", FILE)


class Answer:
    """What the opener returns: a response with a status, headers and a body."""

    def __init__(self, status: int, body: bytes = b"", headers: dict[str, str] | None = None):
        self.status = status
        self.headers = headers or {}
        self.body = body
        self._stream = io.BytesIO(body)

    def __enter__(self) -> "Answer":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)

    read1 = read


def error_body(code: str) -> bytes:
    return json.dumps({"error": {"code": code, "message": "fake"}}).encode()


def version(*features: str) -> Answer:
    body = {"version": 1, "appVersion": "1", "features": list(features)}
    return Answer(200, json.dumps(body).encode())


def resume_answer(data: bytes = FILE, *, parts: int = 1) -> Answer:
    return Answer(
        200,
        data,
        {
            "x-snapshot-parts": str(parts),
            "x-snapshot-bytes": str(len(FILE)),
            "x-snapshot-raw-bytes": str(4 * len(FILE)),
            "x-snapshot-sha256": DIGEST,
            "x-snapshot-opencode-version": "1.19.0",
        },
    )


class Opener:
    """Answers the requests one after the other and keeps them."""

    def __init__(self, *answers: Answer | Exception) -> None:
        self.answers = list(answers)
        self.requests: list[urllib.request.Request] = []

    def open(self, request: urllib.request.Request, timeout: float | None = None) -> Answer:
        self.requests.append(request)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        if answer.status >= 400:
            headers = Message()
            for name, value in answer.headers.items():
                headers[name] = value
            raise HTTPError(request.full_url, answer.status, "x", headers, io.BytesIO(answer.body))
        return answer


def header(request: urllib.request.Request, name: str) -> str | None:
    lower = {key.lower(): value for key, value in request.header_items()}
    return lower.get(name.lower())


def make(*answers: Answer | Exception) -> tuple[RunnerJobApi, Opener]:
    api = RunnerJobApi("https://app.test", CREDENTIAL, request_timeout=5)
    opener = Opener(*answers)
    api._opener = opener  # type: ignore[assignment]  # pyright: ignore[reportPrivateUsage]
    api.hold(JOB, LEASE)
    return api, opener


def switched_on(*answers: Answer | Exception) -> tuple[RunnerJobApi, Opener]:
    """An API that has read `runner_session_snapshot` from the app for the job."""
    api, opener = make(version("worker_api", "runner_session_snapshot"), *answers)
    asyncio.run(api.check_app(JOB))
    opener.requests.clear()
    return api, opener


# #879-T01
def test_the_snapshot_goes_to_the_runner_route_with_the_lease_token_in_a_header() -> None:
    api, opener = switched_on(Answer(200, b'{"version":1,"part":0,"parts":1,"complete":true}'))

    asyncio.run(api.snapshot(JOB, PART))

    (request,) = opener.requests
    assert request.get_method() == "PUT"
    path = request.full_url.removeprefix("https://app.test")
    assert path == (
        f"/api/runners/v1/jobs/{JOB}/session?part=0&parts=1&bytes={len(FILE)}"
        f"&rawBytes={4 * len(FILE)}&sha256={DIGEST}&opencodeVersion=1.19.0"
    )
    assert header(request, "Authorization") == f"Bearer {CREDENTIAL}"
    assert header(request, "X-Lease-Token") == LEASE
    assert header(request, "Content-Type") == "application/octet-stream"
    assert request.data == FILE


# #879-T01
def test_the_stored_session_is_read_from_the_runner_route_with_the_lease_token() -> None:
    api, opener = switched_on(resume_answer())

    received = asyncio.run(api.resume_session(JOB))

    (request,) = opener.requests
    assert request.get_method() == "GET"
    assert request.full_url == f"https://app.test/api/runners/v1/jobs/{JOB}/resume-session?part=0"
    assert header(request, "Authorization") == f"Bearer {CREDENTIAL}"
    assert header(request, "X-Lease-Token") == LEASE
    assert received.data == FILE and received.header.sha256 == DIGEST


# #879-T01
def test_every_part_of_a_stored_session_carries_the_lease_token() -> None:
    first, second = b"a" * CHUNK_BYTES, b"b" * 10
    whole = first + second
    digest = hashlib.sha256(whole).hexdigest()
    described = {
        "x-snapshot-parts": "2",
        "x-snapshot-bytes": str(len(whole)),
        "x-snapshot-raw-bytes": "99",
        "x-snapshot-sha256": digest,
        "x-snapshot-opencode-version": "1.19.0",
    }
    api, opener = switched_on(Answer(200, first, described), Answer(200, second, described))

    received = asyncio.run(api.resume_session(JOB))

    assert received.data == whole
    assert [r.full_url.rsplit("?", 1)[1] for r in opener.requests] == ["part=0", "part=1"]
    assert [header(r, "X-Lease-Token") for r in opener.requests] == [LEASE, LEASE]


# #879-T02
@pytest.mark.parametrize(
    ("features", "expected"),
    [
        (("worker_api", "runner_session_snapshot"), True),
        (("runner_session_snapshot",), True),  # `worker_api` is not a runner job's concern
        # An app that has the Worker routes and not the runner's: the fault of #874.
        (("worker_api", "implementer_steps", "implementer_snapshot"), False),
        (("worker_api", "implementer_steps"), False),
        ((), False),
    ],
)
def test_the_snapshot_is_on_only_when_the_app_lists_runner_session_snapshot(
    features: tuple[str, ...], expected: bool
) -> None:
    api, opener = make(version(*features))

    asyncio.run(api.check_app(JOB))

    assert api.supports_snapshot is expected
    (request,) = opener.requests
    assert request.full_url == f"https://app.test/api/runners/v1/version?jobId={JOB}"
    assert header(request, "Authorization") == f"Bearer {CREDENTIAL}"


# #879-T02
def test_a_client_that_has_not_asked_the_app_has_no_snapshot() -> None:
    api, _ = make()

    assert api.supports_snapshot is False


# #879-T02
def test_the_decision_is_taken_for_every_job_not_once() -> None:
    api, _ = make(
        version("runner_session_snapshot"),
        version("implementer_snapshot"),
        ApiUnavailable("no answer"),
    )
    seen: list[bool] = []

    async def go() -> None:
        for job in (JOB, OTHER_JOB, JOB):
            await api.check_app(job)
            seen.append(api.supports_snapshot)

    asyncio.run(go())

    # An app that lists it, one that does not any more, and one that does not answer: what an
    # earlier job found is never carried over.
    assert seen == [True, False, False]


# #879-T02
def test_the_steps_call_stays_available_when_the_app_lists_it_or_does_not_answer() -> None:
    api, _ = make(version("implementer_steps"), ApiUnavailable("no answer"))

    assert api.supports_steps is True  # before the version call: the default
    asyncio.run(api.check_app(JOB))
    assert api.supports_steps is True
    asyncio.run(api.check_app(JOB))
    assert api.supports_steps is True


# #879-T03
def test_with_the_feature_off_nothing_is_sent_and_the_turn_goes_on_without_a_snapshot() -> None:
    api, opener = make(version("worker_api", "implementer_snapshot"))
    asyncio.run(api.check_app(JOB))
    opener.requests.clear()

    with pytest.raises(ApiUnavailable):
        asyncio.run(api.snapshot(JOB, PART))
    with pytest.raises(ResumeUnavailable) as unavailable:
        asyncio.run(api.resume_session(JOB))

    assert unavailable.value.reason is ResumeReason.DOWNLOAD_FAILED
    assert opener.requests == []
    assert isinstance(api, SnapshotApi) and api.supports_snapshot is False


# #879-T03
def test_the_switch_is_gone_from_the_constructor() -> None:
    with pytest.raises(TypeError):
        RunnerJobApi("https://app.test", CREDENTIAL, snapshot=True)  # type: ignore[call-arg]


# #879-T04
@pytest.mark.parametrize(
    ("status", "code", "raised"),
    [
        (404, "RUNNER_JOB_NOT_FOUND", LeaseLost),
        (409, "RUNNER_LEASE_LOST", LeaseLost),
        (409, "RUNNER_JOB_ENDED", LeaseLost),
        (401, "RUNNER_UNAUTHORIZED", CredentialInvalid),
        (400, "RUNNER_REQUEST_INVALID", ApiRejected),
        (413, "RUNNER_BODY_TOO_LARGE", ApiRejected),
        (503, "RUNNER_UNAVAILABLE", ApiUnavailable),
    ],
)
def test_the_snapshot_answers_are_mapped_as_the_apps_are_meant(
    status: int, code: str, raised: type[Exception]
) -> None:
    api, _ = switched_on(Answer(status, error_body(code)))

    with pytest.raises(raised):
        asyncio.run(api.snapshot(JOB, PART))
    assert isinstance(CredentialInvalid("x", 401), LeaseLost)  # a lost claim for every caller


# #879-T04
def test_a_session_without_a_stored_snapshot_is_the_summary_fallback() -> None:
    api, _ = switched_on(Answer(204))

    with pytest.raises(ResumeUnavailable) as unavailable:
        asyncio.run(api.resume_session(JOB))

    assert unavailable.value.reason is ResumeReason.NO_SNAPSHOT


# #879-T04
@pytest.mark.parametrize("status", [400, 401, 404, 409, 503])
def test_every_other_answer_of_the_stored_session_is_a_failed_download(status: int) -> None:
    api, _ = switched_on(Answer(status, error_body("RUNNER_LEASE_LOST")))

    with pytest.raises(ResumeUnavailable) as unavailable:
        asyncio.run(api.resume_session(JOB))

    assert unavailable.value.reason is ResumeReason.DOWNLOAD_FAILED


# #879-T05
def test_a_job_the_runner_does_not_hold_sends_nothing() -> None:
    api, opener = switched_on()
    api.forget(JOB)

    with pytest.raises(ApiRejected):
        asyncio.run(api.snapshot(JOB, PART))
    with pytest.raises(ResumeUnavailable):
        asyncio.run(api.resume_session(JOB))

    assert opener.requests == []


# #879-T06
@pytest.mark.parametrize("failure", ["snapshot", "resume", "lost", "version"])
def test_neither_the_credential_nor_the_lease_token_reaches_a_log_or_an_error(
    failure: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    leaked: list[str] = []
    api, _ = switched_on(Answer(409, error_body("RUNNER_LEASE_LOST")))
    calls: dict[str, Callable[[], Any]] = {
        "snapshot": lambda: api.snapshot(JOB, PART),
        "resume": lambda: api.resume_session(JOB),
        "lost": lambda: api.snapshot(JOB, PART),
        "version": lambda: api.check_app(JOB),
    }
    if failure == "version":
        api, _ = make(ApiUnavailable("no answer (URLError)"))
        calls["version"] = lambda: api.check_app(JOB)

    try:
        asyncio.run(calls[failure]())
    except Exception as error:
        leaked.append(f"{error!r} {error}")

    leaked.append(caplog.text)
    assert not any(secret in text for secret in SECRET_PARTS for text in leaked)
