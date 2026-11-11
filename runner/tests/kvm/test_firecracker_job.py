# SPDX-License-Identifier: LicenseRef-Proprietary

"""A job in a real Firecracker VM (#978, the KVM lane): the launcher of the local Dispatcher starts
the VM of the release (kernel, read-only root file system, a copy of the prepared Docker disk) on a
TAP device, vm-init prepares it and runs Control with the hosted container's flags, the Worker in
it fetches a job from a fake App over the VM's network, delivers its result, and vm-init reports.
What is real: KVM, Firecracker, the kernel, vm-init, dockerd, Sysbox, the Worker image, the vsock,
the TAP, the cgroup, the job disk. What is a double: the App (`runner_app.py`), and the model and
GitHub, which the job never reaches. (The probe that a container cannot open a vsock socket is in
the smoke boot of the same workflow: `vsock_denied_agent`, its control and `ia32_unavailable`.)

Besides the one job and the wall clock: the Worker's `narrow` arrives over the vsock with the VM's
token and gets the answer the operator chose (refuse or inner wall only), two jobs run at once in
two slots, and a VM that a dispatcher that crashed left behind is found and removed by the next
one."""

import asyncio
import copy
import dataclasses
import os
import threading
import time
from typing import Any

import pytest
from kvm_support import Machine

from code_reviewer_runner.factory_runner.app_client import AppClient
from code_reviewer_runner.factory_runner.firecracker.cgroups import CgroupTree
from code_reviewer_runner.factory_runner.firecracker.control_run import load_template
from code_reviewer_runner.factory_runner.firecracker.launcher import (
    EXIT_KILLED,
    FirecrackerSandbox,
)
from code_reviewer_runner.factory_runner.firecracker.outer_wall import (
    OuterWall,
    OuterWallMode,
    VmIdentity,
    outer_wall_for,
)
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.firecracker.wire import NarrowMessage, Refusal
from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome, WorkerStart
from runner_app import EXAMPLE_JOB, FakeRunnerApp

pytestmark = pytest.mark.kvm

JOB = "00000000-0000-4000-8000-0000000000b1"
SECOND_JOB = "00000000-0000-4000-8000-0000000000b2"
RUNNER_CREDENTIAL = "crc_" + "K" * 43


class RecordingWall:
    """The wall the operator chose (`inner-only` unless told otherwise), and a note of every
    `narrow` that reached it: it is only asked once the VM's token was checked."""

    def __init__(self, mode: OuterWallMode = OuterWallMode.INNER_ONLY) -> None:
        self.inner: OuterWall = outer_wall_for(mode)
        self.narrows: list[str] = []

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        self.narrows.append(f"{message.rule.mode} model={message.model_host}")
        return await self.inner.narrow(vm, message)

    async def forget(self, vm: VmIdentity) -> None:
        await self.inner.forget(vm)


def job_input() -> dict[str, Any]:
    """The example Implementer job with the project's cost limit, which a real App always sends
    (a job without one does not start)."""
    document = copy.deepcopy(EXAMPLE_JOB)
    document["llm"]["maxCostUsd"] = 0.5
    return document


def claimed(app: FakeRunnerApp, job_id: str = JOB, slot: int = 0) -> WorkerStart:
    """The job's claim over the runner API, handed to the VM as the dispatcher hands it: the address
    the App has from inside the VM is the host's side of the slot's TAP."""
    app.queue_job(job_id, job_input())
    claim = AppClient(app.url, credential=RUNNER_CREDENTIAL).claim()
    assert claim is not None and claim.job_id == job_id
    return WorkerStart(
        f"http://{Slot(slot).host_address}:{app.port}", claim.job_id, claim.credential
    )


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


def what_the_job_delivered(app: FakeRunnerApp) -> str:
    """The results the Worker delivered, for the log of a run and the messages of failed asserts."""
    return "; ".join(
        f"{done.get('status')} {done.get('errorCode')}: {str(done.get('errorMessage'))[:300]}"
        for done in app.completions
    )


def delegated_tree(sandbox: FirecrackerSandbox) -> CgroupTree:
    """The delegated cgroup the launcher works in. Not `delegated_root()` again: after `setup` this
    process lives in the leaf below it."""
    assert isinstance(sandbox.cgroups, CgroupTree)
    return sandbox.cgroups


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
        try:
            watcher = CgroupWatcher(delegated_tree(sandbox))
            watcher_box.append(watcher)
            watcher.start()
            began = time.monotonic()
            worker = await sandbox.start(start)
            acked = time.monotonic() - began
            return await worker.wait(), acked
        finally:
            await sandbox.close()

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
    print(f"delivered: {what_the_job_delivered(app)}")
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
    assert delegated_tree(sandbox).vm_cgroups() == []


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
        try:
            worker = await sandbox.start(start)
            return await worker.wait()
        finally:
            await sandbox.close()

    outcome = asyncio.run(scenario())

    assert outcome.exit_code == EXIT_KILLED and "wall clock" in outcome.log_tail
    assert ran(machine) == []
    assert sandbox.free == sandbox.capacity
    assert delegated_tree(sandbox).vm_cgroups() == []


# #978-T07
@pytest.mark.parametrize("mode", [OuterWallMode.REFUSE, OuterWallMode.INNER_ONLY])
def test_the_workers_narrow_arrives_over_the_vsock_with_the_token_and_gets_the_chosen_answer(
    machine: Machine, app: FakeRunnerApp, mode: OuterWallMode
) -> None:
    # The host asks its wall only for a `narrow` that carries the VM's token (the session refuses
    # the rest before it), so a note in the wall is a real request of the Worker in the VM, over
    # the vsock, with the token vm-init was given.
    wall = RecordingWall(mode)
    sandbox = sandbox_for(machine, wall, outer_wall=mode)
    start = claimed(app)

    async def scenario() -> WorkerOutcome:
        await sandbox.setup()
        try:
            worker = await sandbox.start(start)
            return await worker.wait()
        finally:
            await sandbox.close()

    outcome = asyncio.run(scenario())
    delivered = what_the_job_delivered(app)
    print(f"\n{mode.value}: {wall.narrows=} delivered: {delivered}\n{outcome.log_tail}")

    # The job had no environment: its rule is `off`; the model host is the entry's.
    assert wall.narrows == ["off model=openrouter.ai"], delivered
    errors = [done.get("errorCode") for done in app.completions]
    if mode is OuterWallMode.REFUSE:
        # `refused` (`unavailable`): the Worker ended the job before an agent existed.
        assert errors == ["environment_control_failed"], delivered
    else:
        # `ack`: the job went on past the narrowing (and ended later for what the lane lacks).
        assert errors and "environment_control_failed" not in errors, delivered
    assert ran(machine) == [] and sandbox.free == sandbox.capacity


# #978-T10
def test_two_jobs_run_at_once_in_two_slots_each_on_its_own_tap(
    machine: Machine, app: FakeRunnerApp
) -> None:
    wall = RecordingWall()
    sandbox = sandbox_for(machine, wall, slots=2)
    first, second = claimed(app, JOB, 0), claimed(app, SECOND_JOB, 1)

    async def scenario() -> tuple[int, list[WorkerOutcome]]:
        await sandbox.setup()
        try:
            # Called in this order, the two starts take slot 0 and slot 1 (each job's address of the
            # App is its slot's).
            workers = await asyncio.gather(sandbox.start(first), sandbox.start(second))
            running = len(workers) - sandbox.free
            return running, list(await asyncio.gather(*(worker.wait() for worker in workers)))
        finally:
            await sandbox.close()

    running, outcomes = asyncio.run(scenario())
    delivered = what_the_job_delivered(app)
    print(f"\n{running} VMs ran at once; delivered: {delivered}")
    print(f"exit codes: {[outcome.exit_code for outcome in outcomes]}")

    assert running == 2
    for job in (JOB, SECOND_JOB):
        assert f"/api/workers/v1/jobs/{job}" in [request.path for request in app.requests], job
        assert app.job(job).status != "running", job
    assert len(app.completions) == 2, delivered
    assert not app.violations
    assert ran(machine) == [] and sandbox.free == 2
    assert delegated_tree(sandbox).vm_cgroups() == []


# #978-T13
def test_a_vm_that_a_crashed_dispatcher_left_is_found_and_removed_by_the_next_one(
    machine: Machine, app: FakeRunnerApp
) -> None:
    # The first dispatcher "crashes" with its VM running: it lets go of the machine (the kernel
    # drops the lock of a process that dies) and nothing else is cleaned. The second one finds the
    # VMM by its command line, kills it, and removes its directory and its cgroup.
    first = sandbox_for(machine, RecordingWall())
    second = sandbox_for(machine, RecordingWall())
    start = claimed(app)

    async def scenario() -> tuple[int, str]:
        await first.setup()
        worker = await first.start(start)
        vm = first._vms[worker.vm_id]  # pyright: ignore[reportPrivateUsage]
        assert vm.process is not None
        pid = vm.process.pid
        os.kill(pid, 0)  # still there: the job takes longer than this
        await first.close()
        try:
            await second.setup()
            assert second.reaped.processes == (pid,), second.reaped
            assert second.reaped.directories == (worker.vm_id,), second.reaped
            assert second.reaped.cgroups == (worker.vm_id,), second.reaped
        finally:
            await second.close()
        return pid, worker.vm_id

    pid, _ = asyncio.run(scenario())

    assert not os.path.exists(f"/proc/{pid}")
    assert ran(machine) == []
    assert delegated_tree(second).vm_cgroups() == []
