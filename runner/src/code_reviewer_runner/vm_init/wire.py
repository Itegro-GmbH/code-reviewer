# SPDX-License-Identifier: LicenseRef-Proprietary

"""The wire of vm-init (`contracts/vm-init.v1.json`): the frame, the start request it accepts, the
replies it sends and the exit report.

Standard library only, and no import outside this package: vm-init is copied into a root file
system without the runner (`runner/vm-init/install.sh`), and a test holds that. The framing is the
one of `implementer/environment_control.py` (four bytes of length, one JSON object); it is written
again here, a few lines, instead of importing the Worker's module and everything that module needs.
"""

import ipaddress
import json
import re
import struct
import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Final, Protocol, cast

PROTOCOL_VERSION: Final = 1
HOST_CID: Final = 2
START_PORT: Final = 5000
REPORT_PORT: Final = 5101
MAX_FRAME_BYTES: Final = 262144
HEADER_BYTES: Final = 4
START_READ_SECONDS: Final = 10.0
START_WAIT_SECONDS: Final = 300.0
REPORT_SECONDS: Final = 10.0
REPORT_RETRY_SECONDS: Final = 0.5

REQUEST_START: Final = "start"
REQUEST_EXIT: Final = "exit"
REFUSAL_INVALID_START: Final = "invalid_start"


class ExitReason(StrEnum):
    """Why the VM ends (`ExitReason` of the contract)."""

    WORKER_EXITED = "worker_exited"
    DOCKER_FAILED = "docker_failed"
    PREPARE_FAILED = "prepare_failed"
    IMAGE_MISSING = "image_missing"
    IMAGE_MISMATCH = "image_mismatch"
    START_INVALID = "start_invalid"
    START_TIMEOUT = "start_timeout"


# The exit status of a VM that ended before Control ran: the Worker's "setup error".
SETUP_ERROR_EXIT: Final = 2


class ProtocolError(Exception):
    """A frame or a message that is not one of the contract."""


class InvalidStart(ProtocolError):
    """A start that is not a `StartRequest`, or one that would put the credential in an argument."""


class StreamSocket(Protocol):
    """The part of a connected stream socket vm-init uses; `socket.socket` has it."""

    def sendall(self, data: bytes, /) -> None: ...

    def recv(self, bufsize: int, /) -> bytes: ...

    def settimeout(self, value: float | None, /) -> None: ...

    def close(self) -> None: ...


# -- the frame ---


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
    above
    the limit, a connection that ends inside the frame and a body that is not one JSON object, and
    `TimeoutError` when the frame is not whole `deadline_seconds` from now."""
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


# -- the start request ---

# Matched with `fullmatch`: `$` would let a trailing newline through.
_APP_URL = re.compile(r"https?://[!-~]+")
_JOB_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
_PRINTABLE = re.compile(r"[!-~]+")
_VARIABLE = re.compile(r"[A-Z][A-Z0-9_]{0,63}")
_IMAGE_REFERENCE = re.compile(r"[a-z0-9][A-Za-z0-9._/:@-]{0,255}")
_IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
_VOLUME_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,159}")
# 32 to 96 random bytes in base64url, without padding.
_CONTROL_TOKEN = re.compile(r"[A-Za-z0-9_-]{43,128}")
_MAX_ARGUMENTS = 256
_MAX_ARGUMENT_CHARACTERS = 4096


@dataclass(frozen=True)
class JobDocument:
    """What the Worker reads from its stdin. The credential is never part of a `repr`."""

    app_url: str
    job_id: str
    credential: str = field(repr=False)


@dataclass(frozen=True)
class LocalCredential:
    """The one credential that exists only on the dispatcher's device (#980)."""

    name: str
    value: str = field(repr=False)


@dataclass(frozen=True)
class OuterProxy:
    """The proxy of the host's outer wall for this VM's slot (#994): the host's address on the
    slot's TAP and the proxy's port. Everything in the VM that dials the internet goes through it;
    it is the host's to name and never a job's."""

    host: str
    port: int


@dataclass(frozen=True)
class ImageCheck:
    reference: str
    image_id: str


@dataclass(frozen=True)
class StartRequest:
    job: JobDocument
    local_credential: LocalCredential | None
    image: ImageCheck
    args: tuple[str, ...]
    volume_name: str
    reserve_gib: int
    # The host's per-VM token: in every message the VM's processes send to the host, so that the
    # host can tell them from a forged one (`contracts/vm-init.v1.json`, "THE TOKEN").
    control_token: str = field(repr=False)
    # The outer wall's proxy of this slot (#994), set when the host runs the proxy wall: None means
    # the VM dials as it did before (the inner wall only, or hosted).
    outer_proxy: OuterProxy | None = None

    def stdin_document(self) -> bytes:
        """The bytes written to Control's stdin: the job document as one JSON line, plus the token
        of the environment control under `controlToken`, the local credential under
        `localCredential` when there is one and the outer wall's proxy under `outerProxy` when the
        host has one. Other keys are ignored by a Worker that does not know them."""
        document: dict[str, Any] = {
            "appUrl": self.job.app_url,
            "jobId": self.job.job_id,
            "credential": self.job.credential,
            "controlToken": self.control_token,
        }
        if self.local_credential is not None:
            document["localCredential"] = {
                "name": self.local_credential.name,
                "value": self.local_credential.value,
            }
        if self.outer_proxy is not None:
            document["outerProxy"] = {"host": self.outer_proxy.host, "port": self.outer_proxy.port}
        return (
            json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8") + b"\n"
        )

    def secrets(self) -> tuple[str, ...]:
        """Every value that must not appear anywhere but in the stdin document."""
        values = [self.job.credential, self.control_token]
        if self.local_credential is not None:
            values.append(self.local_credential.value)
        return tuple(values)


def _invalid(what: str) -> InvalidStart:
    # The message names a field and never a value: the start holds secrets.
    return InvalidStart(f"the start is not valid: {what}")


def _record(value: object, keys: set[str], optional: set[str], what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(what)
    given = cast("dict[str, Any]", value)
    names = set(given)
    if not (keys <= names <= keys | optional):
        raise _invalid(what)
    return given


def _text(value: object, pattern: re.Pattern[str], what: str, *, longest: int) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= longest or not pattern.fullmatch(value):
        raise _invalid(what)
    return value


# The slots' network is chosen by the installer for each machine (`firecracker/slots.py`) and the VM
# does not know it: the proxy is on a private address (the nft table lets the VM reach its slot's
# address and nothing else).
_PRIVATE_NETWORKS = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)


def _outer_proxy(value: object) -> OuterProxy:
    """`outerProxy` of the contract: a private IPv4 address, written the way `ipaddress` prints it,
    and a port. Anything else is refused: the proxy is the one way out of the VM, so a public,
    loopback or link-local address is a start that is wrong."""
    given = _record(value, {"host", "port"}, set(), "outerProxy")
    host, port = given["host"], given["port"]
    if not isinstance(host, str):
        raise _invalid("outerProxy.host")
    try:
        address = ipaddress.IPv4Address(host)
    except ValueError:
        raise _invalid("outerProxy.host") from None
    if str(address) != host or not any(address in each for each in _PRIVATE_NETWORKS):
        raise _invalid("outerProxy.host")
    if type(port) is not int or not 1 <= port <= 65535:
        raise _invalid("outerProxy.port")
    return OuterProxy(host=host, port=port)


def parse_start(document: object) -> StartRequest:
    """The `StartRequest` of the contract, or `InvalidStart` naming the field that is wrong. Refuses
    a start that would put a credential in an argument of `docker run`."""
    top = _record(
        document,
        {"version", "type", "job", "controlToken", "image", "control", "workVolume"},
        {"localCredential", "outerProxy"},
        "the document",
    )
    version = top["version"]
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise _invalid("version")
    if top["type"] != REQUEST_START:
        raise _invalid("type")

    job = _record(top["job"], {"appUrl", "jobId", "credential"}, set(), "job")
    job_document = JobDocument(
        app_url=_text(job["appUrl"], _APP_URL, "job.appUrl", longest=2048),
        job_id=_text(job["jobId"], _JOB_ID, "job.jobId", longest=128),
        credential=_text(job["credential"], _PRINTABLE, "job.credential", longest=512),
    )
    if len(job_document.app_url) < 8:
        raise _invalid("job.appUrl")

    local: LocalCredential | None = None
    if "localCredential" in top:
        given = _record(top["localCredential"], {"name", "value"}, set(), "localCredential")
        local = LocalCredential(
            name=_text(given["name"], _VARIABLE, "localCredential.name", longest=64),
            value=_text(given["value"], _PRINTABLE, "localCredential.value", longest=4096),
        )

    token = _text(top["controlToken"], _CONTROL_TOKEN, "controlToken", longest=128)
    proxy = _outer_proxy(top["outerProxy"]) if "outerProxy" in top else None

    image = _record(top["image"], {"reference", "id"}, set(), "image")
    check = ImageCheck(
        reference=_text(image["reference"], _IMAGE_REFERENCE, "image.reference", longest=256),
        image_id=_text(image["id"], _IMAGE_ID, "image.id", longest=71),
    )

    control = _record(top["control"], {"args"}, set(), "control")
    arguments = control["args"]
    if (
        not isinstance(arguments, list)
        or not 2 <= len(cast("list[Any]", arguments)) <= _MAX_ARGUMENTS
    ):
        raise _invalid("control.args")
    args: list[str] = []
    for argument in cast("list[Any]", arguments):
        if (
            not isinstance(argument, str)
            or not 1 <= len(argument) <= _MAX_ARGUMENT_CHARACTERS
            or "\x00" in argument
        ):
            raise _invalid("control.args")
        args.append(argument)
    if args[0] != "run":
        raise _invalid("control.args")

    volume = _record(top["workVolume"], {"name", "reserveGib"}, set(), "workVolume")
    reserve = volume["reserveGib"]
    if type(reserve) is not int or not 1 <= reserve <= 64:
        raise _invalid("workVolume.reserveGib")
    volume_name = _text(volume["name"], _VOLUME_NAME, "workVolume.name", longest=160)
    request = StartRequest(
        job=job_document,
        local_credential=local,
        image=check,
        args=check_control_args(tuple(args), check, volume_name),
        volume_name=volume_name,
        reserve_gib=reserve,
        control_token=token,
        outer_proxy=proxy,
    )
    for secret in request.secrets():
        if any(secret in argument for argument in request.args):
            raise _invalid("control.args holds a credential")
    return request


# -- what `control.args` may be ---

# The options of `docker run` that stand alone; every other option takes a value (the next argument,
# or after an equals sign). A flag this list does not know takes the next argument as its value, so
# a mistake reads the image operand wrongly and the start is refused: it fails closed.
_FLAGS_WITHOUT_VALUE: Final = frozenset(
    {
        "--interactive",
        "--rm",
        "--read-only",
        "--privileged",
        "--init",
        "--tty",
        "--detach",
        "--oom-kill-disable",
        "--no-healthcheck",
        "--sig-proxy",
        "--publish-all",
        "-i",
        "-t",
        "-d",
        "-P",
        "-it",
        "-ti",
    }
)
_HOST_NAMESPACES: Final = frozenset({"--pid", "--net", "--network", "--ipc", "--userns", "--uts"})
_DOCKER_SOCKET_MOUNT: Final = frozenset(
    {
        "type=bind",
        "source=/var/run/docker.sock",
        "target=/run/docker.sock",
        "readonly",
    }
)


def _split_options(args: tuple[str, ...]) -> tuple[list[tuple[str, str | None]], int]:
    """The options of `docker run` as (name, value) and the index of the first argument that is not
    one: the image operand. -1 when there is none."""
    options: list[tuple[str, str | None]] = []
    index = 1
    while index < len(args):
        argument = args[index]
        if not argument.startswith("-"):
            return options, index
        name, equals, value = argument.partition("=")
        if equals:
            options.append((name, value))
            index += 1
        elif argument in _FLAGS_WITHOUT_VALUE:
            options.append((argument, None))
            index += 1
        elif index + 1 < len(args):
            options.append((argument, args[index + 1]))
            index += 2
        else:
            options.append((argument, None))
            index += 1
    return options, -1


def _refused_option(name: str, value: str | None, volume_name: str) -> bool:
    given = (value or "").lower()
    if name == "--privileged":
        return given not in ("false",)
    if name == "--security-opt":
        return given.replace(":", "=") in ("seccomp=unconfined", "apparmor=unconfined")
    if name in _HOST_NAMESPACES:
        return given == "host"
    if name == "--device":
        return True
    if name == "--cap-add":
        return given == "all"
    if name in ("--volume", "-v"):
        return True
    if name == "--mount":
        fields = set((value or "").split(","))
        work_volume = {"type=volume", f"source={volume_name}", "target=/work"}
        return fields not in (work_volume, _DOCKER_SOCKET_MOUNT)
    return False


def check_control_args(
    args: tuple[str, ...], image: ImageCheck, volume_name: str
) -> tuple[str, ...]:
    """`args` as vm-init runs them, or `InvalidStart`.

    * The image operand (the first argument after the options) is the image that was checked: the
      checked id, or the checked reference, which is then replaced by the id so that what runs is
      what `docker image inspect` printed the id of. Any other image is refused.
    * A cheap deny-list: no `--privileged`, `seccomp=unconfined`, `apparmor=unconfined`, a host
      namespace (`--pid`, `--net`, `--network`, `--ipc`, `--userns`, `--uts` with `host`),
      `--device`, `--cap-add ALL`, `--volume`, and no `--mount` but the job's work volume and the
      Docker socket (read only). It catches a bug of the Dispatcher that renders such an option;
      the host owns the VMM, the kernel and the root file system and is trusted
      (`runner/vm-init/README.md`, "Trust, the token and the wall clock"), so it is no defence
      against a host that is hostile.

    The messages name the field, never a value."""
    options, operand = _split_options(args)
    if operand < 0:
        raise _invalid("control.args names no image")
    for name, value in options:
        if _refused_option(name, value, volume_name):
            raise _invalid("control.args holds an option that is not allowed")
    if args[operand] not in (image.image_id, image.reference):
        raise _invalid("control.args runs an image that is not the checked one")
    return (*args[:operand], image.image_id, *args[operand + 1 :])


# -- the replies and the report ---


def ack_reply(request: str) -> dict[str, Any]:
    """`AckReply` of the contract."""
    return {"version": PROTOCOL_VERSION, "type": "ack", "for": request}


def refused_start_reply() -> dict[str, Any]:
    """`RefusedReply` of the contract."""
    return {
        "version": PROTOCOL_VERSION,
        "type": "refused",
        "for": REQUEST_START,
        "reason": REFUSAL_INVALID_START,
    }


def exit_report(exit_code: int, reason: ExitReason, token: str | None = None) -> dict[str, Any]:
    """`ExitReport` of the contract. `token` is the start's `controlToken`: every report of a VM
    that took a start carries it; the few that end the VM before one was read cannot."""
    report: dict[str, Any] = {
        "version": PROTOCOL_VERSION,
        "type": REQUEST_EXIT,
        "exitCode": exit_code,
        "reason": reason.value,
    }
    if token is not None:
        report["token"] = token
    return report


def read_ack(document: object, request: str) -> None:
    """Raises `ProtocolError` unless `document` is the `AckReply` to `request`."""
    if not isinstance(document, dict):
        raise ProtocolError("the reply is not an object")
    given = cast("dict[str, Any]", document)
    version = given.get("version")
    if type(version) is not int or version != PROTOCOL_VERSION:
        raise ProtocolError("the reply's version is not 1")
    if given.keys() != {"version", "type", "for"} or given["type"] != "ack":
        raise ProtocolError("the reply is not an ack")
    if given["for"] != request:
        raise ProtocolError("the reply answers another request")
