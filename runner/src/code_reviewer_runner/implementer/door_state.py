# SPDX-License-Identifier: LicenseRef-Proprietary

"""What Control knows of its model door at any moment (#745, step 3): the last status line the door
wrote, and how the door ended if it did. The reader thread of the launcher writes it; the ledger
and the session read it. Thread-safe."""

import threading
from dataclasses import dataclass

from code_reviewer_runner.dynamic_review.budget import LimitError
from code_reviewer_runner.result import ErrorCode

from .door.protocol import DoorStatus


@dataclass(frozen=True)
class DoorEnd:
    """How the door's container ended: the exit code Docker reports (None: not read), and whether
    the kernel killed it for its memory."""

    exit_code: int | None
    out_of_memory: bool
    # False for an end that Control asked for (stop), True for a door that went away by itself.
    unexpected: bool

    def sentence(self) -> str:
        how = "the container was killed for its memory" if self.out_of_memory else "the container"
        code = "" if self.exit_code is None else f" (exit code {self.exit_code})"
        return f"the model door ended during the turn: {how} stopped{code}"


class DoorState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status: DoorStatus | None = None
        self._end: DoorEnd | None = None
        self._ready = threading.Event()
        self._refused: str | None = None
        self._said_ready = False

    # -- written by the reader ------------------------------------------------------------------

    def ready(self) -> None:
        with self._lock:
            self._said_ready = True
        self._ready.set()

    def refused(self, reason: str) -> None:
        with self._lock:
            self._refused = reason
        self._ready.set()

    def update(self, status: DoorStatus) -> None:
        with self._lock:
            if self._status is None or status.seq >= self._status.seq:
                self._status = status

    def ended(self, end: DoorEnd) -> None:
        with self._lock:
            if self._end is None:
                self._end = end
        self._ready.set()

    # -- read -----------------------------------------------------------------------------------

    def wait_ready(self, seconds: float) -> bool:
        return self._ready.wait(seconds)

    @property
    def is_ready(self) -> bool:
        """The door said `ready` (a refusal or an end also wakes the wait, and is not this)."""
        with self._lock:
            return self._said_ready

    @property
    def status(self) -> DoorStatus | None:
        with self._lock:
            return self._status

    @property
    def end(self) -> DoorEnd | None:
        with self._lock:
            return self._end

    @property
    def refusal(self) -> str | None:
        with self._lock:
            return self._refused

    @property
    def lost(self) -> DoorEnd | None:
        """The end of a door that went away by itself, else None."""
        end = self.end
        return end if end is not None and end.unexpected else None

    @property
    def model_used(self) -> bool:
        """Whether the model was used, as far as Control can know: the door said so, a call was
        open when it last spoke, or the door is gone with no word of its own about it."""
        status = self.status
        return status is not None and (status.model_used or status.open_calls > 0)

    @property
    def cost_unknown(self) -> bool:
        """A door that went away with a call open: the call may have been billed and nobody saw
        what it cost."""
        status = self.status
        return self.lost is not None and status is not None and status.open_calls > 0

    def failure(self) -> LimitError | None:
        """What stopped the turn at the door, in the ledger's own type: the door's own recorded
        failure first (the cost limit, the clock, a refusal of the provider), else the loss of the
        door itself. A turn is not stopped by a door that Control stopped."""
        status = self.status
        if status is not None and status.failure is not None:
            try:
                code = ErrorCode(status.failure.code)
            except ValueError:
                code = ErrorCode.RUNNER_ERROR
            return LimitError(code, status.failure.detail)
        lost = self.lost
        if lost is not None:
            return LimitError(ErrorCode.RUNNER_ERROR, lost.sentence())
        return None

    @property
    def upstream_error(self) -> ErrorCode | None:
        """The code of the provider's last failed call, as the door's proxy kept it. None once the
        door itself is gone: then the door is the cause, not the provider."""
        status = self.status
        if status is None or status.upstream_error is None or self.lost is not None:
            return None
        try:
            return ErrorCode(status.upstream_error)
        except ValueError:
            return None
