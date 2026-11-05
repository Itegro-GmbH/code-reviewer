# SPDX-License-Identifier: LicenseRef-Proprietary

"""#827: the attack test of the sandbox (`scripts/sandbox_boundary_check.py`) cannot test a stale
size. The memory of the agent's container is the variable the Launcher passes or, without it, the
figure of `contracts/environment-sizes.v1.json` for the VM's vCPU count; it is never a default
written into the script."""

import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

import pytest

RUNNER = Path(__file__).parents[2]
CONTRACT = RUNNER.parent / "contracts" / "environment-sizes.v1.json"
VARIABLE = "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB"


def load_module() -> ModuleType:
    path = RUNNER / "scripts" / "boundary_memory.py"
    spec = importlib.util.spec_from_file_location("boundary_memory", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["boundary_memory"] = module
    spec.loader.exec_module(module)
    return module


memory = load_module()


def write_contract(tmp_path: Path, sizes: dict[str, int]) -> Path:
    path = tmp_path / "environment-sizes.v1.json"
    path.write_text(json.dumps({"agentMemoryMb": sizes}), encoding="utf-8")
    return path


# #827-T01
def test_the_variable_wins_and_the_contract_is_not_read(tmp_path: Path) -> None:
    missing = tmp_path / "absent.json"
    assert memory.agent_memory_mb({VARIABLE: "2560"}, 2, [missing]) == 2560


# #827-T02
def test_without_the_variable_the_contract_figure_of_the_vcpu_count_is_used(
    tmp_path: Path,
) -> None:
    path = write_contract(tmp_path, {"2": 1952, "4": 5904})
    assert memory.agent_memory_mb({}, 2, [path]) == 1952
    assert memory.agent_memory_mb({}, 4, [path]) == 5904
    # An empty variable is not a size: it counts as unset.
    assert memory.agent_memory_mb({VARIABLE: " "}, 4, [path]) == 5904


# #827-T03
def test_the_first_reachable_contract_is_read(tmp_path: Path) -> None:
    path = write_contract(tmp_path, {"2": 1952})
    assert memory.agent_memory_mb({}, 2, [tmp_path / "absent.json", path]) == 1952


# #827-T04
def test_without_variable_and_contract_it_stops_naming_both(tmp_path: Path) -> None:
    with pytest.raises(memory.BoundaryMemoryError) as caught:
        memory.agent_memory_mb({}, 2, [tmp_path / "absent.json"])
    assert VARIABLE in str(caught.value)
    assert "environment-sizes.v1.json" in str(caught.value)


# #827-T05
@pytest.mark.parametrize("vcpus", [1, 3, 16])
def test_a_vcpu_count_without_a_figure_stops(tmp_path: Path, vcpus: int) -> None:
    path = write_contract(tmp_path, {"1": 0, "2": 1952})
    with pytest.raises(memory.BoundaryMemoryError) as caught:
        memory.agent_memory_mb({}, vcpus, [path])
    assert VARIABLE in str(caught.value)
    assert str(vcpus) in str(caught.value)


# #827-T06
@pytest.mark.parametrize("value", ["lots", "0", "-5"])
def test_a_variable_that_is_not_a_size_stops(value: str) -> None:
    with pytest.raises(memory.BoundaryMemoryError, match=VARIABLE):
        memory.agent_memory_mb({VARIABLE: value}, 2, [])


# #827-T07
def test_a_contract_that_cannot_be_read_stops(tmp_path: Path) -> None:
    path = tmp_path / "environment-sizes.v1.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(memory.BoundaryMemoryError, match=r"environment-sizes\.v1\.json"):
        memory.agent_memory_mb({}, 2, [path])


# #827-T08
def test_the_search_path_works_from_a_checkout_and_from_driver() -> None:
    checkout = memory.contract_candidates(RUNNER / "scripts")
    assert CONTRACT in checkout
    assert Path("/contracts/environment-sizes.v1.json") in memory.contract_candidates(
        Path("/driver")
    )


# #827-T09
def test_the_real_contract_gives_the_figure_the_launcher_passes() -> None:
    assert memory.agent_memory_mb({}, 2, [CONTRACT]) == 1952
