# SPDX-License-Identifier: LicenseRef-Proprietary

"""`ControlMemoryWatch` (#827): Control's own container memory is read from the cgroup files, and
the callback runs once when what it holds that the kernel cannot give back (`anon`, `shmem`,
`kernel`, `sock`: no file cache) stays at 90% of the container's limit for several looks in a row.
The kernel never picks Control (`--oom-score-adj -1000`), so this is what ends a Control that
grows without a bound, fast, as the OOM killer used to."""

import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from code_reviewer_runner.implementer import control_memory
from code_reviewer_runner.implementer.control_memory import (
    HITS,
    PERCENT,
    REASON_CONTROL_MEMORY,
    ControlMemoryWatch,
    Reading,
    read_working_set,
)

MIB = 1024 * 1024
pytestmark = pytest.mark.unit


def cgroup(
    directory: Path,
    *,
    anon_mib: float = 0,
    limit_mib: float | None = 768,
    inactive_mib: float = 0,
    active_mib: float = 0,
    shmem_mib: float = 0,
    kernel_mib: float = 0,
    sock_mib: float = 0,
    omit: tuple[str, ...] = (),
) -> None:
    """The files of a container's memory cgroup (v2) the watch reads; `limit_mib` None is "max" (no
    limit). `memory.current` is the sum of what `memory.stat` lists; `omit` leaves keys out of the
    stat (a kernel that does not list them)."""
    parts = {
        "anon": anon_mib,
        "shmem": shmem_mib,
        "kernel": kernel_mib,
        "sock": sock_mib,
        "inactive_file": inactive_mib,
        "active_file": active_mib,
    }
    current = sum(parts.values())
    (directory / "memory.current").write_text(f"{int(current * MIB)}\n")
    (directory / "memory.max").write_text("max\n" if limit_mib is None else f"{limit_mib * MIB}\n")
    lines = [f"{name} {int(mib * MIB)}" for name, mib in parts.items() if name not in omit]
    lines.append(f"file {int((inactive_mib + active_mib + shmem_mib) * MIB)}")
    (directory / "memory.stat").write_text("\n".join(lines) + "\n")


def wait_until(check: Callable[[], bool], seconds: float = 3.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.005)
    return check()


def test_what_the_container_holds_is_what_the_kernel_cannot_give_back(tmp_path: Path) -> None:
    cgroup(
        tmp_path,
        anon_mib=300,
        shmem_mib=20,
        kernel_mib=30,
        sock_mib=10,
        inactive_mib=100,
        active_mib=200,
    )

    assert read_working_set(str(tmp_path)) == Reading(360 * MIB, 768 * MIB, exact=True)


def test_a_stat_without_the_unreclaimable_keys_falls_back_to_current_without_inactive_file(
    tmp_path: Path,
) -> None:
    cgroup(tmp_path, anon_mib=300, inactive_mib=100, active_mib=50, omit=("kernel",))

    assert read_working_set(str(tmp_path)) == Reading(350 * MIB, 768 * MIB, exact=False)


def test_no_limit_reads_as_no_limit_and_unreadable_files_as_none(tmp_path: Path) -> None:
    cgroup(tmp_path, anon_mib=600, limit_mib=None)
    assert read_working_set(str(tmp_path)) == Reading(600 * MIB, None, exact=True)

    (tmp_path / "memory.max").write_text("many\n")
    assert read_working_set(str(tmp_path)) is None

    assert read_working_set(str(tmp_path / "missing")) is None

    cgroup(tmp_path, anon_mib=600)
    (tmp_path / "memory.stat").unlink()
    assert read_working_set(str(tmp_path)) is None, "a stat that cannot be had is not zero"


# #827-S1
def test_the_callback_runs_once_when_the_working_set_stays_at_ninety_percent(
    tmp_path: Path,
) -> None:
    cgroup(tmp_path, anon_mib=300, limit_mib=1000)
    fired: list[tuple[int, int]] = []
    watch = ControlMemoryWatch(
        lambda used, limit: fired.append((used, limit)), str(tmp_path), 0.005
    )
    watch.start()
    assert wait_until(lambda: watch.highest == 300 * MIB)
    assert fired == [] and not watch.fired

    cgroup(tmp_path, anon_mib=900, limit_mib=1000)  # exactly 90%
    assert wait_until(lambda: watch.fired)
    time.sleep(0.05)
    watch.close()

    assert fired == [(900 * MIB, 1000 * MIB)], "once, with what it read"


# #827-S1
def test_file_cache_of_any_kind_is_not_a_runaway(tmp_path: Path) -> None:
    # A `git fetch --fsckObjects` of a big repository: the cgroup sits at its limit, nearly all of
    # it file cache, active as well as inactive.
    cgroup(tmp_path, anon_mib=100, inactive_mib=100, active_mib=560)
    watch = ControlMemoryWatch(
        lambda used, limit: pytest.fail("fired for a cache"), str(tmp_path), 0.005, hits=3
    )
    watch.start()

    assert wait_until(lambda: watch.highest == 100 * MIB)
    time.sleep(0.05)
    watch.close()
    assert not watch.fired


# #827-S1
def test_anon_near_the_limit_trips_only_after_the_hits_in_a_row(tmp_path: Path) -> None:
    cgroup(tmp_path, anon_mib=700, limit_mib=768)
    reads = 0
    fired = threading.Event()

    class Counting(ControlMemoryWatch):
        def _read(self) -> Reading | None:
            nonlocal reads
            reads += 1
            return super()._read()

    watch = Counting(lambda used, limit: fired.set(), str(tmp_path), 0.005, hits=3)
    watch.start()

    assert fired.wait(3.0)
    watch.close()
    assert reads >= 3, "not on the first look"


# #827-S1
def test_a_single_spike_does_not_trip(tmp_path: Path) -> None:
    cgroup(tmp_path, anon_mib=100, limit_mib=768)
    watch = ControlMemoryWatch(
        lambda used, limit: pytest.fail("fired for one spike"), str(tmp_path), 0.05, hits=3
    )
    watch.start()
    assert wait_until(lambda: watch.highest == 100 * MIB)

    cgroup(tmp_path, anon_mib=760, limit_mib=768)  # over the line for about one look
    assert wait_until(lambda: watch.highest == 760 * MIB)
    cgroup(tmp_path, anon_mib=100, limit_mib=768)
    time.sleep(0.4)  # several looks at the low value: the count started again
    cgroup(tmp_path, anon_mib=760, limit_mib=768)
    assert wait_until(lambda: watch.highest == 760 * MIB)
    cgroup(tmp_path, anon_mib=100, limit_mib=768)
    time.sleep(0.2)
    watch.close()

    assert not watch.fired


# #827-S1
def test_files_that_cannot_be_read_are_logged_once_and_the_watch_goes_on(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    fired = threading.Event()
    watch = ControlMemoryWatch(
        lambda used, limit: fired.set(), str(tmp_path), 0.002, unreadable_after=5, hits=1
    )
    with caplog.at_level("WARNING"):
        watch.start()
        assert wait_until(lambda: "watch is blind" in caplog.text)
        time.sleep(0.05)
    assert caplog.text.count("watch is blind") == 1

    cgroup(tmp_path, anon_mib=750)  # readable again, and over the line
    assert fired.wait(3.0)
    watch.close()


# #827-S1
def test_a_limit_of_max_says_no_limit_once_and_not_that_the_watch_is_blind(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    cgroup(tmp_path, anon_mib=600, limit_mib=None)
    watch = ControlMemoryWatch(
        lambda used, limit: pytest.fail("nothing to bound"),
        str(tmp_path),
        0.002,
        unreadable_after=5,
    )
    with caplog.at_level("INFO"):
        watch.start()
        assert wait_until(lambda: "no limit" in caplog.text)
        time.sleep(0.1)
        watch.close()

    # Only what the watch itself logged: another logger's line is not the watch going blind.
    own = "\n".join(
        record.getMessage() for record in caplog.records if record.name == control_memory.__name__
    )
    assert own.count("no limit") == 1
    assert "blind" not in own and "could not be read" not in own


# #827-S1
def test_the_fallback_is_logged_once(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    cgroup(tmp_path, anon_mib=100, omit=("sock",))
    watch = ControlMemoryWatch(lambda used, limit: None, str(tmp_path), 0.002)
    with caplog.at_level("WARNING"):
        watch.start()
        assert wait_until(lambda: "inactive_file" in caplog.text)
        time.sleep(0.05)
        watch.close()

    assert caplog.text.count("inactive_file") == 1


def test_a_closed_watch_looks_no_more(tmp_path: Path) -> None:
    cgroup(tmp_path, anon_mib=100)
    watch = ControlMemoryWatch(lambda used, limit: None, str(tmp_path), 0.005)
    watch.start()
    assert wait_until(lambda: watch.highest == 100 * MIB)

    watch.close()
    cgroup(tmp_path, anon_mib=200)
    time.sleep(0.05)

    assert watch.highest == 100 * MIB
    assert watch.closed


def test_the_reason_word_is_the_one_the_report_starts_with() -> None:
    assert REASON_CONTROL_MEMORY == "control_memory"
    assert PERCENT == 90
    assert HITS == 3
