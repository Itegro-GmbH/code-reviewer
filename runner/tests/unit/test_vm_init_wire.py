# SPDX-License-Identifier: LicenseRef-Proprietary

"""The wire of vm-init (#977): the frame and the start request it accepts. The same documents are
held against `contracts/vm-init.v1.json` in `tests/contract/test_vm_init_contract.py`."""

import json
import socket
import struct
from typing import Any

import pytest

from code_reviewer_runner.vm_init import wire
from vm_init_support import BAD_STARTS, CREDENTIAL, LOCAL_CREDENTIAL, start_document


def _pair() -> tuple[socket.socket, socket.socket]:
    return socket.socketpair()


# #977-T02
def test_a_frame_round_trips() -> None:
    guest, host = _pair()
    host.sendall(wire.encode_frame({"a": "ä"}))

    assert wire.read_frame(guest, deadline_seconds=1) == {"a": "ä"}


# #977-T02
@pytest.mark.parametrize("length", [0, wire.MAX_FRAME_BYTES + 1, 2**32 - 1])
def test_a_frame_of_a_length_outside_the_contract_is_refused_before_its_body_is_read(
    length: int,
) -> None:
    guest, host = _pair()
    host.sendall(struct.pack(">I", length))

    with pytest.raises(wire.ProtocolError):
        wire.read_frame(guest, deadline_seconds=1)


# #977-T02
@pytest.mark.parametrize("body", [b"not json", b"[1]", b'"text"', b"\xff\xfe", b"{"])
def test_a_body_that_is_not_one_json_object_is_refused(body: bytes) -> None:
    guest, host = _pair()
    host.sendall(struct.pack(">I", len(body)) + body)

    with pytest.raises(wire.ProtocolError):
        wire.read_frame(guest, deadline_seconds=1)


# #977-T02
def test_a_connection_that_ends_inside_a_frame_is_a_protocol_error() -> None:
    guest, host = _pair()
    host.sendall(struct.pack(">I", 10) + b"abc")
    host.close()

    with pytest.raises(wire.ProtocolError):
        wire.read_frame(guest, deadline_seconds=1)


# #977-T02
def test_a_frame_that_does_not_arrive_in_time_is_a_timeout() -> None:
    guest, _host = _pair()

    with pytest.raises(TimeoutError):
        wire.read_frame(guest, deadline_seconds=0.05)


# #977-T02
def test_a_message_larger_than_a_frame_cannot_be_written() -> None:
    with pytest.raises(wire.ProtocolError):
        wire.encode_frame({"x": "a" * wire.MAX_FRAME_BYTES})


# #977-T01
def test_a_valid_start_is_read_into_its_parts() -> None:
    request = wire.parse_start(start_document())

    assert request.job.app_url == "https://app.example"
    assert request.job.job_id == "job-1"
    assert request.job.credential == CREDENTIAL
    assert request.local_credential is not None
    assert request.local_credential.name == "CLAUDE_CODE_OAUTH_TOKEN"
    assert request.image.reference == "code-reviewer-worker:golden"
    assert request.args[0] == "run" and request.args[-1] == "worker-once"
    assert (request.volume_name, request.reserve_gib) == ("code-reviewer-work-job-1", 8)


# #977-T04
def test_the_local_credential_is_optional() -> None:
    request = wire.parse_start(start_document(localCredential=None))

    assert request.local_credential is None
    assert json.loads(request.stdin_document()) == {
        "appUrl": "https://app.example",
        "jobId": "job-1",
        "credential": CREDENTIAL,
    }


# #977-T04
def test_the_stdin_document_is_one_json_line_with_the_local_credential_under_its_own_key() -> None:
    request = wire.parse_start(start_document())

    stdin = request.stdin_document()

    assert stdin.endswith(b"\n") and stdin.count(b"\n") == 1
    assert json.loads(stdin) == {
        "appUrl": "https://app.example",
        "jobId": "job-1",
        "credential": CREDENTIAL,
        "localCredential": {"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": LOCAL_CREDENTIAL},
    }


# #977-T04
def test_no_credential_is_part_of_a_repr_or_an_error() -> None:
    request = wire.parse_start(start_document())
    shown = repr(request) + repr(request.job) + repr(request.local_credential)

    assert CREDENTIAL not in shown and LOCAL_CREDENTIAL not in shown


# #977-T02
@pytest.mark.parametrize("document", list(BAD_STARTS.values()), ids=list(BAD_STARTS))
def test_a_start_that_is_not_the_contracts_is_refused(document: Any) -> None:
    with pytest.raises(wire.InvalidStart):
        wire.parse_start(document)


# #977-T02
@pytest.mark.parametrize("document", [None, [], "start", 1])
def test_a_start_that_is_not_an_object_is_refused(document: Any) -> None:
    with pytest.raises(wire.InvalidStart):
        wire.parse_start(document)


# #977-T04
@pytest.mark.parametrize("secret", [CREDENTIAL, LOCAL_CREDENTIAL])
def test_a_start_whose_arguments_hold_a_credential_is_refused_without_naming_it(
    secret: str,
) -> None:
    document = start_document(control={"args": ["run", f"--env=X={secret}"]})

    with pytest.raises(wire.InvalidStart) as refusal:
        wire.parse_start(document)

    assert CREDENTIAL not in str(refusal.value) and LOCAL_CREDENTIAL not in str(refusal.value)


def test_the_replies_and_the_report_are_the_contracts() -> None:
    assert wire.ack_reply("start") == {"version": 1, "type": "ack", "for": "start"}
    assert wire.refused_start_reply() == {
        "version": 1,
        "type": "refused",
        "for": "start",
        "reason": "invalid_start",
    }
    assert wire.exit_report(1, wire.ExitReason.WORKER_EXITED) == {
        "version": 1,
        "type": "exit",
        "exitCode": 1,
        "reason": "worker_exited",
    }


@pytest.mark.parametrize(
    "document",
    [
        {"version": 1, "type": "refused", "for": "exit", "reason": "x"},
        {"version": 1, "type": "ack", "for": "start"},
        {"version": 2, "type": "ack", "for": "exit"},
        {"version": 1, "type": "ack", "for": "exit", "extra": 1},
        [],
    ],
)
def test_a_reply_that_is_not_the_ack_of_the_exit_report_is_refused(document: Any) -> None:
    with pytest.raises(wire.ProtocolError):
        wire.read_ack(document, "exit")


def test_the_ack_of_the_exit_report_is_read() -> None:
    wire.read_ack({"version": 1, "type": "ack", "for": "exit"}, "exit")
