# SPDX-License-Identifier: LicenseRef-Proprietary

"""The memory of the agent's container for `sandbox_boundary_check.py` (#827).

The check must run with the size the Launcher gives the agent, so it has no default of its own:
the variable `RUNNER_IMPLEMENTER_AGENT_MEMORY_MB` wins when it is set, otherwise the figure of
`contracts/environment-sizes.v1.json` (`agentMemoryMb`) for the VM's vCPU count is used, otherwise
the check stops. This file sits next to the check, so it is mounted at `/driver` with it; the
contract is not part of the image, so on a VM it has to be mounted too, at
`/contracts/environment-sizes.v1.json`.
"""

import json
import os
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, cast

VARIABLE = "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB"
CONTRACT_NAME = "environment-sizes.v1.json"


class BoundaryMemoryError(Exception):
    """The size of the agent's container cannot be decided; the message says what to do."""


def contract_candidates(driver: Path) -> list[Path]:
    """Where the contract is looked for: `<repository>/contracts` for a script run from a checkout
    (`runner/scripts` is two levels below the root), `/contracts` for `/driver` on a VM."""
    return [driver.parent.parent / "contracts" / CONTRACT_NAME]


def vcpu_count() -> int:
    """The processors this process may use (the VM's, as the Control container has no cpuset)."""
    return len(os.sched_getaffinity(0)) or (os.cpu_count() or 1)


def _hint(vcpus: int) -> str:
    return (
        f"set {VARIABLE} to the memory of the agent's container in MB, or make "
        f"contracts/{CONTRACT_NAME} (`agentMemoryMb` for {vcpus} vCPU) reachable "
        f"(on a VM: mount it read-only at /contracts/{CONTRACT_NAME})"
    )


def _from_variable(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError:
        value = 0
    if value <= 0:
        raise BoundaryMemoryError(f"{VARIABLE} is {raw!r}, not a positive number of MB")
    return value


def _read_contract(path: Path) -> Mapping[str, Any]:
    try:
        document: object = json.loads(path.read_text(encoding="utf-8"))
        sizes = cast(Mapping[str, Any], document)["agentMemoryMb"]
        return cast(Mapping[str, Any], sizes)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise BoundaryMemoryError(
            f"{path} ({CONTRACT_NAME}) cannot be read as the sizes contract ({error!r}); "
            f"set {VARIABLE} instead"
        ) from error


def agent_memory_mb(environment: Mapping[str, str], vcpus: int, contracts: Sequence[Path]) -> int:
    """The agent's memory in MB: the variable, else the contract's figure for `vcpus`, else stop."""
    raw = environment.get(VARIABLE, "").strip()
    if raw:
        return _from_variable(raw)
    path = next((candidate for candidate in contracts if candidate.is_file()), None)
    if path is None:
        searched = ", ".join(str(candidate) for candidate in contracts) or "nowhere"
        raise BoundaryMemoryError(
            f"{VARIABLE} is not set and {CONTRACT_NAME} was not found (looked in {searched}): "
            f"{_hint(vcpus)}"
        )
    figure = _read_contract(path).get(str(vcpus))
    if not isinstance(figure, int) or figure <= 0:
        raise BoundaryMemoryError(
            f"{path} has no agent memory for {vcpus} vCPU (found {figure!r}): {_hint(vcpus)}"
        )
    return figure
