# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job process's end of the steps channel (#745, live view): it takes the records out of the
feeder every two seconds and hands them to the job host over the descriptor `RUNNER_STEPS_FD`.

Best effort, and never on the turn's path. The pump runs on a thread of its own, its writes are
bounded (a host that does not read costs one write timeout, then the channel is given up), and
the turn, the heartbeat, the lease question and the push never wait for it. What it could not hand
over is counted, and the count is a line in the turn's notes (`finish`).

**Batches are measured as they are sent.** A batch is at most 50 records in at most 48 KiB of the
*escaped* JSON body (`step_wire.py`): a record of control characters is six times its text, so the
size is that of the encoded record, not of its text. A single record that is too large even alone
has its longest texts halved until it fits, with a mark; one that cannot be made to fit is lost and
counted.

**The last flush** (`finish`) comes after the engine's stream has ended, before the result is made:
it hands over what is left and asks the host to say when everything it holds is sent, for at most
the seconds it is given (`FLUSH_SECONDS`, `STOP_FLUSH_SECONDS`; they are in the sums of the end of
the turn, `session.py`). A finished run then shows all its steps; one whose app does not answer
shows what arrived, and the notes say how many records did not.

**No double count.** A record is in exactly one place: dropped by the feeder's full queue (the
feeder counts it), lost on the way to the host or given up in the pump (`lost`), lost by the host
(`U` answer), or left unsent at the end (`pending`). The notes add the last three; the feeder's own
count is `ImplementerAgent.step_notes`.
"""

import contextlib
import logging
import os
import select
import socket
import threading
import time
from collections.abc import Callable, Mapping
from typing import Any, Final

from code_reviewer_runner.implementer.step_feed import StepFeeder
from code_reviewer_runner.implementer.step_records import StepRecord
from code_reviewer_runner.step_wire import (
    ENVELOPE_BYTES,
    MAX_BATCH_RECORDS,
    MAX_BODY_BYTES,
    STEPS_FD_VARIABLE,
    batch_line,
    body_of,
    encode_record,
    flush_line,
    parse_answer,
)

_log = logging.getLogger(__name__)

# How often the feeder is drained.
TICK_SECONDS: Final = 2.0
# What one write to the host may take before the channel is given up.
WRITE_TIMEOUT_SECONDS: Final = 1.0
# The most batches one tick hands over: a burst does not hold the thread for long.
MAX_BATCHES_PER_TICK: Final = 20
# The last flush, all in: the final drain, the host's wait and the answer. The host is told how
# long it may wait and the process keeps `ANSWER_MARGIN_SECONDS` of it to read the answer. Both are
# in the sums of the end of the turn (`session.py`).
FLUSH_SECONDS: Final = 8.0
# A stop (SIGTERM) has less time in all: the flush is shorter.
STOP_FLUSH_SECONDS: Final = 5.0
ANSWER_MARGIN_SECONDS: Final = 1.0
_CUT_MARK: Final = "\n[cut to fit]"
_TEXT_FIELDS: Final = ("text", "input", "error", "title")
_MAX_SHRINKS: Final = 32


class StepPump:
    """Hands the records of a feeder to the job host. One per turn; `start`, then `finish`."""

    def __init__(
        self,
        channel: socket.socket,
        *,
        tick: float = TICK_SECONDS,
        write_timeout: float = WRITE_TIMEOUT_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._channel = channel
        self._tick = tick
        self._write_timeout = write_timeout
        self._clock = clock
        self._feeder: StepFeeder | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        # Guards the channel, the carry and the counts: the thread and `finish` never both write.
        self._lock = threading.Lock()
        self._open = True
        # Records already encoded that did not fit the batch before them.
        self._carry: list[str] = []
        self._lost = 0
        self._batches = 0

    # -- the turn's side ------------------------------------------------------

    def start(self, feeder: StepFeeder) -> None:
        """Begin to drain `feeder`. Safe to call once."""
        if self._feeder is not None:
            return
        self._feeder = feeder
        self._thread = threading.Thread(target=self._run, name="step-pump", daemon=True)
        self._thread.start()

    @property
    def closed(self) -> bool:
        """True once the channel is given up: the host went away, or a write failed or timed out."""
        with self._lock:
            return not self._open

    def finish(self, budget: float) -> tuple[str, ...]:
        """The last flush within `budget` seconds, then the channel is closed. Returns the lines
        for the turn's notes: what could not be sent. Never raises and never takes longer than the
        budget."""
        deadline = self._clock() + budget
        notes: list[str] = []
        try:
            unsent, confirmed = self._flush(deadline)
        except Exception:
            _log.warning("the last flush of the live view failed")
            unsent, confirmed = self._leftover(), False
        finally:
            self._close()
        if unsent:
            notes.append(f"the live view could not send {unsent} step records to the app")
        elif not confirmed and self._batches:
            notes.append("the live view could not confirm that its last step records arrived")
        return tuple(notes)

    # -- the thread ------------------------------------------------------------

    def _run(self) -> None:
        while not self._stop.wait(self._tick):
            try:
                self._hand_over(limit=MAX_BATCHES_PER_TICK, deadline=None)
            except Exception:
                _log.warning("the live view's pump failed; it stops")
                self._give_up()
                return

    def _hand_over(self, *, limit: int, deadline: float | None) -> None:
        """Drain the feeder into batches and write them, the oldest first."""
        with self._lock:
            if self._host_has_gone():
                self._give_up_locked()
            for _ in range(limit):
                if not self._open or (deadline is not None and self._clock() >= deadline):
                    return
                items = self._next_batch()
                if items is None:
                    return
                self._write(items, deadline)

    def _next_batch(self) -> list[str] | None:
        feeder = self._feeder
        if feeder is None:
            return None
        if not self._carry:
            for record in feeder.drain(MAX_BATCH_RECORDS):
                encoded = self._encode(record)
                if encoded is None:
                    self._lost += 1
                else:
                    self._carry.append(encoded)
        count, size = 0, ENVELOPE_BYTES
        for item in self._carry:
            added = len(item) + (1 if count else 0)
            if count >= MAX_BATCH_RECORDS or size + added > MAX_BODY_BYTES:
                break
            count += 1
            size += added
        if count == 0:
            return None
        items = self._carry[:count]
        del self._carry[:count]
        return items

    def _write_seconds(self, deadline: float | None) -> float:
        """A write may take the write timeout, and never past the deadline of the last flush."""
        if deadline is None:
            return self._write_timeout
        return min(self._write_timeout, max(deadline - self._clock(), 0.05))

    def _write(self, items: list[str], deadline: float | None) -> None:
        line = batch_line(len(items), body_of(items))
        try:
            self._channel.settimeout(self._write_seconds(deadline))
            self._channel.sendall(line)
        except OSError:
            # A line cut in the middle would be glued to the next one: the channel is done.
            self._lost += len(items)
            self._give_up_locked()
            return
        self._batches += 1

    @staticmethod
    def _encode(record: StepRecord) -> str | None:
        """The record as it goes in the body, shrunk until it fits alone; None if it cannot."""
        document: dict[str, Any] = record.as_json()
        text = encode_record(document)
        limit = MAX_BODY_BYTES - ENVELOPE_BYTES
        for _ in range(_MAX_SHRINKS):
            if len(text) <= limit:
                return text
            name = max(
                (key for key in _TEXT_FIELDS if isinstance(document.get(key), str)),
                key=lambda key: len(document[key]),
                default=None,
            )
            if name is None or len(document[name]) <= 2 * len(_CUT_MARK):
                return None
            document[name] = document[name][: len(document[name]) // 2] + _CUT_MARK
            text = encode_record(document)
        return None

    def _host_has_gone(self) -> bool:
        """True when the host closed its end (it stopped for good): it never writes unasked."""
        try:
            readable, _, _ = select.select([self._channel], [], [], 0)
            return bool(readable) and self._channel.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    # -- the end ---------------------------------------------------------------

    def _flush(self, deadline: float) -> tuple[int, bool]:
        """Stop the thread, hand over the rest and ask the host to confirm. Returns the records
        that could not be sent and whether the host answered."""
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=max(min(deadline - self._clock(), self._write_timeout + 0.5), 0.0))
        if self._feeder is None:
            return 0, True
        self._hand_over(limit=1_000_000, deadline=deadline - ANSWER_MARGIN_SECONDS)
        with self._lock:
            if not self._open:
                return self._leftover_locked(), False
            wait = max(deadline - self._clock() - ANSWER_MARGIN_SECONDS, 0.0)
            try:
                self._channel.settimeout(self._write_seconds(deadline))
                self._channel.sendall(flush_line(wait))
            except OSError:
                self._give_up_locked()
                return self._leftover_locked(), False
            answered = self._read_answer(deadline)
            if answered is None:
                return self._leftover_locked(), False
            return self._lost + answered + self._pending_locked(), True

    def _read_answer(self, deadline: float) -> int | None:
        """The host's `U <n>` line, or None if it does not come before `deadline`."""
        line = bytearray()
        while len(line) < 32:
            remaining = deadline - self._clock()
            if remaining <= 0:
                return None
            try:
                self._channel.settimeout(remaining)
                byte = self._channel.recv(1)
            except OSError:
                return None
            if not byte:
                return None
            if byte == b"\n":
                return parse_answer(bytes(line))
            line += byte
        return None

    def _leftover(self) -> int:
        with self._lock:
            return self._leftover_locked()

    def _leftover_locked(self) -> int:
        return self._lost + self._pending_locked()

    def _pending_locked(self) -> int:
        feeder = self._feeder
        return len(self._carry) + (0 if feeder is None else feeder.pending)

    def _give_up(self) -> None:
        with self._lock:
            self._give_up_locked()

    def _give_up_locked(self) -> None:
        """The channel is done: what is queued will never leave. The feeder takes no more and its
        queue is counted as lost (not as "not taken in time")."""
        if not self._open:
            return
        self._open = False
        self._lost += len(self._carry)
        self._carry.clear()
        if self._feeder is not None:
            self._lost += self._feeder.close()
        self._shutdown_channel()

    def _close(self) -> None:
        with self._lock:
            self._open = False
            self._shutdown_channel()

    def _shutdown_channel(self) -> None:
        with contextlib.suppress(OSError):
            self._channel.close()


def step_pump_from_environment(environment: Mapping[str, str]) -> StepPump | None:
    """The pump over the descriptor the job host named, or None for a process started without one
    (an app without the feature, a runner of another kind): such a turn records nothing."""
    raw = environment.get(STEPS_FD_VARIABLE)
    if raw is None:
        return None
    try:
        descriptor = int(raw)
        # Not inherited by anything this process starts (the engine must never hold it).
        os.set_inheritable(descriptor, False)
        return StepPump(socket.socket(fileno=descriptor))
    except (OSError, ValueError):
        return None
