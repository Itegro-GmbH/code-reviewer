# SPDX-License-Identifier: LicenseRef-Proprietary

"""The steps vm-init makes after the hosted launcher (#977): they are held equal to what the
Dispatcher's code renders (`dispatcher/src/launchers/testdata/vm-steps.golden.json`, written by
`vm-steps.test.ts`), and their checks are pinned here."""

import json
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.vm_init import steps
from vm_init_support import FakeRunner, work_volume_mountinfo

GOLDEN = (
    Path(__file__).resolve().parents[3]
    / "dispatcher"
    / "src"
    / "launchers"
    / "testdata"
    / "vm-steps.golden.json"
)
_GOLDEN: dict[str, Any] = json.loads(GOLDEN.read_text(encoding="utf-8"))


def _summary(listed: tuple[steps.Step, ...]) -> list[tuple[str, tuple[str, ...]]]:
    return [(step.label, step.argv) for step in listed]


def _golden(entries: list[dict[str, Any]]) -> list[tuple[str, tuple[str, ...]]]:
    return [(entry["label"], tuple(entry["argv"])) for entry in entries]


# #977-T01
def test_the_steps_before_the_daemon_are_the_hosted_launchers() -> None:
    assert _summary(steps.pre_daemon_steps()) == _golden(_GOLDEN["preDaemon"])


# #977-T01
def test_the_sysbox_step_is_the_hosted_launchers() -> None:
    assert _summary((steps.sysbox_step(),)) == _golden([_GOLDEN["sysbox"]])


# #977-T01
def test_the_work_volume_steps_are_the_hosted_launchers_for_the_hosted_reserve() -> None:
    made = steps.work_volume_steps("code-reviewer-work-job-1", 8)

    assert _summary(made) == _golden(_GOLDEN["workVolume"])


# #977-T01
def test_the_times_of_the_steps_are_the_hosted_launchers_where_it_names_them() -> None:
    ours = {s.label: s.timeout for s in (*steps.pre_daemon_steps(), steps.sysbox_step())}
    ours.update({s.label: s.timeout for s in steps.work_volume_steps("v", 8)})

    for entry in (*_GOLDEN["preDaemon"], _GOLDEN["sysbox"], *_GOLDEN["workVolume"]):
        if "timeoutSeconds" in entry:
            assert ours[entry["label"]] == entry["timeoutSeconds"], entry["label"]


# #977-T01
def test_the_reserve_is_the_hosts_to_choose() -> None:
    made = {s.label: s for s in steps.work_volume_steps("job", 3)}

    assert made["work-volume-reserve-image"].argv[:3] == ("fallocate", "-l", "3G")


def test_the_paths_are_the_ones_the_root_file_system_installs_the_scripts_at() -> None:
    assert steps.VM_PREPARE_PATH == "/usr/local/sbin/vm-prepare.sh"
    assert steps.SYSBOX_PREPARE_PATH == "/usr/local/sbin/sysbox-prepare.sh"


def _mountinfo(directory: str, options: str) -> str:
    return f"101 99 8:1 / {directory} {options} - ext4 /dev/vdb rw,noexec\n"


# #977-T02
@pytest.mark.parametrize(
    ("mountinfo", "ok"),
    [
        (_mountinfo("/v", "rw,nosuid,nodev"), True),
        (_mountinfo("/v", "rw,nosuid,nodev,relatime"), True),
        (_mountinfo("/v", "rw,nosuid"), False),
        (_mountinfo("/v", "rw,noexec,nosuid,nodev"), False),
        (_mountinfo("/other", "rw,nosuid,nodev"), False),
        # The file system's own options (the last field) never count, only the mount's.
        ("101 99 8:1 / /v rw,nosuid,nodev - ext4 /dev/vdb rw\n", True),
        ("101 99 8:1 / /v ro,nosuid,nodev - ext4 /dev/vdb rw,nosuid,nodev\n", False),
        # The last mount at the directory is the one that hides the others.
        (
            _mountinfo("/v", "rw,nosuid,nodev") + _mountinfo("/v", "rw,noexec,nosuid,nodev"),
            False,
        ),
        (
            _mountinfo("/v", "rw,noexec,nosuid,nodev") + _mountinfo("/v", "rw,nosuid,nodev"),
            True,
        ),
        ("", False),
        ("short line\n", False),
    ],
)
def test_the_mount_options_are_read_as_the_hosted_launcher_reads_them(
    mountinfo: str, ok: bool
) -> None:
    assert steps.mount_has_options(mountinfo, "/v", ("rw", "nosuid", "nodev")) is ok


# #977-T02
def test_a_run_of_steps_stops_at_the_first_that_fails_and_names_it_without_its_output() -> None:
    runner = FakeRunner()
    runner.rules.append((("mount", "--rbind"), steps.CommandResult(1, "secret-output")))

    with pytest.raises(steps.StepFailed) as failure:
        steps.run_steps(runner, steps.work_volume_steps("job", 1))

    assert failure.value.label == "work-volume-mount"
    assert "secret-output" not in str(failure.value)
    assert runner.commands[-1][:2] == ("mount", "--rbind")


# #977-T02
def test_a_work_volume_whose_mounts_are_not_as_the_profile_wants_them_fails_its_check() -> None:
    runner = FakeRunner(mountinfo=lambda: work_volume_mountinfo("job").replace("nodev", "dev", 1))

    with pytest.raises(steps.StepFailed) as failure:
        steps.run_steps(runner, steps.work_volume_steps("job", 1))

    assert failure.value.label == "work-volume-check"


# #977-T02
def test_a_work_volume_whose_reserve_has_no_mount_of_its_own_fails_its_check() -> None:
    runner = FakeRunner(mountinfo=lambda: work_volume_mountinfo("job").splitlines()[0] + "\n")

    with pytest.raises(steps.StepFailed):
        steps.run_steps(runner, steps.work_volume_steps("job", 1))


def test_a_good_work_volume_passes_every_step() -> None:
    runner = FakeRunner(mountinfo=lambda: work_volume_mountinfo("job"))

    steps.run_steps(runner, steps.work_volume_steps("job", 1))

    assert runner.commands[-1][:3] == ("docker", "volume", "create")
