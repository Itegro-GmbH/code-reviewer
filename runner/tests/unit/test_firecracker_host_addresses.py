# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's own IPv4 addresses (#979): read from the kernel's table of local addresses, kept for a
while, read again when old, and never forgotten because a read failed."""

from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.firecracker.host_addresses import (
    HostAddresses,
    local_addresses,
)

pytestmark = pytest.mark.unit

# /proc/net/fib_trie as a host with eth0, loopback, a TAP and a second (public) address writes it;
# the same address is in the "Local:" and the "Main:" tables, and a network or broadcast address is
# there with another kind.
FIB_TRIE = """\
Main:
  +-- 0.0.0.0/0 3 0 5
     |-- 0.0.0.0
        /0 universe UNICAST
     +-- 10.0.0.0/24 2 0 2
        |-- 10.0.0.0
           /32 link BROADCAST
           /24 link UNICAST
        |-- 10.0.0.5
           /32 host LOCAL
        |-- 10.0.0.255
           /32 link BROADCAST
     +-- 127.0.0.0/8 2 0 2
        +-- 127.0.0.0/31 1 0 0
           |-- 127.0.0.0
              /32 link BROADCAST
              /8 host LOCAL
           |-- 127.0.0.1
              /32 host LOCAL
        |-- 127.255.255.255
           /32 link BROADCAST
     |-- 203.0.113.9
        /32 host LOCAL
Local:
  +-- 0.0.0.0/0 3 0 5
     +-- 10.0.0.0/24 2 0 2
        |-- 10.0.0.5
           /32 host LOCAL
     +-- 127.0.0.0/8 2 0 2
        |-- 127.0.0.1
           /32 host LOCAL
     |-- 172.31.0.1
        /32 host LOCAL
"""


def test_the_local_addresses_are_the_host_local_entries_of_the_kernels_table(
    tmp_path: Path,
) -> None:
    table = tmp_path / "fib_trie"
    table.write_text(FIB_TRIE)

    assert local_addresses(table) == frozenset(
        {"10.0.0.5", "127.0.0.1", "203.0.113.9", "172.31.0.1"}
    )


def test_a_table_that_cannot_be_read_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(OSError):
        local_addresses(tmp_path / "missing")


def test_a_table_with_no_local_address_is_an_error_not_an_empty_list(tmp_path: Path) -> None:
    # Every machine has at least its loopback: nothing found means this was not the table.
    table = tmp_path / "fib_trie"
    table.write_text("Main:\n  +-- 0.0.0.0/0 3 0 5\n")

    with pytest.raises(OSError, match="no local address"):
        local_addresses(table)


def test_the_addresses_are_read_once_and_again_only_when_old() -> None:
    now = [0.0]
    reads: list[int] = []

    def read() -> frozenset[str]:
        reads.append(1)
        return frozenset({"192.0.2.1"})

    addresses = HostAddresses(read, clock=lambda: now[0], max_age=30.0)

    assert addresses.contains("192.0.2.1") and addresses.contains("192.0.2.1")
    assert len(reads) == 1
    now[0] = 29.9
    addresses.contains("192.0.2.1")
    assert len(reads) == 1
    now[0] = 30.0
    addresses.contains("192.0.2.1")
    assert len(reads) == 2


def test_refresh_reads_at_once_and_raises_when_it_cannot() -> None:
    def broken() -> frozenset[str]:
        raise OSError("no table")

    with pytest.raises(OSError):
        HostAddresses(broken).refresh()


def test_an_address_that_is_not_listed_is_not_the_hosts() -> None:
    addresses = HostAddresses(lambda: frozenset({"192.0.2.1"}))

    assert not addresses.contains("192.0.2.2") and not addresses.contains("garbage")
