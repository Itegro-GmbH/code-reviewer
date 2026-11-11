# SPDX-License-Identifier: LicenseRef-Proprietary

"""A fake vsock for the tests of vm-init: every connection is a pair of real stream sockets (a Unix
socket pair), so the framing is exercised for real, and the host's end is in the test's hand. No
AF_VSOCK socket is opened: the real boot path is proven by the KVM lane of #978."""

import json
import socket
import struct
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from code_reviewer_runner.vm_init.steps import CommandResult
from code_reviewer_runner.vm_init.wire import StreamSocket, encode_frame

CREDENTIAL = "crj_credential-that-must-never-leak-0123456789"
LOCAL_CREDENTIAL = "local-credential-that-must-never-leak-0123456789"
CONTROL_TOKEN = "control-token-that-must-never-leak-0123456789"
IMAGE_ID = "sha256:" + "ab" * 32
IMAGE_REFERENCE = "code-reviewer-worker:golden"
VOLUME_NAME = "code-reviewer-work-job-1"


def start_document(**changes: Any) -> dict[str, Any]:
    """A valid `StartRequest`, with the top-level keys of `changes` replaced (None removes one)."""
    document: dict[str, Any] = {
        "version": 1,
        "type": "start",
        "job": {"appUrl": "https://app.example", "jobId": "job-1", "credential": CREDENTIAL},
        "localCredential": {"name": "CLAUDE_CODE_OAUTH_TOKEN", "value": LOCAL_CREDENTIAL},
        "controlToken": CONTROL_TOKEN,
        "image": {"reference": IMAGE_REFERENCE, "id": IMAGE_ID},
        "control": {
            "args": [
                "run",
                "--interactive",
                "--rm",
                "--name",
                "code-reviewer-worker-job-1",
                IMAGE_ID,
                "worker-once",
            ]
        },
        "workVolume": {"name": VOLUME_NAME, "reserveGib": 8},
    }
    for key, value in changes.items():
        if value is None:
            document.pop(key, None)
        else:
            document[key] = value
    return document


def _bad(**changes: Any) -> dict[str, Any]:
    return start_document(**changes)


def _with_job(**changes: Any) -> dict[str, Any]:
    job = dict(start_document()["job"])
    for key, value in changes.items():
        if value is None:
            job.pop(key)
        else:
            job[key] = value
    return start_document(job=job)


def _with_args(args: list[Any]) -> dict[str, Any]:
    return start_document(control={"args": args})


_ARGS = start_document()["control"]["args"]

OUTER_PROXY = {"host": "172.31.0.5", "port": 3128}

# One entry per way the start can be wrong; the id names the field. The value is a start that
# vm-init refuses. `SCHEMA_ALLOWS` are the ones the contract's schema cannot say (the parser is
# stricter there); every other one is invalid under the schema as well.
BAD_STARTS: dict[str, dict[str, Any]] = {
    "version 2": _bad(version=2),
    "version true": _bad(version=True),
    "type": _bad(type="stop"),
    "no job": _bad(job=None),
    "unknown top-level key": _bad(extra=1),
    "job.appUrl not http": _with_job(appUrl="ftp://app.example"),
    "job.appUrl too short": _with_job(appUrl="http://"),
    "job.jobId with a slash": _with_job(jobId="a/b"),
    "job.credential empty": _with_job(credential=""),
    "job.credential with a space": _with_job(credential="crj_a b"),
    "job.credential too long": _with_job(credential="c" * 513),
    "job unknown key": _with_job(extra="x"),
    "localCredential lower-case name": _bad(localCredential={"name": "token", "value": "x"}),
    "localCredential no value": _bad(localCredential={"name": "TOKEN"}),
    "image.id not a digest": _bad(image={"reference": "worker:golden", "id": "abc"}),
    "image.reference upper-case": _bad(image={"reference": "Worker", "id": "sha256:" + "a" * 64}),
    "args not a list": _bad(control={"args": "run"}),
    "args one entry": _with_args(["run"]),
    "args not run first": _with_args(["exec", *_ARGS[1:]]),
    "args an empty one": _with_args([*_ARGS, ""]),
    "args a number": _with_args([*_ARGS, 1]),
    "args a NUL": _with_args([*_ARGS, "a\x00b"]),
    "args too many": _with_args(["run", *["x"] * 256]),
    "args too long": _with_args([*_ARGS, "x" * 4097]),
    "control unknown key": _bad(control={"args": _ARGS, "extra": 1}),
    "workVolume.reserveGib 0": _bad(workVolume={"name": "v", "reserveGib": 0}),
    "workVolume.reserveGib 65": _bad(workVolume={"name": "v", "reserveGib": 65}),
    "workVolume.reserveGib true": _bad(workVolume={"name": "v", "reserveGib": True}),
    "workVolume.name starts with a dash": _bad(workVolume={"name": "-v", "reserveGib": 8}),
    "no controlToken": _bad(controlToken=None),
    "controlToken too short": _bad(controlToken="t" * 42),
    "controlToken with a space": _bad(controlToken="t" * 43 + " "),
    "controlToken a number": _bad(controlToken=1),
    # A trailing newline passes a pattern that ends in `$` (Python's `re`, `match`): the parser
    # uses `fullmatch`. The schema (ECMA 262 `$`) refuses these; Python's `jsonschema` does not.
    "job.appUrl trailing newline": _with_job(appUrl="https://app.example\n"),
    "job.jobId trailing newline": _with_job(jobId="job-1\n"),
    "job.credential trailing newline": _with_job(credential=CREDENTIAL + "\n"),
    "localCredential.name trailing newline": _bad(
        localCredential={"name": "TOKEN\n", "value": "x"}
    ),
    "localCredential.value trailing newline": _bad(
        localCredential={"name": "TOKEN", "value": "x\n"}
    ),
    "image.reference trailing newline": _bad(
        image={"reference": IMAGE_REFERENCE + "\n", "id": IMAGE_ID}
    ),
    "image.id trailing newline": _bad(image={"reference": IMAGE_REFERENCE, "id": IMAGE_ID + "\n"}),
    "workVolume.name trailing newline": _bad(workVolume={"name": "v\n", "reserveGib": 8}),
    "controlToken trailing newline": _bad(controlToken=CONTROL_TOKEN + "\n"),
    # #994: the proxy is the one way out of the VM, so an address outside the slots' network, a
    # spelling `ipaddress` would not print, a missing or wrong port and any other key are refused.
    "outerProxy not an object": _bad(outerProxy="172.31.0.5:3128"),
    "outerProxy host outside the slots": _bad(outerProxy={**OUTER_PROXY, "host": "10.0.0.1"}),
    "outerProxy host below the slots": _bad(outerProxy={**OUTER_PROXY, "host": "172.30.0.5"}),
    "outerProxy host loopback": _bad(outerProxy={**OUTER_PROXY, "host": "127.0.0.1"}),
    "outerProxy host a name": _bad(outerProxy={**OUTER_PROXY, "host": "proxy.example"}),
    "outerProxy host a leading zero": _bad(outerProxy={**OUTER_PROXY, "host": "172.31.0.05"}),
    "outerProxy host a number": _bad(outerProxy={**OUTER_PROXY, "host": 1}),
    "outerProxy host trailing newline": _bad(outerProxy={**OUTER_PROXY, "host": "172.31.0.5\n"}),
    "outerProxy no port": _bad(outerProxy={"host": "172.31.0.5"}),
    "outerProxy port 0": _bad(outerProxy={**OUTER_PROXY, "port": 0}),
    "outerProxy port 65536": _bad(outerProxy={**OUTER_PROXY, "port": 65536}),
    "outerProxy port true": _bad(outerProxy={**OUTER_PROXY, "port": True}),
    "outerProxy port a string": _bad(outerProxy={**OUTER_PROXY, "port": "3128"}),
    "outerProxy unknown key": _bad(outerProxy={**OUTER_PROXY, "scheme": "http"}),
    # What the schema cannot say: the image that runs is the image that was checked, and the
    # arguments hold no option that takes the VM's walls away (`wire.check_control_args`).
    "args image is not the checked one": _with_args([*_ARGS[:-2], "other:tag", _ARGS[-1]]),
    "args no image": _with_args(["run", "--rm"]),
}


# The pattern is the same, but Python's `$` matches before a final newline, so the schema's reader
# here lets these through; the parser does not (an ECMA 262 reader refuses them too).
SCHEMA_ALLOWS = frozenset(
    {"args a NUL", "args image is not the checked one", "args no image"}
    | {name for name in BAD_STARTS if name.endswith("trailing newline")}
)


def read_frame_from(sock: socket.socket) -> dict[str, Any]:
    """The one frame the guest wrote to its end of a connection, read at the host's end."""
    sock.settimeout(2.0)
    header = _exactly(sock, 4)
    (length,) = struct.unpack(">I", header)
    return json.loads(_exactly(sock, length).decode("utf-8"))


def _exactly(sock: socket.socket, count: int) -> bytes:
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        assert chunk, "the connection ended inside a frame"
        data += chunk
    return data


@dataclass
class HostConnection:
    """The host's end of one connection the guest made, or the host's end of the one it will
    accept."""

    sock: socket.socket

    def send(self, document: object) -> None:
        self.sock.sendall(encode_frame(document))

    def send_raw(self, data: bytes) -> None:
        self.sock.sendall(data)

    def read(self) -> dict[str, Any]:
        return read_frame_from(self.sock)


class FakeListener:
    def __init__(self, queue: list[socket.socket]) -> None:
        self._queue = queue
        self.closed = False
        self.timeouts: list[float] = []

    def accept(self, timeout: float) -> StreamSocket | None:
        self.timeouts.append(timeout)
        return self._queue.pop(0) if self._queue else None

    def close(self) -> None:
        self.closed = True


@dataclass
class FakeVsock:
    """What the guest sees of the VM's vsock. `connections` are the host's connections to the
    guest's listener, queued before the guest accepts; `report_replies` are what the host answers to
    each exit report (in order; an exception is raised as the connect error)."""

    refuse_listen: bool = False
    listen_ports: list[int] = field(default_factory=lambda: [])
    listener: FakeListener | None = None
    start_host_ends: list[HostConnection] = field(default_factory=lambda: [])
    report_host_ends: list[HostConnection] = field(default_factory=lambda: [])
    connect_errors: list[OSError] = field(default_factory=lambda: [])
    report_ports: list[int] = field(default_factory=lambda: [])
    ack_reports: bool = True
    _queue: list[socket.socket] = field(default_factory=lambda: [])

    def host_connects(self) -> HostConnection:
        """The host connects to the guest's start port: the connection waits until it is
        accepted."""
        guest_end, host_end = socket.socketpair()
        self._queue.append(guest_end)
        connection = HostConnection(host_end)
        self.start_host_ends.append(connection)
        return connection

    def listen(self, port: int) -> FakeListener:
        if self.refuse_listen:
            raise OSError("no vsock")
        self.listen_ports.append(port)
        self.listener = FakeListener(self._queue)
        return self.listener

    def connect_host(self, port: int, timeout: float) -> StreamSocket:
        _ = timeout
        self.report_ports.append(port)
        if self.connect_errors:
            raise self.connect_errors.pop(0)
        guest_end, host_end = socket.socketpair()
        connection = HostConnection(host_end)
        if self.ack_reports:
            connection.send({"version": 1, "type": "ack", "for": "exit"})
        self.report_host_ends.append(connection)
        return guest_end


@dataclass
class FakeRunner:
    """Records every command; answers by the first of `rules` whose prefix the command starts
    with."""

    rules: list[tuple[tuple[str, ...], CommandResult]] = field(default_factory=lambda: [])
    commands: list[tuple[str, ...]] = field(default_factory=lambda: [])
    mountinfo: Callable[[], str] | None = None

    def run(self, argv: tuple[str, ...], *, timeout: float, capture: bool) -> CommandResult:
        _ = timeout, capture
        self.commands.append(argv)
        for prefix, result in self.rules:
            if argv[: len(prefix)] == prefix:
                return result
        if argv == ("docker", "info"):
            return CommandResult(1)  # no daemon yet, as in a VM whose init does not start one
        if argv[:2] == ("docker", "image"):
            return CommandResult(0, IMAGE_ID + "\n")
        if argv == ("cat", "/proc/self/mountinfo") and self.mountinfo is not None:
            return CommandResult(0, self.mountinfo())
        return CommandResult(0, "")


@dataclass
class FakeControl:
    """Stands in for `docker run`: remembers what it was given and ends with `status`."""

    status: int = 0
    calls: list[tuple[tuple[str, ...], bytes]] = field(default_factory=lambda: [])

    def __call__(self, args: tuple[str, ...], stdin: bytes) -> int:
        self.calls.append((args, stdin))
        return self.status


@dataclass
class FakePower:
    calls: int = 0
    result: bool = True

    def __call__(self) -> bool:
        self.calls += 1
        return self.result


def work_volume_mountinfo(name: str = "code-reviewer-work-job-1") -> str:
    """What `/proc/self/mountinfo` shows after the work volume's mounts, as the check reads it."""
    root = "/var/lib/code-reviewer-work"
    lines = [
        f"101 99 8:1 /{name} {root}/{name} rw,nosuid,nodev - ext4 /dev/vdb rw",
        f"102 101 7:0 / {root}/{name}/reserve rw,nosuid,nodev - ext4 /dev/loop0 rw",
    ]
    return "\n".join(lines) + "\n"
