# SPDX-License-Identifier: LicenseRef-Proprietary

"""The parts of the Firecracker launcher (#978) one by one: slots, the job disk, the cgroup tree,
the leftovers of an earlier service, Control's arguments, the VM's configuration, the settings."""

import json
import os
import re
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from firecracker_support import CREDENTIAL, IMAGE_ID, LOCAL_CREDENTIAL, short_directory
from jsonschema import Draft202012Validator

from code_reviewer_runner.factory_runner.firecracker import disks, vmm
from code_reviewer_runner.factory_runner.firecracker.cgroups import (
    MIB,
    CgroupError,
    CgroupTree,
    VmLimits,
    delegated_root,
)
from code_reviewer_runner.factory_runner.firecracker.control_run import (
    ControlRunError,
    build_start,
    load_template,
    local_credential,
)
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.firecracker.reaper import processes_of, reap_leftovers
from code_reviewer_runner.factory_runner.firecracker.settings import (
    BOOT_ARGS,
    INIT_COMMAND,
    FirecrackerSettings,
    SettingsError,
    settings_from_environment,
)
from code_reviewer_runner.factory_runner.firecracker.slots import MAX_SLOTS, Slot, SlotPool

pytestmark = pytest.mark.unit

REPOSITORY = Path(__file__).resolve().parents[3]
TOKEN = "T" * 43


# -- slots ---


# #978-T10
def test_a_slot_owns_a_slash_thirty_network_derived_from_its_number() -> None:
    assert (Slot(0).tap, Slot(0).host_address, Slot(0).guest_address) == (
        "fctap0",
        "172.31.0.1",
        "172.31.0.2",
    )
    assert (Slot(1).host_address, Slot(1).guest_address) == ("172.31.0.5", "172.31.0.6")
    assert (Slot(63).host_address, Slot(63).guest_address) == ("172.31.0.253", "172.31.0.254")
    assert (Slot(64).host_address, Slot(64).guest_address) == ("172.31.1.1", "172.31.1.2")
    assert Slot(1).guest_mac == "06:00:ac:1f:00:06"


# #978-T10
def test_no_two_slots_share_an_address() -> None:
    addresses = [
        a
        for index in range(MAX_SLOTS)
        for a in (Slot(index).host_address, Slot(index).guest_address)
    ]

    assert len(set(addresses)) == len(addresses)


# #978-T10
def test_the_pool_gives_each_slot_once_and_takes_it_back() -> None:
    pool = SlotPool(2)

    first, second = pool.acquire(), pool.acquire()

    assert (first, second) == (Slot(0), Slot(1))
    assert pool.acquire() is None and pool.free == 0
    pool.release(first or Slot(0))
    pool.release(first or Slot(0))  # twice is once
    assert pool.free == 1 and pool.acquire() == Slot(0)


# #978-T10
@pytest.mark.parametrize("count", [0, MAX_SLOTS + 1])
def test_a_pool_of_no_slots_or_too_many_is_refused(count: int) -> None:
    with pytest.raises(ValueError, match="slots"):
        SlotPool(count)


# -- the job disk ---


class FakeRun:
    def __init__(self, results: dict[str, list[int]] | None = None) -> None:
        self.calls: list[list[str]] = []
        self.results = results or {}

    def __call__(self, argv: Sequence[str]) -> int:
        self.calls.append(list(argv))
        queue = self.results.get(argv[0])
        return queue.pop(0) if queue else 0


def base_disk(directory: Path, size: int = 1000) -> Path:
    path = directory / "base.ext4"
    path.write_bytes(b"x" * size)
    return path


# #978-T11
def test_a_reflink_copy_is_grown_to_the_quota_and_nothing_is_copied_by_hand() -> None:
    with short_directory() as root:
        run = FakeRun()
        base = base_disk(root)

        def clone(source: Path, destination: Path) -> bool:
            destination.write_bytes(source.read_bytes())
            return True

        reflinked = disks.make_job_disk(base, root / "disk.ext4", 4096, run=run, clone=clone)

        assert reflinked is True
        assert (root / "disk.ext4").stat().st_size == 4096  # the quota is the size of the file
        assert run.calls == [["resize2fs", str(root / "disk.ext4")]]


# #978-T11
def test_a_file_system_without_reflinks_gets_a_plain_sparse_copy() -> None:
    with short_directory() as root:
        run = FakeRun()

        def copy(argv: Sequence[str]) -> int:
            run.calls.append(list(argv))
            if argv[0] == "cp":
                Path(argv[-1]).write_bytes(Path(argv[-2]).read_bytes())
            return 0

        def no_clone(source: Path, destination: Path) -> bool:
            return False

        reflinked = disks.make_job_disk(
            base_disk(root), root / "disk.ext4", 4096, run=copy, clone=no_clone
        )

        assert reflinked is False
        assert run.calls[0][:2] == ["cp", "--sparse=always"]
        assert (root / "disk.ext4").stat().st_size == 4096


# #978-T11
def test_a_real_clone_on_a_file_system_without_reflinks_leaves_nothing_behind() -> None:
    with short_directory() as root:
        base = base_disk(root)

        # /tmp is no reflink file system on a CI runner or here; where it is, the clone is made.
        made = disks.clone_file(base, root / "copy.ext4")

        assert made == (root / "copy.ext4").exists()


# #978-T11
def test_a_resize_that_wants_a_check_runs_e2fsck_once_and_then_resizes_again() -> None:
    with short_directory() as root:
        run = FakeRun({"resize2fs": [1, 0], "e2fsck": [1]})  # 1: e2fsck corrected something

        disks.make_job_disk(
            base_disk(root),
            root / "disk.ext4",
            4096,
            run=run,
            clone=lambda s, d: d.write_bytes(s.read_bytes()) > 0,
        )

        assert [call[0] for call in run.calls] == ["resize2fs", "e2fsck", "resize2fs"]


# #978-T11
@pytest.mark.parametrize(
    ("results", "reason"),
    [
        ({"resize2fs": [1, 1], "e2fsck": [0]}, "cannot be grown"),
        ({"resize2fs": [1], "e2fsck": [4]}, "cannot be grown"),
        ({"cp": [1]}, "cannot be copied"),
    ],
)
def test_a_disk_that_cannot_be_copied_or_grown_is_an_error_and_leaves_no_file(
    results: dict[str, list[int]], reason: str
) -> None:
    with short_directory() as root:
        with pytest.raises(disks.DiskError, match=reason):
            disks.make_job_disk(
                base_disk(root),
                root / "disk.ext4",
                4096,
                run=FakeRun(results),
                clone=lambda s, d: d.write_bytes(s.read_bytes()) < 0,
            )

        if "cp" in results:
            assert not (root / "disk.ext4").exists()


# #978-T11
def test_a_quota_below_the_base_disk_or_a_missing_base_is_an_error() -> None:
    with short_directory() as root:
        with pytest.raises(disks.DiskError, match="smaller"):
            disks.make_job_disk(base_disk(root, 5000), root / "disk.ext4", 4096, run=FakeRun())
        with pytest.raises(disks.DiskError, match="cannot be read"):
            disks.make_job_disk(root / "none", root / "disk.ext4", 4096, run=FakeRun())


# #978-T11
def test_only_the_directory_of_a_vm_below_vms_is_deleted() -> None:
    with short_directory() as root:
        vms = root / "vms"
        vms.mkdir()
        vm = vms / "vm-0-deadbeef"
        vm.mkdir()
        (vm / "disk.ext4").write_bytes(b"x")
        (vms / "not-a-vm").mkdir()
        outside = root / "vm-0-deadbeef"
        outside.mkdir()

        disks.remove_vm_directory(vm, vms)

        assert not vm.exists()
        for refused in (vms / "not-a-vm", outside, vms, root):
            with pytest.raises(disks.DiskError):
                disks.remove_vm_directory(refused, vms)
            assert refused.exists()


# -- the cgroup tree ---


def cgroup_tree(root: Path, *, controllers: str = "cpuset cpu io memory pids") -> CgroupTree:
    root.mkdir()
    (root / "cgroup.controllers").write_text(controllers)
    (root / "cgroup.procs").write_text("")
    (root / "cgroup.subtree_control").write_text("")
    return CgroupTree(root)


# #978-T12
def test_the_delegated_cgroup_is_the_one_this_process_runs_in() -> None:
    with short_directory() as root:
        file = root / "cgroup"
        file.write_text("0::/system.slice/factory-runner.service\n")

        assert delegated_root(file, Path("/sys/fs/cgroup")) == Path(
            "/sys/fs/cgroup/system.slice/factory-runner.service"
        )
        file.write_text("12:memory:/x\n")
        with pytest.raises(CgroupError, match="no cgroup v2"):
            delegated_root(file)
        with pytest.raises(CgroupError, match="cannot be read"):
            delegated_root(root / "none")


# #978-T12
def test_prepare_moves_the_service_into_a_leaf_and_enables_the_controllers_below() -> None:
    with short_directory() as root:
        tree = cgroup_tree(root / "unit")
        (root / "unit" / "cgroup.procs").write_text(f"{os.getpid()}\n4242\n")
        (root / "unit" / "service").mkdir()
        (root / "unit" / "service" / "cgroup.procs").write_text("")

        tree.prepare()
        tree.prepare()  # again is the same

        assert (root / "unit" / "cgroup.subtree_control").read_text() == "+cpu +memory +pids"
        # Only this process moves: the other one in the cgroup is not the service's.
        assert (root / "unit" / "service" / "cgroup.procs").read_text() == str(os.getpid())


# #978-T12
def test_a_cgroup_without_a_controller_the_limits_need_is_an_error_that_names_it() -> None:
    with short_directory() as root:
        tree = cgroup_tree(root / "unit", controllers="cpu memory")

        with pytest.raises(CgroupError, match="pids"):
            tree.prepare()


# #978-T12
def test_a_vm_cgroup_gets_cpu_memory_without_swap_and_a_process_limit() -> None:
    with short_directory() as root:
        tree = cgroup_tree(root / "unit")

        path = tree.create("vm-0-deadbeef", VmLimits(vcpus=4, memory_mib=8192))

        def value(name: str) -> str:
            return (path / name).read_text()

        assert value("cpu.max") == "400000 100000"
        assert int(value("memory.max")) == (8192 + 384) * MIB
        assert value("memory.swap.max") == "0"
        assert value("memory.oom.group") == "1"  # one OOM kill ends the whole VM
        assert int(value("pids.max")) >= 64


# #978-T12
def test_only_the_cgroup_of_a_vm_is_made_or_removed() -> None:
    with short_directory() as root:
        tree = cgroup_tree(root / "unit")
        (root / "unit" / "service").mkdir()

        for name in ("service", "../escape", "vm-0", "vm-0-DEADBEEF"):
            with pytest.raises(CgroupError):
                tree.create(name, VmLimits(2, 4096))
        with pytest.raises(CgroupError):
            tree.remove(root / "unit" / "service")


# #978-T12
def test_a_cgroup_that_is_empty_is_removed_and_killing_goes_through_cgroup_kill() -> None:
    with short_directory() as root:

        class Plain(CgroupTree):
            """On a plain directory a limit file is a file, so the leftover files are taken out."""

            def kill(self, path: Path) -> None:
                if not path.exists():
                    return
                super().kill(path)
                for each in path.iterdir():
                    each.unlink()

        tree = Plain(root / "unit")
        (root / "unit").mkdir()
        path = tree.create("vm-1-0a0b0c0d", VmLimits(2, 4096))

        assert tree.remove(path) is True
        assert not path.exists()
        assert tree.remove(path) is True  # gone already


# #978-T12
def test_killing_a_cgroup_writes_cgroup_kill_and_falls_back_to_each_process() -> None:
    with short_directory() as root:
        tree = cgroup_tree(root / "unit")
        path = root / "unit" / "vm-0-deadbeef"
        path.mkdir()

        tree.kill(path)
        assert (path / "cgroup.kill").read_text() == "1"

        (path / "cgroup.kill").unlink()
        (path / "cgroup.kill").mkdir()  # a write to it fails: the file is a directory
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        (path / "cgroup.procs").write_text(f"{child.pid}\n")
        try:
            tree.kill(path)
            assert child.wait(timeout=5) == -9
        finally:
            child.kill()
            child.wait()


# -- the leftovers of an earlier service ---


def firecracker_path(root: Path) -> Path:
    return root / "bin" / "firecracker"


def vmm_like(root: Path, directory: Path) -> subprocess.Popen[bytes]:
    """A process that Firecracker's own command line describes: its argv[0] is the binary's path
    and it is given `--no-api --config-file <directory>/firecracker.json`."""
    return subprocess.Popen(
        [
            "bash",
            "-c",
            'exec -a "$0" "$1" -c "import time; time.sleep(60)" "${@:2}"',
            str(firecracker_path(root)),
            sys.executable,
            "--no-api",
            "--config-file",
            f"{directory}/firecracker.json",
        ]
    )


# #978-T13
def test_a_leftover_vm_with_its_process_and_disk_is_removed_at_the_start() -> None:
    with short_directory() as root:
        vms = root / "vms"
        vms.mkdir()
        leftover = vms / "vm-0-deadbeef"
        leftover.mkdir()
        (leftover / "disk.ext4").write_bytes(b"x" * 100_000)
        process = vmm_like(root, leftover)
        try:
            assert processes_of(leftover, firecracker_path(root)) == [process.pid]

            reaped = reap_leftovers(vms, None, firecracker=firecracker_path(root))

            assert process.wait(timeout=5) == -9
            assert reaped.processes == (process.pid,)
            assert reaped.directories == ("vm-0-deadbeef",)
            assert list(vms.iterdir()) == []
        finally:
            process.kill()
            process.wait()


# #978-T13
def test_a_process_that_does_not_name_a_vm_directory_of_this_machine_is_not_touched() -> None:
    with short_directory() as root:
        vms = root / "vms"
        vms.mkdir()
        leftover = vms / "vm-0-deadbeef"
        leftover.mkdir()
        elsewhere = root / "elsewhere" / "vm-0-deadbeef"  # the same name, another tree
        stranger = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)", f"{elsewhere}/firecracker.json"]
        )
        try:
            assert processes_of(leftover, firecracker_path(root)) == []

            reaped = reap_leftovers(vms, None, firecracker=firecracker_path(root))

            assert reaped.processes == () and stranger.poll() is None
        finally:
            stranger.kill()
            stranger.wait()


# #978-T13
def test_a_directory_that_is_not_a_vms_is_left_alone() -> None:
    with short_directory() as root:
        vms = root / "vms"
        vms.mkdir()
        (vms / "keep-me").mkdir()
        (vms / "a-file").write_text("x")

        reaped = reap_leftovers(vms, None, firecracker=firecracker_path(root))

        assert reaped.directories == ()
        assert sorted(p.name for p in vms.iterdir()) == ["a-file", "keep-me"]


# #978-T13
def test_a_missing_vms_directory_is_nothing_to_reap() -> None:
    with short_directory() as root:
        assert (
            reap_leftovers(root / "vms", None, firecracker=firecracker_path(root)).directories == ()
        )


# #978-T13
def test_a_cgroup_of_a_vm_without_a_directory_is_removed_too() -> None:
    with short_directory() as root:

        class Plain(CgroupTree):
            def kill(self, path: Path) -> None:
                pass

        (root / "unit").mkdir()
        (root / "unit" / "vm-3-0a0b0c0d").mkdir()
        (root / "unit" / "service").mkdir()
        (root / "vms").mkdir()

        reaped = reap_leftovers(
            root / "vms", Plain(root / "unit"), firecracker=firecracker_path(root)
        )

        assert reaped.cgroups == ("vm-3-0a0b0c0d",)
        assert (root / "unit" / "service").exists()


# -- Control's arguments ---


def golden() -> list[str]:
    path = REPOSITORY / "dispatcher/src/launchers/testdata/docker-run.local-control.golden.json"
    return json.loads(path.read_text())


# #978-T02
def test_the_template_filled_for_the_golden_job_is_the_golden_file_of_977() -> None:
    template = load_template()

    filled = template.fill(
        job_id="job-1",
        image="registry.invalid/code-reviewer-worker@sha256:" + "0" * 64,
        timeout_seconds=3600,
        vcpus=2,
    )

    assert filled == golden()


# #978-T02
def test_the_template_knows_the_sizes_of_the_platform_and_the_stop_timeout_of_control() -> None:
    template = load_template()

    assert dict(template.agent_memory_mb) == {2: 1952, 4: 5904, 6: 9672, 8: 13441}
    assert template.stop_timeout_seconds == 150
    assert template.volume_name("job-1") == "code-reviewer-work-job-1"
    with pytest.raises(ControlRunError, match="size"):
        template.fill(job_id="j", image=IMAGE_ID, timeout_seconds=1, vcpus=1)


# #978-T02
def test_the_start_is_valid_under_the_contract_and_holds_the_credential_only_in_the_job() -> None:
    contract: dict[str, Any] = json.loads((REPOSITORY / "contracts/vm-init.v1.json").read_text())

    start = build_start(
        load_template(),
        app_url="https://app.example",
        job_id="job-1",
        credential=CREDENTIAL,
        token=TOKEN,
        image_id=IMAGE_ID,
        timeout_seconds=1800,
        vcpus=4,
        reserve_gib=2,
        local={"CLAUDE_CODE_OAUTH_TOKEN": LOCAL_CREDENTIAL},
    )

    assert Draft202012Validator({"$ref": "#/$defs/StartRequest", **contract}).is_valid(start)  # pyright: ignore[reportUnknownMemberType]
    arguments = "\n".join(start["control"]["args"])
    for secret in (CREDENTIAL, TOKEN, LOCAL_CREDENTIAL):
        assert secret not in arguments
    assert "RUNNER_JOB_TIMEOUT_SECONDS=1800" in start["control"]["args"]
    assert "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB=5904" in start["control"]["args"]


# #978-T02
@pytest.mark.parametrize("secret", ["credential", "token", "local"])
def test_a_start_whose_arguments_would_hold_a_secret_is_refused(secret: str) -> None:
    # An argument of the rendering: the name of the image's entry mode.
    values: dict[str, Any] = {
        "credential": CREDENTIAL,
        "token": TOKEN,
        "image_id": IMAGE_ID,
        "local": {"CLAUDE_CODE_OAUTH_TOKEN": LOCAL_CREDENTIAL},
    }
    if secret == "credential":
        values["credential"] = "worker-once"
    elif secret == "token":
        values["token"] = "bridge"
    else:
        values["local"] = {"CLAUDE_CODE_OAUTH_TOKEN": "worker-once"}

    with pytest.raises(ControlRunError, match="credential"):
        build_start(
            load_template(),
            app_url="https://app.example",
            job_id="job-1",
            timeout_seconds=60,
            vcpus=2,
            reserve_gib=1,
            **values,
        )


# #974-review, #978-T05
def test_only_the_claude_code_login_may_be_given_to_a_vm() -> None:
    assert local_credential({}) is None
    assert local_credential({"CLAUDE_CODE_OAUTH_TOKEN": "t"}) == {
        "name": "CLAUDE_CODE_OAUTH_TOKEN",
        "value": "t",
    }
    for refused in ({"PATH": "/evil"}, {"A": "1", "B": "2"}, {"RUNNER_JOB_TIMEOUT_SECONDS": "1"}):
        with pytest.raises(ControlRunError):
            local_credential(refused)


# -- the VM's configuration ---


# #978-T06
def test_the_boot_arguments_and_the_init_are_those_of_the_release() -> None:
    boot = (REPOSITORY / "dispatcher/src/vm-artifacts/boot.ts").read_text()
    args = re.search(r'RELEASE_BOOT_ARGS =\s*"([^"]+)"', boot)
    init = re.search(r'RELEASE_INIT_COMMAND =\s*"([^"]+)"', boot)

    assert args is not None and init is not None
    assert args.group(1) == BOOT_ARGS
    assert init.group(1) == INIT_COMMAND


# #978-T06
def test_the_command_line_names_the_mode_the_address_and_the_init() -> None:
    settings = FirecrackerSettings(Path("k"), Path("r"), Path("d"), IMAGE_ID)

    line = vmm.kernel_command_line(settings, Slot(2))

    assert line.startswith(BOOT_ARGS)
    assert " vm.mode=run vm.ip=172.31.0.10/30 vm.gw=172.31.0.9 " in line
    assert line.endswith("init=/usr/bin/docker-init -- /usr/local/sbin/vm-boot")


# #978-T06
def test_a_console_is_given_to_the_guest_only_when_asked_for() -> None:
    quiet = FirecrackerSettings(Path("k"), Path("r"), Path("d"), IMAGE_ID)
    loud = FirecrackerSettings(Path("k"), Path("r"), Path("d"), IMAGE_ID, console=True)

    assert "8250.nr_uarts=0 quiet loglevel=0" in vmm.kernel_command_line(quiet, Slot(0))
    line = vmm.kernel_command_line(loud, Slot(0))
    assert "console=ttyS0 8250.nr_uarts=1" in line
    assert "quiet" not in line and "8250.nr_uarts=0" not in line


# #978-T06
def test_the_config_file_is_written_once_and_only_the_owner_reads_it() -> None:
    with short_directory() as root:
        path = root / "firecracker.json"

        vmm.write_config({"a": 1}, path)

        assert json.loads(path.read_text()) == {"a": 1}
        assert path.stat().st_mode & 0o777 == 0o600
        with pytest.raises(FileExistsError):
            vmm.write_config({"a": 2}, path)


# #978-T06
def test_the_vmm_runs_without_the_jailer_and_without_an_api_socket() -> None:
    settings = FirecrackerSettings(Path("k"), Path("r"), Path("d"), IMAGE_ID)

    argv = vmm.command(settings, Path("/x/firecracker.json"))

    assert argv == [
        "/usr/local/bin/firecracker",
        "--no-api",
        "--config-file",
        "/x/firecracker.json",
    ]


# -- the settings ---


def machine(**changes: str) -> dict[str, str]:
    return {"FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID, **changes}


# #978-T10
def test_the_artifacts_and_the_state_are_below_var_lib_code_reviewer() -> None:
    settings = settings_from_environment(machine(), parallel_runs=3, disk_gb=40)

    assert settings.state_dir == Path("/var/lib/code-reviewer")
    assert settings.kernel == Path("/var/lib/code-reviewer/artifacts/vmlinux")
    assert settings.rootfs == Path("/var/lib/code-reviewer/artifacts/rootfs.ext4")
    assert settings.base_disk == Path("/var/lib/code-reviewer/artifacts/dockerdata.ext4")
    assert settings.vms_dir == Path("/var/lib/code-reviewer/vms")
    assert settings.slots == 3  # parallelRuns
    assert settings.quota_bytes == 40 * 1024**3 and settings.reserve_gib == 5
    assert settings.memory_mib == 4096 and settings.outer_wall is OuterWallMode.PROXY


# #978-T10
def test_the_environment_moves_the_paths_the_size_the_wall_and_the_timeout() -> None:
    settings = settings_from_environment(
        machine(
            FACTORY_RUNNER_VM_STATE_DIR="/srv/cr",
            FACTORY_RUNNER_VM_KERNEL="/boot/vm",
            FACTORY_RUNNER_VM_VCPUS="4",
            FACTORY_RUNNER_OUTER_WALL="inner-only",
            FACTORY_RUNNER_FIRECRACKER="/opt/fc",
        ),
        job_environment={"RUNNER_JOB_TIMEOUT_SECONDS": "1200"},
    )

    assert settings.vms_dir == Path("/srv/cr/vms") and settings.kernel == Path("/boot/vm")
    assert (settings.vcpus, settings.memory_mib) == (4, 8192)
    assert settings.outer_wall is OuterWallMode.INNER_ONLY and settings.firecracker == Path(
        "/opt/fc"
    )
    assert settings.wall_clock_seconds(150) == 1200 + 150 + 300


# #979
@pytest.mark.parametrize(
    ("value", "mode"),
    [
        ("proxy", OuterWallMode.PROXY),
        ("refuse", OuterWallMode.REFUSE),
        ("inner-only", OuterWallMode.INNER_ONLY),
        ("", OuterWallMode.PROXY),
    ],
)
def test_the_proxy_is_the_outer_wall_unless_the_operator_chose_another(
    value: str, mode: OuterWallMode
) -> None:
    settings = settings_from_environment(machine(FACTORY_RUNNER_OUTER_WALL=value))

    assert settings.outer_wall is mode


@pytest.mark.parametrize(
    ("environment", "kwargs", "message"),
    [
        ({}, {}, "IMAGE_ID"),
        (machine(FACTORY_RUNNER_OUTER_WALL="off"), {}, "OUTER_WALL"),
        (machine(FACTORY_RUNNER_VM_VCPUS="1"), {}, "vcpus"),
        (machine(FACTORY_RUNNER_VM_VCPUS="two"), {}, "whole number"),
        (machine(), {"parallel_runs": 0}, "slots"),
        (machine(), {"parallel_runs": MAX_SLOTS + 1}, "slots"),
        (machine(), {"disk_gb": 7}, "diskGb"),
    ],
)
# #978-T10
def test_a_setting_that_cannot_work_is_an_error_that_names_it(
    environment: dict[str, str], kwargs: dict[str, Any], message: str
) -> None:
    with pytest.raises(SettingsError, match=message):
        settings_from_environment(environment, **kwargs)


# #978-T13
def test_a_tail_on_a_vm_directory_is_not_killed_but_the_vmm_of_that_directory_is() -> None:
    with short_directory() as root:
        vms = root / "vms"
        vms.mkdir()
        leftover = vms / "vm-0-deadbeef"
        leftover.mkdir()
        (leftover / "firecracker.log").write_text("log\n")
        watcher = subprocess.Popen(["tail", "-f", f"{leftover}/firecracker.log"])
        editor = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)", f"{leftover}/firecracker.json"]
        )
        # Firecracker's binary, but another VM's configuration: not this directory's process.
        other = vmm_like(root, vms / "vm-1-cafebabe")
        vmm = vmm_like(root, leftover)
        try:
            assert processes_of(leftover, firecracker_path(root)) == [vmm.pid]

            reaped = reap_leftovers(vms, None, firecracker=firecracker_path(root))

            assert vmm.wait(timeout=5) == -9 and reaped.processes == (vmm.pid,)
            assert watcher.poll() is None and editor.poll() is None and other.poll() is None
        finally:
            for each in (watcher, editor, other, vmm):
                each.kill()
                each.wait()
