# SPDX-License-Identifier: LicenseRef-Proprietary

"""Pins down the vsock transport of the environment control (#975) from the runner's side.

The Worker is the writer of the requests and the reader of the replies. What it writes must be valid
under `contracts/environment-control.v1.json`, what it accepts must be what the file accepts, and
the port, the size limit and the times it uses must be the file's.
"""

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from code_reviewer_runner.implementer import environment_control as control
from code_reviewer_runner.implementer.network_rule import (
    MODE_LIST,
    MODE_OPEN,
    OFF,
    NetworkRule,
    parse_rule,
)
from code_reviewer_runner.result import ErrorCode

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
Document = dict[str, Any]

pytestmark = pytest.mark.contract


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


_SCHEMA: Document = _load(CONTRACTS / "environment-control.v1.json")
_RUNNER_API: Document = _load(CONTRACTS / "runner-api.v1.json")
_DEFS: Document = _SCHEMA["$defs"]


def _accepts(definition: str, document: Any) -> bool:
    validator = Draft202012Validator({"$ref": "#/$defs/" + definition, "$defs": _DEFS})
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


LIST = NetworkRule(MODE_LIST, ("registry.npmjs.org", "*.pythonhosted.org"))
OPEN = NetworkRule(MODE_OPEN)


# #975-T02
@pytest.mark.parametrize("definition", ["NarrowRequest", "EndRequest", "AckReply", "RefusedReply"])
def test_every_example_is_valid(definition: str) -> None:
    example = _load(CONTRACTS / "examples" / "environment-control" / f"{definition}.json")

    assert _accepts(definition, example)


# #975-T02
def test_the_constants_of_the_worker_are_the_constants_of_the_file() -> None:
    assert _DEFS["ControlVariable"]["const"] == control.ENVIRONMENT_CONTROL_VARIABLE
    assert _DEFS["ControlTransportValue"]["const"] == control.TRANSPORT_VSOCK
    assert _DEFS["ControlHostCid"]["const"] == control.VSOCK_HOST_CID
    assert _DEFS["ControlPort"]["const"] == control.VSOCK_PORT
    assert _DEFS["ControlMaxFrameBytes"]["const"] == control.MAX_FRAME_BYTES
    assert _DEFS["ControlNarrowSeconds"]["const"] == control.NARROW_SECONDS
    assert _DEFS["ControlEndSeconds"]["const"] == control.END_SECONDS
    assert _DEFS["NarrowRequest"]["properties"]["version"]["const"] == control.PROTOCOL_VERSION


# #975-T02
def test_the_refusal_reasons_are_the_reasons_of_the_file() -> None:
    assert sorted(reason.value for reason in control.Refusal) == sorted(
        _DEFS["ControlRefusalReason"]["enum"]
    )


# #975-T02
@pytest.mark.parametrize(
    "rule", [OFF, LIST, OPEN, NetworkRule(MODE_LIST, ("registry.npmjs.org",), (443,))]
)
def test_a_narrow_request_the_worker_writes_is_valid(rule: NetworkRule) -> None:
    request = control.narrow_request(rule, "api.example.com")

    assert _accepts("NarrowRequest", request)
    assert _accepts("ControlRequest", request)
    assert len(json.dumps(request).encode()) <= control.MAX_FRAME_BYTES


# #975-T02
def test_the_largest_rule_still_fits_the_frame() -> None:
    names = [
        f"{number:03d}" + "a" * 58 + "." + "b" * 61 + "." + "c" * 61 + "." + "d" * 60 + ".com"
        for number in range(100)
    ]
    assert all(len(name) <= 253 for name in names) and max(map(len, names)) >= 250
    rule = parse_rule({"mode": "list", "hosts": names})
    assert len(rule.hosts) == 100

    request = control.narrow_request(rule, names[0])

    assert _accepts("NarrowRequest", request)
    assert len(control.encode_frame(request)) <= control.MAX_FRAME_BYTES + control.HEADER_BYTES


# #975-T02
def test_the_hosts_of_the_rule_have_the_pattern_of_the_runner_api() -> None:
    ours = _DEFS["ControlNetworkRule"]["properties"]["hosts"]
    theirs = _RUNNER_API["$defs"]["ImplementerNetworkRule"]["properties"]["hosts"]

    assert ours["items"] == theirs["items"]
    assert ours["maxItems"] == theirs["maxItems"]


# #975-T02
@pytest.mark.parametrize("code", [0, 1, 2, 255])
def test_an_end_request_the_worker_writes_is_valid(code: int) -> None:
    assert _accepts("EndRequest", control.end_request(code))


# #975-T02
@pytest.mark.parametrize(
    "reply",
    [
        {"version": 1, "type": "ack", "for": "narrow"},
        {"version": 1, "type": "ack", "for": "end"},
        {"version": 1, "type": "refused", "for": "narrow", "reason": "rule_not_allowed"},
        {"version": 1, "type": "refused", "for": "end", "reason": "unavailable"},
    ],
)
def test_the_worker_reads_the_replies_the_file_accepts(reply: Document) -> None:
    assert _accepts("ControlReply", reply)
    assert control.read_reply(reply, "narrow" if reply["for"] == "narrow" else "end") is not None


# #975-T02
@pytest.mark.parametrize(
    "reply",
    [
        {"version": 2, "type": "ack", "for": "narrow"},
        {"version": 1, "type": "ack"},
        {"version": 1, "type": "ack", "for": "narrow", "extra": 1},
        {"version": 1, "type": "refused", "for": "narrow"},
        {"version": 1, "type": "refused", "for": "narrow", "reason": "because"},
        {"version": 1, "type": "wait", "for": "narrow"},
        {"version": True, "type": "ack", "for": "narrow"},
        ["ack"],
    ],
)
def test_the_worker_refuses_the_replies_the_file_refuses(reply: Any) -> None:
    assert not _accepts("ControlReply", reply)
    with pytest.raises(control.ProtocolError):
        control.read_reply(reply, "narrow")


# #975-T02
def test_the_error_code_is_in_the_known_runner_error_codes() -> None:
    codes = _RUNNER_API["$defs"]["KnownRunnerErrorCode"]["enum"]

    assert ErrorCode.ENVIRONMENT_CONTROL_FAILED.value == "environment_control_failed"
    assert "environment_control_failed" in codes


# #977-T07
def test_a_request_the_worker_writes_with_the_hosts_token_is_valid() -> None:
    token = "control-token-of-the-host-0123456789-abcdefghij"

    assert _accepts("NarrowRequest", control.narrow_request(LIST, "api.example.com", token))
    assert _accepts("EndRequest", control.end_request(0, token))
    assert "token" not in control.narrow_request(LIST, "api.example.com")
    assert "token" not in control.end_request(0)


# #977-T07
@pytest.mark.parametrize("token", ["short", "x" * 129, "has space" + "y" * 40, 7, None])
def test_a_token_that_is_not_the_contracts_is_refused(token: Any) -> None:
    request = {**control.end_request(0), "token": token}

    assert not _accepts("EndRequest", request)
