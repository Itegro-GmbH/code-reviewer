# SPDX-License-Identifier: LicenseRef-Proprietary

"""`MemoryGuard` (#745, step 6): the VM's available memory is read from a file, the floor is the
larger of 512 MiB and 8%, the callback runs once when less is available, and an unreadable file is
no news."""

import threading
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.vm_memory import (
    MemoryGuard,
    floor_bytes,
    read_memory,
)

MIB = 1024 * 1024


def meminfo(path: Path, *, available_mib: int, total_mib: int = 8192) -> None:
    """`available_mib` is what is left: free memory and page cache of files. MemAvailable says
    something else on purpose (the kernel counts the structures of open files as reclaimable)."""
    total, free, cache = total_mib * 1024, (available_mib - 10) * 1024, 5 * 1024
    path.write_text(
        f"MemTotal: {total} kB\nMemFree: {free} kB\nMemAvailable: {total} kB\n"
        f"Active(file): {cache} kB\nInactive(file): {cache} kB\n"
    )


@pytest.mark.unit
def test_the_floor_is_512_mib_or_eight_percent_whichever_is_more() -> None:
    assert floor_bytes(4 * 1024 * MIB) == 512 * MIB  # 8% of 4 GiB is 328 MiB
    assert floor_bytes(8 * 1024 * MIB) == int(8 * 1024 * MIB * 0.08)  # 655 MiB
    assert floor_bytes(16 * 1024 * MIB) > floor_bytes(8 * 1024 * MIB)


@pytest.mark.unit
def test_memory_is_read_in_bytes_and_a_file_without_the_fields_is_none(tmp_path: Path) -> None:
    meminfo(tmp_path / "a", available_mib=100)
    assert read_memory(str(tmp_path / "a")) == (100 * MIB, 8192 * MIB)
    (tmp_path / "b").write_text("MemTotal: 1 kB\nMemFree: 1 kB\nMemAvailable: 1 kB\n")
    assert read_memory(str(tmp_path / "b")) is None
    (tmp_path / "c").write_text(
        "MemTotal: x kB\nMemFree: 1 kB\nActive(file): 1 kB\nInactive(file): 1 kB\n"
    )
    assert read_memory(str(tmp_path / "c")) is None
    assert read_memory(str(tmp_path / "missing")) is None


@pytest.mark.unit
def test_the_guard_calls_back_once_when_less_than_the_floor_is_available(tmp_path: Path) -> None:
    path = tmp_path / "meminfo"
    meminfo(path, available_mib=4000)
    called: list[int] = []
    done = threading.Event()

    def low(available: int) -> None:
        called.append(available)
        done.set()

    guard = MemoryGuard(low, path=str(path), interval=0.01)
    guard.start()
    assert not done.wait(0.1), "4000 MiB of 8192 is plenty"
    meminfo(path, available_mib=600)  # a floor of 655 MiB
    assert done.wait(2.0)
    meminfo(path, available_mib=100)
    done.clear()
    assert not done.wait(0.1), "once"
    assert called == [600 * MIB] and guard.tripped_at == 600 * MIB


@pytest.mark.unit
def test_an_unreadable_file_is_no_news_and_a_closed_guard_does_not_call(tmp_path: Path) -> None:
    path = tmp_path / "meminfo"
    called: list[int] = []
    guard = MemoryGuard(called.append, path=str(path), interval=0.01)
    guard.start()
    threading.Event().wait(0.1)
    assert called == [] and guard.tripped_at is None
    guard.close()
    meminfo(path, available_mib=1)
    threading.Event().wait(0.1)
    assert called == []


@pytest.mark.unit
def test_a_callback_that_fails_does_not_end_the_program(tmp_path: Path) -> None:
    path = tmp_path / "meminfo"
    meminfo(path, available_mib=1)

    def broken(_: int) -> None:
        raise RuntimeError("no")

    guard = MemoryGuard(broken, path=str(path), interval=0.01)
    guard.start()
    for _ in range(100):
        if guard.tripped_at is not None:
            break
        threading.Event().wait(0.02)
    assert guard.tripped_at == MIB
