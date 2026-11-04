# SPDX-License-Identifier: LicenseRef-Proprietary

"""The feeder that puts the step records of a turn in a bounded queue (#745).

It sits beside the tool-part audit on the engine's event stream (`EventReader`) and is the opposite
of it: the audit fails closed, this is best effort and never in the money path. A record that does
not fit is dropped and counted, an event that cannot be converted raises into the reader, which
counts it and goes on (`EventReader` guards every feeder after the audit). Both counts are one line
in the turn's notes at its end (`ImplementerAgent.step_notes`). Nothing here ends a turn,
delays the push or touches the ledger.

The queue is what the pump of the job process drains (`drain`, `step_pump.py`) to the job host,
which sends it to the app. Until it is drained it holds at most `MAX_QUEUED_RECORDS` records and
`MAX_QUEUED_BYTES` of text, and the oldest go first, so a turn that is watched by nobody costs a
fixed amount of memory. A feeder that was `close`d (the host stopped for good) takes nothing more
and counts nothing: a record that is never going to leave is not a record "not taken in time".
"""

import threading
from collections import deque
from collections.abc import Mapping
from typing import Any, Final

from code_reviewer_runner.implementer.step_records import StepConverter, StepRecord
from code_reviewer_runner.redaction import Redactor

MAX_QUEUED_RECORDS: Final = 1_000
MAX_QUEUED_BYTES: Final = 1024 * 1024


class StepFeeder:
    """Converts the events of one session and queues the records. `feed` is called by the reader's
    thread, `drain` by another."""

    def __init__(self, session_id: str, redactor: Redactor) -> None:
        self._converter = StepConverter(session_id, redactor)
        self._lock = threading.Lock()
        self._queue: deque[StepRecord] = deque()
        self._queued_bytes = 0
        self._dropped = 0
        self._closed = False

    def feed(self, event: Mapping[str, Any]) -> None:
        if self._closed:
            return
        record = self._converter.convert(event)
        if record is None:
            return
        with self._lock:
            if self._closed:
                return
            self._queue.append(record)
            self._queued_bytes += record.weight
            while len(self._queue) > MAX_QUEUED_RECORDS or self._queued_bytes > MAX_QUEUED_BYTES:
                self._queued_bytes -= self._queue.popleft().weight
                self._dropped += 1

    def drain(self, limit: int) -> list[StepRecord]:
        """Take up to `limit` records, the oldest first."""
        with self._lock:
            taken = [self._queue.popleft() for _ in range(min(limit, len(self._queue)))]
            self._queued_bytes -= sum(record.weight for record in taken)
            return taken

    def close(self) -> int:
        """Take nothing more and empty the queue; returns how many queued records are given up."""
        with self._lock:
            self._closed = True
            given_up = len(self._queue)
            self._queue.clear()
            self._queued_bytes = 0
            return given_up

    @property
    def pending(self) -> int:
        """Records queued and not yet drained."""
        with self._lock:
            return len(self._queue)

    @property
    def dropped(self) -> int:
        """Records that were queued and pushed out by newer ones."""
        with self._lock:
            return self._dropped

    @property
    def shortened(self) -> bool:
        """True once the turn passed its caps and only the tool calls are recorded."""
        return self._converter.shortened
