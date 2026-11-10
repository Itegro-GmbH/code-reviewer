# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the Firecracker launcher is told (#978): where the artifacts and the state are, how big a
VM is, how many run at once, and how long one may take.

Files under `/var/lib/code-reviewer/` (the state directory; `FACTORY_RUNNER_VM_STATE_DIR`):

    artifacts/vmlinux, rootfs.ext4, dockerdata.ext4
        what the installer put there (#982): the guest kernel, the read-only root file system and
        the base of the per-job Docker disk
    vms/vm-<slot>-<random>/
        one directory per running VM, made before it starts and deleted when it is gone:
        disk.ext4                                      the job disk (the quota is its size)
        vsock.sock, vsock.sock_5100, vsock.sock_5101   Firecracker's vsock, the host's two listeners
        firecracker.json, firecracker.log, vm.json     its configuration, its stderr, a record

The wall clock of a VM is the host's (vm-init keeps no time for the job): the job's timeout plus
what Control's container may take to stop plus the preparation. A VM that is still there then is
killed."""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final

from .control_run import MEMORY_MIB_PER_VCPU, VCPU_SIZES
from .disks import GIB
from .outer_wall import OuterWallMode
from .slots import MAX_SLOTS

STATE_DIR: Final = Path("/var/lib/code-reviewer")
FIRECRACKER: Final = Path("/usr/local/bin/firecracker")
# The command line and the init of a release (`dispatcher/src/vm-artifacts/boot.ts`; a test holds
# them equal). A release's manifest carries them too (`kernel.bootArgs`, `kernel.initCommand`).
BOOT_ARGS: Final = (
    "reboot=k panic=1 pci=off i8042.noaux i8042.nokbd cgroup_no_v1=all root=/dev/vda ro "
    "rootfstype=ext4 8250.nr_uarts=0 quiet loglevel=0"
)
INIT_COMMAND: Final = "/usr/bin/docker-init -- /usr/local/sbin/vm-boot"
DEFAULT_JOB_TIMEOUT_SECONDS: Final = 3600
DEFAULT_DISK_GIB: Final = 16
# What the start of a VM (boot, the daemon, the image check, Sysbox, the work volume) may take at
# most: `StartWaitSeconds` of the contract.
PREPARATION_SECONDS: Final = 300

VARIABLE_PREFIX: Final = "FACTORY_RUNNER_"


class SettingsError(Exception):
    """A setting is missing or unusable. The message names it, never a value."""


@dataclass(frozen=True)
class FirecrackerSettings:
    kernel: Path
    rootfs: Path
    base_disk: Path
    # The Worker image's id from the verified manifest: vm-init refuses any other image.
    image_id: str
    state_dir: Path = STATE_DIR
    firecracker: Path = FIRECRACKER
    slots: int = 1
    vcpus: int = 2
    disk_gib: int = DEFAULT_DISK_GIB
    job_timeout_seconds: int = DEFAULT_JOB_TIMEOUT_SECONDS
    outer_wall: OuterWallMode = OuterWallMode.REFUSE
    boot_args: str = BOOT_ARGS
    init_command: str = INIT_COMMAND
    # The delegated cgroup; None: the one this process runs in.
    cgroup_root: Path | None = None
    # How long the host waits for the first connection to the VM, and for vm-init's `ack`.
    boot_connect_seconds: float = 30.0
    start_ack_seconds: float = 120.0
    # How long a VM that reported gets to power itself off before the host kills it.
    kill_grace_seconds: float = 5.0
    preparation_seconds: float = float(PREPARATION_SECONDS)

    @property
    def vms_dir(self) -> Path:
        return self.state_dir / "vms"

    @property
    def memory_mib(self) -> int:
        return self.vcpus * MEMORY_MIB_PER_VCPU

    @property
    def quota_bytes(self) -> int:
        return self.disk_gib * GIB

    @property
    def reserve_gib(self) -> int:
        """The reserve disk of the work volume, an eighth of the job disk (hosted: 8 of 64)."""
        return max(1, min(64, self.disk_gib // 8))

    def wall_clock_seconds(self, stop_timeout_seconds: int) -> float:
        """The hard limit of a VM: the job's timeout, Control's stop timeout, the preparation."""
        return self.job_timeout_seconds + stop_timeout_seconds + self.preparation_seconds

    def validated(self) -> "FirecrackerSettings":
        if not 1 <= self.slots <= MAX_SLOTS:
            raise SettingsError(f"slots: 1 to {MAX_SLOTS}")
        if self.vcpus not in VCPU_SIZES:
            raise SettingsError(f"vcpus: one of {', '.join(map(str, VCPU_SIZES))}")
        if self.disk_gib < 8:
            raise SettingsError("diskGb: at least 8 (the images alone take 6 GiB)")
        if self.job_timeout_seconds < 1:
            raise SettingsError("RUNNER_JOB_TIMEOUT_SECONDS: at least 1")
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
) -> FirecrackerSettings:
    """The settings of a machine: its environment (`FACTORY_RUNNER_VM_*`,
    `FACTORY_RUNNER_OUTER_WALL`), the runner's limits (`parallelRuns` is the number of slots,
    `diskGb` the quota) and the job timeout of the Worker's environment. Raises `SettingsError`."""
    state = Path(environment.get("FACTORY_RUNNER_VM_STATE_DIR", "").strip() or STATE_DIR)
    artifacts = state / "artifacts"

    def path(name: str, default: Path) -> Path:
        return Path(environment.get(name, "").strip() or default)

    image_id = environment.get("FACTORY_RUNNER_VM_IMAGE_ID", "").strip()
    if not image_id:
        raise SettingsError("FACTORY_RUNNER_VM_IMAGE_ID is not set (the Worker image's id)")
    wall = environment.get("FACTORY_RUNNER_OUTER_WALL", "").strip() or OuterWallMode.REFUSE.value
    try:
        mode = OuterWallMode(wall)
    except ValueError:
        raise SettingsError("FACTORY_RUNNER_OUTER_WALL is refuse or inner-only") from None
    settings = FirecrackerSettings(
        kernel=path("FACTORY_RUNNER_VM_KERNEL", artifacts / "vmlinux"),
        rootfs=path("FACTORY_RUNNER_VM_ROOTFS", artifacts / "rootfs.ext4"),
        base_disk=path("FACTORY_RUNNER_VM_BASE_DISK", artifacts / "dockerdata.ext4"),
        image_id=image_id,
        state_dir=state,
        firecracker=path("FACTORY_RUNNER_FIRECRACKER", FIRECRACKER),
        slots=parallel_runs,
        vcpus=_whole(environment, "FACTORY_RUNNER_VM_VCPUS") or 2,
        disk_gib=disk_gb or DEFAULT_DISK_GIB,
        job_timeout_seconds=_whole(job_environment or {}, "RUNNER_JOB_TIMEOUT_SECONDS")
        or DEFAULT_JOB_TIMEOUT_SECONDS,
        outer_wall=mode,
    )
    return settings.validated()


def with_changes(settings: FirecrackerSettings, **changes: object) -> FirecrackerSettings:
    return replace(settings, **changes)  # type: ignore[arg-type]
