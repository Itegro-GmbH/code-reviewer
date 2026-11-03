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
the edge: `MemoryGuard` calls `on_low` when less than `floor_bytes()` is left, and again about every
half second while it stays below the floor and the container has not ended (a kill that failed once
must not leave the VM to the flood). The floor is 512 MiB or 8% of the VM's memory, whichever is
more (`contracts/environment-sizes.v1.json`, `memoryGuard`: the Dispatcher's `agentMemoryMb`
takes the part of the floor above 512 MiB off the agent's share, so that an agent inside its own
limit cannot bring the VM below it; a test holds the two together); a flood eats about 1 GB a
second, and a kill takes a fraction of that. The guard keeps looking after it has fired and
records the lowest value it saw (`lowest_left`), which is what the attack test reports.

What is "left" is `MemFree` plus the page cache of files, **not `MemAvailable`**: the kernel
counts the `struct file` of every open file as reclaimable slab (2.3 GB of 7.8 GB of slab in the
flood above), and an open file cannot be reclaimed, so `MemAvailable` still said 2.2 GB at the
moment the VM's OOM killer ran.
"""

import logging
import threading
import time
from collections.abc import Callable
from typing import Final

_log = logging.getLogger(__name__)

MEMINFO: Final = "/proc/meminfo"
POLL_SECONDS: Final = 0.1
# How often `on_low` is repeated while the VM stays below the floor and the container is not gone.
RETRY_SECONDS: Final = 0.5
# Consecutive reads of `/proc/meminfo` that fail before one line says so (5 s at the poll rate).
UNREADABLE_LOG_AFTER: Final = 50
FLOOR_MIN_BYTES: Final = 512 * 1024 * 1024
FLOOR_FRACTION: Final = 0.08
# The word a turn's end carries when the guard killed the container (the start of its sentence, so a
# log and a reader tell it from the container's own memory limit).
REASON_VM_MEMORY: Final = "vm_memory"


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
    """A thread that calls `on_low(left_bytes)` when the VM has less memory left than the floor, and
    repeats the call every `retry_seconds` while that stays so and `ended` is not set (the
    container is gone when it is). A call that raises is logged and tried again. It keeps looking
    until `close()`, so `lowest_left` is the least the VM had, also after the kill. A file that
    cannot be read is no news (one line in the log after `unreadable_after` reads in a row)."""

    def __init__(
        self,
        on_low: Callable[[int], None],
        *,
        path: str = MEMINFO,
        interval: float = POLL_SECONDS,
        retry_seconds: float = RETRY_SECONDS,
        unreadable_after: int = UNREADABLE_LOG_AFTER,
        ended: threading.Event | None = None,
    ) -> None:
        self._on_low = on_low
        self._path = path
        self._interval = interval
        self._retry_seconds = retry_seconds
        self._unreadable_after = unreadable_after
        self._ended = ended
        self._closed = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        # The first value below the floor, and the least value seen at all (bytes).
        self.tripped_at: int | None = None
        self.lowest_left: int | None = None
        self.calls = 0
        self.failures = 0

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._closed.set()

    def _run(self) -> None:
        unreadable = 0
        last_call = float("-inf")
        while not self._closed.wait(self._interval):
            read = read_memory(self._path)
            if read is None:
                unreadable += 1
                if unreadable == self._unreadable_after:
                    _log.warning(
                        "the VM's memory could not be read %d times in a row: the guard is blind",
                        unreadable,
                    )
                continue
            unreadable = 0
            left, total = read
            if self.lowest_left is None or left < self.lowest_left:
                self.lowest_left = left
            if left >= floor_bytes(total) or (self._ended is not None and self._ended.is_set()):
                continue
            now = time.monotonic()
            if now - last_call < self._retry_seconds:
                continue
            last_call = now
            if self.tripped_at is None:
                self.tripped_at = left
                _log.warning(
                    "the VM has %d MiB of memory left: the container is killed", left >> 20
                )
            self._call(left)

    def _call(self, left: int) -> None:
        self.calls += 1
        try:
            self._on_low(left)
        except Exception:
            self.failures += 1
            if self.failures == 1 or self.failures % 20 == 0:
                _log.exception(
                    "the guard could not kill the container (%d failed calls so far)",
                    self.failures,
                )
