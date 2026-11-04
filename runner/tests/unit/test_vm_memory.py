# SPDX-License-Identifier: LicenseRef-Proprietary

"""`MemoryGuard` (#745, step 6): the VM's available memory is read from a file, the floor is the
larger of 512 MiB and 8%, the callback runs once when less is available, and an unreadable file is
no news."""

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.vm_memory import (
    FLOOR_FRACTION,
    FLOOR_MIN_BYTES,
    REASON_VM_MEMORY,
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


def wait_until(condition: Callable[[], bool], seconds: float = 3.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.01)
    return condition()


# #745-T07: a kill that failed is tried again, every retry interval, as long as the VM stays below
# the floor and the container has not ended
@pytest.mark.unit
def test_a_callback_that_fails_is_logged_and_tried_again(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "meminfo"
    meminfo(path, available_mib=1)
    attempts: list[int] = []

    def broken(left: int) -> None:
        attempts.append(left)
        if len(attempts) < 3:
            raise RuntimeError("no")

    guard = MemoryGuard(broken, path=str(path), interval=0.005, retry_seconds=0.02)
    with caplog.at_level("ERROR"):
        guard.start()
        assert wait_until(lambda: len(attempts) >= 5)
    guard.close()
    assert guard.tripped_at == MIB and guard.failures == 2
    assert [r.levelname for r in caplog.records].count("ERROR") == 1, "the first failure is logged"
    assert "could not kill the container" in caplog.text


@pytest.mark.unit
def test_the_call_is_repeated_while_the_memory_stays_low_and_stops_when_the_container_ended(
    tmp_path: Path,
) -> None:
    path = tmp_path / "meminfo"
    meminfo(path, available_mib=100)
    attempts: list[int] = []
    ended = threading.Event()
    guard = MemoryGuard(
        attempts.append, path=str(path), interval=0.005, retry_seconds=0.03, ended=ended
    )
    guard.start()
    assert wait_until(lambda: len(attempts) >= 4), "repeated about every retry interval"
    ended.set()
    time.sleep(0.05)
    settled = len(attempts)
    time.sleep(0.15)
    assert len(attempts) == settled, "nothing more once the container is gone"
    guard.close()


@pytest.mark.unit
def test_the_call_is_not_repeated_once_the_memory_is_back_above_the_floor(tmp_path: Path) -> None:
    path = tmp_path / "meminfo"
    meminfo(path, available_mib=100)
    attempts: list[int] = []
    guard = MemoryGuard(attempts.append, path=str(path), interval=0.005, retry_seconds=0.02)
    guard.start()
    assert wait_until(lambda: len(attempts) >= 2)
    meminfo(path, available_mib=4000)
    time.sleep(0.06)
    settled = len(attempts)
    time.sleep(0.15)
    assert len(attempts) == settled
    guard.close()


# #745-T08: the guard keeps looking after it fired, so the report has the least memory the VM had
@pytest.mark.unit
def test_the_lowest_memory_seen_is_kept_after_the_guard_fired(tmp_path: Path) -> None:
    path = tmp_path / "meminfo"
    meminfo(path, available_mib=3000)
    fired = threading.Event()
    guard = MemoryGuard(lambda _: fired.set(), path=str(path), interval=0.005)
    guard.start()
    assert wait_until(lambda: guard.lowest_left == 3000 * MIB)
    meminfo(path, available_mib=400)
    assert fired.wait(2.0)
    meminfo(path, available_mib=90)  # lower, after the call
    assert wait_until(lambda: guard.lowest_left == 90 * MIB)
    meminfo(path, available_mib=6000)  # the kill gave the memory back
    time.sleep(0.05)
    guard.close()
    assert guard.tripped_at == 400 * MIB and guard.lowest_left == 90 * MIB


# #745-T09: a file that cannot be read for a while is said once, not at every look
@pytest.mark.unit
def test_an_unreadable_file_is_logged_once_after_many_reads_in_a_row(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "meminfo"
    guard = MemoryGuard(lambda _: None, path=str(path), interval=0.002, unreadable_after=5)
    with caplog.at_level("WARNING"):
        guard.start()
        assert wait_until(lambda: "guard is blind" in caplog.text)
        time.sleep(0.1)
    assert caplog.text.count("guard is blind") == 1
    meminfo(path, available_mib=4000)  # readable again
    assert wait_until(lambda: guard.lowest_left == 4000 * MIB)
    guard.close()


# #745-T10: the floor is the figure of the contract the Dispatcher's agent memory is computed from
@pytest.mark.unit
def test_the_floor_is_the_one_the_dispatcher_takes_off_the_agents_memory() -> None:
    contract = json.loads(
        (Path(__file__).parents[3] / "contracts" / "environment-sizes.v1.json").read_text()
    )
    assert contract["memoryGuard"]["minFloorMb"] * MIB == FLOOR_MIN_BYTES
    assert contract["memoryGuard"]["floorPercent"] / 100 == FLOOR_FRACTION
    per_vcpu = contract["memoryPerVcpuMb"]
    headroom = 512  # the OS's room, `IMPLEMENTER_VM_HEADROOM_MB`
    others = 768 + 256 + 96 + 2 * 256  # Control, the model door, the network door, both readers
    assert contract["networkDoorMemoryMb"] == 96
    for vcpus in contract["environmentVcpus"]:
        ram = vcpus * per_vcpu
        floor_mb = -(-floor_bytes(ram * MIB) // MIB)  # up
        # the agent's limit, the others' limits and the guard's floor (the OS's room is the floor
        # of 2 vCPU) fit in the VM at every size
        agent = contract["agentMemoryMb"][str(vcpus)]
        assert agent + others + max(headroom, floor_mb) <= ram, vcpus


@pytest.mark.unit
def test_a_guard_kill_starts_the_sentence_of_the_turns_end_with_its_reason_word() -> None:
    from code_reviewer_runner.implementer.agent_container import AgentEnd

    ended = AgentEnd(137, False, True, vm_memory=True).sentence()
    assert ended.startswith(f"{REASON_VM_MEMORY}: the agent's container ended during the turn")
    assert "running out of memory" in ended
    assert REASON_VM_MEMORY not in AgentEnd(137, True, True).sentence()


# #745, step 7: the network door's limit is the figure the Dispatcher takes off the agent's memory
@pytest.mark.unit
def test_the_network_doors_limit_is_the_figure_of_the_contract() -> None:
    from code_reviewer_runner.implementer.netdoor_launcher import (
        NETDOOR_MEMORY_BYTES,
        NETDOOR_MEMORY_MB,
        door_document,
    )

    contract = json.loads(
        (Path(__file__).parents[3] / "contracts" / "environment-sizes.v1.json").read_text()
    )
    assert contract["networkDoorMemoryMb"] == NETDOOR_MEMORY_MB
    assert NETDOOR_MEMORY_BYTES == NETDOOR_MEMORY_MB * MIB
    host = door_document("sha256:x")["HostConfig"]
    assert host["Memory"] == host["MemorySwap"] == NETDOOR_MEMORY_BYTES
