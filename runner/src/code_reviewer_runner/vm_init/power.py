# SPDX-License-Identifier: LicenseRef-Proprietary

"""Powering the VM off. Firecracker on x86 has no ACPI: the kernel's "power off" only halts the CPUs
and the VMM keeps running. A reboot with `reboot=k` on the kernel's command line is a reset of the
keyboard controller, which Firecracker turns into the end of its process (the spike's finding, #970:
"the guest reboots itself, `reboot=k` ends the process"). So the one call that ends the VM is the
restart; the power-off is only the fallback for a kernel on which the restart is refused. The host
kills the VMM after the exit report anyway (#978), which is the backstop for both."""

import ctypes
import logging
import os
from collections.abc import Callable
from typing import Final

_log = logging.getLogger(__name__)

# linux/reboot.h
LINUX_REBOOT_CMD_RESTART: Final = 0x01234567
LINUX_REBOOT_CMD_POWER_OFF: Final = 0x4321FEDC

Reboot = Callable[[int], int]


def _libc_reboot(command: int) -> int:
    libc = ctypes.CDLL(None, use_errno=True)
    # glibc's reboot(int): the magic numbers of the system call are its own business.
    return int(libc.reboot(ctypes.c_int(command)))


def power_off(*, reboot: Reboot = _libc_reboot, sync: Callable[[], None] = os.sync) -> bool:
    """Flushes the disks and ends the VM. A VM that ended does not return; True is what a kernel
    that
    accepted the call but has not yet stopped the CPUs gives, and False means the VM is still
    running."""
    try:
        sync()
    except OSError:
        _log.warning("power off: sync failed")
    for command in (LINUX_REBOOT_CMD_RESTART, LINUX_REBOOT_CMD_POWER_OFF):
        try:
            if reboot(command) == 0:
                return True
        except OSError:
            continue
    _log.error("power off: the kernel refused both the restart and the power off")
    return False
