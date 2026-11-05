# SPDX-License-Identifier: LicenseRef-Proprietary

"""The download of the stored session of a follow-up turn by the Worker's client (#840) against a
real server on loopback: the parts the app serves it in, the checks on every part and on the whole,
and what each way of failing is called. Nothing it raises carries a value of the answer."""

import asyncio
import hashlib
import os
import socket
import threading
import time
from collections.abc import Iterator

import pytest
from worker_api_fake import CREDENTIAL, FakeWorkerApp, RawServer, Scripted, example

from code_reviewer_runner.job_loop import worker_api
from code_reviewer_runner.job_loop.resume_download import ResumeUnavailable
from code_reviewer_runner.job_loop.worker_api import HttpWorkerApi
from code_reviewer_runner.resume_wire import ResumeReason
from code_reviewer_runner.snapshot_wire import CHUNK_BYTES

JOB_ID: str = example("WorkerJobDetailsResponse")["job"]["id"]


@pytest.fixture
def app() -> Iterator[FakeWorkerApp]:
    fake = FakeWorkerApp().start()
    yield fake
    fake.stop()


def client(url: str) -> HttpWorkerApi:
    return HttpWorkerApi(url, CREDENTIAL, request_timeout=5)


def download(app: FakeWorkerApp) -> bytes:
    return asyncio.run(client(app.url).resume_session(JOB_ID)).data


def reason_of(app: FakeWorkerApp) -> ResumeReason:
    with pytest.raises(ResumeUnavailable) as caught:
        asyncio.run(client(app.url).resume_session(JOB_ID))
    return caught.value.reason


# #840-T90
def test_a_small_file_comes_in_one_request_with_the_credential_and_its_description() -> None:
    app = FakeWorkerApp().start()
    try:
        app.resume_file = os.urandom(5_000)
        app.resume_raw_bytes = 20_000

        received = asyncio.run(client(app.url).resume_session(JOB_ID))

        assert received.data == app.resume_file
        assert received.header.size == 5_000
        assert received.header.raw_bytes == 20_000
        assert received.header.sha256 == hashlib.sha256(app.resume_file).hexdigest()
        assert received.header.version == "1.19.0"
        (sent,) = [r for r in app.requests if r["kind"] == "resume"]
        assert sent["method"] == "GET"
        assert sent["headers"]["Authorization"] == f"Bearer {CREDENTIAL}"
        assert sent["query"] == {"part": ["0"]}
    finally:
        app.stop()


# #840-T91
def test_a_large_file_is_fetched_in_its_parts_and_put_together(app: FakeWorkerApp) -> None:
    app.resume_file = os.urandom(2 * CHUNK_BYTES + 1234)

    assert download(app) == app.resume_file
    asked = [r["query"]["part"][0] for r in app.requests if r["kind"] == "resume"]
    assert asked == ["0", "1", "2"]


# #840-T92
def test_a_session_with_no_stored_snapshot_is_no_snapshot(app: FakeWorkerApp) -> None:
    app.resume_file = None

    assert reason_of(app) is ResumeReason.NO_SNAPSHOT


# #840-T93
@pytest.mark.parametrize("status", [400, 401, 404, 409, 413, 429, 500, 502, 503])
def test_every_other_answer_is_a_failed_download(app: FakeWorkerApp, status: int) -> None:
    app.script(
        "resume", Scripted(status, {"error": {"code": "RUNNER_REQUEST_INVALID", "message": "m"}})
    )

    assert reason_of(app) is ResumeReason.DOWNLOAD_FAILED


# #840-T94
def test_a_redirect_is_a_failed_download_and_is_not_followed(app: FakeWorkerApp) -> None:
    app.script("resume", Scripted(302, None, {"Location": "http://127.0.0.1:1/elsewhere"}))

    assert reason_of(app) is ResumeReason.DOWNLOAD_FAILED
    assert [r["kind"] for r in app.requests] == ["resume"]


# #840-T95
def test_no_server_is_a_failed_download() -> None:
    server = FakeWorkerApp().start()
    url = server.url
    server.stop()

    with pytest.raises(ResumeUnavailable) as caught:
        asyncio.run(client(url).resume_session(JOB_ID))

    assert caught.value.reason is ResumeReason.DOWNLOAD_FAILED


# #840-T96
def test_an_answer_that_is_not_http_is_a_failed_download() -> None:
    raw = RawServer(b"garbage that is not http")
    try:
        with pytest.raises(ResumeUnavailable) as caught:
            asyncio.run(client(raw.url).resume_session(JOB_ID))
    finally:
        raw.close()

    assert caught.value.reason is ResumeReason.DOWNLOAD_FAILED


# #840-T97
@pytest.mark.parametrize(
    "headers",
    [
        {"x-snapshot-sha256": "0" * 64},  # not the digest of the bytes
        {"x-snapshot-bytes": "4999"},  # not the size of the bytes
        {"x-snapshot-bytes": "5001"},
        {"x-snapshot-parts": "2"},  # not what the size makes
        {"x-snapshot-parts": "4"},
        {"x-snapshot-sha256": "Z" * 64},
        {"x-snapshot-opencode-version": "../x"},
        {"x-snapshot-raw-bytes": "0"},
        {"x-snapshot-raw-bytes": "abc"},
    ],
)
def test_a_description_the_bytes_do_not_match_is_a_failed_download(
    app: FakeWorkerApp, headers: dict[str, str]
) -> None:
    app.resume_file = os.urandom(5_000)
    app.resume_headers = headers

    assert reason_of(app) is ResumeReason.DOWNLOAD_FAILED


# #840-T98
def test_a_missing_header_is_a_failed_download(app: FakeWorkerApp) -> None:
    app.resume_file = os.urandom(100)
    app.script(
        "resume",
        Scripted(200, b"x" * 100, {"x-snapshot-parts": "1", "x-snapshot-bytes": "100"}),
    )

    assert reason_of(app) is ResumeReason.DOWNLOAD_FAILED


# #840-T99
def test_a_part_longer_or_shorter_than_it_should_be_is_a_failed_download(
    app: FakeWorkerApp,
) -> None:
    whole = os.urandom(5_000)
    app.resume_file = whole
    sha = hashlib.sha256(whole).hexdigest()
    described = {
        "x-snapshot-parts": "1",
        "x-snapshot-bytes": "5000",
        "x-snapshot-raw-bytes": "9",
        "x-snapshot-sha256": sha,
        "x-snapshot-opencode-version": "1.19.0",
    }
    for body in (whole[:-1], whole + b"x"):
        app.script("resume", Scripted(200, body, described))
        assert reason_of(app) is ResumeReason.DOWNLOAD_FAILED


# #840-T100
def test_parts_that_describe_different_files_are_a_failed_download(app: FakeWorkerApp) -> None:
    whole = os.urandom(CHUNK_BYTES + 10)
    sha = hashlib.sha256(whole).hexdigest()
    first = {
        "x-snapshot-parts": "2",
        "x-snapshot-bytes": str(len(whole)),
        "x-snapshot-raw-bytes": "9",
        "x-snapshot-sha256": sha,
        "x-snapshot-opencode-version": "1.19.0",
    }
    second = {**first, "x-snapshot-sha256": "1" * 64}
    app.script(
        "resume",
        Scripted(200, whole[:CHUNK_BYTES], first),
        Scripted(200, whole[CHUNK_BYTES:], second),
    )

    assert reason_of(app) is ResumeReason.DOWNLOAD_FAILED


# #840-T101
def test_a_file_over_the_cap_is_a_failed_download(app: FakeWorkerApp) -> None:
    app.resume_file = b"x" * 100
    app.resume_headers = {"x-snapshot-bytes": str(8 * 1024 * 1024 + 1), "x-snapshot-parts": "3"}

    assert reason_of(app) is ResumeReason.DOWNLOAD_FAILED


class Dribbler:
    """A loopback server that answers the first request and then sends a byte every 0.2 s for as
    long as it is open: no wait of the socket is long, and the answer never ends."""

    def __init__(self, *, headers_first: bool) -> None:
        self._headers_first = headers_first
        self._stop = threading.Event()
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self.url = f"http://127.0.0.1:{self._listener.getsockname()[1]}"
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            threading.Thread(target=self._dribble, args=(connection,), daemon=True).start()

    def _dribble(self, connection: socket.socket) -> None:
        sha = hashlib.sha256(b"x" * 5_000).hexdigest()
        with connection:
            try:
                connection.recv(65536)
                if self._headers_first:
                    connection.sendall(b"HTTP/1.1 200 OK\r\nX-Dribble: ")
                else:
                    connection.sendall(
                        (
                            "HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n"
                            "X-Snapshot-Parts: 1\r\nX-Snapshot-Bytes: 5000\r\n"
                            "X-Snapshot-Raw-Bytes: 9\r\n"
                            f"X-Snapshot-Sha256: {sha}\r\n"
                            "X-Snapshot-Opencode-Version: 1.19.0\r\n\r\n"
                        ).encode("ascii")
                    )
                while not self._stop.is_set():
                    connection.sendall(b"x")
                    time.sleep(0.2)
            except OSError:
                pass

    def close(self) -> None:
        self._stop.set()
        self._listener.close()


# #840-T160
@pytest.mark.parametrize("headers_first", [False, True], ids=["body", "headers"])
def test_a_server_that_dribbles_the_answer_ends_the_download_at_the_total_not_later(
    monkeypatch: pytest.MonkeyPatch, headers_first: bool
) -> None:
    # No wait of the socket (30 s each) is ever long enough to time out, so only the deadline of the
    # download can end it; 2 s instead of 45 keeps the test short.
    monkeypatch.setattr(worker_api, "RESUME_TOTAL_SECONDS", 2.0)
    server = Dribbler(headers_first=headers_first)
    try:
        started = time.monotonic()
        with pytest.raises(ResumeUnavailable) as caught:
            asyncio.run(client(server.url).resume_session(JOB_ID))
        elapsed = time.monotonic() - started

        assert caught.value.reason is ResumeReason.DOWNLOAD_FAILED
        assert 1.5 <= elapsed < 4.0
        if not headers_first:
            # The thread read against the same deadline: it is over, not left reading.
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline and any(
                t.name == "resume-download" for t in threading.enumerate()
            ):
                time.sleep(0.05)
            assert not any(t.name == "resume-download" for t in threading.enumerate())
    finally:
        server.close()
