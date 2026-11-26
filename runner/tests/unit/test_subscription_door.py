# SPDX-License-Identifier: LicenseRef-Proprietary

"""The subscription mode of the model door (#1176): the real token of a Claude Code turn is in the
door and nowhere else. The agent presents a fixed placeholder; the door puts the token in its place
and forwards to api.anthropic.com and to no other host, and refuses every other credential.

The door is the real code on a real loopback socket (`run_door`); the provider is a script."""

import http.client
import json
import os
import threading
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit

import pytest
from door_support import DoorProcess, free_port
from passthrough_support import Scripted, ScriptedUpstream

from code_reviewer_runner.implementer.door.protocol import DoorRefused
from code_reviewer_runner.implementer.door.service import parse_start, run_door
from code_reviewer_runner.implementer.door.subscription import (
    SUBSCRIPTION_PLACEHOLDER,
    SUBSCRIPTION_UPSTREAM,
    parse_subscription_start,
    subscription_start_document,
)

# Split so that no source line is shaped like a real token (`tracked-secrets.test.ts`).
REAL_TOKEN = "sk-" + "ant-" + "oat01-REALTOKEN-0123456789abcdefghijklmnop"
OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20"


def run_subscription_door(
    upstream: ScriptedUpstream | None = None,
    *,
    document: str | None = None,
    destinations: list[str] | None = None,
) -> DoorProcess:
    provider = upstream or ScriptedUpstream(
        Scripted(headers=[("content-type", "text/plain")], chunks=[b"ok"])
    )
    port = free_port()
    in_read, in_write = os.pipe()
    out_read, out_write = os.pipe()
    stdin_here = os.fdopen(in_write, "w", encoding="utf-8")
    process = DoorProcess(provider, stdin_here, url=f"http://127.0.0.1:{port}")
    door_in = os.fdopen(in_read, "r", encoding="utf-8")
    door_out = os.fdopen(out_write, "w", encoding="utf-8")
    seen = threading.Event()

    def made(destination: str) -> ScriptedUpstream:
        if destinations is not None:
            destinations.append(destination)
        return provider

    def main() -> None:
        process.exit_code.append(
            run_door(
                door_in,
                door_out,
                bind=("127.0.0.1", port),
                upstream_for=made,
                poll_seconds=0.02,
            )
        )
        door_out.close()
        door_in.close()

    def read() -> None:
        reader = os.fdopen(out_read, "r", encoding="utf-8")
        for line in reader:
            process.lines.append(json.loads(line))
            seen.set()
        seen.set()

    process.reader = threading.Thread(target=read, daemon=True)
    process.reader.start()
    process.thread = threading.Thread(target=main, daemon=True)
    process.thread.start()
    text = (
        subscription_start_document(REAL_TOKEN, deadline_seconds=600.0, port=10180).decode()
        if document is None
        else document + "\n"
    )
    process.send(text)
    assert seen.wait(10)
    process.refused = process.lines[0]["t"] == "refused"
    return process


def call(
    url: str,
    method: str,
    target: str,
    headers: Mapping[str, str],
    body: bytes | None = None,
) -> tuple[int, bytes]:
    parts = urlsplit(url)
    connection = http.client.HTTPConnection(parts.hostname or "", parts.port, timeout=10)
    try:
        connection.request(method, target, body, dict(headers))
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def messages_headers(**extra: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {SUBSCRIPTION_PLACEHOLDER}",
        "anthropic-beta": OAUTH_BETA,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        **extra,
    }


def stop(door: DoorProcess) -> None:
    door.end_of_input()
    door.wait()


# #1176-T01
def test_the_door_puts_the_real_token_in_place_of_the_placeholder_and_keeps_the_beta_header() -> (
    None
):
    destinations: list[str] = []
    door = run_subscription_door(destinations=destinations)
    assert door.lines[0] == {"t": "ready"}

    body = b'{"model":"sonnet","messages":[]}'
    status, answer = call(door.url, "POST", "/v1/messages?beta=true", messages_headers(), body)

    assert status == 200 and answer == b"ok"
    sent = door.upstream.requests[0]
    headers = {name.lower(): value for name, value in sent.headers.items()}
    assert headers["authorization"] == f"Bearer {REAL_TOKEN}"
    assert headers["anthropic-beta"] == OAUTH_BETA, "the beta header is forwarded as sent"
    assert (sent.method, sent.path, sent.body) == ("POST", "/v1/messages?beta=true", body)
    assert SUBSCRIPTION_PLACEHOLDER not in json.dumps(dict(sent.headers))
    assert REAL_TOKEN.encode() not in answer
    assert destinations == [SUBSCRIPTION_UPSTREAM], "the one destination is api.anthropic.com"
    stop(door)


# #1176-T02
def test_a_request_without_credentials_passes_through_without_any() -> None:
    door = run_subscription_door()

    status, _ = call(door.url, "HEAD", "/api/hello", {"anthropic-version": "2023-06-01"})

    assert status == 200
    sent = door.upstream.requests[0]
    assert sent.method == "HEAD" and sent.path == "/api/hello"
    assert not {name.lower() for name in sent.headers} & {"authorization", "x-api-key"}
    stop(door)


@pytest.mark.parametrize(
    "credentials",
    [
        {"Authorization": "Bearer sk-" + "ant-" + "oat01-SOMEONE-ELSES-TOKEN"},
        {"Authorization": f"Bearer {REAL_TOKEN}"},
        {"Authorization": f"bearer {SUBSCRIPTION_PLACEHOLDER}x"},
        {"Authorization": f"Basic {SUBSCRIPTION_PLACEHOLDER}"},
        {"x-api-key": "sk-ant-api03-OWN-KEY"},
        {"Authorization": f"Bearer {SUBSCRIPTION_PLACEHOLDER}", "x-api-key": "sk-ant-api03-K"},
        {"Proxy-Authorization": "Basic Zm9vOmJhcg=="},
    ],
)
# #1176-T03
def test_any_other_credential_is_refused_and_the_provider_is_not_asked(
    credentials: dict[str, str],
) -> None:
    door = run_subscription_door()
    headers = {"anthropic-version": "2023-06-01", **credentials}

    status, answer = call(door.url, "POST", "/v1/messages", headers, b"{}")

    assert status in (401, 403)
    assert door.upstream.requests == []
    assert REAL_TOKEN.encode() not in answer
    stop(door)


@pytest.mark.parametrize(
    "target",
    ["http://example.com/v1/messages", "https://api.anthropic.com.evil/", "example.com:443"],
)
# #1176-T04
def test_only_a_path_on_api_anthropic_com_is_forwarded(target: str) -> None:
    destinations: list[str] = []
    door = run_subscription_door(destinations=destinations)

    status, _ = call(door.url, "POST", target, messages_headers(), b"{}")

    assert status in (400, 403)
    assert door.upstream.requests == []
    stop(door)


# #1176-T04
def test_a_host_header_cannot_name_another_destination() -> None:
    door = run_subscription_door()

    call(door.url, "POST", "/v1/messages", messages_headers(Host="evil.example"), b"{}")

    sent = door.upstream.requests[0]
    assert "host" not in {name.lower() for name in sent.headers}, "the host is the door's own"
    stop(door)


# #1176-T05
def test_the_token_is_never_written_to_the_pipe_and_the_door_says_its_last_word() -> None:
    door = run_subscription_door()
    call(door.url, "POST", "/v1/messages", messages_headers(), b"{}")
    stop(door)

    assert door.lines[-1]["t"] == "status" and door.lines[-1]["final"] is True
    assert REAL_TOKEN not in json.dumps(door.lines)
    assert door.exit_code == [0]


# #1176-T05
def test_the_door_ends_when_control_is_gone() -> None:
    door = run_subscription_door()
    door.end_of_input()
    assert door.wait() == 0


def _document(**overrides: Any) -> str:
    document: dict[str, Any] = {
        "version": 1,
        "kind": "subscription",
        "token": REAL_TOKEN,
        "deadlineSeconds": 600,
        "listenPort": 10180,
    }
    document.update(overrides)
    return json.dumps(document)


# #1176-T06
def test_the_start_document_is_exactly_one_or_the_door_refuses_with_a_word_only() -> None:
    bad = [
        _document(token=""),
        _document(token="two words"),
        _document(token=None),
        _document(extra=1),
        _document(listenPort=80),
        _document(deadlineSeconds=0),
        _document(version=2),
        _document(kind="other"),
    ]
    for text in bad:
        with pytest.raises(DoorRefused) as refused:
            parse_subscription_start(text)
        assert REAL_TOKEN not in str(refused.value) and "two words" not in str(refused.value)
    door = run_subscription_door(document=_document(token=""))
    assert door.refused and set(door.lines[0]) == {"t", "reason"}
    door.wait()
    door.end_of_input()


# #1176-T06
def test_a_model_start_document_is_still_read_as_before() -> None:
    from door_support import start_document

    started = parse_start(json.dumps(start_document()))
    assert started.capability


def test_the_placeholder_is_a_fixed_value_that_is_no_secret() -> None:
    assert SUBSCRIPTION_PLACEHOLDER.startswith("sk-ant-oat01-")
    assert REAL_TOKEN != SUBSCRIPTION_PLACEHOLDER
