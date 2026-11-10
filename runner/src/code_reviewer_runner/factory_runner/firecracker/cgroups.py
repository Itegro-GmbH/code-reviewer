# SPDX-License-Identifier: LicenseRef-Proprietary

"""One cgroup per VM, under the subtree systemd delegated to the service (`Delegate=yes`, #978).

The limits hold without root (spike #970, Q4): `cpu.max` throttled a guest with two busy vCPUs to
0.47 CPU at 50 %, and `memory.max` below what the guest touches made the cgroup OOM-kill the
Firecracker process while the host and the service were untouched. The service first moves itself
into a leaf of its own (a cgroup that has processes cannot enable controllers for its children, the
"no internal process" rule), enables `cpu memory pids` in the delegated cgroup, and makes one cgroup
`vm-<n>-<random>` per VM that holds the Firecracker process and nothing else.

`memory.max` is the guest's memory plus room for the VMM (about 56 MiB fixed) and what the guest's
disk files cost in the page cache (reclaimable, charged to the VM: `memory.current` was 1599 MiB for
a 2 GiB guest that touched 573 MiB). `io.max` is not set (not measured in the spike)."""

import logging
import os
import re
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

CGROUP_ROOT: Final = Path("/sys/fs/cgroup")
SERVICE_LEAF: Final = "service"
CONTROLLERS: Final = ("cpu", "memory", "pids")
MIB: Final = 1024 * 1024
# The Firecracker process itself, its device buffers and the kernel image's pages (measured 50 to
# 56 MiB), and room for the rest of what the VM costs the host.
VMM_OVERHEAD_MIB: Final = 384
# Firecracker's threads: one per vCPU, the VMM, the API and device threads.
PIDS_PER_VM: Final = 256
CPU_PERIOD_US: Final = 100_000
_VM_CGROUP = re.compile(r"vm-[0-9]+-[0-9a-f]{8}")
# How long a killed VM's cgroup may take to empty.
EMPTY_SECONDS: Final = 5.0


class CgroupError(Exception):
    """The cgroup cannot be used. The message names what is missing."""


@dataclass(frozen=True)
class VmLimits:
    """What one VM may use of the machine."""

    vcpus: int
    memory_mib: int

    @property
    def memory_max_bytes(self) -> int:
        return (self.memory_mib + VMM_OVERHEAD_MIB) * MIB

    @property
    def cpu_max(self) -> str:
        return f"{self.vcpus * CPU_PERIOD_US} {CPU_PERIOD_US}"


def delegated_root(
    proc_cgroup: Path = Path("/proc/self/cgroup"), mount: Path = CGROUP_ROOT
) -> Path:
    """The cgroup this process runs in (cgroup v2: the line `0::<path>`), below the cgroup mount."""
    try:
        lines = proc_cgroup.read_text(encoding="utf-8").splitlines()
    except OSError:
        raise CgroupError("this process's cgroup cannot be read") from None
    for line in lines:
        if line.startswith("0::"):
            return mount / line[3:].lstrip("/")
    raise CgroupError("this machine has no cgroup v2")


class CgroupTree:
    """The delegated cgroup and the VM cgroups below it."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def prepare(self) -> None:
        """Make the tree usable: this process into a leaf, the controllers on for the children.
        Safe to run again."""
        leaf = self.root / SERVICE_LEAF
        try:
            leaf.mkdir(exist_ok=True)
            self._move_processes(self.root, leaf)
            enabled = (self.root / "cgroup.controllers").read_text(encoding="utf-8").split()
            missing = [name for name in CONTROLLERS if name not in enabled]
            if missing:
                raise CgroupError(f"the delegated cgroup has no controller {', '.join(missing)}")
            (self.root / "cgroup.subtree_control").write_text(
                " ".join(f"+{name}" for name in CONTROLLERS), encoding="utf-8"
            )
        except OSError as error:
            raise CgroupError(f"the delegated cgroup cannot be set up ({error.strerror})") from None

    @staticmethod
    def _move_processes(source: Path, target: Path) -> None:
        for line in (source / "cgroup.procs").read_text(encoding="utf-8").split():
            try:
                (target / "cgroup.procs").write_text(line, encoding="utf-8")
            except OSError:
                continue  # it ended meanwhile

    def create(self, name: str, limits: VmLimits) -> Path:
        """The cgroup of one VM with its limits. Swap is off: a VM that outgrows its memory is
        killed, the host never swaps for it."""
        if _VM_CGROUP.fullmatch(name) is None:
            raise CgroupError("not the name of a VM's cgroup")
        path = self.root / name
        try:
            path.mkdir()
            (path / "memory.max").write_text(str(limits.memory_max_bytes), encoding="utf-8")
            (path / "memory.swap.max").write_text("0", encoding="utf-8")
            (path / "memory.oom.group").write_text("1", encoding="utf-8")
            (path / "cpu.max").write_text(limits.cpu_max, encoding="utf-8")
            (path / "pids.max").write_text(str(PIDS_PER_VM), encoding="utf-8")
        except OSError as error:
            self.remove(path)
            raise CgroupError(f"the cgroup of a VM cannot be made ({error.strerror})") from None
        return path

    def kill(self, path: Path) -> None:
        """SIGKILL everything in the cgroup (`cgroup.kill`, Linux 5.14), or each process."""
        try:
            (path / "cgroup.kill").write_text("1", encoding="utf-8")
            return
        except OSError:
            pass
        for pid in self.processes(path):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                continue

    @staticmethod
    def processes(path: Path) -> list[int]:
        try:
            return [int(each) for each in (path / "cgroup.procs").read_text().split()]
        except (OSError, ValueError):
            return []

    def remove(self, path: Path, *, seconds: float = EMPTY_SECONDS) -> bool:
        """Kill what is left and remove the cgroup. False when it stays (a process in
        uninterruptible sleep)."""
        if path.parent != self.root or _VM_CGROUP.fullmatch(path.name) is None:
            raise CgroupError("not the cgroup of a VM")
        deadline = time.monotonic() + seconds
        while True:
            self.kill(path)
            try:
                path.rmdir()
            except FileNotFoundError:
                return True
            except OSError:
                if time.monotonic() >= deadline:
                    _log.warning("the cgroup of a VM could not be removed")
                    return False
                time.sleep(0.02)
                continue
            return True

    def vm_cgroups(self) -> list[Path]:
        """The VM cgroups that exist now (a crashed service's leftovers among them)."""
        try:
            return sorted(
                each
                for each in self.root.iterdir()
                if each.is_dir() and _VM_CGROUP.fullmatch(each.name)
            )
        except OSError:
            return []
