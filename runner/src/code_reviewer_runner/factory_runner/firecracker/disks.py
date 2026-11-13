# SPDX-License-Identifier: LicenseRef-Proprietary

"""The job disk (#978): a copy of the prepared Docker data disk, grown to the job's quota.

The root file system is shared by every VM as a read-only drive; the writable disk (Docker's data,
containerd's and Sysbox's state, the work volume) is one file per job. Firecracker takes the file
as a block device, so the unprivileged service needs no mount, no loop device and no root (spike
#970, Q3). The copy is a reflink where the file system has them (XFS with `reflink=1`, btrfs: 34 ms
for 752 MiB against 1.3 s) and a plain sparse copy elsewhere. **The quota is the size of the file**:
`truncate` and `resize2fs` on the file before the VM starts (20 ms); the guest sees `No space left
on device` at the quota. The file is deleted when the VM is gone."""

import fcntl
import logging
import os
import re
import shutil
import subprocess
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Final

_log = logging.getLogger(__name__)

# linux/fs.h: FICLONE, `_IOW(0x94, 9, int)`.
FICLONE: Final = 0x40049409
GIB: Final = 1024**3
# What a tool may take: a copy of a file system of a few GiB, a check, a resize.
COMMAND_SECONDS: Final = 300.0
_VM_DIRECTORY = re.compile(r"vm-[0-9]+-[0-9a-f]{8}")

# argv -> exit status. A test brings its own; the real one runs the tool with a bare environment.
Run = Callable[[Sequence[str]], int]


class DiskError(Exception):
    """The job disk could not be made. The message names the step, never a path's content."""


def run_command(argv: Sequence[str]) -> int:
    try:
        return subprocess.run(
            list(argv),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=COMMAND_SECONDS,
            env={"PATH": os.environ.get("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")},
        ).returncode
    except (OSError, subprocess.TimeoutExpired):
        return 127


def clone_file(source: Path, destination: Path) -> bool:
    """A reflink copy (`FICLONE`): True when it was made, False when the file system has none (the
    destination is then removed)."""
    try:
        with source.open("rb") as origin, destination.open("xb") as target:
            fcntl.ioctl(target.fileno(), FICLONE, origin.fileno())
    except OSError:
        destination.unlink(missing_ok=True)
        return False
    return True


def make_job_disk(
    base: Path,
    destination: Path,
    quota_bytes: int,
    *,
    run: Run = run_command,
    clone: Callable[[Path, Path], bool] = clone_file,
) -> bool:
    """Make `destination` from `base` with a size of `quota_bytes`. True when the copy is a
    reflink. Raises `DiskError`."""
    try:
        size = base.stat().st_size
    except OSError:
        raise DiskError("the base disk cannot be read") from None
    if quota_bytes < size:
        raise DiskError("the quota is smaller than the base disk")
    reflinked = clone(base, destination)
    if not reflinked and run(["cp", "--sparse=always", "--", str(base), str(destination)]) != 0:
        destination.unlink(missing_ok=True)
        raise DiskError("the base disk cannot be copied")
    try:
        os.truncate(destination, quota_bytes)
    except OSError:
        raise DiskError("the job disk cannot be grown") from None
    if run(["resize2fs", str(destination)]) != 0:
        # resize2fs wants a checked file system; a copy of a clean one needs it rarely.
        e2fsck = run(["e2fsck", "-fy", str(destination)])
        if e2fsck > 1 or run(["resize2fs", str(destination)]) != 0:
            raise DiskError("the file system of the job disk cannot be grown")
    _log.info(
        "job disk made (%s copy, quota %d GiB)",
        "reflink" if reflinked else "plain",
        quota_bytes // GIB,
    )
    return reflinked


def remove_vm_directory(directory: Path, vms: Path) -> None:
    """Delete the directory of one VM (its disk, sockets and configuration). Refuses anything that
    is not a directory of that name directly below `vms`: it deletes a tree."""
    if directory.parent != vms or _VM_DIRECTORY.fullmatch(directory.name) is None:
        raise DiskError("not the directory of a VM")
    shutil.rmtree(directory, ignore_errors=True)
