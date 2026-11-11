# SPDX-License-Identifier: LicenseRef-Proprietary

"""The IPv4 addresses of the machine the outer wall's proxy runs on (#979).

The public-address check refuses private ranges, but a name that resolves to an address of **the
host itself** (its public one, on a machine that has one) is public by range and would let a job's
VM reach the host's own listeners through the proxy. The proxy therefore also refuses every address
the host has. The list is the kernel's own table of local addresses (`/proc/net/fib_trie`, no
command and no privilege), read when the proxy starts and again when it is older than `MAX_AGE`
seconds; an address the host gains later is refused after the next read."""

import logging
import re
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

FIB_TRIE: Final = Path("/proc/net/fib_trie")
MAX_AGE: Final = 30.0
_ADDRESS: Final = re.compile(r"^\s*\|--\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$")
_LOCAL: Final = re.compile(r"^\s*/32 host LOCAL\s*$")


def local_addresses(table: Path = FIB_TRIE) -> frozenset[str]:
    """The addresses the host has, from `table`. Raises `OSError` when it cannot be read or holds
    none (a machine has at least its loopback: a file with none is not the table)."""
    found: set[str] = set()
    last: str | None = None
    for line in table.read_text(encoding="ascii", errors="replace").splitlines():
        match = _ADDRESS.match(line)
        if match is not None:
            last = match.group(1)
        elif _LOCAL.match(line) and last is not None:
            found.add(last)
    if not found:
        raise OSError(f"no local address in {table}")
    return frozenset(found)


class HostAddresses:
    """The host's addresses, kept and refreshed. `contains` is called from the proxy's threads."""

    def __init__(
        self,
        read: Callable[[], frozenset[str]] = local_addresses,
        *,
        clock: Callable[[], float] = time.monotonic,
        max_age: float = MAX_AGE,
    ) -> None:
        self._read = read
        self._clock = clock
        self._max_age = max_age
        self._lock = threading.Lock()
        self._addresses: frozenset[str] = frozenset()
        self._read_at: float | None = None

    def refresh(self) -> None:
        """Read the addresses now. Raises `OSError` when they cannot be read."""
        addresses = self._read()
        with self._lock:
            self._addresses, self._read_at = addresses, self._clock()

    def contains(self, address: str) -> bool:
        with self._lock:
            old = self._read_at is None or self._clock() - self._read_at >= self._max_age
        if old:
            try:
                self.refresh()
            except OSError:
                # The last known list stays (an address is not forgotten because a read failed);
                # the next read is a full age away, so a broken table is not read for every request.
                _log.warning("the addresses of this host could not be read; keeping the last ones")
                with self._lock:
                    self._read_at = self._clock()
        with self._lock:
            return address in self._addresses
