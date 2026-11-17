# SPDX-License-Identifier: LicenseRef-Proprietary

"""The relay of the MCP door (#1067): the local endpoint the agent's harness talks to, forwarding to
the app with the job's credential. The relay is the real code on a loopback socket; the app is
`FakeApp`. No real network."""

import http.client
import json
import threading
from collections.abc import Iterator
from dataclasses import dataclass, field

import pytest
from mcp_door_support import (
    JOB_CREDENTIAL,
    JOB_ID,
    SERVER_A,
    SERVER_B,
    SERVER_CREDENTIAL,
    Answer,
    FakeApp,
    error,
    jsonrpc,
)

from code_reviewer_runner.implementer.mcpdoor.relay import (
    MAX_REQUEST_BYTES,
    AppAccess,
    McpRelay,
    make_server,
)

pytestmark = pytest.mark.unit


@dataclass
class Rig:
    app: FakeApp
    relay: McpRelay
    port: int
    slept: list[float] = field(default_factory=lambda: [])

    def request(
        self,
        method: str,
        server: str = SERVER_A,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        path: str | None = None,
    ) -> tuple[int, dict[str, str], bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            connection.request(method, path or f"/mcp/{server}", body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            return response.status, {k.lower(): v for k, v in response.getheaders()}, data
        finally:
            connection.close()


@pytest.fixture
def rig() -> Iterator[Rig]:
    app = FakeApp()
    slept: list[float] = []
    relay = McpRelay(
        AppAccess(app.url, JOB_ID, JOB_CREDENTIAL),
        frozenset({SERVER_A, SERVER_B}),
        sleeper=slept.append,
    )
    server = make_server(relay, "127.0.0.1", 0)
    threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
    ).start()
    yield Rig(app, relay, server.server_address[1], slept)
    server.shutdown()
    server.server_close()
    app.stop()


def initialize(rig: Rig, server: str = SERVER_A) -> str:
    status, headers, _ = rig.request("POST", server, jsonrpc("initialize"))
    assert status == 200
    return headers["mcp-session-id"]


# #1067-T01
def test_a_call_goes_to_the_app_with_the_job_credential_and_the_server_sees_its_own(
    rig: Rig,
) -> None:
    session = initialize(rig)

    status, headers, body = rig.request(
        "POST",
        body=jsonrpc("tools/call", name="issues_list", arguments={"q": 1}),
        headers={"Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18"},
    )

    assert status == 200 and headers["content-type"] == "application/json"
    assert json.loads(body)["result"]["content"][0]["text"] == "called issues_list"
    seen = rig.app.requests[-1]
    assert seen.method == "POST"
    assert seen.path == f"/api/workers/v1/jobs/{JOB_ID}/mcp/{SERVER_A}"
    assert seen.headers["authorization"] == f"Bearer {JOB_CREDENTIAL}"
    assert seen.headers["mcp-session-id"] == session
    assert seen.headers["mcp-protocol-version"] == "2025-06-18"
    assert rig.app.server_saw and set(rig.app.server_saw) == {SERVER_CREDENTIAL}, (
        "the credential of the server is the app's to add; the fake server saw it"
    )


# #1067-T01
def test_nothing_of_the_agents_request_goes_on_but_the_message_the_session_and_the_version(
    rig: Rig,
) -> None:
    rig.request(
        "POST",
        body=jsonrpc("tools/list"),
        headers={
            "Authorization": "Bearer the-agents-own",
            "Cookie": "sid=1",
            "X-Forwarded-For": "1.2.3.4",
            "X-Anything": "else",
            "Origin": "http://evil.example",
            "Mcp-Session-Id": "s-1",
        },
    )

    seen = rig.app.requests[-1]
    assert seen.headers["authorization"] == f"Bearer {JOB_CREDENTIAL}", "never the agent's own"
    for name in ("cookie", "x-forwarded-for", "x-anything", "origin"):
        assert name not in seen.headers
    assert json.loads(seen.body)["method"] == "tools/list"


# #1067-T01
def test_only_the_content_type_the_session_id_and_the_body_come_back(rig: Rig) -> None:
    rig.app.script.append(
        Answer(
            200,
            b"{}",
            {
                "Content-Type": "application/json",
                "Mcp-Session-Id": "s-9",
                "Set-Cookie": "a=b",
                "WWW-Authenticate": "Bearer realm=x",
                "X-Internal": "yes",
                "Location": "http://elsewhere",
            },
        )
    )

    status, headers, body = rig.request("POST", body=jsonrpc("initialize"))

    assert (status, body) == (200, b"{}")
    assert headers["mcp-session-id"] == "s-9" and headers["content-type"] == "application/json"
    for name in ("set-cookie", "www-authenticate", "x-internal", "location"):
        assert name not in headers


# #1067-T01
def test_a_server_the_step_does_not_have_is_404_and_nothing_goes_to_the_app(rig: Rig) -> None:
    other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

    for path in (f"/mcp/{other}", "/mcp/not-an-id", "/other", "/mcp/", f"/mcp/{SERVER_A}/x"):
        status, _, body = rig.request("POST", body=jsonrpc("tools/list"), path=path)
        assert status == 404
        assert json.loads(body)["error"]["message"] == "mcp_server_unavailable"

    assert rig.app.requests == []


# #1067-T01
def test_get_is_405_like_the_app_and_makes_no_request(rig: Rig) -> None:
    status, headers, _ = rig.request("GET")

    assert status == 405 and headers["allow"] == "POST, DELETE"
    assert rig.app.requests == []


@pytest.mark.parametrize("header", ["Mcp-Session-Id", "MCP-Protocol-Version"])
def test_a_session_id_or_version_that_is_not_a_plain_token_is_400(rig: Rig, header: str) -> None:
    status, _, body = rig.request("POST", body=jsonrpc("tools/list"), headers={header: "a b"})

    assert status == 400
    assert json.loads(body)["error"]["message"] == "mcp_proxy_request_invalid"
    assert rig.app.requests == []


def test_a_request_larger_than_the_cap_is_413_and_a_body_without_a_length_is_400(rig: Rig) -> None:
    status, _, body = rig.request("POST", body=b"x" * (MAX_REQUEST_BYTES + 1))
    assert status == 413
    assert json.loads(body)["error"]["message"] == "mcp_proxy_request_too_large"

    connection = http.client.HTTPConnection("127.0.0.1", rig.port, timeout=10)
    connection.putrequest("POST", f"/mcp/{SERVER_A}")
    connection.endheaders()
    assert connection.getresponse().status == 400
    connection.close()
    assert rig.app.requests == []


# #1067-T04
def test_a_503_is_passed_on_as_it_is_and_never_asked_again(rig: Rig) -> None:
    rig.app.script.append(
        Answer(503, error("mcp_proxy_timeout"), {"Content-Type": "application/json"})
    )

    status, _, body = rig.request("POST", body=jsonrpc("tools/call", name="t"))

    assert status == 503
    assert json.loads(body)["error"]["message"] == "mcp_proxy_timeout"
    assert len(rig.app.requests) == 1, "a tools/call may have run: no automatic retry"
    assert rig.slept == []


# #1067-T04
@pytest.mark.parametrize(
    "code",
    [
        "mcp_proxy_unreachable",
        "mcp_proxy_http_error",
        "mcp_credential_broken",
        "RUNNER_INTERNAL_ERROR",
    ],
)
def test_no_failure_of_the_app_is_ever_repeated(rig: Rig, code: str) -> None:
    for status in (500, 503):
        rig.app.script.append(Answer(status, error(code), {"Content-Type": "application/json"}))
        rig.request("POST", body=jsonrpc("tools/call", name="t"))

    assert len(rig.app.requests) == 2


# #1067-T04
def test_a_concurrent_call_429_with_retry_after_is_asked_once_more_after_the_wait(rig: Rig) -> None:
    rig.app.script.append(
        Answer(
            429,
            error("mcp_too_many_concurrent_calls"),
            {"Retry-After": "1", "Content-Type": "application/json"},
        )
    )

    status, _, body = rig.request("POST", body=jsonrpc("tools/call", name="issues_list"))

    assert status == 200 and b"called issues_list" in body
    assert rig.slept == [1.0]
    assert len(rig.app.requests) == 2 and rig.app.requests[0].body == rig.app.requests[1].body


# #1067-T04
def test_a_second_429_is_the_answer_there_is_one_retry_at_most(rig: Rig) -> None:
    busy = Answer(429, error("mcp_too_many_concurrent_calls"), {"Retry-After": "1"})
    rig.app.script.extend([busy, busy, busy])

    status, headers, body = rig.request("POST", body=jsonrpc("tools/call", name="t"))

    assert status == 429 and headers["retry-after"] == "1"
    assert json.loads(body)["error"]["message"] == "mcp_too_many_concurrent_calls"
    assert len(rig.app.requests) == 2 and rig.slept == [1.0]


# #1067-T04
def test_the_call_limit_of_the_claim_is_final(rig: Rig) -> None:
    rig.app.script.append(Answer(429, error("mcp_call_limit_reached"), {"Retry-After": "1"}))

    status, _, body = rig.request("POST", body=jsonrpc("tools/call", name="t"))

    assert status == 429
    assert json.loads(body)["error"]["message"] == "mcp_call_limit_reached"
    assert len(rig.app.requests) == 1 and rig.slept == []


def test_a_retry_after_is_honoured_only_up_to_a_few_seconds(rig: Rig) -> None:
    rig.app.script.append(
        Answer(429, error("mcp_too_many_concurrent_calls"), {"Retry-After": "3600"})
    )

    rig.request("POST", body=jsonrpc("tools/call", name="t"))

    assert rig.slept == [5.0]


# #1067-T04
def test_a_429_without_retry_after_is_not_retried(rig: Rig) -> None:
    rig.app.script.append(Answer(429, error("mcp_too_many_concurrent_calls")))

    status, _, _ = rig.request("POST", body=jsonrpc("tools/call", name="t"))

    assert status == 429 and len(rig.app.requests) == 1


# #1067-T04
def test_an_app_that_cannot_be_reached_is_a_503_of_the_door_and_not_repeated() -> None:
    sleeps: list[float] = []
    relay = McpRelay(
        AppAccess("http://127.0.0.1:1", JOB_ID, JOB_CREDENTIAL),
        frozenset({SERVER_A}),
        sleeper=sleeps.append,
    )
    server = make_server(relay, "127.0.0.1", 0)
    threading.Thread(
        target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
    ).start()
    try:
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
        connection.request("POST", f"/mcp/{SERVER_A}", body=jsonrpc("tools/call", name="t"))
        response = connection.getresponse()
        body = response.read()
    finally:
        server.shutdown()
        server.server_close()

    assert response.status == 503
    assert json.loads(body)["error"]["message"] == "mcp_proxy_unreachable"
    assert sleeps == []
    assert JOB_CREDENTIAL not in body.decode()


# #1067-T02
def test_an_event_stream_is_relayed_as_it_arrives_and_letting_go_ends_the_request_to_the_app(
    rig: Rig,
) -> None:
    connection = http.client.HTTPConnection("127.0.0.1", rig.port, timeout=10)
    connection.request("POST", f"/mcp/{SERVER_A}", body=jsonrpc("stream"))
    response = connection.getresponse()

    assert response.status == 200 and response.getheader("content-type") == "text/event-stream"
    assert rig.app.stream_started.wait(5)
    first = response.read1(1024)  # the first event, while the app's stream is still open
    assert b'"first":1' in first
    response.close()
    connection.close()  # the agent lets go
    rig.app.stream_release.set()
    assert rig.app.stream_closed.wait(5), "the request to the app ended with the agent's"


# -- the sessions ---------------------------------------------------------------------------------


# #1067-T05
def test_the_sessions_the_agent_left_open_are_ended_with_a_delete_when_the_step_ends(
    rig: Rig,
) -> None:
    first = initialize(rig, SERVER_A)
    second = initialize(rig, SERVER_B)
    assert rig.app.sessions == {first, second}
    assert set(rig.relay.open_sessions()) == {(SERVER_A, first), (SERVER_B, second)}

    left = rig.relay.close_sessions()

    assert left == 0 and rig.app.sessions == set(), "the fake server has no open session"
    deletes = [seen for seen in rig.app.requests if seen.method == "DELETE"]
    assert {(seen.path.rsplit("/", 1)[1], seen.headers["mcp-session-id"]) for seen in deletes} == {
        (SERVER_A, first),
        (SERVER_B, second),
    }
    assert all(seen.headers["authorization"] == f"Bearer {JOB_CREDENTIAL}" for seen in deletes)
    assert rig.relay.counts.opened == 2 and rig.relay.counts.closed == 2


# #1067-T05
def test_a_session_the_agent_ended_itself_is_not_ended_twice(rig: Rig) -> None:
    session = initialize(rig)

    status, _, _ = rig.request("DELETE", headers={"Mcp-Session-Id": session})
    assert status == 200 and rig.app.sessions == set()
    rig.relay.close_sessions()

    assert [seen.method for seen in rig.app.requests] == ["POST", "DELETE"]


# #1067-T05
def test_a_delete_that_fails_is_not_repeated_and_is_counted_as_left(rig: Rig) -> None:
    initialize(rig)
    rig.app.script.append(Answer(503, error("mcp_proxy_unreachable")))

    left = rig.relay.close_sessions()

    assert left == 1
    assert len([seen for seen in rig.app.requests if seen.method == "DELETE"]) == 1


# #1067-T05
def test_after_the_sessions_are_closed_the_credential_is_dropped_and_no_call_goes_out(
    rig: Rig,
) -> None:
    rig.relay.close_sessions()
    before = len(rig.app.requests)

    status, _, _ = rig.request("POST", body=jsonrpc("tools/call", name="t"))

    assert status == 503 and len(rig.app.requests) == before


def test_the_credential_and_the_address_are_not_in_what_a_repr_shows() -> None:
    access = AppAccess("https://app.example", JOB_ID, JOB_CREDENTIAL)

    assert JOB_CREDENTIAL not in repr(access) and "app.example" not in repr(access)


def test_a_path_that_tries_to_leave_the_server_is_404(rig: Rig) -> None:
    status, _, _ = rig.request("POST", body=b"{}", path=f"/mcp/{SERVER_A}/../../x")

    assert status == 404 and rig.app.requests == []
