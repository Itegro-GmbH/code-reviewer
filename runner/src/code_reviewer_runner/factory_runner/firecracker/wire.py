# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's side of the vsock messages (`contracts/environment-control.v1.json` and
`contracts/vm-init.v1.json`): the frame, the three messages the VM sends (`narrow`, `end`, the exit
report), the replies the host sends and the start it sends first.

The framing is the one of the Worker's own client (`implementer/environment_control.py`) and of
vm-init, read here with asyncio streams. A request is one frame of four bytes of length (1 to the
limit) and a JSON object; a length of 0 or above the limit, a body that is not one object, a version
other than 1, a type the receiver does not know, a field the contract does not have and any byte
after the frame are protocol errors. Everything read from the VM is untrusted: the parsers are
strict and their errors name the field, never a value."""

import asyncio
import json
import re
import struct
from dataclasses import dataclass, field
from typing import Any, Final, cast

from code_reviewer_runner.implementer.environment_control import (
    HEADER_BYTES,
    PROTOCOL_VERSION,
    REQUEST_END,
    REQUEST_NARROW,
    Refusal,
)
from code_reviewer_runner.implementer.environment_control import (
    MAX_FRAME_BYTES as CONTROL_MAX_FRAME_BYTES,
)
from code_reviewer_runner.implementer.network_rule import NetworkRule, RuleError, parse_rule
from code_reviewer_runner.vm_init.wire import (
    MAX_FRAME_BYTES as START_MAX_FRAME_BYTES,
)
from code_reviewer_runner.vm_init.wire import (
    REPORT_PORT,
    REQUEST_EXIT,
    REQUEST_START,
    START_PORT,
    ExitReason,
)

__all__ = [
    "CONTROL_PORT",
    "MAX_CONTROL_FRAME_BYTES",
    "REPORT_PORT",
    "START_PORT",
    "EndMessage",
    "ExitMessage",
    "NarrowMessage",
    "ProtocolError",
    "Refusal",
    "ack",
    "encode_frame",
    "parse_control_request",
    "parse_exit_report",
    "read_frame",
    "refused",
    "start_frame",
]

# The vsock port the host's environment control listens on (Firecracker: `<uds>_5100`).
CONTROL_PORT: Final = 5100
# How long a connection may take to deliver its one frame.
FRAME_SECONDS: Final = 10.0
# How long the host looks for a byte after the frame (a request is exactly one frame).
TRAILING_SECONDS: Final = 0.05

_MODEL_HOST = re.compile(r"([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?")


class ProtocolError(Exception):
    """A frame or a message that is not one of the contract: the connection is closed (a host may
    first answer a request of the environment control with `refused`, `invalid_request`)."""


@dataclass(frozen=True)
class NarrowMessage:
    rule: NetworkRule
    model_host: str
    token: str | None = field(default=None, repr=False)

    def canonical(self) -> str:
        """The request without its token, as text: the same request again is recognised by it."""
        return json.dumps(
            {"network": self.rule.to_json(), "modelHost": self.model_host}, sort_keys=True
        )


@dataclass(frozen=True)
class EndMessage:
    exit_code: int
    token: str | None = field(default=None, repr=False)


@dataclass(frozen=True)
class ExitMessage:
    exit_code: int
    reason: ExitReason
    token: str | None = field(default=None, repr=False)


# -- frames ---


def encode_frame(document: object) -> bytes:
    body = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if not 1 <= len(body) <= START_MAX_FRAME_BYTES:
        raise ProtocolError("the message is larger than a frame may be")
    return struct.pack(">I", len(body)) + body


async def read_frame(
    reader: asyncio.StreamReader, *, max_bytes: int, seconds: float = FRAME_SECONDS
) -> dict[str, Any]:
    """One frame as the JSON object in its body, with no byte after it. `ProtocolError` for a frame
    outside the contract, `TimeoutError` when it is not whole in `seconds`."""

    async def read() -> dict[str, Any]:
        try:
            (length,) = struct.unpack(">I", await reader.readexactly(HEADER_BYTES))
            if not 1 <= length <= max_bytes:
                raise ProtocolError("the frame's length is not one of the contract")
            body = await reader.readexactly(length)
        except asyncio.IncompleteReadError:
            raise ProtocolError("the connection ended inside a frame") from None
        try:
            document = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise ProtocolError("the frame's body is not JSON") from None
        if not isinstance(document, dict):
            raise ProtocolError("the frame's body is not an object")
        return cast("dict[str, Any]", document)

    document = await asyncio.wait_for(read(), seconds)
    try:
        extra = await asyncio.wait_for(reader.read(1), TRAILING_SECONDS)
    except TimeoutError:
        return document
    if extra:
        raise ProtocolError("a byte follows the frame")
    return document


# -- what the host sends ---


def ack(request: str) -> dict[str, Any]:
    return {"version": PROTOCOL_VERSION, "type": "ack", "for": request}


def refused(request: str, reason: Refusal) -> dict[str, Any]:
    return {"version": PROTOCOL_VERSION, "type": "refused", "for": request, "reason": reason.value}


def start_frame(document: dict[str, Any]) -> bytes:
    """The start of `contracts/vm-init.v1.json` as one frame (`type` and `version` are checked: the
    document is the one the host built, a mistake here is the host's bug)."""
    if document.get("type") != REQUEST_START or document.get("version") != PROTOCOL_VERSION:
        raise ProtocolError("the start is not a start of the contract")
    return encode_frame(document)


# -- what the VM sends ---


def _version_and_type(document: dict[str, Any]) -> str:
    version = document.get("version")
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise ProtocolError("the version is not 1")
    kind = document.get("type")
    if not isinstance(kind, str):
        raise ProtocolError("the type is not a text")
    return kind


def _token(document: dict[str, Any]) -> str | None:
    """The token as sent. A token that is not of the contract's shape is not refused here: the
    check against the VM's own token (`tokens.py`) decides, and it refuses it as `wrong`."""
    if "token" not in document:
        return None
    given = document["token"]
    return given if isinstance(given, str) else ""


def _exit_code(document: dict[str, Any]) -> int:
    code = document.get("exitCode")
    if type(code) is not int or not 0 <= code <= 255:
        raise ProtocolError("exitCode is not a status")
    return code


def request_type(document: dict[str, Any]) -> str | None:
    """The `type` of a request of the environment control, if it names one the host knows (for the
    `for` of a `refused`)."""
    kind = document.get("type")
    return kind if kind in (REQUEST_NARROW, REQUEST_END) else None


def parse_control_request(document: dict[str, Any]) -> NarrowMessage | EndMessage:
    """`NarrowRequest` or `EndRequest` of the environment control; `ProtocolError` for anything
    else."""
    kind = _version_and_type(document)
    if kind == REQUEST_END:
        if not document.keys() <= {"version", "type", "exitCode", "token"}:
            raise ProtocolError("the request has a field the contract does not have")
        return EndMessage(_exit_code(document), _token(document))
    if kind != REQUEST_NARROW:
        raise ProtocolError("the type is not a request of the environment control")
    if not document.keys() <= {"version", "type", "network", "modelHost", "token"}:
        raise ProtocolError("the request has a field the contract does not have")
    host = document.get("modelHost")
    if (
        not isinstance(host, str)
        or not 3 <= len(host) <= 253
        or _MODEL_HOST.fullmatch(host) is None
    ):
        raise ProtocolError("modelHost is not a host name")
    if "network" not in document:
        raise ProtocolError("network is missing")
    try:
        rule = parse_rule(document["network"])
    except RuleError:
        raise ProtocolError("network is not a rule of the contract") from None
    return NarrowMessage(rule, host, _token(document))


def parse_exit_report(document: dict[str, Any]) -> ExitMessage:
    """`ExitReport` of `contracts/vm-init.v1.json`; `ProtocolError` for anything else."""
    kind = _version_and_type(document)
    if kind != REQUEST_EXIT:
        raise ProtocolError("the type is not an exit report")
    if not document.keys() <= {"version", "type", "exitCode", "reason", "token"}:
        raise ProtocolError("the report has a field the contract does not have")
    try:
        reason = ExitReason(document.get("reason"))
    except ValueError:
        raise ProtocolError("reason is not one of the contract") from None
    return ExitMessage(_exit_code(document), reason, _token(document))


# What the host reads at most on its two ports (the contract's limit of the environment control).
MAX_CONTROL_FRAME_BYTES: Final = CONTROL_MAX_FRAME_BYTES
