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
import fcntl
import json
import logging
import os
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Protocol

from code_reviewer_runner.factory_runner.sandbox import SandboxInUse, WorkerOutcome, WorkerStart
from code_reviewer_runner.vm_init.wire import InvalidStart, parse_start

from . import vmm
from .cgroups import CgroupError, CgroupTree, VmLimits, delegated_root
from .control_run import ControlRunError, ControlTemplate, build_start, load_template
from .disks import DiskError, make_job_disk, remove_vm_directory
from .endpoint import HostListeners, StartNotAnswered, StartRefused, send_start
from .outer_rule import WEB_PORTS, app_endpoint
from .outer_wall import OuterWall, OuterWallMode, VmIdentity, WallLifecycle, outer_wall_for
from .proxy_wall import PROXY_PORT
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
# `firecracker.log` holds the end of what the VMM wrote and never more than this (a VMM that loops
# on an error, or a serial console, would fill the disk): when the file would pass it, it is
# truncated and the last `LOG_KEEP_BYTES` are written again, so the tail is never lost to the cut.
LOG_FILE_MAX_BYTES: Final = 4 * 1024 * 1024
LOG_KEEP_BYTES: Final = 16 * 1024
LOG_CHUNK_BYTES: Final = 64 * 1024
# The lock of the state directory: one dispatcher per machine.
LOCK_FILE: Final = "dispatcher.lock"


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


@dataclass
class _Vm:
    vm_id: str
    slot: Slot
    directory: Path
    session: VmSession
    listeners: HostListeners
    cgroup: Path | None = None
    process: asyncio.subprocess.Process | None = None
    # Reads the VMM's output into `firecracker.log` (bounded); `log_written` is the file's size.
    pump: "asyncio.Future[None] | None" = None
    log_written: int = 0
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
    _lock_fd: int | None = field(init=False, default=None)
    _lost: list[Slot] = field(init=False, default_factory=list[Slot])
    _vms: dict[str, _Vm] = field(init=False, default_factory=dict[str, _Vm])
    # What the last `setup` removed.
    reaped: Reaped = field(init=False, default_factory=Reaped)

    def __post_init__(self) -> None:
        self.settings = self.settings.validated()
        self._pool = SlotPool(self.settings.slots, self.settings.slot_network)
        if self.wall is None:
            self.wall = outer_wall_for(
                self.settings.outer_wall, self.settings.slots, self.settings.slot_network
            )

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
        """Before the first claim: take the lock of the state directory, make the cgroup tree usable
        and remove what an earlier service left (`reaped`). Raises `SandboxInUse` when another
        dispatcher holds the machine (it touches nothing then: what it would remove as a leftover
        is that dispatcher's running VMs), `CgroupError` when the delegated cgroup cannot be
        used and `OuterWallUnavailable` when the outer wall's proxy cannot listen (the log names
        the TAP). The wall starts last: it listens only for a service that holds the machine."""
        self.settings.vms_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._take_lock()
        if self.cgroups is None:
            tree = CgroupTree(self.settings.cgroup_root or delegated_root())
            self.cgroups = tree
        self.cgroups.prepare()
        tree = self.cgroups if isinstance(self.cgroups, CgroupTree) else None
        self.reaped = await asyncio.to_thread(
            lambda: reap_leftovers(
                self.settings.vms_dir, tree, firecracker=self.settings.firecracker
            )
        )
        if isinstance(self.wall, WallLifecycle):
            await self.wall.start()

    def _take_lock(self) -> None:
        """An exclusive `flock` on `<state_dir>/dispatcher.lock`, kept until `close` or the end of
        the process (the kernel lets go of it then, whatever way the process ends). Two dispatchers
        on one state directory would reap each other's VMs and share its slots and TAPs."""
        if self._lock_fd is not None:
            return
        descriptor = os.open(
            self.settings.state_dir / LOCK_FILE, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600
        )
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(descriptor)
            raise SandboxInUse(
                "another dispatcher runs on this machine (it holds the lock of the state "
                "directory); one dispatcher per machine, `run --once` included"
            ) from None
        except OSError:
            os.close(descriptor)
            raise
        self._lock_fd = descriptor

    async def close(self) -> None:
        """Stop the wall's listeners and let go of the lock."""
        if isinstance(self.wall, WallLifecycle):
            with contextlib.suppress(Exception):
                await self.wall.close()
        descriptor, self._lock_fd = self._lock_fd, None
        if descriptor is not None:
            with contextlib.suppress(OSError):
                os.close(descriptor)

    async def start(self, start: WorkerStart) -> "FirecrackerWorker":
        # The start document is made and checked before anything exists: a job whose id, URL or
        # credential the VM would refuse costs no slot, no disk copy and no VMM.
        token = self.new_token()
        # Checked with the address of the first slot: the document does not depend on which slot
        # the job gets, and the slot's own address is put in below, once there is one.
        self._start_document(start, token, Slot(0, self.settings.slot_network))
        slot = self._pool.acquire()
        if slot is None:
            raise NoFreeSlot
        vm: _Vm | None = None
        try:
            document = self._start_document(start, token, slot)
            vm = await self._create(slot, start, token)
            await self._hand_over(vm, document)
        except BaseException:
            if vm is not None:
                await self._destroy(vm)
            elif slot not in self._lost:
                # Nothing was made yet; a slot whose VMM would not die stays out of use.
                self._pool.release(slot)
            raise
        return FirecrackerWorker(self, vm)

    # -- one VM ---

    async def _create(self, slot: Slot, start: WorkerStart, token: str) -> _Vm:
        settings = self.settings
        vm_id = f"vm-{slot.index}-{secrets.token_hex(4)}"
        directory = settings.vms_dir / vm_id
        directory.mkdir(parents=True, mode=0o700)
        wall = self.wall or outer_wall_for(settings.outer_wall, settings.slots)
        app_host, app_port = app_endpoint(start.app_url)
        if settings.outer_wall is OuterWallMode.PROXY and app_port not in (None, *WEB_PORTS):
            # The Worker's own calls go through the proxy, which dials 80 and 443 only: this job
            # ends at its first call to the app, and its `narrow` is refused.
            self.logger.warning(
                "%s: the app is on port %s, which the outer wall's proxy does not dial (only "
                "%d and %d): the job cannot reach it",
                vm_id,
                app_port,
                *WEB_PORTS,
            )
        session = VmSession(VmIdentity(vm_id, slot, app_host, app_port), wall, token)
        listeners = HostListeners(directory / "vsock.sock", session)
        vm = _Vm(vm_id, slot, directory, session, listeners)
        self._vms[vm_id] = vm
        try:
            # The wall holds the wide rule of the setup for this VM before the VMM exists: nothing
            # of the VM reaches a proxy that has no rule for it.
            await wall.admit(session.vm)
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
        log = os.open(
            vm.directory / "firecracker.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        try:
            process = await asyncio.create_subprocess_exec(
                *vmm.command(settings, vm.directory / "firecracker.json"),
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                env={},
                cwd=vm.directory,
                start_new_session=True,
                preexec_fn=preexec,
            )
        except BaseException:
            os.close(log)
            raise
        finally:
            if close is not None:
                close()
        assert process.stdout is not None
        # The VMM's output goes through a pipe this service reads: the file is bounded, not the
        # VMM's own to fill.
        vm.pump = asyncio.ensure_future(self._pump(vm, process.stdout, log))
        return process

    async def _pump(self, vm: _Vm, stream: asyncio.StreamReader, descriptor: int) -> None:
        """Copy the VMM's output into `firecracker.log`, never more than `LOG_FILE_MAX_BYTES` of it:
        past the limit the file is cut and the last `LOG_KEEP_BYTES` written again. The reading
        never stops while the VMM lives (a VMM whose pipe is full would block); what cannot be
        written (a full disk) is dropped."""
        recent = bytearray()
        try:
            while chunk := await stream.read(LOG_CHUNK_BYTES):
                try:
                    if vm.log_written + len(chunk) > LOG_FILE_MAX_BYTES:
                        os.ftruncate(descriptor, 0)
                        os.write(descriptor, bytes(recent))
                        vm.log_written = len(recent)
                    os.write(descriptor, chunk)
                    vm.log_written += len(chunk)
                except OSError:
                    pass
                recent += chunk
                del recent[:-LOG_KEEP_BYTES]
        finally:
            os.close(descriptor)

    async def _drain_log(self, vm: _Vm) -> None:
        """Wait a moment for the pump to read what the VMM wrote before it ended."""
        if vm.pump is not None:
            await asyncio.wait({vm.pump}, timeout=1.0)

    async def _hand_over(self, vm: _Vm, document: dict[str, Any]) -> None:
        """Send the start and wait for vm-init's `ack`. The start fails when the VM refuses it,
        ends first, reports first (before it ever took the job) or does not answer in time."""
        settings = self.settings
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

    def _outer_proxy(self, slot: Slot) -> dict[str, Any] | None:
        """The proxy the VM in `slot` dials through, or None: with the proxy wall it is the host's
        side of the slot's TAP, where the proxy listens (`proxy_wall.py`); with another wall the
        VM has none (the inner wall only, or no wall at all)."""
        if self.settings.outer_wall is not OuterWallMode.PROXY:
            return None
        return {"host": slot.host_address, "port": PROXY_PORT}

    def _start_document(self, start: WorkerStart, token: str, slot: Slot) -> dict[str, Any]:
        settings = self.settings
        try:
            document = build_start(
                self.template,
                app_url=start.app_url,
                job_id=start.job_id,
                credential=start.credential,
                token=token,
                image_id=settings.image_id,
                timeout_seconds=settings.job_timeout_seconds,
                vcpus=settings.vcpus,
                reserve_gib=settings.reserve_gib,
                local=start.local_credential,
                outer_proxy=self._outer_proxy(slot),
            )
            # What vm-init would check, checked here first (it names a field, never a value).
            parse_start(document)
        except ControlRunError as error:
            raise StartFailed(str(error)) from None
        except InvalidStart as error:
            raise StartFailed(str(error)) from None
        return document

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
            await vm.session.wall.forget(vm.session.vm)
        if vm.pump is not None:
            await self._drain_log(vm)
            vm.pump.cancel()
            await asyncio.gather(vm.pump, return_exceptions=True)
        if vm.cgroup is not None and self.cgroups is not None and gone:
            # Off the event loop: removing a cgroup retries for seconds while a process leaves it,
            # and every other VM's listeners are served by this loop. A VMM that is not gone keeps
            # its cgroup (the reaper of the next start removes it).
            try:
                if not await asyncio.to_thread(self.cgroups.remove, vm.cgroup):
                    self.logger.warning("%s: its cgroup stays", vm.vm_id)
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
        """The end of the VMM's log: the file is read from `LOG_TAIL_BYTES` before its end, never
        whole."""
        try:
            with (vm.directory / "firecracker.log").open("rb") as handle:
                size = handle.seek(0, os.SEEK_END)
                handle.seek(max(size - LOG_TAIL_BYTES, 0))
                raw = handle.read(LOG_TAIL_BYTES)
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
                await self._drain_log(vm)
                return WorkerOutcome(
                    report.exit_code,
                    f"vm-init reported {report.reason.value} ({report.exit_code})\n"
                    + self._log_tail(vm),
                )
            if vm.stopped:
                return WorkerOutcome(EXIT_KILLED, "the VM was stopped")
            await self._drain_log(vm)
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
