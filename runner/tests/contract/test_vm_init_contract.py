# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down vm-init (#977) against `contracts/vm-init.v1.json`: its constants are the file's, what
it writes is valid under the file, and it refuses what the file refuses.

The Dispatcher's side (`dispatcher/src/launchers/local-control.test.ts`) holds the start request it
builds to the same file, so the two ends meet in the schema."""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner.vm_init import wire
from vm_init_support import (
    BAD_STARTS,
    CONTROL_TOKEN,
    CREDENTIAL,
    IMAGE_ID,
    SCHEMA_ALLOWS,
    start_document,
)

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
Document = dict[str, Any]

pytestmark = pytest.mark.contract


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


_SCHEMA: Document = _load(CONTRACTS / "vm-init.v1.json")
_DEFS: Document = _SCHEMA["$defs"]


def _accepts(definition: str, document: Any) -> bool:
    validator = Draft202012Validator({"$ref": "#/$defs/" + definition, "$defs": _DEFS})
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


# #977-T01
@pytest.mark.parametrize("definition", ["StartRequest", "ExitReport", "AckReply", "RefusedReply"])
def test_every_example_is_valid(definition: str) -> None:
    example = _load(CONTRACTS / "examples" / "vm-init" / f"{definition}.json")

    assert _accepts(definition, example)


# #977-T01
def test_the_example_start_is_read_by_vm_init() -> None:
    wire.parse_start(_load(CONTRACTS / "examples" / "vm-init" / "StartRequest.json"))


# #977-T01
def test_the_constants_are_the_files() -> None:
    assert _DEFS["HostCid"]["const"] == wire.HOST_CID
    assert _DEFS["StartPort"]["const"] == wire.START_PORT
    assert _DEFS["ReportPort"]["const"] == wire.REPORT_PORT
    assert _DEFS["MaxFrameBytes"]["const"] == wire.MAX_FRAME_BYTES
    assert _DEFS["StartReadSeconds"]["const"] == wire.START_READ_SECONDS
    assert _DEFS["StartWaitSeconds"]["const"] == wire.START_WAIT_SECONDS
    assert _DEFS["ReportSeconds"]["const"] == wire.REPORT_SECONDS
    assert _DEFS["ReportRetrySeconds"]["const"] == wire.REPORT_RETRY_SECONDS
    assert _SCHEMA["version"] == wire.PROTOCOL_VERSION


# #977-T01
def test_the_report_port_is_not_the_environment_controls() -> None:
    environment_control = _load(CONTRACTS / "environment-control.v1.json")["$defs"]

    assert environment_control["ControlPort"]["const"] != wire.REPORT_PORT
    assert environment_control["ControlPort"]["const"] != wire.START_PORT
    assert environment_control["ControlHostCid"]["const"] == wire.HOST_CID
    # The framing is the one the Worker uses, so one reader serves both.
    assert wire.HEADER_BYTES == 4


# #977-T03
def test_the_exit_reasons_are_the_files() -> None:
    assert {reason.value for reason in wire.ExitReason} == set(_DEFS["ExitReason"]["enum"])


# #977-T03
@pytest.mark.parametrize("reason", list(wire.ExitReason))
@pytest.mark.parametrize("exit_code", [0, 1, 2, 125, 255])
def test_every_report_is_valid(reason: wire.ExitReason, exit_code: int) -> None:
    assert _accepts("ExitReport", wire.exit_report(exit_code, reason))


# #977-T03
@pytest.mark.parametrize("request_type", ["start", "exit"])
def test_every_ack_is_valid(request_type: str) -> None:
    assert _accepts("AckReply", wire.ack_reply(request_type))


def test_the_refusal_is_valid() -> None:
    assert _accepts("RefusedReply", wire.refused_start_reply())


# #977-T02
def test_vm_init_reads_a_start_that_is_valid_under_the_file() -> None:
    document = start_document()

    assert _accepts("StartRequest", document)
    wire.parse_start(document)


# #977-T02
@pytest.mark.parametrize("name", list(BAD_STARTS))
def test_vm_init_refuses_what_the_file_refuses(name: str) -> None:
    document = BAD_STARTS[name]

    if name not in SCHEMA_ALLOWS:
        assert not _accepts("StartRequest", document)
    with pytest.raises(wire.InvalidStart):
        wire.parse_start(document)


# #977-T04
def test_a_start_with_the_credential_in_its_arguments_is_valid_only_under_the_file() -> None:
    # The schema cannot compare two fields; the parser does, and the Dispatcher refuses to build
    # one.
    document = start_document(control={"args": ["run", f"--env=X={CREDENTIAL}", IMAGE_ID]})

    assert _accepts("StartRequest", document)
    with pytest.raises(wire.InvalidStart):
        wire.parse_start(document)


# #977-T07
def test_the_token_of_the_start_is_the_token_of_both_contracts() -> None:
    environment_control = _load(CONTRACTS / "environment-control.v1.json")["$defs"]

    assert _DEFS["ControlToken"]["pattern"] == environment_control["ControlToken"]["pattern"]
    assert _accepts("ControlToken", CONTROL_TOKEN)
    assert not _accepts("ControlToken", "short")


# #977-T07
@pytest.mark.parametrize("reason", list(wire.ExitReason))
def test_every_report_with_the_token_is_valid(reason: wire.ExitReason) -> None:
    report = wire.exit_report(2, reason, CONTROL_TOKEN)

    assert _accepts("ExitReport", report)
    assert report["token"] == CONTROL_TOKEN


# #977-T07
def test_a_report_with_a_token_that_is_not_the_contracts_is_refused() -> None:
    report = {**wire.exit_report(0, wire.ExitReason.WORKER_EXITED), "token": "short"}

    assert not _accepts("ExitReport", report)


# #977-T07
def test_the_start_requires_the_token_and_the_report_may_carry_it() -> None:
    assert "controlToken" in _DEFS["StartRequest"]["required"]
    assert "token" not in _DEFS["ExitReport"]["required"]
