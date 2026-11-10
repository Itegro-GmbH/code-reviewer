# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the KVM lane (#978) knows about its machine (not a test file): the VM artifacts and the
state directory the workflow names in the environment, the settings of the launcher made from them.
Anything missing is a failure that names it, never a skip."""

import json
import os
from dataclasses import dataclass
from pathlib import Path

import pytest

from code_reviewer_runner.factory_runner.firecracker.settings import FirecrackerSettings
from code_reviewer_runner.factory_runner.firecracker.slots import Slot

HOST_ADDRESS = Slot(0).host_address


@dataclass(frozen=True)
class Machine:
    settings: FirecrackerSettings
    state: Path


def need(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        pytest.fail(f"the KVM lane needs {name} (the workflow sets it)", pytrace=False)
    return value


def load_machine() -> Machine:
    kernel, rootfs, base = (
        Path(need(name)) for name in ("KVM_VM_KERNEL", "KVM_VM_ROOTFS", "KVM_VM_BASE_DISK")
    )
    images = json.loads(Path(need("KVM_VM_IMAGES")).read_text())
    state = Path(need("KVM_VM_STATE_DIR"))
    for path in (kernel, rootfs, base):
        if not path.is_file():
            pytest.fail(f"{path} is not a file", pytrace=False)
    if not Path("/dev/kvm").exists():
        pytest.fail("this runner has no /dev/kvm", pytrace=False)
    if not (Path("/sys/class/net") / Slot(0).tap).exists():
        pytest.fail(f"no TAP device {Slot(0).tap} (the workflow makes it)", pytrace=False)
    state.mkdir(parents=True, exist_ok=True)
    settings = FirecrackerSettings(
        kernel=kernel,
        rootfs=rootfs,
        base_disk=base,
        image_id=images["worker"]["id"],
        state_dir=state,
        firecracker=Path(os.environ.get("KVM_FIRECRACKER", "/usr/local/bin/firecracker")),
        slots=1,
        vcpus=2,
        disk_gib=16,
        job_timeout_seconds=300,
        # The guest's console goes to the VM's log, which a failed run prints.
        console=True,
    )
    return Machine(settings, state)
