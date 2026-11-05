# SPDX-License-Identifier: LicenseRef-Proprietary

"""Control's own memory, watched from inside its container (#827).

The Implementer's Control container is started with `--oom-score-adj -1000` so that the VM's kernel
never picks it while the agent's container is there (the agent can lower its processes to -999,
not to -1000). The kernel exempts a process with that score from the OOM killer altogether, also
inside the container's own `--memory` limit: a Control that grew without a bound would not be
killed at the limit and end the turn as a container that died (`worker_exited`, free), it would
stall at the limit. So Control bounds itself: this watch reads the container's memory cgroup
(`memory.stat` and `memory.max`) a few times a second and calls `on_high` once when what the
container holds reaches `PERCENT` of its limit on `HITS` looks in a row, and the job process ends
the turn at once with `runner_error` (`agent_gave_up` when the model was billed), the way the OOM
killer used to end it. Ending the turn is the job process printing the result and exiting; it does
not stop the agent's container, the doors or the readers: the VM's teardown ends them, and the
model door's cost cap holds meanwhile.

What the container holds is the memory the kernel cannot give back: `anon + shmem + kernel + sock`
of `memory.stat`. The file cache, active as well as inactive, is not counted: a `git fetch
--fsckObjects` of a big repository fills the cgroup with it up to the limit, and the kernel
reclaims it when it needs the memory. Only a `memory.stat` that lacks one of those keys is read as
`memory.current` without `inactive_file` (the working set as Kubernetes counts it), which still
holds the active cache; that is logged once, and the looks in a row are what stops a short spike
from ending a healthy turn.
"""

import logging
import threading
from collections.abc import Callable
from typing import Final, NamedTuple

_log = logging.getLogger(__name__)

CGROUP: Final = "/sys/fs/cgroup"
POLL_SECONDS: Final = 0.2
# The percent of the container's limit at which Control ends its own turn: well before the limit
# (the allocation that would cross it can be a large one), and above what a Control in order
# holds.
PERCENT: Final = 90
# Looks in a row at or over the line before the turn ends (0.6 s at the poll rate): one spike of
# an allocation that is given back at once is not a runaway.
HITS: Final = 3
# Consecutive reads that fail before one line says so (10 s at the poll rate).
UNREADABLE_LOG_AFTER: Final = 50
# The word the report of the turn starts its detail with, so that a log and a reader tell this end
# from the agent's container memory limit and from the VM's memory (`vm_memory`).
REASON_CONTROL_MEMORY: Final = "control_memory"
# What the kernel cannot give back, as `memory.stat` names it.
_UNRECLAIMABLE: Final = ("anon", "shmem", "kernel", "sock")


class Reading(NamedTuple):
    """What the container holds and its limit (None: `max`), in bytes. `exact` is False when
    `memory.stat` lacked a key and the file cache that is active is inside `used`."""

    used: int
    limit: int | None
    exact: bool


def _text(path: str) -> str | None:
    try:
        with open(path, encoding="ascii") as handle:
            return handle.read().strip()
    except (OSError, ValueError):
        return None


def _stat(path: str) -> dict[str, int] | None:
    try:
        with open(path, encoding="ascii") as handle:
            lines = handle.readlines()
    except (OSError, ValueError):
        return None
    values: dict[str, int] = {}
    for line in lines:
        name, _, rest = line.partition(" ")
        if rest.strip().isdigit():
            values[name] = int(rest)
    return values


def read_working_set(directory: str = CGROUP) -> Reading | None:
    """What the container holds that the kernel cannot give back, and its limit. None when a file
    cannot be read (counting a missing number as zero would end a turn for a cache or miss a
    runaway)."""
    limit_text = _text(f"{directory}/memory.max")
    stat = _stat(f"{directory}/memory.stat")
    if limit_text is None or stat is None:
        return None
    limit = None if limit_text == "max" else int(limit_text) if limit_text.isdigit() else -1
    if limit is not None and limit <= 0:
        return None
    if all(name in stat for name in _UNRECLAIMABLE):
        return Reading(sum(stat[name] for name in _UNRECLAIMABLE), limit, exact=True)
    current_text = _text(f"{directory}/memory.current")
    if current_text is None or not current_text.isdigit() or "inactive_file" not in stat:
        return None
    return Reading(max(int(current_text) - stat["inactive_file"], 0), limit, exact=False)


class ControlMemoryWatch:
    """Calls `on_high(used, limit)` once, from its own thread, when what the container holds that
    the kernel cannot give back stays at `percent` of its limit for `hits` looks in a row.
    `highest` is the most it saw; `fired` says it was called; `closed` that it was closed."""

    def __init__(
        self,
        on_high: Callable[[int, int], None],
        directory: str = CGROUP,
        interval: float = POLL_SECONDS,
        *,
        percent: int = PERCENT,
        hits: int = HITS,
        unreadable_after: int = UNREADABLE_LOG_AFTER,
    ) -> None:
        self._on_high = on_high
        self._directory = directory
        self._interval = interval
        self._percent = percent
        self._hits = hits
        self._unreadable_after = unreadable_after
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._run, name="control-memory", daemon=True)
        self.highest: int | None = None
        self.fired = False

    @property
    def closed(self) -> bool:
        return self._closed.is_set()

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._closed.set()

    def _read(self) -> Reading | None:
        return read_working_set(self._directory)

    def _run(self) -> None:
        unreadable = 0
        high = 0
        said_no_limit = said_fallback = False
        while not self._closed.wait(self._interval):
            read = self._read()
            if read is None:
                high = 0
                unreadable += 1
                if unreadable == self._unreadable_after:
                    _log.warning(
                        "Control's memory could not be read %d times in a row: the watch is blind",
                        unreadable,
                    )
                continue
            unreadable = 0
            used, limit = read.used, read.limit
            if not read.exact and not said_fallback:
                said_fallback = True
                _log.warning(
                    "memory.stat of Control's container lacks anon, shmem, kernel or sock: "
                    "counting memory.current without inactive_file, which includes the active "
                    "file cache"
                )
            if self.highest is None or used > self.highest:
                self.highest = used
            if limit is None:
                high = 0
                if not said_no_limit:
                    said_no_limit = True
                    _log.info("the memory of Control's container has no limit: nothing is watched")
                continue
            if used * 100 < limit * self._percent:
                high = 0
                continue
            high += 1
            if high < self._hits:
                continue
            if self._closed.is_set():
                return
            self.fired = True
            _log.error("Control holds %d of %d MiB: its turn is ended", used >> 20, limit >> 20)
            try:
                self._on_high(used, limit)
            except Exception:
                _log.exception("Control's memory watch could not end the turn")
            return
