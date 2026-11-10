# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a crashed or restarted service left behind (#978): VMs, their disks, their cgroups.

A service that ends cleanly leaves nothing (every VM is killed and its directory deleted when its
worker ends). One that is killed, or whose machine loses power, can leave a Firecracker process, the
directory of its VM (a job disk of GiB) and its cgroup. At every start of the service, before the
first claim, this removes them: each `vms/vm-*` directory is a VM of an earlier service (this one
has not started any), its process is found by its command line (`--config-file <directory>/...`,
never by a remembered pid: a pid may have been reused), killed with its cgroup, and the directory
deleted. A cgroup named like a VM's with no directory is removed too."""

import logging
import os
import signal
import time
from dataclasses import dataclass
from pathlib import Path

from .cgroups import CgroupError, CgroupTree
from .disks import DiskError, remove_vm_directory

_log = logging.getLogger(__name__)

PROC = Path("/proc")
# How long a killed process may take to go.
GONE_SECONDS = 5.0


@dataclass(frozen=True)
class Reaped:
    """What was removed, for the log and the tests."""

    directories: tuple[str, ...] = ()
    processes: tuple[int, ...] = ()
    cgroups: tuple[str, ...] = ()


def _command_lines(proc: Path) -> dict[int, str]:
    found: dict[int, str] = {}
    try:
        entries = list(proc.iterdir())
    except OSError:
        return found
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        found[int(entry.name)] = raw.replace(b"\0", b" ").decode("utf-8", errors="replace")
    return found


def processes_of(directory: Path, proc: Path = PROC) -> list[int]:
    """The processes whose command line names a file of this VM directory."""
    needle = f"{directory}/"
    return [
        pid for pid, line in _command_lines(proc).items() if needle in line and pid != os.getpid()
    ]


def _kill_and_wait(pids: list[int], proc: Path, seconds: float) -> None:
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            continue
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and any((proc / str(pid)).exists() for pid in pids):
        time.sleep(0.02)


def reap_leftovers(
    vms: Path, cgroups: CgroupTree | None, *, proc: Path = PROC, wait_seconds: float = GONE_SECONDS
) -> Reaped:
    """Remove the VMs, disks and cgroups an earlier service left. Never raises: what cannot be
    removed is logged and found again at the next start."""
    directories: list[str] = []
    killed: list[int] = []
    removed_cgroups: list[str] = []
    try:
        listing = sorted(vms.iterdir()) if vms.is_dir() else []
    except OSError:
        listing = []
    for directory in listing:
        if not directory.is_dir():
            continue
        pids = processes_of(directory, proc)
        _kill_and_wait(pids, proc, wait_seconds)
        killed.extend(pids)
        try:
            remove_vm_directory(directory, vms)
        except DiskError:
            _log.warning("%s is not the directory of a VM: left alone", directory.name)
            continue
        directories.append(directory.name)
    if cgroups is not None:
        for path in cgroups.vm_cgroups():
            try:
                if cgroups.remove(path):
                    removed_cgroups.append(path.name)
            except CgroupError:
                continue
    if directories or killed or removed_cgroups:
        _log.warning(
            "removed what an earlier service left: %d VM directories, %d processes, %d cgroups",
            len(directories),
            len(killed),
            len(removed_cgroups),
        )
    return Reaped(tuple(directories), tuple(killed), tuple(removed_cgroups))
