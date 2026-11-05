# SPDX-License-Identifier: LicenseRef-Proprietary

"""Unit-test setup shared by every file in this directory."""

from collections.abc import Iterator

import pytest

from code_reviewer_runner.implementer.control_memory import ControlMemoryWatch
from code_reviewer_runner.implementer.vm_memory import MemoryGuard

_JOIN_SECONDS = 5.0


@pytest.fixture(autouse=True)
def memory_threads_end_with_their_test(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """No `MemoryGuard` or `ControlMemoryWatch` thread outlives the test that started it (#888).

    Both read a file a few times a second and say so in the log when it cannot be read. A test that
    started one over a temporary directory and never closed it left a thread that, a few seconds
    later, found the directory gone and logged "guard is blind" into whichever test was running
    then: `caplog` of an unrelated test (`test_control_memory`) failed now and then. Every thread
    started in a test is closed and waited for when the test ends, so its last look is over before
    the next test begins."""
    guards: list[MemoryGuard] = []
    watches: list[ControlMemoryWatch] = []
    start_guard, start_watch = MemoryGuard.start, ControlMemoryWatch.start

    def guard_started(self: MemoryGuard) -> None:
        guards.append(self)
        start_guard(self)

    def watch_started(self: ControlMemoryWatch) -> None:
        watches.append(self)
        start_watch(self)

    monkeypatch.setattr(MemoryGuard, "start", guard_started)
    monkeypatch.setattr(ControlMemoryWatch, "start", watch_started)
    yield
    for guard in guards:
        guard.close()
    for watch in watches:
        watch.close()
    threads = [guard._thread for guard in guards]  # pyright: ignore[reportPrivateUsage]
    threads += [watch._thread for watch in watches]  # pyright: ignore[reportPrivateUsage]
    for thread in threads:
        thread.join(timeout=_JOIN_SECONDS)
    alive = [thread for thread in threads if thread.is_alive()]
    assert not alive, f"{len(alive)} memory thread(s) still looking after the test"
