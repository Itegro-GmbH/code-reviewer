# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a crashed or restarted service left behind (#978): VMs, their disks, their cgroups.

A service that ends cleanly leaves nothing (every VM is killed and its directory deleted when its
worker ends). One that is killed, or whose machine loses power, can leave a Firecracker process, the
directory of its VM (a job disk of GiB) and its cgroup. At every start of the service, before the
first claim, this removes them: each `vms/vm-*` directory is a VM of an earlier service (this one
has not started any), its process is found by its command line (the configured Firecracker binary
as argv[0] and `--config-file <directory>/firecracker.json`; never by a remembered pid, which may
have been reused, and never by a file name alone: a `tail -f` on the VM's log is not a VMM), killed
with its cgroup, and the directory deleted. A cgroup named like a VM's with no directory is removed
too."""

import itertools
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


def _command_lines(proc: Path) -> dict[int, list[str]]:
    found: dict[int, list[str]] = {}
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
        argv = raw.rstrip(b"\0").split(b"\0")
        found[int(entry.name)] = [each.decode("utf-8", errors="replace") for each in argv]
    return found


def _is_vmm_of(argv: list[str], firecracker: Path, directory: Path) -> bool:
    """Whether `argv` is the Firecracker of this VM: the program is the configured binary, and it
    was given `--config-file <directory>/firecracker.json` (the launcher's own command line). A
    `tail -f` on the VM's log, an editor with its disk open, a shell in the directory are not."""
    if not argv or argv[0] != str(firecracker):
        return False
    config = f"{directory}/firecracker.json"
    return any(
        option == "--config-file" and value == config for option, value in itertools.pairwise(argv)
    )


def processes_of(directory: Path, firecracker: Path, proc: Path = PROC) -> list[int]:
    """The processes that are the Firecracker of this VM directory (`_is_vmm_of`)."""
    return [
        pid
        for pid, argv in _command_lines(proc).items()
        if pid != os.getpid() and _is_vmm_of(argv, firecracker, directory)
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
    vms: Path,
    cgroups: CgroupTree | None,
    *,
    firecracker: Path,
    proc: Path = PROC,
    wait_seconds: float = GONE_SECONDS,
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
        pids = processes_of(directory, firecracker, proc)
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
