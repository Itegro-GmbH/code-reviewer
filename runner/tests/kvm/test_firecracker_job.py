# SPDX-License-Identifier: LicenseRef-Proprietary

"""A job in a real Firecracker VM (#978, the KVM lane): the launcher of the local Dispatcher starts
the VM of the release (kernel, read-only root file system, a copy of the prepared Docker disk) on a
TAP device, vm-init prepares it and runs Control with the hosted container's flags, the Worker in
it fetches a job from a fake App over the VM's network, delivers its result, and vm-init reports.
What is real: KVM, Firecracker, the kernel, vm-init, dockerd, Sysbox, the Worker image, the vsock,
the TAP, the cgroup, the job disk. What is a double: the App (`runner_app.py`), and the model and
GitHub, which the job never reaches. (The probe that a container cannot open a vsock socket is in
the smoke boot of the same workflow: `vsock_denied_agent`, its control and `ia32_unavailable`.)"""

import asyncio
import dataclasses
import threading
import time
from typing import Any

import pytest
from kvm_support import HOST_ADDRESS, Machine

from code_reviewer_runner.factory_runner.app_client import AppClient
from code_reviewer_runner.factory_runner.firecracker.cgroups import CgroupTree, delegated_root
from code_reviewer_runner.factory_runner.firecracker.control_run import load_template
from code_reviewer_runner.factory_runner.firecracker.launcher import (
    EXIT_KILLED,
    FirecrackerSandbox,
)
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode, VmIdentity
from code_reviewer_runner.factory_runner.firecracker.wire import NarrowMessage, Refusal
from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome, WorkerStart
from runner_app import FakeRunnerApp

pytestmark = pytest.mark.kvm

JOB = "00000000-0000-4000-8000-0000000000b1"
RUNNER_CREDENTIAL = "crc_" + "K" * 43


class RecordingWall:
    """The inner wall only (nothing narrows before #979), and a note of what the Worker asked."""

    def __init__(self) -> None:
        self.narrows: list[str] = []

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        self.narrows.append(f"{message.rule.mode} model={message.model_host}")
        return None

    async def forget(self, vm: VmIdentity) -> None:
        return None


def claimed(app: FakeRunnerApp) -> WorkerStart:
    """The job's claim over the runner API, handed to the VM as the dispatcher hands it: the address
    the App has from inside the VM is the host's side of the slot's TAP."""
    app.queue_job(JOB)
    claim = AppClient(app.url, credential=RUNNER_CREDENTIAL).claim()
    assert claim is not None and claim.job_id == JOB
    return WorkerStart(f"http://{HOST_ADDRESS}:{app.port}", claim.job_id, claim.credential)


class CgroupWatcher(threading.Thread):
    """Reads the limits and the members of the VM's cgroup while the VM runs."""

    def __init__(self, tree: CgroupTree) -> None:
        super().__init__(daemon=True)
        self.tree = tree
        self.seen: dict[str, Any] = {}
        self.stopping = threading.Event()

    def run(self) -> None:
        while not self.stopping.is_set():
            for path in self.tree.vm_cgroups():
                members = self.tree.processes(path)
                if members and not self.seen:
                    try:
                        self.seen = {
                            "name": path.name,
                            "members": members,
                            "memory.max": int((path / "memory.max").read_text()),
                            "cpu.max": (path / "cpu.max").read_text().strip(),
                            "pids.max": int((path / "pids.max").read_text()),
                            "swap": (path / "memory.swap.max").read_text().strip(),
                        }
                    except OSError:
                        self.seen = {}
            time.sleep(0.2)


def sandbox_for(machine: Machine, wall: RecordingWall, **changes: Any) -> FirecrackerSandbox:
    settings = dataclasses.replace(machine.settings, outer_wall=OuterWallMode.INNER_ONLY, **changes)
    return FirecrackerSandbox(settings, wall=wall)


def ran(machine: Machine) -> list[str]:
    return sorted(path.name for path in machine.settings.vms_dir.iterdir())


# #978-T05
def test_a_real_job_runs_end_to_end_in_a_vm_and_leaves_nothing(
    machine: Machine, app: FakeRunnerApp
) -> None:
    wall = RecordingWall()
    sandbox = sandbox_for(machine, wall)
    start = claimed(app)
    watcher_box: list[CgroupWatcher] = []

    async def scenario() -> tuple[WorkerOutcome, float]:
        await sandbox.setup()
        watcher = CgroupWatcher(CgroupTree(sandbox.settings.cgroup_root or delegated_root()))
        watcher_box.append(watcher)
        watcher.start()
        began = time.monotonic()
        worker = await sandbox.start(start)
        acked = time.monotonic() - began
        return await worker.wait(), acked

    try:
        outcome, acked = asyncio.run(scenario())
    finally:
        for watcher in watcher_box:
            watcher.stopping.set()
            watcher.join(5)

    print(
        f"\nvm-init acknowledged the start {acked:.1f} s after the launcher began; {wall.narrows=}"
    )
    print(outcome.log_tail)
    # vm-init prepared the VM, ran the Worker image in Control's container, which ended by itself:
    # the status is the Worker's (a job that cannot reach GitHub ends with an error, delivered).
    assert "worker_exited" in outcome.log_tail, outcome.log_tail
    assert outcome.exit_code in (0, 1)
    # The Worker in the VM reached the App over the TAP with the credential of its claim, and the
    # job is no longer running at the App: a result was delivered.
    paths = [request.path for request in app.requests]
    assert f"/api/workers/v1/jobs/{JOB}" in paths, paths
    assert app.job(JOB).status != "running"
    assert not app.violations
    # The delegated cgroup of the VM held the VMM, with its limits.
    seen = watcher_box[0].seen
    assert seen, "the VM's cgroup was never seen"
    limits = sandbox.settings
    assert seen["cpu.max"] == f"{limits.vcpus * 100_000} 100000"
    assert seen["memory.max"] > limits.memory_mib * 1024 * 1024 and seen["swap"] == "0"
    # And nothing is left: no directory, no disk, no cgroup, the slot is free.
    assert ran(machine) == []
    assert sandbox.free == sandbox.capacity
    assert CgroupTree(sandbox.settings.cgroup_root or delegated_root()).vm_cgroups() == []


# #978-T09
def test_a_vm_that_outlives_its_wall_clock_is_killed_for_real(
    machine: Machine, app: FakeRunnerApp
) -> None:
    wall = RecordingWall()
    sandbox = sandbox_for(
        machine,
        wall,
        job_timeout_seconds=1,
        preparation_seconds=1.0,
    )
    template = load_template()
    # Control's stop timeout is 0 here, so the whole limit is 2 s: a VM takes longer to start.
    sandbox.template = dataclasses.replace(
        template, arguments=tuple("0" if each == "150" else each for each in template.arguments)
    )
    start = claimed(app)

    async def scenario() -> WorkerOutcome:
        await sandbox.setup()
        worker = await sandbox.start(start)
        return await worker.wait()

    outcome = asyncio.run(scenario())

    assert outcome.exit_code == EXIT_KILLED and "wall clock" in outcome.log_tail
    assert ran(machine) == []
    assert sandbox.free == sandbox.capacity
    assert CgroupTree(sandbox.settings.cgroup_root or delegated_root()).vm_cgroups() == []
