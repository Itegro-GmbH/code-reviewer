# SPDX-License-Identifier: LicenseRef-Proprietary

"""Powering the VM off (#977): a restart ends a Firecracker VM, the power off is the fallback."""

from code_reviewer_runner.vm_init import power


def test_the_disks_are_flushed_and_a_restart_ends_the_vm() -> None:
    calls: list[str] = []

    ended = power.power_off(
        reboot=lambda command: calls.append(f"reboot {command:#x}") or 0,
        sync=lambda: calls.append("sync"),
    )

    assert ended is True
    assert calls == ["sync", f"reboot {power.LINUX_REBOOT_CMD_RESTART:#x}"]


def test_a_refused_restart_is_followed_by_the_power_off() -> None:
    commands: list[int] = []

    def reboot(command: int) -> int:
        commands.append(command)
        return -1 if command == power.LINUX_REBOOT_CMD_RESTART else 0

    assert power.power_off(reboot=reboot, sync=lambda: None) is True
    assert commands == [power.LINUX_REBOOT_CMD_RESTART, power.LINUX_REBOOT_CMD_POWER_OFF]


def test_a_vm_that_neither_call_ends_says_so() -> None:
    assert power.power_off(reboot=lambda command: -1, sync=lambda: None) is False


def test_a_failing_sync_or_reboot_does_not_stop_the_attempt() -> None:
    def sync() -> None:
        raise OSError("sync")

    def reboot(command: int) -> int:
        if command == power.LINUX_REBOOT_CMD_RESTART:
            raise OSError("restart")
        return 0

    assert power.power_off(reboot=reboot, sync=sync) is True
