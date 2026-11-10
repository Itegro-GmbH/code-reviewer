# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Firecracker launcher (#978) against a fake Firecracker that is a VM with vm-init in it: real
Unix sockets, real processes, the real framing, the real session and token checks. Nothing here
boots a VM: that is the KVM lane (`.github/workflows/vm-artifacts.yml`)."""

import asyncio
import dataclasses
import json
import logging
import os
import sys
from collections.abc import Callable, Coroutine
from pathlib import Path
from typing import Any

import pytest
from firecracker_support import (
    CREDENTIAL,
    FAKE,
    IMAGE_ID,
    LOCAL_CREDENTIAL,
    Rig,
    short_directory,
    start_for,
)
from jsonschema import Draft202012Validator

from code_reviewer_runner.factory_runner.firecracker.cgroups import MIB, VMM_OVERHEAD_MIB
from code_reviewer_runner.factory_runner.firecracker.control_run import load_template
from code_reviewer_runner.factory_runner.firecracker.disks import DiskError
from code_reviewer_runner.factory_runner.firecracker.launcher import (
    EXIT_KILLED,
    EXIT_NO_REPORT,
    FirecrackerSandbox,
    NoFreeSlot,
    StartFailed,
)
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.sandbox import WorkerOutcome

pytestmark = pytest.mark.unit

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
VM_INIT = json.loads((CONTRACTS / "vm-init.v1.json").read_text())


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


async def run_job(
    rig: Rig, sandbox: FirecrackerSandbox | None = None, **start: Any
) -> WorkerOutcome:
    sandbox = sandbox or rig.sandbox()
    worker = await sandbox.start(start_for(**start))
    return await worker.wait()


# -- the job end to end ---


# #978-T06
def test_a_job_runs_in_a_vm_and_ends_with_the_exit_report() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.behavior(mode="good", exit=0)
        sandbox = rig.sandbox()

        outcome = go(lambda: run_job(rig, sandbox))

        seen = rig.seen()
        assert outcome.exit_code == 0
        assert "worker_exited" in outcome.log_tail
        assert seen["report"] == {"version": 1, "type": "ack", "for": "exit"}
        assert seen["connect_line"] == "CONNECT 5000\n"
        # Nothing of the VM is left: its directory with the job disk, its cgroup, its slot.
        assert rig.vm_directories() == []
        assert [name for name, _ in rig.cgroups.created] == rig.cgroups.removed
        assert sandbox.free == sandbox.capacity


# #978-T06
def test_the_exit_status_of_the_worker_is_the_status_of_the_outcome() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.behavior(mode="good", exit=1)

        outcome = go(lambda: run_job(rig))

        assert outcome.exit_code == 1


# #978-T06
def test_the_start_carries_the_job_the_token_the_image_and_controls_arguments() -> None:
    with short_directory() as root:
        rig = Rig(root)

        go(lambda: run_job(rig))

        start = rig.seen()["start"]
        assert Draft202012Validator({"$ref": "#/$defs/StartRequest", **VM_INIT}).is_valid(start)  # pyright: ignore[reportUnknownMemberType]
        assert start["job"] == {
            "appUrl": "http://172.31.0.1:8080",
            "jobId": "00000000-0000-4000-8000-000000000001",
            "credential": CREDENTIAL,
        }
        assert start["image"] == {"reference": "code-reviewer-worker:golden", "id": IMAGE_ID}
        assert "localCredential" not in start
        args = start["control"]["args"]
        assert IMAGE_ID in args and args[-1] == "worker-once"
        assert "RUNNER_ENVIRONMENT_CONTROL=vsock" in args
        assert "RUNNER_JOB_TIMEOUT_SECONDS=3600" in args
        # The credential and the token are in the job document and nowhere in an argument.
        assert CREDENTIAL not in "\n".join(args)
        assert start["controlToken"] not in "\n".join(args)
        assert start["workVolume"] == {
            "name": "code-reviewer-work-00000000-0000-4000-8000-000000000001",
            "reserveGib": 2,
        }


# #978-T06
def test_the_one_local_credential_travels_in_the_start_and_nowhere_else() -> None:
    with short_directory() as root:
        rig = Rig(root)

        go(lambda: run_job(rig, local=True))

        seen = rig.seen()
        assert seen["start"]["localCredential"] == {
            "name": "CLAUDE_CODE_OAUTH_TOKEN",
            "value": LOCAL_CREDENTIAL,
        }
        # Not in the VM's configuration, its command line, its environment or any file it has.
        assert LOCAL_CREDENTIAL not in json.dumps(seen["config"])
        assert LOCAL_CREDENTIAL not in json.dumps(seen["environ"])
        assert CREDENTIAL not in json.dumps(seen["config"])


# #978-T06
def test_the_vm_is_what_the_release_describes() -> None:
    with short_directory() as root:
        rig = Rig(root, vcpus=4, disk_gib=24)

        go(lambda: run_job(rig))

        config = rig.seen()["config"]
        rootfs, data = config["drives"]
        assert (rootfs["drive_id"], rootfs["is_root_device"], rootfs["is_read_only"]) == (
            "rootfs",
            True,
            True,
        )
        assert (data["drive_id"], data["is_read_only"]) == ("data", False)
        assert data["path_on_host"].endswith("/disk.ext4")
        assert config["machine-config"] == {"vcpu_count": 4, "mem_size_mib": 8192, "smt": False}
        assert config["network-interfaces"][0]["host_dev_name"] == "fctap0"
        assert config["vsock"]["guest_cid"] == 3
        boot = config["boot-source"]["boot_args"]
        assert "vm.mode=run" in boot and "vm.ip=172.31.0.2/30 vm.gw=172.31.0.1" in boot
        assert "8250.nr_uarts=0" in boot  # no console the guest has to write to
        assert boot.endswith("init=/usr/bin/docker-init -- /usr/local/sbin/vm-boot")


# #978-T06
def test_the_vmm_runs_with_no_environment_in_the_vms_directory_and_its_own_cgroup() -> None:
    with short_directory() as root:
        rig = Rig(root, vcpus=2)

        go(lambda: run_job(rig))

        seen = rig.seen()
        # Only what the shell and the interpreter of the fake add themselves.
        assert set(seen["environ"]) <= {"PWD", "SHLVL", "_", "OLDPWD", "LC_CTYPE"}
        assert Path(seen["cwd"]).parent == root / "vms"
        ((name, limits),) = rig.cgroups.created
        assert name.startswith("vm-0-")
        assert (limits.vcpus, limits.memory_mib) == (2, 4096)
        assert limits.memory_max_bytes == (4096 + VMM_OVERHEAD_MIB) * MIB
        assert limits.cpu_max == "200000 100000"


# #978-T06
def test_the_listeners_exist_before_the_vm_starts() -> None:
    with short_directory() as root:
        rig = Rig(root)
        wrapper = root / "firecracker"
        wrapper.write_text(
            "#!/bin/sh\n"
            'cfg=$3; dir=$(dirname "$cfg")\n'
            'if [ -S "$dir/vsock.sock_5100" ] && [ -S "$dir/vsock.sock_5101" ]; then '
            f'touch "{root}/listening"; fi\n'
            f"exec {sys.executable} {FAKE} "
            f'{rig.behavior_file} "$@"\n'
        )

        go(lambda: run_job(rig))

        assert (root / "listening").exists()


# -- the token ---


# #978-T07
def test_a_message_of_the_vm_without_its_token_changes_nothing() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.behavior(mode="forged", exit=0)

        outcome = go(lambda: run_job(rig))

        seen = rig.seen()
        refusal = {"version": 1, "type": "refused", "reason": "invalid_request"}
        assert seen["control"]["forged_narrow_no_token"] == {**refusal, "for": "narrow"}
        assert seen["control"]["forged_end_wrong"] == {**refusal, "for": "end"}
        # A report without the token or with another one is not taken, not even answered.
        assert seen["forged_report_wrong"] is None
        assert seen["forged_report_none"] is None
        # The genuine one, with the token, ends the job.
        assert outcome.exit_code == 0 and "worker_exited" in outcome.log_tail
        assert seen["report"] == {"version": 1, "type": "ack", "for": "exit"}


# #978-T07
def test_the_first_exit_report_wins_and_a_repeated_one_gets_the_same_ack() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.behavior(mode="duplicate_report", exit=0, linger=1)

        outcome = go(lambda: run_job(rig))

        seen = rig.seen()
        assert outcome.exit_code == 0  # not the second report's docker_failed
        assert "worker_exited" in outcome.log_tail
        assert (
            seen["report"] == seen["report_again"] == {"version": 1, "type": "ack", "for": "exit"}
        )


# #978-T07
def test_a_report_without_a_token_is_taken_only_while_the_start_has_no_ack() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.behavior(mode="report_before_start")
        sandbox = rig.sandbox()

        with pytest.raises(StartFailed, match="start_timeout"):
            go(lambda: sandbox.start(start_for()))

        assert rig.vm_directories() == []
        assert sandbox.free == sandbox.capacity


# -- narrow: the outer wall ---


# #978-T08
def test_narrow_is_refused_until_there_is_an_outer_wall_and_the_log_says_why(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with short_directory() as root:
        rig = Rig(root, outer_wall=OuterWallMode.REFUSE)

        with caplog.at_level(logging.WARNING):
            go(lambda: run_job(rig))

        control = rig.seen()["control"]
        expected = {"version": 1, "type": "refused", "for": "narrow", "reason": "unavailable"}
        assert control["narrow"] == expected
        assert control["narrow_again"] == expected  # idempotent: the same answer
        assert "no outer wall yet" in caplog.text


# #978-T08
def test_inner_wall_only_is_a_choice_that_acks_and_warns_every_time(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with short_directory() as root:
        rig = Rig(root, outer_wall=OuterWallMode.INNER_ONLY)

        with caplog.at_level(logging.WARNING):
            go(lambda: run_job(rig))

        control = rig.seen()["control"]
        assert control["narrow"] == {"version": 1, "type": "ack", "for": "narrow"}
        assert control["narrow_again"] == control["narrow"]
        # Another rule after the first is not a request of this job.
        assert control["narrow_other"]["reason"] == "invalid_request"
        assert "WITHOUT an outer wall" in caplog.text
        assert control["end"] == {"version": 1, "type": "ack", "for": "end"}


# #978-T08
def test_the_wall_is_asked_once_with_the_vm_it_is_for_and_told_when_the_vm_is_gone() -> None:
    with short_directory() as root:
        rig = Rig(root)
        calls: list[Any] = []

        class Wall:
            async def narrow(self, vm: Any, message: Any) -> None:
                calls.append(("narrow", vm.slot.tap, message.rule.mode, message.model_host))

            async def forget(self, vm: Any) -> None:
                calls.append(("forget", vm.slot.tap))

        go(lambda: run_job(rig, rig.sandbox(wall=Wall())))

        assert calls == [
            ("narrow", "fctap0", "list", "api.example.com"),
            ("forget", "fctap0"),
        ]


# -- the end of a VM ---


# #978-T09
def test_a_vm_that_ends_without_a_report_is_an_unknown_outcome_the_dispatcher_gives_back() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.behavior(mode="no_report")
        sandbox = rig.sandbox()

        outcome = go(lambda: run_job(rig, sandbox))

        assert outcome.exit_code == EXIT_NO_REPORT
        assert "without an exit report" in outcome.log_tail
        assert rig.vm_directories() == [] and sandbox.free == sandbox.capacity


# #978-T09
def test_a_vm_that_outlives_its_wall_clock_is_killed_and_everything_is_removed() -> None:
    with short_directory() as root:
        rig = Rig(root, job_timeout_seconds=1, preparation_seconds=0.5)
        rig.behavior(mode="hang")
        template = load_template()
        short = dataclasses.replace(
            template,
            arguments=tuple("0" if a == "150" else a for a in template.arguments),
        )
        sandbox = rig.sandbox(template=short)

        async def scenario() -> WorkerOutcome:
            worker = await sandbox.start(start_for())
            return await worker.wait()

        outcome = go(scenario)

        assert outcome.exit_code == EXIT_KILLED
        assert "wall clock" in outcome.log_tail
        assert rig.vm_directories() == [] and sandbox.free == sandbox.capacity
        assert rig.cgroups.killed and rig.cgroups.removed


# #978-T09
def test_the_wall_clock_is_the_job_timeout_plus_the_stop_timeout_plus_the_preparation() -> None:
    with short_directory() as root:
        rig = Rig(root, job_timeout_seconds=3600)

        assert (
            rig.settings.wall_clock_seconds(load_template().stop_timeout_seconds)
            == 3600 + 150 + 300
        )


# #978-T09
def test_stop_ends_the_vm_at_once_and_wait_says_so() -> None:
    with short_directory() as root:
        rig = Rig(root)
        rig.behavior(mode="hang")
        sandbox = rig.sandbox()

        async def scenario() -> WorkerOutcome:
            worker = await sandbox.start(start_for())
            await worker.stop()
            await worker.stop()  # twice is the same as once
            return await worker.wait()

        outcome = go(scenario)

        assert outcome.exit_code == EXIT_KILLED and "stopped" in outcome.log_tail
        assert rig.vm_directories() == [] and sandbox.free == sandbox.capacity


# #978-T09
def test_a_report_ends_a_vm_that_would_not_power_off_after_the_grace() -> None:
    with short_directory() as root:
        rig = Rig(root, kill_grace_seconds=0.3)
        rig.behavior(mode="good", linger=30)
        sandbox = rig.sandbox()

        outcome = go(lambda: run_job(rig, sandbox))

        assert outcome.exit_code == 0
        assert rig.vm_directories() == [] and sandbox.free == sandbox.capacity


# -- a start that fails ---


@pytest.mark.parametrize(
    ("behavior", "settings", "reason"),
    [
        ({"mode": "refuse"}, {}, "refused the start"),
        ({"mode": "die_at_boot"}, {}, "ended before the VM took the job"),
        ({"mode": "silent"}, {"start_ack_seconds": 0.5}, "did not answer the start"),
        ({"mode": "no_ok"}, {"boot_connect_seconds": 0.5}, "did not accept a connection"),
    ],
    ids=["refused", "died", "silent", "never connects"],
)
# #978-T09
def test_a_vm_that_does_not_take_the_job_fails_the_start_and_leaves_nothing(
    behavior: dict[str, Any], settings: dict[str, Any], reason: str
) -> None:
    with short_directory() as root:
        rig = Rig(root, **settings)
        rig.behavior(**behavior)
        sandbox = rig.sandbox()

        with pytest.raises(StartFailed, match=reason):
            go(lambda: sandbox.start(start_for()))

        assert rig.vm_directories() == []
        assert sandbox.free == sandbox.capacity
        assert rig.cgroups.removed == [name for name, _ in rig.cgroups.created]


# #978-T09
def test_a_job_disk_that_cannot_be_made_fails_the_start_and_frees_the_slot() -> None:
    with short_directory() as root:
        rig = Rig(root)

        def failing(base: Path, destination: Path, quota: int) -> bool:
            raise DiskError("the base disk cannot be copied")

        sandbox = rig.sandbox(make_disk=failing)

        with pytest.raises(DiskError):
            go(lambda: sandbox.start(start_for()))

        assert rig.vm_directories() == [] and sandbox.free == sandbox.capacity


# #978-T09
def test_a_firecracker_that_cannot_start_fails_the_start_and_removes_the_cgroup() -> None:
    with short_directory() as root:
        rig = Rig(root, firecracker=root / "no-such-firecracker")
        sandbox = rig.sandbox()

        with pytest.raises(OSError):
            go(lambda: sandbox.start(start_for()))

        assert rig.vm_directories() == [] and sandbox.free == sandbox.capacity
        assert rig.cgroups.removed == [name for name, _ in rig.cgroups.created]


# #978-T09
def test_a_credential_in_an_argument_is_refused_before_a_vm_exists() -> None:
    with short_directory() as root:
        rig = Rig(root)
        sandbox = rig.sandbox()
        start = dataclasses.replace(start_for(), credential="worker-once")  # an argument's text

        with pytest.raises(StartFailed, match="credential"):
            go(lambda: sandbox.start(start))

        assert sandbox.free == sandbox.capacity


# -- slots ---


# #978-T10
def test_the_slots_are_the_number_of_jobs_that_run_at_once_each_with_its_own_tap() -> None:
    with short_directory() as root:
        rig = Rig(root, slots=2)
        rig.behavior(mode="good", run=1.5)
        sandbox = rig.sandbox()

        async def scenario() -> list[str]:
            first = await sandbox.start(start_for(1))
            first_tap = rig.seen()["config"]["network-interfaces"][0]["host_dev_name"]
            second = await sandbox.start(start_for(2))
            second_tap = rig.seen()["config"]["network-interfaces"][0]["host_dev_name"]
            assert sandbox.free == 0
            with pytest.raises(NoFreeSlot):
                await sandbox.start(start_for(3))
            await asyncio.gather(first.wait(), second.wait())
            assert sandbox.free == 2
            return [first_tap, second_tap]

        taps = go(scenario)

        assert taps == ["fctap0", "fctap1"]
        assert rig.vm_directories() == []


# #978-T10
def test_a_slot_is_free_again_for_the_next_job() -> None:
    with short_directory() as root:
        rig = Rig(root, slots=1)
        sandbox = rig.sandbox()

        async def scenario() -> list[int]:
            codes: list[int] = []
            for number in (1, 2):
                codes.append((await (await sandbox.start(start_for(number))).wait()).exit_code)
            return codes

        assert go(scenario) == [0, 0]


# -- the service's seam ---


# #978-T10
def test_setup_prepares_the_cgroup_tree_and_removes_what_an_earlier_service_left() -> None:
    with short_directory() as root:
        rig = Rig(root)
        leftover = root / "vms" / "vm-0-deadbeef"
        leftover.mkdir()
        (leftover / "disk.ext4").write_bytes(b"x" * 1000)
        sandbox = rig.sandbox()

        reaped = go(sandbox.setup)

        assert rig.cgroups.prepared == 1
        assert reaped.directories == ("vm-0-deadbeef",)
        assert rig.vm_directories() == []


# #978-T10
def test_the_environment_of_the_vmm_never_holds_the_environment_of_the_service() -> None:
    with short_directory() as root:
        rig = Rig(root)
        os.environ["FACTORY_RUNNER_TEST_SECRET"] = "must-not-reach-the-vmm"
        try:
            go(lambda: run_job(rig))
        finally:
            del os.environ["FACTORY_RUNNER_TEST_SECRET"]

        assert "must-not-reach-the-vmm" not in json.dumps(rig.seen()["environ"])
