# SPDX-License-Identifier: LicenseRef-Proprietary

"""The environment control of the Worker (#975, epic #969, ADR 0005): the one interface through
which Control asks whoever started the sandbox to change the sandbox's outer network wall and tells
it that the Worker ended.

    narrow(rule, model_host)   the wall switches from the setup's wide rule to the job's rule
    report_end(exit_code)      the Worker ends; the sandbox may power off (best effort)

Two transports implement it and the environment the Worker is started with chooses:

* **https** (`RUNNER_IMPLEMENTER_NETWORK_SWITCH`): the hosted Dispatcher's `POST /network`
  (`network_switch.py`), unchanged on the wire. There is nothing to report at the end: the hosted
  Dispatcher watches the container.
* **vsock** (`RUNNER_ENVIRONMENT_CONTROL=vsock`): a Firecracker VM on a customer's own machine. The
  Worker opens a stream connection to the host (CID 2) on a fixed port for each request, writes one
  frame (four bytes of length, one JSON object) and reads one frame back. The messages and their
  limits are `contracts/environment-control.v1.json`; the real AF_VSOCK socket is the lane of #977
  and #978, every test here uses a socket of its own (`Connect`).
* **none**: the Worker runs with the inner wall (the network door) only, and the session says so
  once. This is the R1b runner's behaviour.

A `narrow` that times out, is refused or cannot reach the host ends the job
`environment_control_failed` (free: the agent never started). The https transport keeps its own
codes, because hosted behaviour and its tests do not change. `report_end` never fails the Worker:
it is ending anyway.
"""

import json
import logging
import re
import socket
import struct
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Final, Protocol, cast

from code_reviewer_runner.job import (
    IMPLEMENTER_NETWORK_SWITCH_VARIABLE,
    JobError,
)
from code_reviewer_runner.result import ErrorCode

from .network_rule import NetworkRule
from .network_switch import NetworkSwitch, Post, narrow_policy, parse_switch, urllib_post

_log = logging.getLogger(__name__)

# The environment variable that chooses the vsock transport. Its one value is `vsock`; the port is
# not configurable, it is the contract's.
ENVIRONMENT_CONTROL_VARIABLE: Final = "RUNNER_ENVIRONMENT_CONTROL"
TRANSPORT_VSOCK: Final = "vsock"

# `contracts/environment-control.v1.json` (a contract test holds them equal).
PROTOCOL_VERSION: Final = 1
VSOCK_HOST_CID: Final = 2
VSOCK_PORT: Final = 5100
MAX_FRAME_BYTES: Final = 65536
NARROW_SECONDS: Final = 30.0
END_SECONDS: Final = 5.0
HEADER_BYTES: Final = 4
# `ControlToken` of the contract: the host's per-VM token, which every request carries (#977).
CONTROL_TOKEN: Final = re.compile(r"[A-Za-z0-9_-]{43,128}")

REQUEST_NARROW: Final = "narrow"
REQUEST_END: Final = "end"


class Refusal(StrEnum):
    """Why a host refused (`ControlRefusalReason`)."""

    RULE_NOT_ALLOWED = "rule_not_allowed"
    INVALID_REQUEST = "invalid_request"
    UNAVAILABLE = "unavailable"


class ProtocolError(Exception):
    """A frame or a message that is not one of the contract: the connection is not to be trusted."""


class StreamSocket(Protocol):
    """The part of a connected stream socket the transport uses; `socket.socket` has it."""

    def sendall(self, data: bytes, /) -> None: ...

    def recv(self, bufsize: int, /) -> bytes: ...

    def settimeout(self, value: float | None, /) -> None: ...

    def close(self) -> None: ...


# Opens the connection to the host; the argument is the seconds it may take. A test brings its own.
Connect = Callable[[float], StreamSocket]


def vsock_connect(timeout: float) -> StreamSocket:
    """The real connection: AF_VSOCK to the host's CID on the contract's port."""
    family = getattr(socket, "AF_VSOCK", None)
    if family is None:
        raise OSError("this platform has no AF_VSOCK")
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect((VSOCK_HOST_CID, VSOCK_PORT))
    except BaseException:
        sock.close()
        raise
    return sock


# -- the messages and the framing ---


def narrow_request(rule: NetworkRule, model_host: str, token: str | None = None) -> dict[str, Any]:
    """`NarrowRequest` of the contract. `token` is the host's per-VM token: a host that serves a VM
    of vm-init refuses a request without it."""
    request: dict[str, Any] = {
        "version": PROTOCOL_VERSION,
        "type": REQUEST_NARROW,
        "network": rule.to_json(),
        "modelHost": model_host,
    }
    if token is not None:
        request["token"] = token
    return request


def end_request(exit_code: int, token: str | None = None) -> dict[str, Any]:
    """`EndRequest` of the contract, with the host's token when the Worker has one."""
    request: dict[str, Any] = {
        "version": PROTOCOL_VERSION,
        "type": REQUEST_END,
        "exitCode": exit_code,
    }
    if token is not None:
        request["token"] = token
    return request


def encode_frame(document: object) -> bytes:
    """The four bytes of the body's length (unsigned, big-endian) and the body."""
    body = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if not 1 <= len(body) <= MAX_FRAME_BYTES:
        raise ProtocolError("the message is larger than a frame may be")
    return struct.pack(">I", len(body)) + body


def _read_exactly(sock: StreamSocket, count: int, deadline: float) -> bytes:
    chunks: list[bytes] = []
    missing = count
    while missing > 0:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("the frame did not arrive in time")
        sock.settimeout(remaining)
        chunk = sock.recv(min(missing, 65536))
        if not chunk:
            raise ProtocolError("the connection ended inside a frame")
        chunks.append(chunk)
        missing -= len(chunk)
    return b"".join(chunks)


def read_frame(sock: StreamSocket, *, deadline_seconds: float) -> object:
    """One frame, as the JSON document in its body. Raises `ProtocolError` for a length of 0 or
    above the limit, a connection that ends inside the frame and a body that is not one JSON
    object, and `TimeoutError` when the frame is not whole `deadline_seconds` from now."""
    deadline = time.monotonic() + deadline_seconds
    (length,) = struct.unpack(">I", _read_exactly(sock, HEADER_BYTES, deadline))
    if not 1 <= length <= MAX_FRAME_BYTES:
        raise ProtocolError("the frame's length is not one of the contract")
    body = _read_exactly(sock, length, deadline)
    try:
        document = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise ProtocolError("the frame's body is not JSON") from None
    if not isinstance(document, dict):
        raise ProtocolError("the frame's body is not an object")
    return document  # pyright: ignore[reportUnknownVariableType]


@dataclass(frozen=True)
class Reply:
    """A host's answer: `ack`, or `refused` with the reason."""

    refusal: Refusal | None

    @property
    def acked(self) -> bool:
        return self.refusal is None


def read_reply(document: object, expected: str) -> Reply:
    """The reply of the contract (`AckReply`, `RefusedReply`) to the request `expected`. Raises
    `ProtocolError` for anything else, an unknown field included."""
    if not isinstance(document, dict):
        raise ProtocolError("the reply is not an object")
    given = cast("dict[str, Any]", document)
    version = given.get("version")
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise ProtocolError("the reply's version is not 1")
    if given.get("for") != expected:
        raise ProtocolError("the reply answers another request")
    kind = given.get("type")
    if kind == "ack" and given.keys() == {"version", "type", "for"}:
        return Reply(None)
    if kind == "refused" and given.keys() == {"version", "type", "for", "reason"}:
        try:
            return Reply(Refusal(given["reason"]))
        except ValueError:
            raise ProtocolError("the reply's reason is not one of the contract") from None
    raise ProtocolError("the reply is not one of the contract")


# -- the interface and its transports ---


class EnvironmentControl(Protocol):
    """What Control asks of the one who started the sandbox."""

    def narrow(self, rule: NetworkRule, model_host: str) -> None:
        """Switch the outer wall to the job's rule, or raise `JobError`."""
        ...

    def report_end(self, exit_code: int) -> None:
        """Say that the Worker ends. Never raises."""
        ...


@dataclass(frozen=True)
class HttpsControl:
    """The hosted Dispatcher's `POST /network` (`network_switch.py`), as it always was."""

    switch: NetworkSwitch
    post: Post = urllib_post
    pause_seconds: float = 2.0

    def narrow(self, rule: NetworkRule, model_host: str) -> None:
        narrow_policy(
            self.switch, rule, model_host, post=self.post, pause_seconds=self.pause_seconds
        )

    def report_end(self, exit_code: int) -> None:
        _ = exit_code  # the hosted Dispatcher sees the container end


@dataclass(frozen=True)
class VsockControl:
    """The host's environment control over AF_VSOCK (`contracts/environment-control.v1.json`)."""

    connect: Connect = vsock_connect
    narrow_seconds: float = NARROW_SECONDS
    end_seconds: float = END_SECONDS
    # The host's per-VM token (vm-init hands it to Control on its stdin, #977). It is in every
    # request, never in a log, an error or a `repr`.
    token: str | None = field(default=None, repr=False)

    def narrow(self, rule: NetworkRule, model_host: str) -> None:
        request = narrow_request(rule, model_host, self.token)
        try:
            reply = self._exchange(request, REQUEST_NARROW, self.narrow_seconds)
        except TimeoutError:
            raise JobError(
                ErrorCode.ENVIRONMENT_CONTROL_FAILED,
                "environment_control_timeout: the host did not narrow the network wall in time",
            ) from None
        except ProtocolError as error:
            raise JobError(
                ErrorCode.ENVIRONMENT_CONTROL_FAILED,
                f"environment_control_protocol: {error}",
            ) from None
        except OSError:
            raise JobError(
                ErrorCode.ENVIRONMENT_CONTROL_FAILED,
                "environment_control_unavailable: the host could not be reached",
            ) from None
        if reply.refusal is not None:
            raise JobError(
                ErrorCode.ENVIRONMENT_CONTROL_FAILED,
                f"environment_control_refused: {reply.refusal.value}: "
                "the host refused the network wall",
            )

    def report_end(self, exit_code: int) -> None:
        try:
            reply = self._exchange(
                end_request(exit_code, self.token), REQUEST_END, self.end_seconds
            )
        except (TimeoutError, ProtocolError, OSError) as error:
            _log.warning("environment control: the end was not reported (%s)", type(error).__name__)
            return
        if reply.refusal is not None:
            _log.warning("environment control: the end was refused (%s)", reply.refusal.value)

    def _exchange(self, request: dict[str, Any], expected: str, seconds: float) -> Reply:
        """One connection, one request, one reply, all inside `seconds`. The connection is closed
        whatever happens."""
        started = time.monotonic()
        sock = self.connect(seconds)
        try:
            remaining = seconds - (time.monotonic() - started)
            if remaining <= 0:
                raise TimeoutError("the host did not answer in time")
            sock.settimeout(remaining)
            sock.sendall(encode_frame(request))
            remaining = seconds - (time.monotonic() - started)
            return read_reply(read_frame(sock, deadline_seconds=max(remaining, 0.001)), expected)
        finally:
            sock.close()


def control_from_environment(
    environment: Mapping[str, str],
    *,
    post: Post = urllib_post,
    pause_seconds: float = 2.0,
    connect: Connect = vsock_connect,
    narrow_seconds: float = NARROW_SECONDS,
    token: str | None = None,
) -> EnvironmentControl | None:
    """The transport the Worker was started for, or None when it was started for none. Raises
    `JobError` (`implementer_config_invalid`) for a configuration that says something and cannot be
    read, and for one that says two things: a deployment that says it can narrow the wall and
    cannot is not the same as one that does not say so. `token` is the host's per-VM token, which
    only the vsock transport sends; the https transport is unchanged."""
    chosen = environment.get(ENVIRONMENT_CONTROL_VARIABLE)
    switch_text = environment.get(IMPLEMENTER_NETWORK_SWITCH_VARIABLE)
    has_switch = switch_text is not None and bool(switch_text.strip())
    if chosen is not None:
        if chosen != TRANSPORT_VSOCK:
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID,
                f"{ENVIRONMENT_CONTROL_VARIABLE} must be {TRANSPORT_VSOCK} when it is set",
            )
        if has_switch:
            raise JobError(
                ErrorCode.IMPLEMENTER_CONFIG_INVALID,
                "this container names two environment controls, the network switch and vsock",
            )
        return VsockControl(connect=connect, narrow_seconds=narrow_seconds, token=token)
    switch = parse_switch(switch_text)
    if switch is None:
        return None
    return HttpsControl(switch, post=post, pause_seconds=pause_seconds)


def report_worker_end(
    environment: Mapping[str, str],
    exit_code: int,
    *,
    token: str | None = None,
    connect: Connect = vsock_connect,
) -> None:
    """The Worker's last act: tell the host over vsock that it ended. Over https and with no control
    there is nothing to tell. Never raises: a Worker that cannot say goodbye still ends."""
    if environment.get(ENVIRONMENT_CONTROL_VARIABLE) is None:
        return
    try:
        transport = control_from_environment(environment, connect=connect, token=token)
    except JobError:
        _log.warning("environment control: not configured, so the end was not reported")
        return
    if transport is not None:
        transport.report_end(exit_code)
