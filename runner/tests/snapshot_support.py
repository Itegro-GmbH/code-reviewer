# SPDX-License-Identifier: LicenseRef-Proprietary

"""Helpers for the tests of the session snapshot (#839; not a test file): the snapshot the engine
export would make, and the job host's end of the snapshot channel played by a thread."""

import hashlib
import socket
import threading
import time

from code_reviewer_runner.implementer.session_export import SessionSnapshot
from code_reviewer_runner.snapshot_wire import SnapshotHeader, parse_header


def snapshot_of(data: bytes = b"\x1f\x8b" + b"gzip bytes") -> SessionSnapshot:
    return SessionSnapshot(
        data=data,
        raw_bytes=len(data) * 3,
        sha256=hashlib.sha256(data).hexdigest(),
        messages=2,
        blanked=0,
    )


class SnapshotHost:
    """The host's end of a snapshot channel, played by a thread that reads until the process
    closes its end. `reads=False` is a host that never reads."""

    def __init__(self, *, reads: bool = True) -> None:
        self.process_end, self._end = socket.socketpair()
        self.wire = b""
        self.ended = threading.Event()
        self._thread: threading.Thread | None = None
        if reads:
            self._thread = threading.Thread(target=self._serve, daemon=True)
            self._thread.start()

    def _serve(self) -> None:
        chunks: list[bytes] = []
        while chunk := self._end.recv(1 << 16):
            chunks.append(chunk)
        self.wire = b"".join(chunks)
        self.ended.set()

    def wait(self, seconds: float = 5.0) -> bool:
        return self.ended.wait(seconds)

    @property
    def header(self) -> SnapshotHeader | None:
        line, _, _ = self.wire.partition(b"\n")
        return parse_header(line + b"\n")

    @property
    def data(self) -> bytes:
        return self.wire.partition(b"\n")[2]

    def close(self) -> None:
        self._end.close()
        self.process_end.close()
        time.sleep(0)
