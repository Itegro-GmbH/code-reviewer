# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Incus launcher is told (#1007): which pool, image and names it uses, how big the two
instances of a job are, how many jobs run at once and how long one may take.

Everything the launcher makes is named after `prefix` (default `cr`): instances `<prefix>-a-<id>`
and `<prefix>-b-<id>`, the networks and ACLs `<prefix>-out<N>` and `<prefix>-in<N>` of slot N. The
launcher touches only objects of that name and only instances that carry its mark
(`user.cr.job`): never the `default` pool or profile, `incusbr0`, or an instance, network or
profile it did not make.

Files under the state directory (`FACTORY_RUNNER_VM_STATE_DIR`, `/var/lib/code-reviewer`):

    dispatcher.lock          one dispatcher per machine
    jobs/job-<slot>-<random>/ctl.sock   the host's end of a job's environment control (0600);
                                        incusd connects to it (the daemon must see the path: not
                                        `/tmp`, which its unit may hide)
"""

import ipaddress
import re
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final

from code_reviewer_runner.factory_runner.firecracker.control_run import (
    MEMORY_MIB_PER_VCPU,
    VCPU_SIZES,
)
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode

from .slots import DEFAULT_SLOT_NETWORK, MAX_SLOTS, parse_slot_network

STATE_DIR: Final = Path("/var/lib/code-reviewer")
INCUS: Final = "incus"
DEFAULT_PREFIX: Final = "cr"
DEFAULT_IMAGE: Final = "code-reviewer-golden"
DEFAULT_JOB_TIMEOUT_SECONDS: Final = 3600
DEFAULT_DISK_GIB: Final = 16
# Instance A (Control, the doors, the inner wall) holds the golden image and the Worker image.
DEFAULT_A_DISK_GIB: Final = 8
DEFAULT_A_MEMORY_MIB: Final = 2048
DEFAULT_A_CPUS: Final = 2
# `limits.processes` of each instance (the spike's profile).
DEFAULT_PROCESSES: Final = 4096
# What the start of the two instances (their boot, the daemon, the image check) may take at most.
PREPARATION_SECONDS: Final = 300
# The name of a Docker-based readiness probe: Docker answers, in both instances.
READY_COMMAND: Final = ("docker", "info")

VARIABLE_PREFIX: Final = "FACTORY_RUNNER_"
_PREFIX = re.compile(r"[a-z][a-z0-9]{0,15}")
_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,62}")


class SettingsError(Exception):
    """A setting is missing or unusable. The message names it, never a value."""


@dataclass(frozen=True)
class IncusSettings:
    # The storage pool the instances live on (a copy-on-write pool: btrfs, so that a job's disk is
    # a snapshot and its quota is enforced: EDQUOT).
    pool: str
    # The Worker image's id from the verified manifest: the launcher refuses any other.
    image_id: str
    # The golden image's alias (or fingerprint) in Incus.
    image: str = DEFAULT_IMAGE
    prefix: str = DEFAULT_PREFIX
    incus: str = INCUS
    state_dir: Path = STATE_DIR
    slots: int = 1
    slot_network: ipaddress.IPv4Network = DEFAULT_SLOT_NETWORK
    vcpus: int = 2
    # None: the hosted table (2 GiB per vCPU).
    memory_mib_override: int | None = None
    disk_gib: int = DEFAULT_DISK_GIB
    a_cpus: int = DEFAULT_A_CPUS
    a_memory_mib: int = DEFAULT_A_MEMORY_MIB
    a_disk_gib: int = DEFAULT_A_DISK_GIB
    processes: int = DEFAULT_PROCESSES
    job_timeout_seconds: int = DEFAULT_JOB_TIMEOUT_SECONDS
    outer_wall: OuterWallMode = OuterWallMode.REFUSE
    # How long one `incus` call may take (a delete of a running instance takes up to 4 s).
    call_seconds: float = 120.0
    # How long both instances may take to answer the readiness command.
    ready_seconds: float = 120.0
    ready_command: tuple[str, ...] = READY_COMMAND
    # How long the host waits for Control's `docker run` to start answering `incus exec`.
    preparation_seconds: float = float(PREPARATION_SECONDS)
    # How long a worker that ended gets before it is killed.
    kill_grace_seconds: float = 5.0

    @property
    def jobs_dir(self) -> Path:
        return self.state_dir / "jobs"

    @property
    def memory_mib(self) -> int:
        """Instance B's memory: the agent's room (the hosted table)."""
        return self.memory_mib_override or self.vcpus * MEMORY_MIB_PER_VCPU

    @property
    def reserve_gib(self) -> int:
        """The reserve disk of the work volume's Control, an eighth of B's disk (hosted: 8 of
        64)."""
        return max(1, min(64, self.disk_gib // 8))

    def wall_clock_seconds(self, stop_timeout_seconds: int) -> float:
        """The hard limit of a job: the job's timeout, Control's stop timeout, the preparation."""
        return self.job_timeout_seconds + stop_timeout_seconds + self.preparation_seconds

    def instance_a(self, job: str) -> str:
        return f"{self.prefix}-a-{job}"

    def instance_b(self, job: str) -> str:
        return f"{self.prefix}-b-{job}"

    def outer_network(self, slot: int) -> str:
        return f"{self.prefix}-out{slot}"

    def inner_network(self, slot: int) -> str:
        return f"{self.prefix}-in{slot}"

    def validated(self) -> "IncusSettings":
        if not _PREFIX.fullmatch(self.prefix):
            raise SettingsError("prefix: lower-case letters and digits, starting with a letter")
        if not _NAME.fullmatch(self.pool):
            raise SettingsError("pool: not a name of an Incus storage pool")
        if not _NAME.fullmatch(self.image):
            raise SettingsError("image: not an alias or fingerprint of an Incus image")
        if not 1 <= self.slots <= MAX_SLOTS:
            raise SettingsError(f"slots: 1 to {MAX_SLOTS}")
        if self.slot_network.num_addresses < self.slots * 8:
            raise SettingsError("slotNetwork: too small for the number of slots")
        if self.vcpus not in VCPU_SIZES:
            raise SettingsError(f"vcpus: one of {', '.join(map(str, VCPU_SIZES))}")
        # The quota counts the image the instance is made from too (referenced size): it must leave
        # the job room, which only the image's size says; the floor is a sanity check.
        if self.disk_gib < 2 or self.a_disk_gib < 2:
            raise SettingsError("diskGb: at least 2 (the quota counts the image too)")
        if self.job_timeout_seconds < 1:
            raise SettingsError("RUNNER_JOB_TIMEOUT_SECONDS: at least 1")
        if self.memory_mib < 512 or self.a_memory_mib < 512:
            raise SettingsError("memory: at least 512 MiB per instance")
        if self.a_cpus < 1:
            raise SettingsError("cpus: at least 1 per instance")
        return self


def _whole(environment: Mapping[str, str], name: str) -> int | None:
    raw = environment.get(name, "").strip()
    if not raw:
        return None
    if not raw.isascii() or not raw.isdigit():
        raise SettingsError(f"{name} is not a whole number")
    return int(raw)


def settings_from_environment(
    environment: Mapping[str, str],
    *,
    parallel_runs: int = 1,
    disk_gb: int | None = None,
    job_environment: Mapping[str, str] | None = None,
) -> IncusSettings:
    """The settings of a machine: its environment (`FACTORY_RUNNER_INCUS_*`, `FACTORY_RUNNER_VM_*`,
    `FACTORY_RUNNER_OUTER_WALL`, `FACTORY_RUNNER_SLOT_NETWORK`), the runner's limits
    (`parallelRuns` is the number of slots, `diskGb` B's quota) and the job timeout of the Worker's
    environment. Raises `SettingsError`."""

    def text(name: str, default: str = "") -> str:
        return environment.get(name, "").strip() or default

    pool = text("FACTORY_RUNNER_INCUS_POOL")
    if not pool:
        raise SettingsError("FACTORY_RUNNER_INCUS_POOL is not set (the storage pool of the jobs)")
    image_id = text("FACTORY_RUNNER_VM_IMAGE_ID")
    if not image_id:
        raise SettingsError("FACTORY_RUNNER_VM_IMAGE_ID is not set (the Worker image's id)")
    wall = text("FACTORY_RUNNER_OUTER_WALL", OuterWallMode.REFUSE.value)
    try:
        mode = OuterWallMode(wall)
    except ValueError:
        raise SettingsError("FACTORY_RUNNER_OUTER_WALL is proxy, refuse or inner-only") from None
    network_text = text("FACTORY_RUNNER_SLOT_NETWORK")
    try:
        slot_network = (
            parse_slot_network(network_text, parallel_runs)
            if network_text
            else DEFAULT_SLOT_NETWORK
        )
    except ValueError as error:
        raise SettingsError(f"FACTORY_RUNNER_SLOT_NETWORK must be {error}") from None
    settings = IncusSettings(
        pool=pool,
        image_id=image_id,
        image=text("FACTORY_RUNNER_INCUS_IMAGE", DEFAULT_IMAGE),
        prefix=text("FACTORY_RUNNER_INCUS_PREFIX", DEFAULT_PREFIX),
        incus=text("FACTORY_RUNNER_INCUS", INCUS),
        state_dir=Path(text("FACTORY_RUNNER_VM_STATE_DIR") or STATE_DIR),
        slots=parallel_runs,
        slot_network=slot_network,
        vcpus=_whole(environment, "FACTORY_RUNNER_VM_VCPUS") or 2,
        disk_gib=disk_gb or DEFAULT_DISK_GIB,
        a_disk_gib=_whole(environment, "FACTORY_RUNNER_INCUS_A_DISK_GB") or DEFAULT_A_DISK_GIB,
        a_memory_mib=_whole(environment, "FACTORY_RUNNER_INCUS_A_MEMORY_MB")
        or DEFAULT_A_MEMORY_MIB,
        job_timeout_seconds=_whole(job_environment or {}, "RUNNER_JOB_TIMEOUT_SECONDS")
        or DEFAULT_JOB_TIMEOUT_SECONDS,
        outer_wall=mode,
    )
    return settings.validated()


def with_changes(settings: IncusSettings, **changes: object) -> IncusSettings:
    return replace(settings, **changes)  # type: ignore[arg-type]
