# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control's own clients and the outer wall's proxy (#994): the Worker reads the proxy vm-init puts
on its stdin, its calls to the app go through it and through nothing else, and only an Implementer's
job process is told of it, by the host and never by the job. The proxy here is a loopback stand-in
(the real one is `test_firecracker_proxy_wall.py`)."""

import asyncio
import json
import socket
import threading
import urllib.request
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any

import pytest
from loop_support import Harness, make_claim, outcome, run, settle
from test_implementer_job_host import (
    ALL_THREE,
    PROFILE,
    USERS,
    advertising_harness,
    implementer_claim,
    line,
)

from code_reviewer_runner.job_loop import worker
from code_reviewer_runner.job_loop.http import (
    ApiUnavailable,
    NoRedirects,
    Reply,
    build_opener,
    send,
)
from code_reviewer_runner.job_loop.worker import WorkerRequest, parse_request
from code_reviewer_runner.job_loop.worker_errors import WorkerFailure, WorkerSetupError
from code_reviewer_runner.outer_proxy import OUTER_PROXY_VARIABLE, OuterProxy

CREDENTIAL = "crj_" + "Zq3_-" * 8 + "Zq3"
JOB_ID = "00000000-0000-4000-8000-000000000001"
PROXY = OuterProxy("172.31.0.5", 3128)
APP = "http://app.example"


def start_text(**overrides: Any) -> str:
    document: dict[str, Any] = {"appUrl": APP, "jobId": JOB_ID, "credential": CREDENTIAL}
    document.update(overrides)
    return json.dumps(document)


class Proxy:
    """A loopback proxy: it records the head of each request and answers with `answer`."""

    def __init__(self, answer: bytes) -> None:
        self.answer = answer
        self.heads: list[str] = []
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        threading.Thread(target=self._serve, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._listener.getsockname()[1]}"

    def _serve(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            with connection:
                connection.settimeout(2)
                data = b""
                try:
                    while b"\r\n\r\n" not in data:
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                    self.heads.append(data.split(b"\r\n")[0].decode())
                    connection.sendall(self.answer)
                except OSError:
                    pass

    def close(self) -> None:
        self._listener.close()


@contextmanager
def proxy(answer: bytes) -> Generator[Proxy]:
    stand_in = Proxy(answer)
    try:
        yield stand_in
    finally:
        stand_in.close()


OK_JSON = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}"
REFUSED = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"


# -- the start document ---


# #994-T01
def test_the_start_document_may_carry_the_proxy_of_the_slot() -> None:
    request = parse_request(start_text(outerProxy={"host": "172.31.0.5", "port": 3128}))

    assert request.outer_proxy == PROXY


# #994-T03
def test_a_start_document_without_a_proxy_has_none() -> None:
    assert parse_request(start_text()).outer_proxy is None


# #994-T04
@pytest.mark.parametrize(
    "bad",
    [
        None,
        "172.31.0.5:3128",
        {"host": "10.0.0.1", "port": 3128},
        {"host": "127.0.0.1", "port": 3128},
        {"host": "172.31.0.5"},
        {"host": "172.31.0.5", "port": 0},
        {"host": "172.31.0.5", "port": 3128, "extra": 1},
    ],
)
def test_a_proxy_that_is_given_and_wrong_is_an_input_error_and_never_a_direct_connection(
    bad: Any,
) -> None:
    with pytest.raises(WorkerSetupError) as refusal:
        parse_request(start_text(outerProxy=bad))

    assert refusal.value.code is WorkerFailure.INPUT_INVALID
    assert CREDENTIAL not in str(refusal.value)


# #994-T01
def test_the_worker_api_is_made_with_the_proxy_the_start_gave(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    made: list[dict[str, Any]] = []

    class Recorder:
        def __init__(self, base_url: str, credential: str, **options: Any) -> None:
            made.append({"base_url": base_url, **options})

        async def check_app(self, job_id: str) -> None:
            raise WorkerSetupError(WorkerFailure.APP_UNREACHABLE, "stop here")

    monkeypatch.setattr(worker, "HttpWorkerApi", Recorder)
    from code_reviewer_runner.job_loop.settings import WorkerSettings

    for request, expected in (
        (WorkerRequest(APP, JOB_ID, CREDENTIAL, outer_proxy=PROXY), PROXY),
        (WorkerRequest(APP, JOB_ID, CREDENTIAL), None),
    ):
        asyncio.run(
            worker.run_worker(request, WorkerSettings(job_command=("x",)), {"PATH": "/usr/bin"})
        )
        assert made[-1]["proxy"] == expected


# -- the app client ---


def get(opener: urllib.request.OpenerDirector, url: str) -> Reply:
    return send(opener, urllib.request.Request(url, method="GET"), timeout=2)


# #994-T01
def test_an_http_app_is_called_in_absolute_form_through_the_proxy() -> None:
    with proxy(OK_JSON) as stand_in:
        reply = get(build_opener(stand_in.url), "http://app.example/api/workers/v1/jobs/x")

    assert reply.status == 200
    assert stand_in.heads == ["GET http://app.example/api/workers/v1/jobs/x HTTP/1.1"]


# #994-T01
def test_an_https_app_is_asked_for_as_a_connect_tunnel_through_the_proxy() -> None:
    with proxy(REFUSED) as stand_in, pytest.raises(ApiUnavailable):
        get(build_opener(stand_in.url), "https://app.example/api/workers/v1/jobs/x")

    assert stand_in.heads == ["CONNECT app.example:443 HTTP/1.1"]


# #994-T04
def test_a_proxy_that_refuses_the_name_fails_the_call_and_the_app_is_not_dialled_directly() -> None:
    dialled: list[Any] = []
    with proxy(REFUSED) as stand_in:
        proxy_port = int(stand_in.url.rsplit(":", 1)[1])
        original = socket.create_connection

        def spy(address: Any, *args: Any, **kwargs: Any) -> socket.socket:
            dialled.append(address)
            return original(address, *args, **kwargs)

        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(socket, "create_connection", spy)
            with pytest.raises(ApiUnavailable):
                get(build_opener(stand_in.url), "https://127.0.0.1:9/x")
            # Plain http: the proxy's refusal is the answer the client reads (a 403, which the
            # Worker API turns into a refusal), not a connection to the app.
            assert get(build_opener(stand_in.url), "http://127.0.0.1:9/x").status == 403

    # Only the proxy was dialled, never the app (the app's own port 9 is nobody's).
    assert {address[1] for address in dialled} == {proxy_port}


# #994-T04
def test_a_proxy_that_cannot_be_reached_fails_the_call() -> None:
    closed = socket.socket()
    closed.bind(("127.0.0.1", 0))
    url = f"http://127.0.0.1:{closed.getsockname()[1]}"
    closed.close()

    with pytest.raises(ApiUnavailable):
        get(build_opener(url), "http://app.example/x")


# #994-T04
@pytest.mark.parametrize("variable", ["no_proxy", "NO_PROXY"])
def test_the_environments_no_proxy_cannot_take_a_name_around_the_proxy(
    variable: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(variable, "*")
    with proxy(OK_JSON) as stand_in:
        reply = get(build_opener(stand_in.url), "http://app.example/x")

    assert reply.status == 200 and stand_in.heads == ["GET http://app.example/x HTTP/1.1"]


# #994-T03
def test_without_a_proxy_the_opener_is_the_one_it_was_and_dials_directly() -> None:
    opener: Any = build_opener()

    handlers: list[object] = list(opener.handlers)
    assert NoRedirects in [type(handler) for handler in handlers]
    # `ProxyHandler({})` adds no handler at all: nothing proxies, whatever the environment says.
    assert not [h for h in handlers if isinstance(h, urllib.request.ProxyHandler)]


# #994-T01
def test_a_redirect_is_still_refused_through_the_proxy() -> None:
    moved = (
        b"HTTP/1.1 302 Found\r\nLocation: http://elsewhere.example/\r\nContent-Length: 0\r\n\r\n"
    )
    with proxy(moved) as stand_in:
        reply = get(build_opener(stand_in.url), "http://app.example/x")

    assert reply.status == 302
    assert stand_in.heads == ["GET http://app.example/x HTTP/1.1"]


# -- the job process ---


# #994-T01
def test_an_implementer_job_process_is_told_the_proxy_by_the_host() -> None:
    async def scenario() -> None:
        harness = advertising_harness(outer_proxy=PROXY)
        harness.api.claims = [implementer_claim()]
        await harness.start()

        env = harness.launcher.processes[0].spec.env
        assert env[OUTER_PROXY_VARIABLE] == "172.31.0.5:3128"
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

    run(scenario)


# #994-T03
def test_an_implementer_job_process_of_a_host_without_the_proxy_is_told_nothing() -> None:
    async def scenario() -> None:
        harness = advertising_harness()
        harness.api.claims = [implementer_claim()]
        await harness.start()

        assert OUTER_PROXY_VARIABLE not in harness.launcher.processes[0].spec.env
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

    run(scenario)


# #994-T04
def test_the_environment_of_the_container_cannot_name_a_proxy_for_the_job_process() -> None:
    async def scenario() -> None:
        harness = Harness(
            **USERS,
            engines=ALL_THREE,
            dynamic_command=("/usr/local/bin/opencode",),
            dynamic_ripgrep="/usr/local/bin/rg",
            environment={**PROFILE, OUTER_PROXY_VARIABLE: "172.31.9.9:3128"},
        )
        harness.api.claims = [implementer_claim()]
        await harness.start()

        assert OUTER_PROXY_VARIABLE not in harness.launcher.processes[0].spec.env
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

    run(scenario)


# #994-T04
def test_a_job_document_cannot_name_a_proxy_for_its_own_process() -> None:
    async def scenario() -> None:
        harness = advertising_harness(outer_proxy=PROXY)
        claim = implementer_claim()
        harness.api.claims = [claim]
        await harness.start()

        spec = harness.launcher.processes[0].spec
        # The proxy is in the environment, from the host; the job's stdin is the app's document.
        assert "outerProxy" not in json.loads(spec.stdin)
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

    run(scenario)


# #994-T03
def test_a_diff_job_process_is_told_no_proxy() -> None:
    async def scenario() -> None:
        harness = Harness(outer_proxy=PROXY)
        harness.api.claims = [make_claim(1)]
        await harness.start()

        assert OUTER_PROXY_VARIABLE not in harness.launcher.processes[0].spec.env
        harness.launcher.processes[0].finish(outcome(stdout=line()))
        await settle()

    run(scenario)
