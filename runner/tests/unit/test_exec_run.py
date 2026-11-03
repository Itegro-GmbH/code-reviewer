# SPDX-License-Identifier: LicenseRef-Proprietary

"""A command that goes silent and never ends must not hold the runner for longer than its time limit
(#745, step 6).

`run_exec` ends a command that has run out of time by closing the connection of its streams from a
timer thread. On Linux, closing a socket does not wake a thread that is already waiting in `recv()`
on it, so the limit did not hold for a command that prints nothing and does not exit: a `git add`
that reads a FIFO the agent planted where git reads its config, a clean filter that sleeps, a file
of a terabyte to hash. The final commit and the final push of a turn waited for it for ever, and the
agent's work was lost with the VM."""

import socket
import threading
import time

from code_reviewer_runner.implementer.docker_api import AttachedStreams
from code_reviewer_runner.implementer.exec_run import run_exec


class SilentApi:
    """An Engine API whose exec attaches to a socket nothing ever writes to, and whose command
    never ends."""

    def __init__(self) -> None:
        self.peer, self.ours = socket.socketpair()

    def create_exec(self, container: str, document: dict[str, object]) -> str:
        return "exec-1"

    def attach_exec(self, exec_id: str) -> AttachedStreams:
        return AttachedStreams(self.ours, b"")

    def inspect_exec(self, exec_id: str) -> dict[str, object]:
        return {"Running": True, "ExitCode": 0}


# #745-S6-08
def test_closing_the_streams_ends_a_read_that_waits_for_a_silent_command() -> None:
    api = SilentApi()
    streams = AttachedStreams(api.ours, b"")
    ended = threading.Event()

    def read() -> None:
        list(streams.chunks())
        ended.set()

    threading.Thread(target=read, daemon=True).start()
    time.sleep(0.3)
    assert not ended.is_set(), "the reader is waiting for a command that says nothing"

    streams.close()

    assert ended.wait(5.0), "a close from another thread must wake the read"
    api.peer.close()


# #745-S6-08
def test_a_command_that_prints_nothing_and_does_not_end_is_unanswered_at_its_time_limit() -> None:
    api = SilentApi()

    began = time.monotonic()
    outcome = run_exec(api, "reader", ["/bin/cat", "/fifo"], timeout=0.5)  # type: ignore[arg-type]
    took = time.monotonic() - began

    assert outcome.unanswered and outcome.returncode == 255
    assert took < 10.0, took
    api.peer.close()
