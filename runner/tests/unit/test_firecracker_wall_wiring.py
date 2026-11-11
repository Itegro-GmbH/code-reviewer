# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the launcher uses the outer wall (#979): the wall is told of a VM before the VMM exists, with
the host of the app; its listeners start with the service and end with it; the real proxy wall is
the default; and the answer to `narrow` is the wall's. Against the launcher's fake Firecracker."""

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from firecracker_support import Rig, short_directory, start_for

from code_reviewer_runner.factory_runner.firecracker.launcher import FirecrackerSandbox
from code_reviewer_runner.factory_runner.firecracker.outer_wall import (
    InnerWallOnly,
    OuterWallMode,
    RefusingOuterWall,
    VmIdentity,
    WallLifecycle,
    outer_wall_for,
)
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import (
    OuterWallUnavailable,
    ProxyOuterWall,
    SlotAddresses,
)
from code_reviewer_runner.factory_runner.firecracker.slots import Slot

pytestmark = pytest.mark.unit


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


class Wall:
    """A wall that notes what it is asked, and what the VM's directory looked like when it was."""

    def __init__(self, rig: Rig | None = None) -> None:
        self.rig = rig
        self.calls: list[str] = []
        self.configs_at_admit: list[list[str]] | None = None

    async def admit(self, vm: VmIdentity) -> None:
        self.calls.append(f"admit {vm.slot.tap} {vm.app_host}")
        if self.rig is not None:
            self.configs_at_admit = [
                sorted(p.name for p in directory.iterdir())
                for directory in (self.rig.root / "vms").iterdir()
            ]

    async def narrow(self, vm: VmIdentity, message: Any) -> None:
        _ = vm, message
        self.calls.append("narrow")

    async def forget(self, vm: VmIdentity) -> None:
        _ = vm
        self.calls.append("forget")


class LifecycleWall(Wall):
    def __init__(self, fail_start: bool = False) -> None:
        super().__init__()
        self.fail_start = fail_start

    async def start(self) -> None:
        self.calls.append("start")
        if self.fail_start:
            raise OuterWallUnavailable("fctap0")

    async def close(self) -> None:
        self.calls.append("close")


async def whole_job(sandbox: FirecrackerSandbox) -> None:
    await sandbox.setup()
    try:
        worker = await sandbox.start(start_for())
        await worker.wait()
    finally:
        await sandbox.close()


# #979
def test_the_wall_is_told_of_the_vm_before_the_vmm_exists_with_the_host_of_the_app() -> None:
    with short_directory() as root:
        rig = Rig(root)
        wall = Wall(rig)

        go(lambda: whole_job(rig.sandbox(wall=wall)))

        assert wall.calls == ["admit fctap0 172.31.0.1", "narrow", "forget"]
        # The VM's directory held no VMM configuration yet: no VMM, so no VM that could reach a wall
        # that has no rule for it.
        assert wall.configs_at_admit is not None
        assert all("firecracker.json" not in names for names in wall.configs_at_admit)


# #979
def test_a_wall_that_cannot_admit_the_vm_fails_the_start_and_leaves_nothing() -> None:
    with short_directory() as root:
        rig = Rig(root)

        class Broken(Wall):
            async def admit(self, vm: VmIdentity) -> None:
                await super().admit(vm)
                raise OuterWallUnavailable(vm.slot.tap)

        wall = Broken()
        sandbox = rig.sandbox(wall=wall)

        async def scenario() -> None:
            await sandbox.setup()
            try:
                with pytest.raises(OuterWallUnavailable):
                    await sandbox.start(start_for())
            finally:
                await sandbox.close()

        go(scenario)

        assert wall.calls == ["admit fctap0 172.31.0.1", "forget"]
        assert rig.vm_directories() == []
        assert sandbox.free == sandbox.capacity


# #979
def test_the_walls_listeners_start_with_the_service_and_end_with_it() -> None:
    with short_directory() as root:
        rig = Rig(root)
        wall = LifecycleWall()
        assert isinstance(wall, WallLifecycle)

        go(lambda: whole_job(rig.sandbox(wall=wall)))

        assert wall.calls[0] == "start" and wall.calls[-1] == "close"
        assert wall.calls[1:-1] == ["admit fctap0 172.31.0.1", "narrow", "forget"]


# #979
def test_a_wall_that_cannot_start_stops_the_service_before_the_first_claim() -> None:
    with short_directory() as root:
        rig = Rig(root)
        sandbox = rig.sandbox(wall=LifecycleWall(fail_start=True))

        async def scenario() -> None:
            with pytest.raises(OuterWallUnavailable):
                await sandbox.setup()
            await sandbox.close()

        go(scenario)

        assert rig.vm_directories() == []


# #979
def test_the_proxy_wall_is_the_default_and_listens_for_every_slot() -> None:
    wall = outer_wall_for(OuterWallMode.PROXY, slots=3)

    assert isinstance(wall, ProxyOuterWall)
    assert wall.addresses_of(Slot(2)) == SlotAddresses("172.31.0.9", "172.31.0.10")
    assert isinstance(outer_wall_for(OuterWallMode.REFUSE), RefusingOuterWall)
    assert isinstance(outer_wall_for(OuterWallMode.INNER_ONLY), InnerWallOnly)


# #979
def test_a_sandbox_made_with_the_default_settings_has_the_proxy_wall() -> None:
    with short_directory() as root:
        rig = Rig(root, outer_wall=OuterWallMode.PROXY, slots=2)

        sandbox = FirecrackerSandbox(rig.settings, cgroups=rig.cgroups)

        assert isinstance(sandbox.wall, ProxyOuterWall)
