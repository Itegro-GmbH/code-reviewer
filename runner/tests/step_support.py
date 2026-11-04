# SPDX-License-Identifier: LicenseRef-Proprietary

"""Helpers for the tests of the step transport (#745; not a test file): events the feeder turns
into records, and the job host's end of the steps channel played by a thread."""

import json
import socket
import threading
import time
from collections.abc import Callable
from typing import Any

from code_reviewer_runner.implementer.step_feed import StepFeeder
from code_reviewer_runner.redaction import Redactor
from code_reviewer_runner.step_wire import (
    answer_line,
    parse_batch,
    parse_flush,
)

SESSION = "ses_fake"


def new_feeder() -> StepFeeder:
    feeder = StepFeeder(SESSION, Redactor([]))
    feeder.feed(
        {
            "type": "message.updated",
            "properties": {"sessionID": SESSION, "info": {"id": "msg_a", "role": "assistant"}},
        }
    )
    return feeder


def say(feeder: StepFeeder, number: int, text: str = "hello") -> None:
    """One finished assistant text part, which becomes one `text` record."""
    feeder.feed(
        {
            "type": "message.part.updated",
            "properties": {
                "sessionID": SESSION,
                "time": 1_000,
                "part": {
                    "id": f"prt_{number:06d}",
                    "sessionID": SESSION,
                    "messageID": "msg_a",
                    "type": "text",
                    "text": text,
                    "time": {"start": 1, "end": 2},
                },
            },
        }
    )


class HostEnd:
    """The job host's end of a steps channel, played by a thread: it keeps the batches it reads and
    answers a flush with `unsent`. `reads=False` is a host that never reads."""

    def __init__(self, *, unsent: int = 0, answers: bool = True, reads: bool = True) -> None:
        self.process_end, self._end = socket.socketpair()
        self.batches: list[tuple[int, bytes]] = []
        self.flushes: list[float] = []
        self.garbage = 0
        self._unsent = unsent
        self._answers = answers
        self._thread: threading.Thread | None = None
        if reads:
            self._thread = threading.Thread(target=self._serve, daemon=True)
            self._thread.start()

    def _serve(self) -> None:
        reader = self._end.makefile("rb")
        while line := reader.readline():
            batch = parse_batch(line)
            if batch is not None:
                self.batches.append(batch)
                continue
            seconds = parse_flush(line)
            if seconds is None:
                self.garbage += 1
                continue
            self.flushes.append(seconds)
            if self._answers:
                self._end.sendall(answer_line(self._unsent))

    def close(self) -> None:
        self._end.close()
        self.process_end.close()

    @property
    def records(self) -> list[dict[str, Any]]:
        """Every record of every batch, in the order they came."""
        return [
            record
            for _, body in self.batches
            for record in json.loads(body.decode("ascii"))["records"]
        ]


def wait_until(condition: Callable[[], bool], seconds: float = 5.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.01)
    return condition()
