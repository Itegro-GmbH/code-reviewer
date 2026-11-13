# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Incus `WorkerSandbox` of the local Dispatcher (#1007, Runner v2, epic #969, spike #1005).

`start(WorkerStart)` runs one job in **two unprivileged Incus instances** made from the golden image
on a copy-on-write pool, and returns a worker that waits for it:

* **A** is the trusted one: Control (the Worker image in A's own Docker), the model door, the
  network door and the inner wall (an nft table in A, `walls.py`). Its outer NIC leads to the
  proxy of
  this dispatcher; its second NIC leads to B.
* **B** is the untrusted one: the setup **and** the agent (the same instance: what the setup left,
  its processes included, is what the agent has). Its only NIC after `narrow` is the inner one, from
  which it reaches A's two doors and nothing else.

A job:

1. takes a **slot** (the number of slots is `parallelRuns`; the two bridges of each slot were made
by
   `provision.py`), makes the job's directory and its token, and **listens on the control socket
   before the instances exist**;
2. admits the job at the **outer wall** (the wide rule of the setup);
3. creates both instances (no profile; limits, quota, devices, the job mark, the network files),
   starts A, loads the inner wall in it, starts B and waits until Docker answers in both;
4. checks the Worker image's id in A and makes the work volume;
5. runs Control with `incus exec` in A: `docker run ...` with the job document on its stdin.

`wait()` ends with the end of Control's `docker run` (its exit status is the Worker's, as vm-init's
report was) or with the **wall clock**, which kills it. Whatever ends it, both instances are deleted
(`incus delete --force`), the listener is closed, the wall's rule dropped and the job's directory
and slot given back before `wait()` returns. `stop()` kills Control's `exec` at once.

`narrow` is answered `ack` only after the outer wall holds the job's rule **and** B's outer NIC is
unplugged (`JobWall`). Instances are marked (`user.cr.job`); at every start of the service the ones
an earlier service left are deleted (`reaper.py`)."""

import asyncio
import contextlib
import fcntl
import logging
import os
import secrets
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final

from code_reviewer_runner.factory_runner.firecracker.control_run import (
    ControlRunError,
    ControlTemplate,
    load_template,
)
from code_reviewer_runner.factory_runner.firecracker.launcher import (
    EXIT_KILLED,
    LOCK_FILE,
    LOG_TAIL_BYTES,
    NoFreeSlot,
    StartFailed,
)
from code_reviewer_runner.factory_runner.firecracker.outer_rule import WEB_PORTS, app_endpoint
from code_reviewer_runner.factory_runner.firecracker.outer_wall import (
    OuterWall,
    OuterWallMode,
    VmIdentity,
    WallLifecycle,
)
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import (
    PROXY_PORT,
    ProxyOuterWall,
)
from code_reviewer_runner.factory_runner.firecracker.session import VmSession
from code_reviewer_runner.factory_runner.firecracker.tokens import generate_control_token
from code_reviewer_runner.factory_runner.sandbox import SandboxInUse, WorkerOutcome, WorkerStart
from code_reviewer_runner.implementer.environment_control import UNIX_SOCKET_PATH
from code_reviewer_runner.implementer.placement import B_DOCKER_SOCKET

from .client import ExecProcess, ExecResult, IncusClient, IncusError, InstanceSpec, run_exec
from .control_run import ControlLaunch, build_control
from .endpoint import ControlListener
from .provision import misconfigured_objects, missing_objects
from .reaper import MARK, OWNER_MARK, ROLE_MARK, SLOT_MARK, Reaped, reap_leftovers
from .settings import IncusSettings
from .slots import INNER_A_ADDRESS, INNER_B_ADDRESS, IncusSlot, SlotPool
from .walls import (
    DEVICE_INNER,
    DEVICE_OUTER,
    INNER_NIC_A,
    INNER_NIC_B,
    INNER_WALL_PATH,
    INNER_WALL_TABLE,
    OUTER_NIC,
    OUTER_NIC_B,
    JobWall,
    inner_nic,
    inner_wall_holds,
    inner_wall_ruleset,
    network_files_a,
    network_files_b,
    outer_nic,
    slot_addresses,
)

_log = logging.getLogger(__name__)

# What `WorkerOutcome.exit_code` says when Control did not end by itself: the instances ended
# without
# its status (1: an unknown outcome, the dispatcher gives the claim back) or the host killed it
# (`EXIT_KILLED`, -9, from the Firecracker launcher: the same meaning).
EXIT_NO_STATUS: Final = 1
# A write past the instance's quota: Linux's EDQUOT. The log names it (`disk_quota_exceeded`).
EXIT_DISK_QUOTA: Final = 122
QUOTA_TEXT: Final = "disk quota exceeded"
# The device of B's outer NIC, the one `narrow` unplugs.
DEVICE_B_OUTER: Final = OUTER_NIC_B
# The name of the proxy device that makes the control socket in A.
DEVICE_CONTROL: Final = "ctl"
# B's Docker for Control (#1017): two `proxy` devices chain B's own socket to a socket in A. The one
# in B listens on the host (`bind=host`: a file in the job's directory that nothing but `incusd`
# reaches) and connects to B's `docker.sock`; the one in A listens at `/b-docker.sock` and connects
# to that file. A dials B; B has no connection of any kind to A through it.
DEVICE_B_DOCKER_A: Final = "bdocker"
DEVICE_B_DOCKER_B: Final = "bdocker"
B_DOCKER_SOCKET_IN_B: Final = "/var/run/docker.sock"
B_DOCKER_FILE: Final = "bdocker.sock"
# How often the readiness probes are tried.
PROBE_SECONDS: Final = 0.25
PROBE_CALL_SECONDS: Final = 15.0
# What shows an instance its addresses: one `inet <address>/<prefix>` per address.
ADDRESS_COMMAND: Final = ("ip", "-4", "-o", "addr", "show")
IMAGE_CHECK_SECONDS: Final = 30.0
VOLUME_SECONDS: Final = 30.0


class IncusNotReady(Exception):
    """Incus lacks something the launcher needs (the pool, the image, a bridge). The message names
    the objects, never more."""


__all__ = [
    "EXIT_DISK_QUOTA",
    "EXIT_KILLED",
    "IncusNotReady",
    "IncusSandbox",
    "IncusWorker",
    "NoFreeSlot",
    "StartFailed",
]


@dataclass
class _Job:
    short: str
    slot: IncusSlot
    start: WorkerStart
    directory: Path
    session: VmSession
    listener: ControlListener
    launch: ControlLaunch
    instance_a: str
    instance_b: str
    created: list[str] = field(default_factory=list[str])
    control: ExecProcess | None = None
    started_at: float = 0.0
    ended: bool = False
    stopped: bool = False
    # Why the launcher stopped the job itself (None: `stop()` asked for it).
    stop_reason: str | None = None
    b_plugged: bool = True

    @property
    def socket(self) -> Path:
        return self.directory / "ctl.sock"

    @property
    def b_docker_socket(self) -> Path:
        """The file `incusd` makes for B's proxy device; A's device connects to it."""
        return self.directory / B_DOCKER_FILE


class IncusSandbox:
    """The `WorkerSandbox` of a machine with Incus. One per service."""

    def __init__(
        self,
        settings: IncusSettings,
        client: IncusClient,
        *,
        template: ControlTemplate | None = None,
        wall: OuterWall | None = None,
        new_token: Callable[[], str] = generate_control_token,
        logger: logging.Logger = _log,
    ) -> None:
        self.settings = settings.validated()
        self._client = client
        self._template = template or load_template()
        self._new_token = new_token
        self.logger = logger
        self._pool = SlotPool(self.settings.slots, self.settings.slot_network)
        if wall is None:
            wall = _wall_for(self.settings)
        self._wall = wall
        self._lock_fd: int | None = None
        self._lost: list[IncusSlot] = []
        self._jobs: dict[str, _Job] = {}
        self.reaped = Reaped()

    # -- what the service asks ---

    @property
    def capacity(self) -> int:
        return self.settings.slots

    @property
    def uses_host_docker(self) -> bool:
        """The Worker's Docker is inside its instance: the host's is never touched."""
        return False

    @property
    def free(self) -> int:
        return self._pool.free

    async def setup(self) -> None:
        """Before the first claim: take the lock of the state directory, check that Incus and its
        objects are there, delete what an earlier service left (`reaped`) and start the outer wall.
        Raises `SandboxInUse` when another dispatcher holds the machine (it touches nothing then),
        `IncusError` when Incus cannot be used and `OuterWallUnavailable` when the wall's proxy
        cannot listen."""
        self.settings.jobs_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._take_lock()
        lacking = await missing_objects(self._client, self.settings)
        if lacking:
            raise IncusNotReady(f"missing: {', '.join(lacking.items)}")
        wrong = await misconfigured_objects(self._client, self.settings)
        if wrong:
            raise IncusNotReady(f"not as the launcher needs them: {'; '.join(wrong)}")
        self.reaped = await reap_leftovers(self._client, self.settings.prefix, self.settings.owner)
        for leftover in self.settings.jobs_dir.glob("job-*"):
            with contextlib.suppress(OSError):
                _remove_directory(leftover, self.settings.jobs_dir)
        if isinstance(self._wall, WallLifecycle):
            await self._wall.start()

    def _take_lock(self) -> None:
        """An exclusive `flock` on `<state_dir>/dispatcher.lock`, kept until `close` or the end of
        the process: two dispatchers on one state directory would reap each other's instances and
        share its slots."""
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
        if isinstance(self._wall, WallLifecycle):
            with contextlib.suppress(Exception):
                await self._wall.close()
        descriptor, self._lock_fd = self._lock_fd, None
        if descriptor is not None:
            with contextlib.suppress(OSError):
                os.close(descriptor)

    # -- start ---

    async def start(self, start: WorkerStart) -> "IncusWorker":
        # The launch is made and checked before anything exists: a job whose id, URL or credential
        # the guest would refuse costs no slot and no instance.
        token = self._new_token()
        slot = self._pool.acquire()
        if slot is None:
            raise NoFreeSlot
        job: _Job | None = None
        try:
            launch = self._launch_for(start, token, slot)
            self._refuse_an_app_the_proxy_cannot_reach(start)
            job = self._prepare(slot, start, token, launch)
            await self._create(job)
            await self._boot(job)
            await self._hand_over(job)
        except BaseException:
            if job is not None:
                await self._destroy(job)
            elif slot not in self._lost:
                self._pool.release(slot)
            raise
        return IncusWorker(self, job)

    def _launch_for(self, start: WorkerStart, token: str, slot: IncusSlot) -> ControlLaunch:
        settings = self.settings
        try:
            return build_control(
                self._template,
                app_url=start.app_url,
                job_id=start.job_id,
                credential=start.credential,
                token=token,
                image_id=settings.image_id,
                timeout_seconds=settings.job_timeout_seconds,
                vcpus=settings.vcpus,
                reserve_gib=settings.reserve_gib,
                door_address=INNER_A_ADDRESS,
                local=start.local_credential,
                outer_proxy=(
                    {"host": slot.host_address, "port": PROXY_PORT}
                    if settings.outer_wall is OuterWallMode.PROXY
                    else None
                ),
            )
        except ControlRunError as error:
            raise StartFailed(str(error)) from None

    def _refuse_an_app_the_proxy_cannot_reach(self, start: WorkerStart) -> None:
        """With the proxy wall the Worker's own calls to the app go through the proxy, which dials
        80 and 443 only: a job on another port would end at its first call to the app."""
        if self.settings.outer_wall is not OuterWallMode.PROXY:
            return
        _, port = app_endpoint(start.app_url)
        if port is None or port in WEB_PORTS:
            return
        reason = (
            f"the app is on port {port}, which the outer wall's proxy does not dial (only "
            f"{WEB_PORTS[0]} and {WEB_PORTS[1]}): the job cannot reach it"
        )
        _log.warning("job refused before an instance exists: %s", reason)
        raise StartFailed(reason)

    def _prepare(
        self, slot: IncusSlot, start: WorkerStart, token: str, launch: ControlLaunch
    ) -> _Job:
        short = f"{slot.index}-{secrets.token_hex(4)}"
        directory = self.settings.jobs_dir / f"job-{short}"
        directory.mkdir(parents=True, mode=0o700)
        app_host, app_port = app_endpoint(start.app_url)
        identity = VmIdentity(short, slot, app_host, app_port)
        # The wall of this job unplugs B's NIC, which needs the job: the closure is bound below.
        holder: list[_Job] = []
        wall = JobWall(
            self._wall, lambda: self._unplug(holder[0]), lambda: self._end_unplugged(holder[0])
        )
        session = VmSession(identity, wall, token)
        job = _Job(
            short=short,
            slot=slot,
            start=start,
            directory=directory,
            session=session,
            listener=ControlListener(directory / "ctl.sock", session),
            launch=launch,
            instance_a=self.settings.instance_a(short),
            instance_b=self.settings.instance_b(short),
        )
        holder.append(job)
        self._jobs[short] = job
        return job

    # -- the two instances ---

    def _spec(self, job: _Job, *, role: str) -> InstanceSpec:
        settings = self.settings
        a = role == "a"
        config = {
            "security.privileged": "false",
            "security.nesting": "true",
            "security.idmap.isolated": "true",
            "limits.cpu": str(settings.a_cpus if a else settings.vcpus),
            "limits.memory": f"{settings.a_memory_mib if a else settings.memory_mib}MiB",
            "limits.memory.swap": "false",
            "limits.processes": str(settings.processes),
            "boot.autostart": "false",
            # The guest API (`/dev/incus`, formerly devlxd: the host's API for an instance) is
            # nothing the launcher or the jobs use: not offered to the setup or the agent.
            "security.guestapi": "false",
            MARK: job.start.job_id,
            SLOT_MARK: str(job.slot.index),
            ROLE_MARK: role,
            OWNER_MARK: self.settings.owner,
        }
        return InstanceSpec(
            name=job.instance_a if a else job.instance_b,
            image=settings.image,
            pool=settings.pool,
            config=config,
            disk_gib=settings.a_disk_gib if a else settings.disk_gib,
        )

    async def _create(self, job: _Job) -> None:
        settings = self.settings
        client = self._client
        slot = job.slot
        # The wall holds the wide rule of the setup for this job before any instance can reach it.
        await job.session.wall.admit(job.session.vm)
        (job.directory / "job.json").write_text(
            f'{{"job":"{job.short}","slot":{slot.index}}}', encoding="utf-8"
        )
        await job.listener.start()
        outer = settings.outer_network(slot.index)
        inner = settings.inner_network(slot.index)
        spec_a = self._spec(job, role="a")
        spec_b = self._spec(job, role="b")
        for spec in (spec_a, spec_b):
            job.created.append(spec.name)
            await client.create(spec)
        control = {
            "type": "proxy",
            "listen": f"unix:{UNIX_SOCKET_PATH}",
            "connect": f"unix:{job.socket}",
            "bind": "instance",
            "mode": "0600",
        }
        await client.add_device(
            spec_a.name, DEVICE_OUTER, outer_nic(outer, slot.guest_address, OUTER_NIC)
        )
        await client.add_device(spec_a.name, DEVICE_INNER, inner_nic(inner, INNER_NIC_A))
        await client.add_device(spec_a.name, DEVICE_CONTROL, control)
        await client.add_device(
            spec_a.name,
            DEVICE_B_DOCKER_A,
            {
                "type": "proxy",
                "listen": f"unix:{B_DOCKER_SOCKET}",
                "connect": f"unix:{job.b_docker_socket}",
                "bind": "instance",
                "mode": "0600",
            },
        )
        await client.add_device(spec_b.name, INNER_NIC_B, inner_nic(inner, INNER_NIC_B))
        await client.add_device(
            spec_b.name,
            DEVICE_B_DOCKER_B,
            {
                "type": "proxy",
                "listen": f"unix:{job.b_docker_socket}",
                "connect": f"unix:{B_DOCKER_SOCKET_IN_B}",
                "bind": "host",
                "mode": "0600",
            },
        )
        await client.add_device(
            spec_b.name, DEVICE_B_OUTER, outer_nic(outer, slot.b_address, OUTER_NIC_B)
        )
        for name, files in (
            (spec_a.name, network_files_a(slot)),
            (spec_b.name, network_files_b(slot)),
        ):
            for path, content in files:
                await client.push_file(name, path, content)
        await client.push_file(spec_a.name, INNER_WALL_PATH, inner_wall_ruleset().encode("ascii"))
        job.started_at = time.monotonic()
        self.logger.info("%s: instances made for slot %d", job.short, slot.index)

    async def _boot(self, job: _Job) -> None:
        """Start A, load the inner wall in it **before B exists as a running instance**, start B and
        wait until both have their addresses and Docker answers."""
        slot = job.slot
        await self._client.start(job.instance_a)
        await self._until_ok(
            job.instance_a, ("nft", "-f", INNER_WALL_PATH), "the inner wall could not be loaded"
        )
        await self._client.start(job.instance_b)
        await asyncio.gather(
            self._ready(job.instance_a, (slot.guest_address, INNER_A_ADDRESS), "A"),
            self._ready(job.instance_b, (INNER_B_ADDRESS, slot.b_address), "B"),
        )
        await self._read_back_the_inner_wall(job)
        # Control drives B's Docker through the socket in A: it answers before Control starts.
        await self._until_ok(
            job.instance_a,
            (
                "docker",
                "-H",
                f"unix://{B_DOCKER_SOCKET}",
                "version",
                "--format",
                "{{.Server.Version}}",
            ),
            "B's Docker does not answer in A",
        )

    async def _read_back_the_inner_wall(self, job: _Job) -> None:
        """`nft -f` ending well is not the wall: read the table back from A, now that both
        instances run, and fail the start when it is not there with its rules (the drops
        especially)."""
        listing = await run_exec(
            self._client,
            job.instance_a,
            ("nft", "list", "table", "inet", INNER_WALL_TABLE),
            timeout=PROBE_CALL_SECONDS,
        )
        if listing.exit_code != 0 or not inner_wall_holds(listing.stdout):
            raise StartFailed("the inner wall is not in place in instance A")

    async def _ready(self, instance: str, addresses: tuple[str, ...], role: str) -> None:
        """An instance is ready when systemd-networkd has applied its addresses (they come from the
        files pushed before the start, a moment after boot) and the readiness command succeeds
        (Docker answers)."""
        await self._until(
            instance,
            ADDRESS_COMMAND,
            lambda result: all(f"inet {address}/" in result.stdout for address in addresses),
            f"{role} did not get its addresses",
        )
        if self.settings.ready_command:
            await self._until_ok(
                instance, self.settings.ready_command, f"{role} did not become ready"
            )

    async def _until_ok(self, instance: str, argv: tuple[str, ...], why: str) -> None:
        """Run a command in an instance until it succeeds, for at most `ready_seconds`."""
        await self._until(instance, argv, lambda result: result.exit_code == 0, why)

    async def _until(
        self,
        instance: str,
        argv: tuple[str, ...],
        done: Callable[[ExecResult], bool],
        why: str,
    ) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.settings.ready_seconds
        while True:
            result = await run_exec(self._client, instance, argv, timeout=PROBE_CALL_SECONDS)
            if result.exit_code == 0 and done(result):
                return
            if loop.time() >= deadline:
                raise StartFailed(why)
            await asyncio.sleep(PROBE_SECONDS)

    async def _hand_over(self, job: _Job) -> None:
        """Check the Worker image, make the work volume and run Control."""
        launch = job.launch
        image = await run_exec(
            self._client,
            job.instance_a,
            ("docker", "image", "inspect", "--format", "{{.Id}}", launch.image_reference),
            timeout=IMAGE_CHECK_SECONDS,
        )
        if image.exit_code != 0:
            raise StartFailed("the Worker image is not in instance A (image_missing)")
        if image.stdout.strip() != self.settings.image_id:
            raise StartFailed(
                "the Worker image in instance A is not the verified one (image_mismatch)"
            )
        volume = await run_exec(
            self._client,
            job.instance_a,
            ("docker", "volume", "create", launch.volume_name),
            timeout=VOLUME_SECONDS,
        )
        if volume.exit_code != 0:
            raise StartFailed("the work volume could not be made in instance A")
        # From here a job and an agent may exist: every message must carry the token.
        job.session.start_acked = True
        job.control = await self._client.start_exec(
            job.instance_a, ("docker", *launch.arguments), stdin=launch.stdin
        )

    async def _unplug(self, job: _Job) -> None:
        """B's outer NIC goes (`narrow`). Idempotent: a second call finds it gone."""
        if not job.b_plugged:
            return
        await self._client.remove_device(job.instance_b, DEVICE_B_OUTER)
        job.b_plugged = False

    async def _end_unplugged(self, job: _Job) -> None:
        """B's outer NIC could not be unplugged, so B still has its way to the host: the launcher
        ends the job itself (Control is killed, `wait()` returns and deletes both instances)."""
        job.stop_reason = "B's outer NIC could not be unplugged: the job was ended"
        self.logger.error("%s: %s", job.short, job.stop_reason)
        await self.stop_job(job)

    # -- the end ---

    async def _destroy(self, job: _Job) -> None:
        """Everything of the job goes: Control's `exec`, the instances, the listener, the wall's
        rule, the directory, the slot. Idempotent; never raises."""
        if job.ended:
            return
        job.ended = True
        if job.control is not None:
            with contextlib.suppress(Exception):
                await job.control.kill()
        with contextlib.suppress(Exception):
            await job.listener.close()
        with contextlib.suppress(Exception):
            await job.session.wall.forget(job.session.vm)
        gone = True
        for name in job.created:
            try:
                await self._client.delete(name)
            except IncusError as error:
                gone = False
                self.logger.error(
                    "%s: instance %s was not deleted (%s)", job.short, name, error.detail
                )
        with contextlib.suppress(Exception):
            await asyncio.to_thread(_remove_directory, job.directory, self.settings.jobs_dir)
        self._jobs.pop(job.short, None)
        if gone:
            self._pool.release(job.slot)
        else:
            # An instance that would not go may still hold the slot's addresses: the slot stays out
            # of use until the service restarts (the reaper deletes it then).
            self._lost.append(job.slot)
            self.logger.error("%s: slot %d is out of use", job.short, job.slot.index)

    def _tail(self, text: str) -> str:
        return text[-LOG_TAIL_BYTES:]

    async def finish(self, job: _Job) -> WorkerOutcome:
        """Wait for the end of Control (or the wall clock) and clean everything up."""
        assert job.control is not None
        wall = self.settings.wall_clock_seconds(self._template.stop_timeout_seconds)
        waiter = asyncio.ensure_future(job.control.wait())
        try:
            remaining = max(wall - (time.monotonic() - job.started_at), 0.0)
            await asyncio.wait({waiter}, timeout=remaining)
            if not waiter.done():
                self.logger.error("%s: no end within %gs: killing the job", job.short, wall)
                return WorkerOutcome(EXIT_KILLED, "the job was killed at its wall clock")
            if job.stopped:
                return WorkerOutcome(EXIT_KILLED, job.stop_reason or "the job was stopped")
            result = waiter.result()
            text = f"{result.stdout}\n{result.stderr}"
            if result.exit_code != 0 and QUOTA_TEXT in text.lower():
                return WorkerOutcome(
                    EXIT_DISK_QUOTA,
                    "disk_quota_exceeded: a write failed with EDQUOT (the quota of an instance)\n"
                    + self._tail(result.stderr),
                )
            return WorkerOutcome(
                result.exit_code,
                f"Control ended with status {result.exit_code}\n" + self._tail(result.stderr),
            )
        finally:
            waiter.cancel()
            await asyncio.gather(waiter, return_exceptions=True)
            await self._destroy(job)

    async def stop_job(self, job: _Job) -> None:
        job.stopped = True
        if job.control is not None:
            await job.control.kill()


class IncusWorker:
    """The running job of one pair of instances (`RunningWorker`)."""

    def __init__(self, sandbox: IncusSandbox, job: _Job) -> None:
        self._sandbox = sandbox
        self._job = job
        self._outcome: asyncio.Future[WorkerOutcome] | None = None

    @property
    def job_id(self) -> str:
        return self._job.short

    async def wait(self) -> WorkerOutcome:
        if self._outcome is None:
            self._outcome = asyncio.ensure_future(self._sandbox.finish(self._job))
        return await asyncio.shield(self._outcome)

    async def stop(self) -> None:
        """End the job now. The claim is given back by the dispatcher (the Worker cannot be asked
        to give it back from outside the instance)."""
        await self._sandbox.stop_job(self._job)


def _wall_for(settings: IncusSettings) -> OuterWall:
    from code_reviewer_runner.factory_runner.firecracker.outer_wall import outer_wall_for

    if settings.outer_wall is OuterWallMode.PROXY:
        return ProxyOuterWall(
            settings.slots, network=settings.slot_network, addresses=slot_addresses
        )
    return outer_wall_for(settings.outer_wall, settings.slots, settings.slot_network)


def _remove_directory(directory: Path, parent: Path) -> None:
    """Delete a job's directory (its socket and record): only a direct child of `jobs/`."""
    if directory.parent != parent or not directory.name.startswith("job-"):
        raise OSError("not a job directory")
    for entry in directory.iterdir():
        entry.unlink(missing_ok=True)
    directory.rmdir()
