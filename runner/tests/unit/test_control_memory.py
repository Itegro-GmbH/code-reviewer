# SPDX-License-Identifier: LicenseRef-Proprietary

"""`ControlMemoryWatch` (#827): Control's own container memory is read from the cgroup files, and
the callback runs once when what it holds (the page cache that can be given back not counted)
reaches 90% of the container's limit. The kernel never picks Control (`--oom-score-adj -1000`), so
this is what ends a Control that grows without a bound, fast, as the OOM killer used to."""

import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.control_memory import (
    PERCENT,
    REASON_CONTROL_MEMORY,
    ControlMemoryWatch,
    read_working_set,
)

MIB = 1024 * 1024
pytestmark = pytest.mark.unit


def cgroup(
    directory: Path, *, current_mib: float, limit_mib: float | None = 768, cache_mib: int = 0
) -> None:
    """The three files of a container's memory cgroup (v2) the watch reads; `limit_mib` None is
    "max" (no limit). `cache_mib` is the inactive file cache inside `current_mib`."""
    (directory / "memory.current").write_text(f"{int(current_mib * MIB)}\n")
    (directory / "memory.max").write_text("max\n" if limit_mib is None else f"{limit_mib * MIB}\n")
    (directory / "memory.stat").write_text(
        f"anon {int((current_mib - cache_mib) * MIB)}\nfile {cache_mib * MIB}\n"
        f"inactive_file {cache_mib * MIB}\nactive_file 0\n"
    )


def wait_until(check: Callable[[], bool], seconds: float = 3.0) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.005)
    return check()


def test_what_the_container_holds_is_read_without_the_cache_that_can_be_given_back(
    tmp_path: Path,
) -> None:
    cgroup(tmp_path, current_mib=600, cache_mib=100)

    assert read_working_set(str(tmp_path)) == (500 * MIB, 768 * MIB)


def test_no_limit_unreadable_files_and_a_file_that_is_not_a_number_read_as_none(
    tmp_path: Path,
) -> None:
    cgroup(tmp_path, current_mib=600, limit_mib=None)
    assert read_working_set(str(tmp_path)) is None

    (tmp_path / "memory.max").write_text("many\n")
    assert read_working_set(str(tmp_path)) is None

    assert read_working_set(str(tmp_path / "missing")) is None

    cgroup(tmp_path, current_mib=600)
    (tmp_path / "memory.stat").unlink()
    assert read_working_set(str(tmp_path)) is None, "a file cache that cannot be had is not zero"


# #827-S1
def test_the_callback_runs_once_when_the_working_set_reaches_ninety_percent(tmp_path: Path) -> None:
    cgroup(tmp_path, current_mib=300, limit_mib=1000)
    fired: list[tuple[int, int]] = []
    watch = ControlMemoryWatch(
        lambda used, limit: fired.append((used, limit)), str(tmp_path), 0.005
    )
    watch.start()
    assert wait_until(lambda: watch.highest == 300 * MIB)
    assert fired == [] and not watch.fired

    cgroup(tmp_path, current_mib=900, limit_mib=1000)  # exactly 90%
    assert wait_until(lambda: watch.fired)
    time.sleep(0.05)
    watch.close()

    assert fired == [(900 * MIB, 1000 * MIB)], "once, with what it read"


# #827-S1
def test_cache_inside_the_usage_is_not_a_runaway(tmp_path: Path) -> None:
    cgroup(tmp_path, current_mib=760, cache_mib=500)  # 99% of the limit, 260 MiB of it in use
    watch = ControlMemoryWatch(
        lambda used, limit: pytest.fail("fired for a cache"), str(tmp_path), 0.005
    )
    watch.start()

    assert wait_until(lambda: watch.highest == 260 * MIB)
    time.sleep(0.05)
    watch.close()
    assert not watch.fired


# #827-S1
def test_files_that_cannot_be_read_are_logged_once_and_the_watch_goes_on(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    fired = threading.Event()
    watch = ControlMemoryWatch(
        lambda used, limit: fired.set(), str(tmp_path), 0.002, unreadable_after=5
    )
    with caplog.at_level("WARNING"):
        watch.start()
        assert wait_until(lambda: "watch is blind" in caplog.text)
        time.sleep(0.05)
    assert caplog.text.count("watch is blind") == 1

    cgroup(tmp_path, current_mib=750)  # readable again, and over the line
    assert fired.wait(3.0)
    watch.close()


def test_a_closed_watch_looks_no_more(tmp_path: Path) -> None:
    cgroup(tmp_path, current_mib=100)
    watch = ControlMemoryWatch(lambda used, limit: None, str(tmp_path), 0.005)
    watch.start()
    assert wait_until(lambda: watch.highest == 100 * MIB)

    watch.close()
    cgroup(tmp_path, current_mib=200)
    time.sleep(0.05)

    assert watch.highest == 100 * MIB


def test_the_reason_word_is_the_one_the_report_starts_with() -> None:
    assert REASON_CONTROL_MEMORY == "control_memory"
    assert PERCENT == 90
