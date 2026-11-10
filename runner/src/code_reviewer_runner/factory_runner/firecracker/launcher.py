# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Firecracker `WorkerSandbox` of the local Dispatcher (#978, Runner v2, epic #969, ADR 0005).

`start(WorkerStart)` runs one job in its own microVM on this machine and returns a worker that
waits for it:

1. takes a **slot** (the number of slots is `parallelRuns`; a TAP device per slot was made at
   install) and makes the VM's directory,
2. makes the **job disk** (a reflink or plain copy of the prepared Docker disk, grown to the quota),
3. makes the VM's **token** and its session, and **listens on both vsock ports before the VM
   starts** (`_5100` environment control, `_5101` exit report),
4. makes a **cgroup** with the VM's limits and starts **Firecracker** in it (no jailer, the
   service's own user),
5. connects to the VM's start port and sends the **start** (`{appUrl, jobId, credential}`, the
   token, the one local credential if the job needs it, Control's `docker run`, the work volume)
   and waits for vm-init's `ack`.

`wait()` ends with the **first exit report** that passes the token check (the authority on how the
job ended), with the end of the VMM without one (an unknown outcome: the dispatcher gives the claim
back), or with the **wall clock** of the VM, which kills the VMM. Whatever ends it, the VMM and its
cgroup are gone, the listeners are closed, the job disk and the VM's directory are deleted and the
slot is free again before `wait()` returns. `stop()` kills the VMM at once (the dispatcher's stop
and its reaper end a VM whose job is over, or a service that is told to stop)."""

import asyncio
import contextlib
import json
import logging
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Protocol

from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome, WorkerStart

from . import vmm
from .cgroups import CgroupError, CgroupTree, VmLimits, delegated_root
from .control_run import ControlRunError, ControlTemplate, build_start, load_template
from .disks import DiskError, make_job_disk, remove_vm_directory
from .endpoint import HostListeners, StartNotAnswered, StartRefused, send_start
from .outer_wall import OuterWall, VmIdentity, outer_wall_for
from .reaper import Reaped, reap_leftovers
from .session import VmSession
from .settings import FirecrackerSettings
from .slots import Slot, SlotPool
from .tokens import generate_control_token
from .wire import start_frame

_log = logging.getLogger(__name__)

# What `WorkerOutcome.exit_code` says when there is no status of the Worker: the VM ended without an
# exit report (1), or the host killed it (-9, a signal).
EXIT_NO_REPORT: Final = 1
EXIT_KILLED: Final = -9
# The lines of the VMM's own log the outcome carries.
LOG_TAIL_BYTES: Final = 6000
# How long a killed VMM may take to be gone before the slot is not given back.
GONE_SECONDS: Final = 10.0


class NoFreeSlot(Exception):
    """Every slot is in use. The service claims only with a free slot, so this is its bug."""


class StartFailed(Exception):
    """The VM did not take the job. The text is a stable reason, never a value of the job."""


class VmCgroups(Protocol):
    """What the launcher asks of the cgroup tree; `CgroupTree` is the real one."""

    def prepare(self) -> None: ...

    def create(self, name: str, limits: VmLimits) -> Path: ...

    def kill(self, path: Path) -> None: ...

    def remove(self, path: Path) -> bool: ...

    def vm_cgroups(self) -> list[Path]: ...


# Seams the tests replace; production leaves the defaults.
SpawnVmm = Callable[..., "asyncio.Future[asyncio.subprocess.Process]"]


@dataclass
class _Vm:
    vm_id: str
    slot: Slot
    directory: Path
    session: VmSession
    listeners: HostListeners
    cgroup: Path | None = None
    process: asyncio.subprocess.Process | None = None
    started_at: float = 0.0
    ended: bool = False
    stopped: bool = False

    @property
    def uds(self) -> Path:
        return self.directory / "vsock.sock"


@dataclass
class FirecrackerSandbox:
    """The `WorkerSandbox` of a machine with KVM. One per service."""

    settings: FirecrackerSettings
    template: ControlTemplate = field(default_factory=load_template)
    wall: OuterWall | None = None
    cgroups: VmCgroups | None = None
    new_token: Callable[[], str] = generate_control_token
    make_disk: Callable[[Path, Path, int], bool] = make_job_disk
    logger: logging.Logger = _log
    # The slots that cannot be given back because their VMM would not die.
    _pool: SlotPool = field(init=False)
    _lost: list[Slot] = field(init=False, default_factory=list[Slot])
    _vms: dict[str, _Vm] = field(init=False, default_factory=dict[str, _Vm])
    # What the last `setup` removed.
    reaped: Reaped = field(init=False, default_factory=Reaped)

    def __post_init__(self) -> None:
        self.settings = self.settings.validated()
        self._pool = SlotPool(self.settings.slots)
        if self.wall is None:
            self.wall = outer_wall_for(self.settings.outer_wall)

    # -- what the service asks ---

    @property
    def capacity(self) -> int:
        """The jobs that may run at once: the number of slots."""
        return self.settings.slots

    @property
    def uses_host_docker(self) -> bool:
        """The Worker's Docker is inside its VM: the host's is never touched."""
        return False

    @property
    def free(self) -> int:
        return self._pool.free

    async def setup(self) -> None:
        """Before the first claim: make the cgroup tree usable and remove what an earlier service
        left (`reaped`). Raises `CgroupError` when the delegated cgroup cannot be used."""
        if self.cgroups is None:
            tree = CgroupTree(self.settings.cgroup_root or delegated_root())
            self.cgroups = tree
        self.cgroups.prepare()
        self.settings.vms_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        tree = self.cgroups if isinstance(self.cgroups, CgroupTree) else None
        self.reaped = await asyncio.to_thread(reap_leftovers, self.settings.vms_dir, tree)

    async def start(self, start: WorkerStart) -> "FirecrackerWorker":
        slot = self._pool.acquire()
        if slot is None:
            raise NoFreeSlot
        vm: _Vm | None = None
        try:
            vm = await self._create(slot, start)
            await self._hand_over(vm, start)
        except BaseException:
            if vm is not None:
                await self._destroy(vm)
            else:
                self._pool.release(slot)
            raise
        return FirecrackerWorker(self, vm)

    # -- one VM ---

    async def _create(self, slot: Slot, start: WorkerStart) -> _Vm:
        settings = self.settings
        vm_id = f"vm-{slot.index}-{secrets.token_hex(4)}"
        directory = settings.vms_dir / vm_id
        directory.mkdir(parents=True, mode=0o700)
        session = VmSession(
            VmIdentity(vm_id, slot),
            self.wall or outer_wall_for(settings.outer_wall),
            self.new_token(),
        )
        listeners = HostListeners(directory / "vsock.sock", session)
        vm = _Vm(vm_id, slot, directory, session, listeners)
        self._vms[vm_id] = vm
        try:
            (directory / "vm.json").write_text(
                json.dumps({"vm": vm_id, "slot": slot.index, "job": start.job_id}), encoding="utf-8"
            )
            await asyncio.to_thread(
                self.make_disk, settings.base_disk, directory / "disk.ext4", settings.quota_bytes
            )
            # Both listeners are up before the VM exists: a guest that reports at once finds them.
            await listeners.start()
            config = vmm.firecracker_config(settings, slot, directory)
            vmm.write_config(config, directory / "firecracker.json")
            vm.process = await self._spawn(vm)
            vm.started_at = time.monotonic()
        except BaseException:
            await self._destroy(vm)
            raise
        self.logger.info("%s: started for slot %d (tap %s)", vm_id, slot.index, slot.tap)
        return vm

    async def _spawn(self, vm: _Vm) -> asyncio.subprocess.Process:
        settings = self.settings
        preexec: Callable[[], None] | None = None
        close: Callable[[], None] | None = None
        if self.cgroups is not None:
            vm.cgroup = self.cgroups.create(vm.vm_id, VmLimits(settings.vcpus, settings.memory_mib))
            procs = vm.cgroup / "cgroup.procs"
            if procs.exists():
                preexec, close = vmm.into_cgroup(procs)
        log = (vm.directory / "firecracker.log").open("ab")
        try:
            return await asyncio.create_subprocess_exec(
                *vmm.command(settings, vm.directory / "firecracker.json"),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                env={},
                cwd=vm.directory,
                start_new_session=True,
                preexec_fn=preexec,
            )
        finally:
            log.close()
            if close is not None:
                close()

    async def _hand_over(self, vm: _Vm, start: WorkerStart) -> None:
        """Send the start and wait for vm-init's `ack`. The start fails when the VM refuses it,
        ends first, reports first (before it ever took the job) or does not answer in time."""
        settings = self.settings
        token = vm.session.token
        document = self._start_document(start, token)
        process = vm.process
        assert process is not None
        sender = asyncio.ensure_future(
            send_start(
                vm.uds,
                start_frame(document),
                connect_seconds=settings.boot_connect_seconds,
                ack_seconds=settings.start_ack_seconds,
            )
        )
        exited = asyncio.ensure_future(process.wait())
        reported = asyncio.ensure_future(vm.session.reported.wait())
        try:
            await asyncio.wait({sender, exited, reported}, return_when=asyncio.FIRST_COMPLETED)
            if sender.done():
                sender.result()
                vm.session.start_acked = True
                return
            if reported.done():
                report = vm.session.report
                reason = report.reason.value if report is not None else "unknown"
                raise StartFailed(f"the VM ended before it took the job ({reason})")
            raise StartFailed("the VMM ended before the VM took the job")
        except StartRefused:
            raise StartFailed("the VM refused the start (invalid_start)") from None
        except StartNotAnswered as error:
            raise StartFailed(str(error)) from None
        finally:
            for task in (sender, exited, reported):
                task.cancel()
            await asyncio.gather(sender, exited, reported, return_exceptions=True)

    def _start_document(self, start: WorkerStart, token: str) -> dict[str, Any]:
        settings = self.settings
        try:
            return build_start(
                self.template,
                app_url=start.app_url,
                job_id=start.job_id,
                credential=start.credential,
                token=token,
                image_id=settings.image_id,
                timeout_seconds=settings.job_timeout_seconds,
                vcpus=settings.vcpus,
                reserve_gib=settings.reserve_gib,
                local=start.local_environment,
            )
        except ControlRunError as error:
            raise StartFailed(str(error)) from None

    # -- the end of a VM ---

    async def _destroy(self, vm: _Vm) -> None:
        """Everything of the VM goes: the VMM and its cgroup, the listeners, the wall's rule, the
        disk and the directory, the slot. Idempotent; never raises."""
        if vm.ended:
            return
        vm.ended = True
        gone = await self._kill(vm)
        with contextlib.suppress(Exception):
            await vm.listeners.close()
        with contextlib.suppress(Exception):
            await (self.wall or outer_wall_for(self.settings.outer_wall)).forget(vm.session.vm)
        if vm.cgroup is not None and self.cgroups is not None:
            try:
                self.cgroups.remove(vm.cgroup)
            except CgroupError:
                self.logger.warning("%s: its cgroup could not be removed", vm.vm_id)
        try:
            await asyncio.to_thread(remove_vm_directory, vm.directory, self.settings.vms_dir)
        except DiskError:
            self.logger.warning("%s: its directory could not be removed", vm.vm_id)
        self._vms.pop(vm.vm_id, None)
        if gone:
            self._pool.release(vm.slot)
        else:
            # A VMM that will not die may still hold the slot's TAP: the slot stays out of use
            # until the service restarts (the reaper kills it then).
            self._lost.append(vm.slot)
            self.logger.error(
                "%s: the VMM did not end: slot %d is out of use", vm.vm_id, vm.slot.index
            )

    async def _kill(self, vm: _Vm) -> bool:
        """SIGKILL the VMM and its cgroup. True when the process is gone."""
        process = vm.process
        if process is None:
            return True
        if vm.cgroup is not None and self.cgroups is not None:
            with contextlib.suppress(Exception):
                self.cgroups.kill(vm.cgroup)
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
        try:
            await asyncio.wait_for(process.wait(), GONE_SECONDS)
        except TimeoutError:
            return False
        return True

    def _log_tail(self, vm: _Vm) -> str:
        try:
            raw = (vm.directory / "firecracker.log").read_bytes()[-LOG_TAIL_BYTES:]
        except OSError:
            return ""
        return raw.decode("utf-8", errors="replace")

    # -- the end of a worker ---

    async def _wait_for_end(self, vm: _Vm, wall_seconds: float) -> str:
        """What ends the VM first: `report` (an exit report was taken), `exited` (the VMM ended;
        a report that is on its way is waited for a moment) or `wall_clock`."""
        process = vm.process
        assert process is not None
        exited = asyncio.ensure_future(process.wait())
        reported = asyncio.ensure_future(vm.session.reported.wait())
        remaining = max(wall_seconds - (time.monotonic() - vm.started_at), 0.0)
        try:
            await asyncio.wait(
                {exited, reported}, timeout=remaining, return_when=asyncio.FIRST_COMPLETED
            )
            if vm.session.reported.is_set():
                return "report"
            if exited.done():
                # The report is sent before the VM powers off: it may still be being read.
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(vm.session.reported.wait(), 1.0)
                return "report" if vm.session.reported.is_set() else "exited"
            return "wall_clock"
        finally:
            for task in (exited, reported):
                task.cancel()
            await asyncio.gather(exited, reported, return_exceptions=True)

    async def finish(self, vm: _Vm) -> WorkerOutcome:
        """Wait for the end of the VM (report, VMM end or wall clock) and clean everything up."""
        wall = self.settings.wall_clock_seconds(self.template.stop_timeout_seconds)
        try:
            ended = await self._wait_for_end(vm, wall)
            if ended == "wall_clock":
                self.logger.error("%s: no end within %gs: killing the VM", vm.vm_id, wall)
                return WorkerOutcome(EXIT_KILLED, "the VM was killed at its wall clock")
            report = vm.session.report
            if report is not None:
                # The VM powers itself off after the host's `ack`; the grace is for that.
                await self._let_power_off(vm)
                return WorkerOutcome(
                    report.exit_code,
                    f"vm-init reported {report.reason.value} ({report.exit_code})\n"
                    + self._log_tail(vm),
                )
            if vm.stopped:
                return WorkerOutcome(EXIT_KILLED, "the VM was stopped")
            return WorkerOutcome(
                EXIT_NO_REPORT, "the VM ended without an exit report\n" + self._log_tail(vm)
            )
        finally:
            await self._destroy(vm)

    async def _let_power_off(self, vm: _Vm) -> None:
        process = vm.process
        if process is None or process.returncode is not None:
            return
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(process.wait(), self.settings.kill_grace_seconds)

    async def stop_vm(self, vm: _Vm) -> None:
        vm.stopped = True
        await self._kill(vm)


class FirecrackerWorker:
    """The running job of one VM (`RunningWorker`)."""

    def __init__(self, sandbox: FirecrackerSandbox, vm: _Vm) -> None:
        self._sandbox = sandbox
        self._vm = vm
        self._outcome: asyncio.Future[WorkerOutcome] | None = None

    @property
    def vm_id(self) -> str:
        return self._vm.vm_id

    async def wait(self) -> WorkerOutcome:
        if self._outcome is None:
            self._outcome = asyncio.ensure_future(self._sandbox.finish(self._vm))
        return await asyncio.shield(self._outcome)

    async def stop(self) -> None:
        """End the VM now. The job's claim is given back by the dispatcher (the Worker cannot be
        asked to give it back from outside the VM)."""
        await self._sandbox.stop_vm(self._vm)
