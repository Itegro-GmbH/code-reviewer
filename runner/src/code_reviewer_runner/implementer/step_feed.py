# SPDX-License-Identifier: LicenseRef-Proprietary

"""The feeder that puts the step records of a turn in a bounded queue (#745).

It sits beside the tool-part audit on the engine's event stream (`EventReader`) and is the opposite
of it: the audit fails closed, this is best effort and never in the money path. A record that does
not fit is dropped and counted, an event that cannot be converted raises into the reader, which
counts it and goes on (`EventReader` guards every feeder after the audit). Nothing here ends a turn,
delays the push or touches the ledger.

Nothing leaves the process yet: the queue is what the transport of the next step drains
(`drain`). Until someone does, it holds at most `MAX_QUEUED_RECORDS` records and `MAX_QUEUED_BYTES`
of text, and the oldest go first, so a turn that is watched by nobody costs a fixed amount of
memory.
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

    def feed(self, event: Mapping[str, Any]) -> None:
        record = self._converter.convert(event)
        if record is None:
            return
        with self._lock:
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

    @property
    def dropped(self) -> int:
        """Records that were queued and pushed out by newer ones."""
        with self._lock:
            return self._dropped

    @property
    def shortened(self) -> bool:
        """True once the turn passed its caps and only the tool calls are recorded."""
        return self._converter.shortened
