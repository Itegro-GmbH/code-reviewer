# SPDX-License-Identifier: LicenseRef-Proprietary

"""The session snapshot of a customer's runner on the client's side (#879): the two calls go to the
runner API's routes with the lease token in a header, the feature that switches them on is
`runner_session_snapshot` read per job, and the answers of the app are mapped as the Worker's are.

The app is a scripted opener (no socket): a test says what the next calls answer and reads what the
client sent. The wire against the fake App is the contract level's, a whole turn the loopback's.
"""

import asyncio
import contextlib
import hashlib
import io
import json
import logging
import threading
import time
import traceback
import urllib.request
from collections.abc import Callable, Generator
from email.message import Message
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError

import pytest

from code_reviewer_runner.factory_runner.job_api import RunnerJobApi
from code_reviewer_runner.job_loop import worker_api
from code_reviewer_runner.job_loop.http import (
    ApiRejected,
    ApiUnavailable,
    LeaseLost,
    Reply,
    parse_json,
)
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


# #879-T08
def test_a_version_answer_nested_beyond_the_parsers_stack_is_no_list_and_no_error() -> None:
    api, _ = make(Answer(200, b"[" * 200_000))

    asyncio.run(api.check_app(JOB))

    assert api.features_listed is False
    assert api.supports_snapshot is False


# #879-T08
def test_the_json_reader_gives_none_for_a_body_too_deep_or_too_large_for_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert parse_json(Reply(200, {}, b"[" * 200_000)) is None

    def out_of_memory(*_: object) -> None:
        raise MemoryError

    monkeypatch.setattr(json, "loads", out_of_memory)
    assert parse_json(Reply(200, {}, b"{}")) is None


# #879-T08
def test_an_app_that_lists_features_is_noted_and_one_that_does_not_is_not() -> None:
    api, _ = make(version("runner_session_snapshot"), Answer(200, b"{}"), ApiUnavailable("x"))
    seen: list[bool] = []

    async def go() -> None:
        for _ in range(3):
            await api.check_app(JOB)
            seen.append(api.features_listed)

    asyncio.run(go())

    assert seen == [True, False, False]


class Trickle(BaseHTTPRequestHandler):
    """A version answer that arrives a hundred bytes at a time, each well inside the socket
    timeout, for much longer than the call may take."""

    def log_message(self, format: str, *args: Any) -> None:
        return None

    def do_GET(self) -> None:
        body = json.dumps(
            {"version": 1, "features": ["runner_session_snapshot"], "pad": "x" * 3000}
        ).encode()
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        for start in range(0, len(body), 100):
            try:
                self.wfile.write(body[start : start + 100])
                self.wfile.flush()
            except OSError:
                return
            time.sleep(0.2)


class EchoFailure(BaseHTTPRequestHandler):
    """A 500 whose body repeats the request, headers included: an app that echoes what it got."""

    def log_message(self, format: str, *args: Any) -> None:
        return None

    def _answer(self) -> None:
        length = int(self.headers.get("content-length") or 0)
        self.rfile.read(length)
        body = json.dumps(
            {
                "error": {
                    "code": "RUNNER_UNAVAILABLE",
                    "message": f"{self.requestline}\n{self.headers}",
                }
            }
        ).encode()
        self.send_response(500)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_PUT = do_POST = _answer


@contextlib.contextmanager
def local_app(handler: type[BaseHTTPRequestHandler]) -> Generator[str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


# #879-T08
def test_a_server_that_trickles_the_version_answer_is_no_list_at_the_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(worker_api, "VERSION_CALL_TOTAL_SECONDS", 1.0)
    with local_app(Trickle) as url:
        # The socket timeout (5 s) never trips: only the call's own deadline can end it.
        api = RunnerJobApi(url, CREDENTIAL, request_timeout=5.0)
        started = time.monotonic()

        asyncio.run(api.check_app(JOB))

        elapsed = time.monotonic() - started

    assert elapsed < 2.5  # the whole answer would take six seconds
    assert api.features_listed is False
    assert api.supports_snapshot is False
    assert api.supports_steps is True  # the default, as for an app that does not answer


# #879-T08
def test_a_version_call_that_does_not_end_is_no_list_at_the_deadline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(worker_api, "VERSION_CALL_TOTAL_SECONDS", 0.5)
    api, _ = make()

    def hangs(*args: object, **kwargs: object) -> Reply:
        time.sleep(3.0)
        raise AssertionError("nobody waits for this answer")

    monkeypatch.setattr(api, "_send_bytes", hangs)
    started = time.monotonic()

    asyncio.run(api.check_app(JOB))

    assert time.monotonic() - started < 2.0
    assert api.features_listed is False and api.supports_snapshot is False


def exposed(error: BaseException | None) -> list[str]:
    """Every text an error shows: its own and the chain's, and the traceback as it is printed."""
    texts: list[str] = []
    seen: set[int] = set()
    while error is not None and id(error) not in seen:
        seen.add(id(error))
        texts += [repr(error), str(error), "".join(traceback.format_exception(error))]
        texts += [repr(error.__cause__), repr(error.__context__)]
        error = error.__cause__ or error.__context__
    return texts


async def snapshot_call(api: RunnerJobApi) -> None:
    await api.snapshot(JOB, PART)


async def resume_call(api: RunnerJobApi) -> None:
    await api.resume_session(JOB)


def assert_no_secret_in(error: BaseException | None, log: str) -> None:
    texts = [*exposed(error), log]
    assert not [s for s in SECRET_PARTS for text in texts if s in text]


# #879-T06
@pytest.mark.parametrize(
    ("answers", "call", "raised"),
    [
        ([Answer(409, error_body("RUNNER_LEASE_LOST"))], snapshot_call, LeaseLost),
        ([Answer(409, error_body("RUNNER_LEASE_LOST"))], resume_call, ResumeUnavailable),
        ([Answer(500, f"{CREDENTIAL} {LEASE}".encode())], snapshot_call, ApiUnavailable),
        ([ConnectionResetError(104, "Connection reset by peer")], snapshot_call, ApiUnavailable),
    ],
    ids=["lease-lost", "resume-failed", "hostile-500-body", "socket-error"],
)
def test_neither_the_credential_nor_the_lease_token_reaches_a_log_or_an_error(
    answers: list[Answer | Exception],
    call: Callable[[RunnerJobApi], Any],
    raised: type[Exception],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    api, _ = switched_on(*answers)

    with pytest.raises(raised) as caught:
        asyncio.run(call(api))

    assert_no_secret_in(caught.value, caplog.text)


# #879-T06
def test_no_secret_is_in_an_error_or_a_log_when_the_app_answers_500_over_a_real_socket(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    with local_app(EchoFailure) as url:
        api = RunnerJobApi(url, CREDENTIAL, request_timeout=5.0)
        api.hold(JOB, LEASE)
        api._features = frozenset({"runner_session_snapshot"})  # pyright: ignore[reportPrivateUsage]
        errors: list[BaseException] = []
        for call in (snapshot_call, resume_call):
            with pytest.raises((ApiUnavailable, ResumeUnavailable)) as caught:
                asyncio.run(call(api))
            errors.append(caught.value)
        asyncio.run(api.check_app(JOB))  # swallows the 500: nothing raised, nothing logged

    # The echo does repeat both secrets: that is what makes the test mean something.
    assert api.features_listed is False
    for error in errors:
        assert_no_secret_in(error, caplog.text)


# #855-F1 (S8): the short wait for the thread of the call before must not stop the event loop.
def test_waiting_for_the_call_before_does_not_block_the_event_loop() -> None:
    api, _ = make()
    release = threading.Event()
    earlier = threading.Thread(target=release.wait, daemon=True)
    earlier.start()
    api._steps_thread = earlier  # pyright: ignore[reportPrivateUsage]
    ticks = 0

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    async def scenario() -> None:
        task = asyncio.ensure_future(ticker())
        try:
            with pytest.raises(ApiUnavailable, match="has not ended"):
                await api.steps(JOB, b"{}")
        finally:
            task.cancel()
            release.set()

    asyncio.run(scenario())

    # The wait is a quarter of a second: a loop that was free ticked a good part of 25 times.
    assert ticks >= 10


# #890 (S8): after the wait the slot is read again, so two callers that waited for the same
# predecessor do not both start a thread.
def test_two_callers_that_waited_for_the_same_predecessor_do_not_both_start_a_thread() -> None:
    api, _ = make()
    gate = threading.Event()
    sent: list[urllib.request.Request] = []

    class Blocking:
        def open(self, request: urllib.request.Request, timeout: float | None = None) -> Answer:
            sent.append(request)
            gate.wait(5)
            return Answer(200)

    api._opener = Blocking()  # type: ignore[assignment]  # pyright: ignore[reportPrivateUsage]
    earlier = threading.Thread(target=time.sleep, args=(0.05,), daemon=True)
    earlier.start()
    api._steps_thread = earlier  # pyright: ignore[reportPrivateUsage]

    async def scenario() -> list[object]:
        calls = [asyncio.ensure_future(api.steps(JOB, b"{}")) for _ in range(2)]
        try:
            await asyncio.wait(calls, timeout=1.0, return_when=asyncio.FIRST_COMPLETED)
            refused = [call for call in calls if call.done()]
            assert len(refused) == 1
            return [refused[0].exception()]
        finally:
            gate.set()
            await asyncio.gather(*calls, return_exceptions=True)

    outcome = asyncio.run(scenario())

    assert len(sent) == 1
    assert isinstance(outcome[0], ApiUnavailable) and "has not ended" in str(outcome[0])


def test_a_call_whose_predecessor_ends_within_the_moment_goes_on() -> None:
    api, opener = make(Answer(200))
    earlier = threading.Thread(target=time.sleep, args=(0.05,), daemon=True)
    earlier.start()
    api._steps_thread = earlier  # pyright: ignore[reportPrivateUsage]

    asyncio.run(api.steps(JOB, b"{}"))

    assert len(opener.requests) == 1
