# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a machine with the Firecracker sandbox finds out before it takes a job (#978): the
counterpart of `factory_runner/prepare.py` for a machine that needs no Docker.

The checks are about the host: the kernel, the root file system and the base disk are there, the
`firecracker` program runs, `/dev/kvm` can be opened by this user, the delegated cgroup has the
controllers the limits need, every slot has its TAP device. They are what the installer (#982)
arranges; a machine that fails one is not ready and the check says which. The VM's own content (its
Docker, Sysbox, the Worker image) is proven by the release's smoke boot in CI, not here: a runner
does not boot a VM to announce itself. Until #982 this is selected by `FACTORY_RUNNER_SANDBOX=
firecracker`, beside the Worker-as-a-process mode."""

import os
from collections.abc import Callable, Mapping
from pathlib import Path

from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.prepare import (
    Prepared,
    announcement_for,
    implementer_settings,
)
from code_reviewer_runner.factory_runner.selftest import (
    CHECK_AGENT_DOCKER,
    Check,
    SelfTestResult,
)
from code_reviewer_runner.job_loop.settings import worker_settings_from_environment

from .cgroups import CONTROLLERS, CgroupError, delegated_root
from .settings import FirecrackerSettings, SettingsError, settings_from_environment
from .slots import Slot

RUNTIME = "firecracker"
KVM = Path("/dev/kvm")
NET = Path("/sys/class/net")

# What the checks look at; a test brings its own.
Access = Callable[[Path, int], bool]


def _access(path: Path, mode: int) -> bool:
    return os.access(path, mode)


def host_checks(
    settings: FirecrackerSettings,
    *,
    access: Access = _access,
    kvm: Path = KVM,
    net: Path = NET,
    cgroup: Callable[[], Path] = delegated_root,
) -> tuple[Check, ...]:
    """One check per thing the installer must have arranged. A detail never holds a secret."""
    checks: list[Check] = []

    def check(name: str, ok: bool, detail: str) -> None:
        checks.append(Check(name, ok, "" if ok else detail))

    for name, path in (
        ("vm-kernel", settings.kernel),
        ("vm-rootfs", settings.rootfs),
        ("vm-base-disk", settings.base_disk),
    ):
        check(name, access(path, os.R_OK), f"{path} is missing or cannot be read")
    check(
        "firecracker",
        access(settings.firecracker, os.X_OK),
        f"{settings.firecracker} is missing or not executable",
    )
    check("kvm", access(kvm, os.R_OK | os.W_OK), f"{kvm} cannot be opened (group kvm?)")
    try:
        root = cgroup()
        controllers = (root / "cgroup.controllers").read_text(encoding="utf-8").split()
        missing = [name for name in CONTROLLERS if name not in controllers]
        check(
            "cgroup",
            not missing and access(root, os.W_OK),
            f"the delegated cgroup lacks {', '.join(missing) or 'write access'} (Delegate=yes?)",
        )
    except (CgroupError, OSError):
        check("cgroup", False, "the delegated cgroup cannot be read (Delegate=yes?)")
    absent = [
        slot.tap for slot in map(Slot, range(settings.slots)) if not (net / slot.tap).exists()
    ]
    check("vm-taps", not absent, f"no TAP device {', '.join(absent)} (made at install)")
    return tuple(checks)


def prepare_firecracker(
    config: RunnerConfig,
    source: Mapping[str, str],
    *,
    checks: Callable[[FirecrackerSettings], tuple[Check, ...]] = host_checks,
) -> Prepared:
    """Test the machine and decide what the runner is. Never raises: a machine that is not ready
    is a `Prepared` whose base is not proven, and the failed check says why."""
    settings = implementer_settings(worker_settings_from_environment(source))
    try:
        vm = settings_from_environment(
            source,
            parallel_runs=config.limits.parallel_runs,
            disk_gb=config.limits.disk_gb,
            job_environment=source,
        )
    except SettingsError as error:
        result = SelfTestResult((Check("vm-settings", False, str(error)),), RUNTIME)
        return Prepared(settings, {}, announcement_for(config, result, None), result)
    results = (*checks(vm), Check(CHECK_AGENT_DOCKER, True, "Docker and Sysbox are in the VM"))
    result = SelfTestResult(results, RUNTIME)
    environment = {name: source[name] for name in ("RUNNER_JOB_TIMEOUT_SECONDS",) if name in source}
    return Prepared(settings, environment, announcement_for(config, result, vm.memory_mib), result)
