# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Firecracker process of one VM (#978): its configuration, its command line, its start.

Firecracker runs **without the jailer**, as the service's own user with no capability: it started,
booted a guest and ran under its own seccomp filter (`Seccomp` 2, `NoNewPrivs` 1) in the spike #970.
Without the jailer the VMM is not in a chroot, a PID or a mount namespace, so a VMM escape lands in
the user that also holds the other jobs' state. What this launcher does about that: a directory per
VM made 0700, every file of the VM below it, one cgroup per VM that kills the whole process tree, no
environment handed to the process, and a unit with systemd's sandboxing is the installer's to add
(#982: `ProtectSystem`, `PrivateTmp`, `NoNewPrivileges`, `CapabilityBoundingSet=` for the service
that holds all of them; one unit per VM is not tried and stays an open decision, see the issue).

The configuration is the file `--config-file` reads with `--no-api`: no API socket exists, so there
is nothing to talk to a VM through but its vsock. The guest gets no serial console it does not read
(0.3 to 0.4 s of every boot)."""

import json
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .settings import FirecrackerSettings
from .slots import PREFIX_LENGTH, Slot

# The guest's context id; the host is 2.
GUEST_CID = 3


def kernel_command_line(settings: FirecrackerSettings, slot: Slot) -> str:
    """The release's command line for a job's VM: `vm.mode=run` and the address of its slot (the
    guest's init sets them up, `docker/vm/rootfs/vm-boot`), then the init command."""
    init, _, rest = settings.init_command.partition(" -- ")
    address = f"vm.ip={slot.guest_address}/{PREFIX_LENGTH} vm.gw={slot.host_address}"
    return f"{settings.boot_args} vm.mode=run {address} init={init} -- {rest}".rstrip(" -")


def firecracker_config(settings: FirecrackerSettings, slot: Slot, vm_dir: Path) -> dict[str, Any]:
    """The VM: the root file system (read-only), the job disk (writable), one NIC on the slot's
    TAP and the vsock."""
    return {
        "boot-source": {
            "kernel_image_path": str(settings.kernel),
            "boot_args": kernel_command_line(settings, slot),
        },
        "drives": [
            {
                "drive_id": "rootfs",
                "path_on_host": str(settings.rootfs),
                "is_root_device": True,
                "is_read_only": True,
            },
            {
                "drive_id": "data",
                "path_on_host": str(vm_dir / "disk.ext4"),
                "is_root_device": False,
                "is_read_only": False,
            },
        ],
        "network-interfaces": [
            {"iface_id": "eth0", "host_dev_name": slot.tap, "guest_mac": slot.guest_mac}
        ],
        "vsock": {"guest_cid": GUEST_CID, "uds_path": str(vm_dir / "vsock.sock")},
        "machine-config": {
            "vcpu_count": settings.vcpus,
            "mem_size_mib": settings.memory_mib,
            "smt": False,
        },
    }


def write_config(config: dict[str, Any], path: Path) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(config, handle)


def command(settings: FirecrackerSettings, config_path: Path) -> list[str]:
    return [str(settings.firecracker), "--no-api", "--config-file", str(config_path)]


def into_cgroup(procs: Path) -> tuple[Callable[[], None], Callable[[], None]]:
    """`(preexec, close)`: `preexec` runs in the child between fork and exec and writes 0 (the
    writer itself) to the cgroup's `cgroup.procs`, so the VMM is never outside its limits, not for
    an instant. `close` closes the descriptor in the parent."""
    descriptor = os.open(procs, os.O_WRONLY)

    def preexec() -> None:
        os.write(descriptor, b"0")

    return preexec, lambda: os.close(descriptor)
