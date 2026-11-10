# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the runner selects and prepares the Firecracker sandbox (#978): the host checks of a machine,
the number of slots from `parallelRuns`, and `run` with `FACTORY_RUNNER_SANDBOX=firecracker`."""

import io
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.factory_runner.base import EXIT_NOT_READY
from code_reviewer_runner.factory_runner.cli import CliSeams, main
from code_reviewer_runner.factory_runner.config import (
    ConfigError,
    RunnerConfig,
    check_limits,
    load_config,
)
from code_reviewer_runner.factory_runner.firecracker.factory import firecracker_sandbox_factory
from code_reviewer_runner.factory_runner.firecracker.launcher import FirecrackerSandbox
from code_reviewer_runner.factory_runner.firecracker.prepare import (
    host_checks,
    prepare_firecracker,
)
from code_reviewer_runner.factory_runner.firecracker.settings import (
    FirecrackerSettings,
    settings_from_environment,
)
from code_reviewer_runner.factory_runner.prepare import Prepared
from code_reviewer_runner.factory_runner.selftest import Check

pytestmark = pytest.mark.unit

IMAGE_ID = "sha256:" + "ab" * 32
CREDENTIAL = "crc_" + "A" * 43


def config(**limits: Any) -> RunnerConfig:
    return RunnerConfig(
        url="https://app.example",
        credential=CREDENTIAL,
        runner_id="runner-1",
        labels=("linux",),
        limits=check_limits(limits, max_parallel=64),
    )


def environment(**more: str) -> dict[str, str]:
    return {"FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID, **more}


# -- the slots are parallelRuns ---


# #978-T10
def test_the_slots_of_a_firecracker_runner_are_its_parallel_runs_and_a_docker_runner_has_one() -> (
    None
):
    limits = {"parallelRuns": 4}

    assert check_limits(limits, max_parallel=64).parallel_runs == 4
    with pytest.raises(ConfigError, match="Firecracker"):
        check_limits(limits)
    with pytest.raises(ConfigError, match="at most 64"):
        check_limits({"parallelRuns": 65}, max_parallel=64)


# #978-T10
def test_the_environment_chooses_the_sandbox_and_the_number_of_slots(tmp_path: Path) -> None:
    home = {"FACTORY_RUNNER_HOME": str(tmp_path), "FACTORY_RUNNER_URL": "https://app.example"}

    vm = load_config(
        {**home, "FACTORY_RUNNER_SANDBOX": "firecracker", "FACTORY_RUNNER_PARALLEL_RUNS": "3"}
    )

    assert vm.limits.parallel_runs == 3
    with pytest.raises(ConfigError, match="one job at a time"):
        load_config({**home, "FACTORY_RUNNER_PARALLEL_RUNS": "3"})


# -- the host's checks ---


def everything_there(path: Path, mode: int) -> bool:
    return True


def cgroup_with(tmp_path: Path, controllers: str) -> Path:
    root = tmp_path / "unit"
    root.mkdir(exist_ok=True)
    (root / "cgroup.controllers").write_text(controllers)
    return root


def vm_settings(**changes: Any) -> FirecrackerSettings:
    return settings_from_environment(environment(**changes), parallel_runs=2)


# #978-T16
def test_a_machine_with_everything_the_installer_makes_passes_every_check(tmp_path: Path) -> None:
    net = tmp_path / "net"
    for tap in ("fctap0", "fctap1"):
        (net / tap).mkdir(parents=True)
    root = cgroup_with(tmp_path, "cpuset cpu io memory pids")

    checks = host_checks(
        vm_settings(), access=everything_there, net=net, cgroup=lambda: root, kvm=tmp_path / "kvm"
    )

    assert all(check.ok for check in checks), [c for c in checks if not c.ok]
    assert {check.name for check in checks} == {
        "vm-kernel",
        "vm-rootfs",
        "vm-base-disk",
        "firecracker",
        "kvm",
        "cgroup",
        "vm-taps",
    }


# #978-T16
def test_each_thing_that_is_missing_is_a_failed_check_that_says_what(tmp_path: Path) -> None:
    net = tmp_path / "net"
    (net / "fctap0").mkdir(parents=True)  # the second slot has no TAP
    root = cgroup_with(tmp_path, "cpu memory")  # no pids

    def nothing(path: Path, mode: int) -> bool:
        return path.name != "vmlinux"

    checks = {
        check.name: check
        for check in host_checks(
            vm_settings(), access=nothing, net=net, cgroup=lambda: root, kvm=tmp_path / "kvm"
        )
    }

    assert not checks["vm-kernel"].ok and "vmlinux" in checks["vm-kernel"].detail
    assert checks["vm-rootfs"].ok
    assert not checks["vm-taps"].ok and "fctap1" in checks["vm-taps"].detail
    assert not checks["cgroup"].ok and "pids" in checks["cgroup"].detail


# #978-T16
def test_a_runner_with_the_checks_passed_is_ready_announces_the_vms_memory_and_the_capability(
    tmp_path: Path,
) -> None:
    def passing(settings: FirecrackerSettings) -> tuple[Check, ...]:
        return (Check("kvm", True),)

    prepared = prepare_firecracker(config(parallelRuns=2, diskGb=40), environment(), checks=passing)

    assert prepared.ready and prepared.selftest.runtime == "firecracker"
    assert prepared.announcement.limits["memoryMb"] == 4096
    assert prepared.announcement.limits["parallelRuns"] == 2
    assert prepared.selftest.capabilities == ("agent-docker",)


# #978-T16
def test_a_runner_with_a_failed_check_is_not_ready_and_says_which() -> None:
    def failing(settings: FirecrackerSettings) -> tuple[Check, ...]:
        return (Check("kvm", False, "/dev/kvm cannot be opened (group kvm?)"),)

    prepared = prepare_firecracker(config(), environment(), checks=failing)

    assert not prepared.ready
    failed = prepared.selftest.failed()
    assert failed is not None and failed.name == "kvm"


# #978-T16
def test_a_settings_error_is_a_runner_that_is_not_ready_and_never_a_crash() -> None:
    prepared = prepare_firecracker(config(), {})  # no image id

    assert not prepared.ready
    failed = prepared.selftest.failed()
    assert failed is not None and "IMAGE_ID" in failed.detail


# -- run ---


# #978-T16
def test_run_with_the_firecracker_sandbox_prepares_without_docker_and_needs_a_usable_machine(
    tmp_path: Path,
) -> None:
    prepared: list[str] = []

    def vm(cfg: RunnerConfig, env: Mapping[str, str]) -> Prepared:
        prepared.append("vm")
        return prepare_firecracker(cfg, env, checks=lambda settings: (Check("kvm", True),))

    def docker(cfg: RunnerConfig, env: Mapping[str, str]) -> Prepared:
        prepared.append("docker")
        raise AssertionError("the Docker self-test must not run")

    class Client:
        def announce(self, announcement: Any) -> Any:
            from code_reviewer_runner.factory_runner.app_client import Announced

            return Announced(None, False)

        def claim(self) -> None:
            raise AssertionError("a runner that cannot use its sandbox claims nothing")

    state = tmp_path / "state"  # no cgroup, no artifacts: `setup` cannot run
    out, err = io.StringIO(), io.StringIO()
    code = main(
        ["run", "--once", "--wait", "0"],
        environment={
            "FACTORY_RUNNER_HOME": str(tmp_path / "home"),
            "FACTORY_RUNNER_URL": "https://app.example",
            "FACTORY_RUNNER_CREDENTIAL": CREDENTIAL,
            "FACTORY_RUNNER_SANDBOX": "firecracker",
            "FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID,
            "FACTORY_RUNNER_VM_STATE_DIR": str(state),
            # Never the real cgroup of this process: a directory with no controllers.
            "FACTORY_RUNNER_VM_CGROUP_ROOT": str(tmp_path / "no-cgroup"),
        },
        seams=CliSeams(client=lambda url, credential: Client(), prepare=docker, prepare_vm=vm),
        out=out,
        err=err,
        stdin=io.StringIO(),
    )

    assert prepared == ["vm"]
    assert code == EXIT_NOT_READY


# #978-T16
def test_the_factory_makes_a_firecracker_sandbox_from_the_machine_and_the_limits() -> None:
    make = firecracker_sandbox_factory(
        config(parallelRuns=3, diskGb=32), environment(FACTORY_RUNNER_VM_VCPUS="4")
    )

    sandbox = make({"RUNNER_JOB_TIMEOUT_SECONDS": "1800"}, 165.0)

    assert isinstance(sandbox, FirecrackerSandbox)
    assert (sandbox.capacity, sandbox.settings.vcpus, sandbox.settings.disk_gib) == (3, 4, 32)
    assert sandbox.settings.job_timeout_seconds == 1800
    assert sandbox.uses_host_docker is False
