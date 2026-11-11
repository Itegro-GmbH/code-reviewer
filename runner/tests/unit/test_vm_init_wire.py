# SPDX-License-Identifier: LicenseRef-Proprietary

"""The wire of vm-init (#977): the frame and the start request it accepts. The same documents are
held against `contracts/vm-init.v1.json` in `tests/contract/test_vm_init_contract.py`."""

import json
import socket
import struct
from typing import Any

import pytest

from code_reviewer_runner.vm_init import wire
from vm_init_support import (
    BAD_STARTS,
    CONTROL_TOKEN,
    CREDENTIAL,
    IMAGE_ID,
    IMAGE_REFERENCE,
    LOCAL_CREDENTIAL,
    OUTER_PROXY,
    VOLUME_NAME,
    start_document,
)


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
        "controlToken": CONTROL_TOKEN,
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
        "controlToken": CONTROL_TOKEN,
        "localCredential": {"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": LOCAL_CREDENTIAL},
    }


# #994-T03
def test_a_start_without_a_proxy_is_read_as_before_and_its_stdin_has_no_proxy() -> None:
    request = wire.parse_start(start_document())

    assert request.outer_proxy is None
    assert "outerProxy" not in json.loads(request.stdin_document())


# #994-T01
def test_the_outer_proxy_of_the_start_is_read_and_goes_to_controls_stdin_under_its_own_key() -> (
    None
):
    request = wire.parse_start(start_document(outerProxy=OUTER_PROXY))

    assert request.outer_proxy == wire.OuterProxy("172.31.0.5", 3128)
    assert json.loads(request.stdin_document())["outerProxy"] == OUTER_PROXY
    # Control's arguments are what the host rendered: the proxy is not added to them.
    assert request.args == wire.parse_start(start_document()).args


# #977-T04
def test_no_credential_is_part_of_a_repr_or_an_error() -> None:
    request = wire.parse_start(start_document())
    shown = repr(request) + repr(request.job) + repr(request.local_credential)

    assert CREDENTIAL not in shown and LOCAL_CREDENTIAL not in shown
    assert CONTROL_TOKEN not in shown


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
@pytest.mark.parametrize("secret", [CREDENTIAL, LOCAL_CREDENTIAL, CONTROL_TOKEN])
def test_a_start_whose_arguments_hold_a_credential_is_refused_without_naming_it(
    secret: str,
) -> None:
    document = start_document(control={"args": ["run", f"--env=X={secret}", IMAGE_ID]})

    with pytest.raises(wire.InvalidStart) as refusal:
        wire.parse_start(document)

    shown = str(refusal.value)
    assert CREDENTIAL not in shown and LOCAL_CREDENTIAL not in shown and CONTROL_TOKEN not in shown


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


# -- the image that runs is the image that was checked (#977 fix round) ---


def _args_with_image(image: str) -> dict[str, Any]:
    return start_document(
        control={"args": ["run", "--interactive", "--rm", "--name", "n", image, "worker-once"]}
    )


# #977-T05
def test_the_image_operand_that_is_the_checked_id_is_run_as_it_is() -> None:
    request = wire.parse_start(_args_with_image(IMAGE_ID))

    assert request.args == ("run", "--interactive", "--rm", "--name", "n", IMAGE_ID, "worker-once")


# #977-T05
def test_the_image_operand_that_is_the_checked_reference_is_run_by_the_checked_id() -> None:
    request = wire.parse_start(_args_with_image(IMAGE_REFERENCE))

    assert request.args == ("run", "--interactive", "--rm", "--name", "n", IMAGE_ID, "worker-once")


# #977-T05
@pytest.mark.parametrize(
    "image",
    ["other:tag", "sha256:" + "cd" * 32, IMAGE_REFERENCE + "x", "registry.invalid/w@" + IMAGE_ID],
)
def test_an_image_operand_that_is_not_the_checked_image_is_refused(image: str) -> None:
    with pytest.raises(wire.InvalidStart):
        wire.parse_start(_args_with_image(image))


# #977-T05
def test_an_image_that_hides_behind_an_option_value_is_not_the_operand() -> None:
    # `--name <checked id>` is a value; the operand after it is another image.
    document = start_document(
        control={"args": ["run", "--name", IMAGE_ID, "other:tag", "worker-once"]}
    )

    with pytest.raises(wire.InvalidStart):
        wire.parse_start(document)


# #977-T05
def test_the_option_forms_with_an_equals_sign_and_the_flags_without_a_value_are_read() -> None:
    document = start_document(
        control={"args": ["run", "-i", "--rm", "--name=n", "--read-only", IMAGE_ID, "worker-once"]}
    )

    assert wire.parse_start(document).args[-2] == IMAGE_ID


# -- what the arguments may not take away (#977 fix round) ---

_WORK = f"type=volume,source={VOLUME_NAME},target=/work"
_SOCKET = "type=bind,source=/var/run/docker.sock,target=/run/docker.sock,readonly"

REFUSED_OPTIONS: dict[str, list[str]] = {
    "--privileged": ["--privileged"],
    "--privileged=true": ["--privileged=true"],
    "seccomp=unconfined": ["--security-opt", "seccomp=unconfined"],
    "seccomp:unconfined": ["--security-opt", "seccomp:unconfined"],
    "--security-opt=seccomp=unconfined": ["--security-opt=seccomp=unconfined"],
    "apparmor=unconfined": ["--security-opt", "apparmor=unconfined"],
    "--pid host": ["--pid", "host"],
    "--pid=host": ["--pid=host"],
    "--net host": ["--net", "host"],
    "--network host": ["--network", "host"],
    "--network=host": ["--network=host"],
    "--ipc host": ["--ipc", "host"],
    "--userns host": ["--userns", "host"],
    "--device": ["--device", "/dev/kvm"],
    "--device=": ["--device=/dev/sda"],
    "--cap-add ALL": ["--cap-add", "ALL"],
    "--cap-add all": ["--cap-add", "all"],
    "--cap-add=ALL": ["--cap-add=ALL"],
    "a bind of the host": ["--mount", "type=bind,source=/,target=/host"],
    "a bind of the socket that is writable": [
        "--mount",
        "type=bind,source=/var/run/docker.sock,target=/run/docker.sock",
    ],
    "another volume": ["--mount", "type=volume,source=other,target=/work"],
    "the work volume elsewhere": ["--mount", f"type=volume,source={VOLUME_NAME},target=/etc"],
    "--mount=": ["--mount=type=bind,source=/etc,target=/etc"],
    "--volume": ["--volume", "/:/host"],
    "-v": ["-v", "/:/host"],
}


def _with_options(options: list[str]) -> dict[str, Any]:
    return start_document(control={"args": ["run", *options, IMAGE_ID, "worker-once"]})


# #977-T06
@pytest.mark.parametrize("options", list(REFUSED_OPTIONS.values()), ids=list(REFUSED_OPTIONS))
def test_an_option_that_takes_the_walls_of_the_container_away_is_refused(
    options: list[str],
) -> None:
    with pytest.raises(wire.InvalidStart):
        wire.parse_start(_with_options(options))


# #977-T06
def test_the_work_volume_and_the_docker_socket_are_the_mounts_that_pass() -> None:
    request = wire.parse_start(_with_options(["--mount", _WORK, "--mount", _SOCKET]))

    assert "--mount" in request.args


# #977-T06
def test_the_hardened_options_of_the_hosted_container_pass() -> None:
    options = [
        "--cap-drop",
        "ALL",
        "--cap-add",
        "NET_ADMIN",
        "--security-opt",
        "no-new-privileges:true",
        "--security-opt",
        "seccomp=/etc/code-reviewer/control-seccomp.json",
        "--network",
        "bridge",
        "--tmpfs",
        "/tmp:rw,noexec",
    ]

    wire.parse_start(_with_options(options))


# #977-T06
def test_the_deny_list_looks_at_options_and_not_at_the_command_after_the_image() -> None:
    document = start_document(control={"args": ["run", IMAGE_ID, "worker-once", "--privileged"]})

    wire.parse_start(document)


# #977-T06
def test_the_refusal_of_an_option_names_the_field_and_not_the_value() -> None:
    with pytest.raises(wire.InvalidStart) as refusal:
        wire.parse_start(_with_options(["--mount", "type=bind,source=/secret-path,target=/x"]))

    assert "/secret-path" not in str(refusal.value)
