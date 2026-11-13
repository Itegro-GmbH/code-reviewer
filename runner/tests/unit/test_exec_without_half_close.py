# SPDX-License-Identifier: LicenseRef-Proprietary

"""Commands in B's Docker without a half-close (#1020).

Control reaches B's Docker through two Incus `proxy` devices, and a device ends the whole
connection, **the daemon's answer included**, when one side shuts down its half: a `docker exec`
whose client says "no more input" with `shutdown(SHUT_WR)` (as `run_exec` did for every command,
with input or without) got an empty answer with exit status 0 (measured on the DevBox, Incus 7.6).
So on that daemon (`DockerApi(half_close=False)`) the end of the input is never sent that way: a
command without input attaches no input, and one with input reads exactly the bytes it was sent."""

import socket
import threading
import time

import pytest

from code_reviewer_runner.implementer.docker_api import AttachedStreams, DockerApi
from code_reviewer_runner.implementer.exec_run import exec_document, framed_argv, run_exec

pytestmark = pytest.mark.unit


class RecordingApi:
    """An Engine API whose exec echoes what the client wrote to the stream and keeps the document
    and the bytes written."""

    def __init__(self, *, half_close: bool) -> None:
        self.half_close = half_close
        self.documents: list[dict[str, object]] = []
        self.written = bytearray()
        self.shutdowns = 0
        self._peer, self._ours = socket.socketpair()

    def create_exec(self, container: str, document: dict[str, object]) -> str:
        self.documents.append(document)
        return "exec-1"

    def attach_exec(self, exec_id: str) -> AttachedStreams:
        peer = self._peer

        def serve() -> None:
            # What the daemon sends: one stdout frame, then the end of the stream; what the client
            # sends is read until it stops (a half-close) or the connection ends.
            peer.sendall(b"\x01\x00\x00\x00\x00\x00\x00\x03abc")
            peer.shutdown(socket.SHUT_WR)
            try:
                while data := peer.recv(65536):
                    self.written += data
            except OSError:
                pass

        threading.Thread(target=serve, daemon=True).start()
        return AttachedStreams(self._ours, b"", half_close=self.half_close)

    def inspect_exec(self, exec_id: str) -> dict[str, object]:
        return {"Running": False, "ExitCode": 0}

    def received(self, length: int) -> bytes:
        """What the daemon's side has read once it has `length` bytes (the reading thread is
        concurrent with the client)."""
        deadline = time.monotonic() + 5.0
        while len(self.written) < length and time.monotonic() < deadline:
            time.sleep(0.01)
        return bytes(self.written)


# #1020-T08
def test_a_command_without_input_attaches_no_input_on_a_daemon_that_cannot_half_close() -> None:
    api = RecordingApi(half_close=False)

    outcome = run_exec(api, "reader", ["/usr/bin/git", "rev-parse", "HEAD"], timeout=5.0)  # type: ignore[arg-type]

    assert outcome.stdout == "abc" and outcome.returncode == 0
    [document] = api.documents
    assert document["AttachStdin"] is False
    assert document["Cmd"] == ["/usr/bin/git", "rev-parse", "HEAD"]


# #1020-T08
def test_a_command_with_input_reads_exactly_its_length_and_the_stream_is_not_half_closed() -> None:
    api = RecordingApi(half_close=False)

    outcome = run_exec(api, "reader", ["/bin/cat"], stdin=b"hello\0world", timeout=5.0)  # type: ignore[arg-type]

    assert outcome.stdout == "abc"
    [document] = api.documents
    assert document["AttachStdin"] is True
    assert document["Cmd"] == framed_argv(["/bin/cat"], 11)
    assert api.received(11) == b"hello\0world"


# #1020-T08
def test_input_that_is_produced_in_parts_is_collected_before_the_command_is_made() -> None:
    api = RecordingApi(half_close=False)

    run_exec(api, "reader", ["/bin/cat"], stdin=iter([b"ab", b"cd"]), timeout=5.0)  # type: ignore[arg-type]

    assert api.documents[0]["Cmd"] == framed_argv(["/bin/cat"], 4)
    assert api.received(4) == b"abcd"


# #1020-T08
def test_the_framed_command_hands_exactly_that_many_bytes_to_the_command() -> None:
    import subprocess

    argv = framed_argv(["/bin/cat"], 5)

    done = subprocess.run(argv, input=b"12345-and-more", capture_output=True, check=True)

    assert done.stdout == b"12345"
    # The exit status is the command's, not the reader's.
    failing = framed_argv(["/bin/sh", "-c", "cat >/dev/null; exit 7"], 3)
    assert subprocess.run(failing, input=b"abc", check=False).returncode == 7


# #1020-T08
def test_a_daemon_that_can_half_close_still_does_as_before() -> None:
    api = RecordingApi(half_close=True)

    run_exec(api, "reader", ["/bin/cat"], stdin=b"hello", timeout=5.0)  # type: ignore[arg-type]

    [document] = api.documents
    assert document["Cmd"] == ["/bin/cat"] and document["AttachStdin"] is True
    assert api.received(5) == b"hello"


# #1020-T08
def test_the_documents_of_a_daemon_that_can_half_close_have_input_unless_told_otherwise() -> None:
    assert exec_document(["/bin/true"])["AttachStdin"] is True
    assert exec_document(["/bin/true"], attach_stdin=False)["AttachStdin"] is False
    assert DockerApi().half_close is True and DockerApi(half_close=False).half_close is False
