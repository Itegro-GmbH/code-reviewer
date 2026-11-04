# SPDX-License-Identifier: LicenseRef-Proprietary

"""#837: `scripts/follow_up_spike.py` removes Docker containers by fixed names and unmounts and
deletes directories as root. It must refuse to run anywhere but a `spike-` VM (or on the say-so of
the one who runs it), and its default work directory is a fresh one, never a fixed path."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "spike_guard.py"


def load_guard() -> ModuleType:
    spec = importlib.util.spec_from_file_location("spike_guard", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["spike_guard"] = module
    spec.loader.exec_module(module)
    return module


guard = load_guard()


def test_a_host_that_is_no_spike_vm_is_refused() -> None:
    with pytest.raises(SystemExit) as refused:
        guard.refuse_unless_spike_vm("devbox-1", {})

    assert "spike-" in str(refused.value) and guard.OVERRIDE in str(refused.value)


def test_a_spike_vm_is_let_through() -> None:
    guard.refuse_unless_spike_vm("spike-0417", {})


def test_the_say_so_of_the_caller_lets_any_host_through_but_only_as_exactly_one() -> None:
    guard.refuse_unless_spike_vm("devbox-1", {guard.OVERRIDE: "1"})
    for other in ("", "0", "true", "yes"):
        with pytest.raises(SystemExit):
            guard.refuse_unless_spike_vm("devbox-1", {guard.OVERRIDE: other})


def test_a_name_that_only_contains_spike_is_no_spike_vm() -> None:
    with pytest.raises(SystemExit):
        guard.refuse_unless_spike_vm("not-spike-1", {})


def test_the_default_work_directory_is_a_fresh_one_each_time() -> None:
    first, second = guard.fresh_out_dir(), guard.fresh_out_dir()
    try:
        assert first != second and first.is_dir() and second.is_dir()
        assert first != Path("/tmp/follow-up-spike")
        assert list(first.iterdir()) == []
    finally:
        first.rmdir()
        second.rmdir()
