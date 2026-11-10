# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's side of the vsock messages (#978): the frame a VM sends, the three messages and what
the host answers. The documents are held to the contracts' own schemas and examples."""

import asyncio
import json
import struct
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner.factory_runner.firecracker.wire import (
    CONTROL_PORT,
    MAX_CONTROL_FRAME_BYTES,
    EndMessage,
    ExitMessage,
    NarrowMessage,
    ProtocolError,
    Refusal,
    ack,
    encode_frame,
    parse_control_request,
    parse_exit_report,
    read_frame,
    refused,
    request_type,
    start_frame,
)
from code_reviewer_runner.implementer.network_rule import MODE_LIST
from code_reviewer_runner.vm_init.wire import ExitReason

pytestmark = pytest.mark.unit

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
TOKEN = "T" * 43


def load(name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS / name).read_text())


CONTROL = load("environment-control.v1.json")
VM_INIT = load("vm-init.v1.json")


def accepted_by(contract: dict[str, Any], definition: str, document: Any) -> bool:
    validator = Draft202012Validator({"$ref": "#/$defs/" + definition, "$defs": contract["$defs"]})
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


def example(directory: str, name: str) -> dict[str, Any]:
    return json.loads((CONTRACTS / "examples" / directory / f"{name}.json").read_text())


def reader_of(data: bytes, *, eof: bool = True) -> asyncio.StreamReader:
    """Inside a running loop only."""
    reader = asyncio.StreamReader()
    reader.feed_data(data)
    if eof:
        reader.feed_eof()
    return reader


def read(data: bytes, *, max_bytes: int = MAX_CONTROL_FRAME_BYTES, eof: bool = True) -> Any:
    async def scenario() -> Any:
        return await read_frame(reader_of(data, eof=eof), max_bytes=max_bytes, seconds=1)

    return asyncio.run(scenario())


def narrow_document(**changes: Any) -> dict[str, Any]:
    document = {
        "version": 1,
        "type": "narrow",
        "network": {"mode": "list", "hosts": ["registry.npmjs.org", "*.pythonhosted.org"]},
        "modelHost": "api.example.com",
        "token": TOKEN,
    }
    for key, value in changes.items():
        if value is None:
            document.pop(key, None)
        else:
            document[key] = value
    return document


# -- the contract's constants ---


# #978-T04
def test_the_port_of_the_host_is_the_contracts() -> None:
    assert CONTROL["$defs"]["ControlPort"]["const"] == CONTROL_PORT
    assert CONTROL["$defs"]["ControlMaxFrameBytes"]["const"] == MAX_CONTROL_FRAME_BYTES


# -- frames ---


# #978-T04
def test_a_frame_is_read_whole_and_gives_its_object() -> None:
    assert read(encode_frame({"a": 1})) == {"a": 1}


# #978-T04
@pytest.mark.parametrize(
    "data",
    [
        struct.pack(">I", 0),
        struct.pack(">I", MAX_CONTROL_FRAME_BYTES + 1) + b"x",
        struct.pack(">I", 10) + b"{}",
        struct.pack(">I", 3) + b"[1]",
        struct.pack(">I", 4) + b"nope",
        struct.pack(">I", 2) + b"\xff\xfe",
        b"\x00",
        b"",
        encode_frame({"a": 1}) + b"x",
    ],
    ids=[
        "empty",
        "too long",
        "cut short",
        "an array",
        "not JSON",
        "not UTF-8",
        "cut header",
        "nothing",
        "a byte after the frame",
    ],
)
def test_a_frame_outside_the_contract_is_a_protocol_error(data: bytes) -> None:
    with pytest.raises(ProtocolError):
        read(data)


# #978-T04
def test_a_frame_that_never_comes_whole_times_out() -> None:
    with pytest.raises(TimeoutError):
        read(struct.pack(">I", 10) + b"{}", eof=False)


# #978-T04
def test_a_byte_that_arrives_just_after_the_frame_is_a_protocol_error() -> None:
    async def scenario() -> None:
        reader = reader_of(encode_frame({"a": 1}), eof=False)
        loop = asyncio.get_running_loop()
        loop.call_later(0.01, reader.feed_data, b"x")
        await read_frame(reader, max_bytes=100, seconds=1)

    with pytest.raises(ProtocolError):
        asyncio.run(scenario())


# -- what the host sends ---


# #978-T04
def test_the_replies_are_the_contracts() -> None:
    for request in ("narrow", "end"):
        assert accepted_by(CONTROL, "AckReply", ack(request))
        for reason in Refusal:
            assert accepted_by(CONTROL, "RefusedReply", refused(request, reason))
    assert accepted_by(VM_INIT, "AckReply", ack("exit"))
    assert ack("narrow") == example("environment-control", "AckReply") | {"for": "narrow"}


# #978-T04
def test_the_start_is_one_frame_and_must_be_a_start() -> None:
    document = example("vm-init", "StartRequest")

    assert read(start_frame(document), max_bytes=262144) == document
    with pytest.raises(ProtocolError):
        start_frame({**document, "type": "exit"})
    with pytest.raises(ProtocolError):
        start_frame({**document, "version": 2})


# -- the messages ---


# #978-T04
def test_the_examples_of_the_contract_parse() -> None:
    narrow = parse_control_request(example("environment-control", "NarrowRequest"))
    end = parse_control_request(example("environment-control", "EndRequest"))
    report = parse_exit_report(example("vm-init", "ExitReport"))

    assert isinstance(narrow, NarrowMessage)
    assert isinstance(end, EndMessage)
    assert isinstance(report, ExitMessage)


# #978-T04
def test_a_narrow_request_gives_its_rule_host_and_token() -> None:
    message = parse_control_request(narrow_document())

    assert isinstance(message, NarrowMessage)
    assert message.rule.mode == MODE_LIST
    assert message.rule.hosts == ("registry.npmjs.org", "*.pythonhosted.org")
    assert message.model_host == "api.example.com"
    assert message.token == TOKEN
    assert TOKEN not in repr(message)  # a token is never printed


# #978-T04
def test_a_request_without_a_token_parses_and_the_check_of_the_token_refuses_it() -> None:
    message = parse_control_request(narrow_document(token=None))

    assert isinstance(message, NarrowMessage)
    assert message.token is None


STRICTER_THAN_THE_SCHEMA: list[Any] = [
    {"mode": "open", "hosts": ["a.example.com"]},
    {"mode": "list", "hosts": []},
]


# #978-T04
@pytest.mark.parametrize(
    "document",
    [
        narrow_document(version=2),
        narrow_document(version=True),
        narrow_document(type="stop"),
        narrow_document(type=None),
        narrow_document(extra=1),
        narrow_document(modelHost="127.0.0.1"),
        narrow_document(modelHost="*.example.com"),
        narrow_document(modelHost="Api.Example.com"),
        narrow_document(modelHost="localhost"),
        narrow_document(modelHost=None),
        narrow_document(network=None),
        narrow_document(network={"mode": "open", "hosts": ["a.example.com"]}),
        narrow_document(network={"mode": "list", "hosts": []}),
        narrow_document(network={"mode": "everything", "hosts": []}),
        narrow_document(network={"mode": "off", "hosts": [], "extra": 1}),
        narrow_document(network="off"),
    ],
)
def test_a_narrow_request_that_is_not_the_contracts_is_a_protocol_error(
    document: dict[str, Any],
) -> None:
    # The host is stricter than the schema where the schema's text says more than it can express
    # (`hosts` is empty unless the mode is `list`, and not empty then).
    if document.get("network") not in STRICTER_THAN_THE_SCHEMA:
        assert not accepted_by(CONTROL, "NarrowRequest", document)
    with pytest.raises(ProtocolError):
        parse_control_request(document)


# #978-T04
@pytest.mark.parametrize("exit_code", [-1, 256, "0", None, True, 1.0])
def test_an_end_request_needs_a_status(exit_code: object) -> None:
    document = {"version": 1, "type": "end", "exitCode": exit_code, "token": TOKEN}

    with pytest.raises(ProtocolError):
        parse_control_request(document)


# #978-T04
def test_an_end_request_with_a_status_parses() -> None:
    message = parse_control_request({"version": 1, "type": "end", "exitCode": 137, "token": TOKEN})

    assert message == EndMessage(137, TOKEN)


# #978-T04
@pytest.mark.parametrize(
    "document",
    [
        {"version": 1, "type": "exit", "exitCode": 0, "reason": "something_else"},
        {"version": 1, "type": "exit", "exitCode": 0},
        {"version": 1, "type": "exit", "exitCode": 256, "reason": "worker_exited"},
        {"version": 1, "type": "exit", "exitCode": 0, "reason": "worker_exited", "x": 1},
        {"version": 1, "type": "end", "exitCode": 0, "reason": "worker_exited"},
        {"version": 3, "type": "exit", "exitCode": 0, "reason": "worker_exited"},
    ],
)
def test_an_exit_report_that_is_not_the_contracts_is_a_protocol_error(
    document: dict[str, Any],
) -> None:
    assert not accepted_by(VM_INIT, "ExitReport", document)
    with pytest.raises(ProtocolError):
        parse_exit_report(document)


# #978-T04
def test_an_exit_report_gives_its_reason_status_and_token() -> None:
    message = parse_exit_report(
        {"version": 1, "type": "exit", "exitCode": 2, "reason": "image_mismatch", "token": TOKEN}
    )

    assert message == ExitMessage(2, ExitReason.IMAGE_MISMATCH, TOKEN)


# #978-T04
def test_the_type_of_a_request_is_known_only_for_the_environment_control() -> None:
    assert request_type({"type": "narrow"}) == "narrow"
    assert request_type({"type": "end"}) == "end"
    assert request_type({"type": "exit"}) is None
    assert request_type({}) is None


# #978-T04
def test_the_same_narrow_request_is_recognised_whatever_its_token() -> None:
    first = parse_control_request(narrow_document())
    again = parse_control_request(narrow_document(token="U" * 43))
    other = parse_control_request(narrow_document(modelHost="api.other.com"))

    assert isinstance(first, NarrowMessage)
    assert isinstance(again, NarrowMessage)
    assert isinstance(other, NarrowMessage)
    assert first.canonical() == again.canonical()
    assert first.canonical() != other.canonical()
