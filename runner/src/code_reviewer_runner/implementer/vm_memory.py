# SPDX-License-Identifier: LicenseRef-Proprietary

"""The VM's memory, watched from Control while the agent runs (#745, step 6).

The memory limit of the agent's container counts what the agent's processes use, but not all of
what the kernel spends on them: a timer, an epoll or an eventfd object costs about 720 bytes, of
which about 260 are not charged to the container's memory cgroup (measured on the VM's kernel
6.18). The table of open files is made too big to fill (`sysbox-prepare.sh`), so a root process
that opens nothing but such objects can take the whole VM's memory before its container reaches
its limit. On a VM with 4 vCPU (8.4 GB, 6 GB for the agent) a flood of them stopped the VM dead
within 12 s. The VM's OOM killer is told to take the agent first (`AGENT_OOM_SCORE_ADJ`), but it
acts only at the edge, and the VM stood still for 50 s before it did.

So Control looks ten times a second at the memory the VM has left and kills the container before
the edge: `MemoryGuard` calls `on_low` once, when less than `floor_bytes()` is left. The floor is
512 MiB or 8% of the VM's memory, whichever is more; a flood eats about 1 GB a second, and a kill
takes a fraction of that.

What is "left" is `MemFree` plus the page cache of files, **not `MemAvailable`**: the kernel
counts the `struct file` of every open file as reclaimable slab (2.3 GB of 7.8 GB of slab in the
flood above), and an open file cannot be reclaimed, so `MemAvailable` still said 2.2 GB at the
moment the VM's OOM killer ran.
"""

import contextlib
import logging
import threading
from collections.abc import Callable
from typing import Final

_log = logging.getLogger(__name__)

MEMINFO: Final = "/proc/meminfo"
POLL_SECONDS: Final = 0.1
FLOOR_MIN_BYTES: Final = 512 * 1024 * 1024
FLOOR_FRACTION: Final = 0.08


LEFT_FIELDS: Final = ("MemFree", "Active(file)", "Inactive(file)")


def read_memory(path: str = MEMINFO) -> tuple[int, int] | None:
    """(what is left, MemTotal) in bytes: `MemFree` and the page cache of files. None when the file
    cannot be read or lacks a field."""
    values: dict[str, int] = {}
    try:
        with open(path, encoding="ascii") as handle:
            for line in handle:
                name, _, rest = line.partition(":")
                if name == "MemTotal" or name in LEFT_FIELDS:
                    values[name] = int(rest.split()[0]) * 1024
    except (OSError, ValueError, IndexError):
        return None
    if "MemTotal" not in values or any(name not in values for name in LEFT_FIELDS):
        return None
    return sum(values[name] for name in LEFT_FIELDS), values["MemTotal"]


def floor_bytes(total: int) -> int:
    return max(FLOOR_MIN_BYTES, int(total * FLOOR_FRACTION))


class MemoryGuard:
    """A thread that calls `on_low(left_bytes)` once, when the VM has less memory left
    than the floor, and ends. `close()` ends it earlier. A file that cannot be read is no news."""

    def __init__(
        self,
        on_low: Callable[[int], None],
        *,
        path: str = MEMINFO,
        interval: float = POLL_SECONDS,
    ) -> None:
        self._on_low = on_low
        self._path = path
        self._interval = interval
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self.tripped_at: int | None = None

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._closed.set()

    def _run(self) -> None:
        while not self._closed.wait(self._interval):
            read = read_memory(self._path)
            if read is None:
                continue
            left, total = read
            if left >= floor_bytes(total):
                continue
            self.tripped_at = left
            _log.warning("the VM has %d MiB of memory left: the container is killed", left >> 20)
            with contextlib.suppress(Exception):
                self._on_low(left)
            return
