# SPDX-License-Identifier: LicenseRef-Proprietary

"""The snapshot channel of the job process (#839): the header, the bytes behind it, the seconds it
may take and what happens when the host is gone or does not read."""

import hashlib
import os
import socket
import threading

import pytest

from code_reviewer_runner.implementer.session_export import SessionSnapshot
from code_reviewer_runner.implementer.snapshot_pump import (
    SnapshotPump,
    snapshot_pump_from_environment,
)
from code_reviewer_runner.snapshot_wire import (
    CHUNK_BYTES,
    MAX_SNAPSHOT_BYTES,
    SNAPSHOT_FD_VARIABLE,
    SnapshotHeader,
    header_line,
    parse_header,
    parts_of,
)

pytestmark = pytest.mark.unit

DIGEST = "a" * 64


def snapshot_of(data: bytes) -> SessionSnapshot:
    return SessionSnapshot(
        data=data,
        raw_bytes=len(data) * 4,
        sha256=hashlib.sha256(data).hexdigest(),
        messages=3,
        blanked=0,
    )


def read_all(end: socket.socket) -> bytes:
    chunks: list[bytes] = []
    while chunk := end.recv(1 << 16):
        chunks.append(chunk)
    return b"".join(chunks)


# #839-T08
def test_the_header_and_the_bytes_behind_it_arrive_whole() -> None:
    process_end, host_end = socket.socketpair()
    data = os.urandom(900_000)
    received: list[bytes] = []
    reader = threading.Thread(target=lambda: received.append(read_all(host_end)))
    reader.start()

    assert SnapshotPump(process_end).send(snapshot_of(data), "1.19.0", 5.0) is True
    reader.join(5)

    line, _, body = received[0].partition(b"\n")
    header = parse_header(line + b"\n")
    assert header == SnapshotHeader(
        len(data), len(data) * 4, hashlib.sha256(data).hexdigest(), "1.19.0"
    )
    assert body == data
    host_end.close()


# #839-T08
def test_a_host_that_does_not_read_costs_the_seconds_and_nothing_more() -> None:
    process_end, host_end = socket.socketpair()
    process_end.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)

    sent = SnapshotPump(process_end).send(snapshot_of(os.urandom(6_000_000)), "1.19.0", 0.2)

    assert sent is False
    host_end.close()


# #839-T08
def test_a_host_that_went_away_is_a_failed_send_not_an_error() -> None:
    process_end, host_end = socket.socketpair()
    host_end.close()

    assert SnapshotPump(process_end).send(snapshot_of(b"x" * 100), "1.19.0", 1.0) is False


# #839-T08
def test_a_process_without_a_channel_has_no_pump() -> None:
    assert snapshot_pump_from_environment({}) is None
    assert snapshot_pump_from_environment({SNAPSHOT_FD_VARIABLE: "not a number"}) is None
    assert snapshot_pump_from_environment({SNAPSHOT_FD_VARIABLE: "9999"}) is None


# #839-T08
def test_the_descriptor_is_not_inherited_by_what_the_process_starts() -> None:
    mine, theirs = socket.socketpair()
    descriptor = os.dup(mine.fileno())
    os.set_inheritable(descriptor, True)

    pump = snapshot_pump_from_environment({SNAPSHOT_FD_VARIABLE: str(descriptor)})

    assert pump is not None
    assert os.get_inheritable(descriptor) is False
    pump.close()
    mine.close()
    theirs.close()


# #839-T09
def test_a_header_is_read_only_when_it_is_exactly_the_protocol() -> None:
    good = header_line(SnapshotHeader(10, 40, DIGEST, "1.19.0"))
    assert parse_header(good) == SnapshotHeader(10, 40, DIGEST, "1.19.0")
    bad = [
        b"",
        b"S 10 40 " + DIGEST.encode() + b"\n",
        b"X 10 40 " + DIGEST.encode() + b" 1.19.0\n",
        b"S ten 40 " + DIGEST.encode() + b" 1.19.0\n",
        b"S 0 40 " + DIGEST.encode() + b" 1.19.0\n",
        b"S %d 40 %s 1.19.0\n" % (MAX_SNAPSHOT_BYTES + 1, DIGEST.encode()),
        b"S 10 0 " + DIGEST.encode() + b" 1.19.0\n",
        b"S 10 40 " + b"A" * 64 + b" 1.19.0\n",
        b"S 10 40 abc 1.19.0\n",
        b"S 10 40 " + DIGEST.encode() + b" ../etc\n",
        b"S 10 40 " + DIGEST.encode() + b" 1.19.0 extra\n",
        b"S 10 40 " + DIGEST.encode() + b" " + b"v" * 400 + b"\n",
    ]
    for line in bad:
        assert parse_header(line) is None, line


# #839-T09
def test_the_upload_is_cut_in_parts_below_what_the_platform_takes_in_one_request() -> None:
    assert CHUNK_BYTES == 3 * 1024 * 1024 < 4_500_000
    assert parts_of(1) == 1
    assert parts_of(CHUNK_BYTES) == 1
    assert parts_of(CHUNK_BYTES + 1) == 2
    assert parts_of(MAX_SNAPSHOT_BYTES) == 3
