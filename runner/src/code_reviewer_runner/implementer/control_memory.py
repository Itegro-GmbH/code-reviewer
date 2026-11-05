# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control's own memory, watched from inside its container (#827).

The Implementer's Control container is started with `--oom-score-adj -1000` so that the VM's kernel
never picks it while the agent's container is there (the agent can lower its processes to -999,
not to -1000). The kernel exempts a process with that score from the OOM killer altogether, also
inside the container's own `--memory` limit: a Control that grew without a bound would not be
killed at the limit and end the turn as a container that died (`worker_exited`, free), it would
stall at the limit. So Control bounds itself: this watch reads the container's memory cgroup
(`memory.current` and `memory.max`) a few times a second and calls `on_high` once when what the
container holds reaches `PERCENT` of its limit, and the job process ends the turn at once with
`runner_error` (`agent_gave_up` when the model was billed), the way the OOM killer used to end it.

What the container holds is `memory.current` without the inactive file cache (the working set, as
Kubernetes counts it): the kernel gives the cache back when it needs the memory, and a Control that
read many files is not a runaway.
"""

import logging
import threading
from collections.abc import Callable
from typing import Final

_log = logging.getLogger(__name__)

CGROUP: Final = "/sys/fs/cgroup"
POLL_SECONDS: Final = 0.2
# The percent of the container's limit at which Control ends its own turn: well before the limit
# (the allocation that would cross it can be a large one), and above what a Control in order
# holds.
PERCENT: Final = 90
# Consecutive reads that fail before one line says so (10 s at the poll rate).
UNREADABLE_LOG_AFTER: Final = 50
# The word the report of the turn starts its detail with, so that a log and a reader tell this end
# from the agent's container memory limit and from the VM's memory (`vm_memory`).
REASON_CONTROL_MEMORY: Final = "control_memory"


def _number(path: str) -> int | None:
    try:
        with open(path, encoding="ascii") as handle:
            text = handle.read().strip()
    except (OSError, ValueError):
        return None
    return int(text) if text.isdigit() else None


def _inactive_file(path: str) -> int | None:
    try:
        with open(path, encoding="ascii") as handle:
            for line in handle:
                name, _, rest = line.partition(" ")
                if name == "inactive_file" and rest.strip().isdigit():
                    return int(rest)
    except (OSError, ValueError):
        return None
    return None


def read_working_set(directory: str = CGROUP) -> tuple[int, int] | None:
    """(what the container holds, its limit) in bytes. None when a file cannot be read, when the
    limit is `max` (nothing to bound) or when the file cache cannot be had (counting it as zero
    would end a turn for a cache)."""
    current = _number(f"{directory}/memory.current")
    limit = _number(f"{directory}/memory.max")
    cache = _inactive_file(f"{directory}/memory.stat")
    if current is None or limit is None or cache is None or limit <= 0:
        return None
    return max(current - cache, 0), limit


class ControlMemoryWatch:
    """Calls `on_high(used, limit)` once, from its own thread, when the container's working set
    reaches `percent` of its limit. `highest` is the most it saw; `fired` says it was called."""

    def __init__(
        self,
        on_high: Callable[[int, int], None],
        directory: str = CGROUP,
        interval: float = POLL_SECONDS,
        *,
        percent: int = PERCENT,
        unreadable_after: int = UNREADABLE_LOG_AFTER,
    ) -> None:
        self._on_high = on_high
        self._directory = directory
        self._interval = interval
        self._percent = percent
        self._unreadable_after = unreadable_after
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._run, name="control-memory", daemon=True)
        self.highest: int | None = None
        self.fired = False

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._closed.set()

    def _run(self) -> None:
        unreadable = 0
        while not self._closed.wait(self._interval):
            read = read_working_set(self._directory)
            if read is None:
                unreadable += 1
                if unreadable == self._unreadable_after:
                    _log.warning(
                        "Control's memory could not be read %d times in a row: the watch is blind",
                        unreadable,
                    )
                continue
            unreadable = 0
            used, limit = read
            if self.highest is None or used > self.highest:
                self.highest = used
            if used * 100 < limit * self._percent:
                continue
            self.fired = True
            _log.error("Control holds %d of %d MiB: its turn is ended", used >> 20, limit >> 20)
            try:
                self._on_high(used, limit)
            except Exception:
                _log.exception("Control's memory watch could not end the turn")
            return
