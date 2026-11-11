# SPDX-License-Identifier: LicenseRef-Proprietary

"""The installer, updater and uninstaller of the Factory-Runner on a machine with KVM (#982):
`runner/install/install.sh` against stand-ins for every command that needs root, in a directory
that plays the machine's root (`host_install_support.py`). The signatures, digests and unpacking
are checked by the real `openssl`, `jq`, `zstd`, `tar` and `sha256sum` against releases that are
signed with a real key. Nothing of the machine that runs the test is touched. What a real systemd,
a real `nft` and a real kernel do with the files is the job of the first install on a machine
(docs/runner.md, "First install on a real host") and of the installer lane of CI.

#982-T01 preflight without /dev/kvm; #982-T02 install, then uninstall; #982-T03 an update with a
bad signature; #982-T04 rollback."""

import fcntl
import ipaddress
import json
import os
import select
import stat
import subprocess
import termios
import time
from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest
from host_install_support import (
    FIRST_NETWORK,
    PROGRAM_BASE,
    REPOSITORY_ROOT,
    SCRIPT,
    TOKEN,
    VM_BASE,
    Machine,
    Release,
    new_machine,
)

pytestmark = pytest.mark.unit

# What changes the machine; the reads (`nft list`, `ip link show`, the manifests) are not in it.
MUTATORS = (
    "useradd",
    "userdel",
    "chown",
    "runuser",
    "ip tuntap",
    "ip addr",
    "ip link set",
    "ip link delete",
    "nft -f",
    "nft delete",
    "systemctl enable",
    "systemctl start",
    "systemctl daemon-reload",
)


@pytest.fixture
def machine(tmp_path: Path) -> Machine:
    return new_machine(tmp_path)


@pytest.fixture
def installed(machine: Machine) -> Machine:
    done = machine.install()
    assert done.returncode == 0, done.stderr
    return machine


def tree_without_locks(machine: Machine) -> dict[str, str]:
    """The tree of the machine; a lock file that stays after an update is a file, not a change."""
    return {path: kind for path, kind in machine.tree().items() if not path.endswith(".lock")}


def changed_nothing(machine: Machine) -> None:
    assert machine.tree() == machine.baseline
    assert not [call for call in machine.calls() if call.startswith(MUTATORS)]
    assert not machine.table_loaded and not machine.user_exists and not machine.taps


def publish(machine: Machine, **changes: object) -> Release:
    needs_vm = changes.pop("needs_vm", None)
    release = Release(
        program=int(str(changes.pop("program", 1))),
        vm=int(str(changes.pop("vm", 10))),
        needs_vm=None if needs_vm is None else int(str(needs_vm)),
        key=machine.release.key,
        tamper=set(changes.pop("tamper", ())),  # type: ignore[call-overload]
    )
    machine.publish(release)
    return release


# -- preflight --


# #982-T01
def test_preflight_without_kvm_stops_with_the_documented_message_and_changes_nothing(
    machine: Machine,
) -> None:
    (machine.root / "dev" / "kvm").unlink()
    machine.baseline = machine.tree()

    done = machine.install()

    assert done.returncode == 1
    for text in (
        "no /dev/kvm",
        "NESTED VIRTUALIZATION",
        "Intel VT-x / AMD-V",
        "Nothing was changed",
    ):
        assert text in done.stderr
    assert machine.tree() == machine.baseline
    # Not one command ran: the check comes first.
    assert machine.calls() == []


def without_nft(m: Machine) -> None:
    (m.bin / "nft").unlink()


def without_resize2fs(m: Machine) -> None:
    (m.bin / "resize2fs").unlink()


def without_cgroup2(m: Machine) -> None:
    (m.root / "sys/fs/cgroup/cgroup.controllers").unlink()


def without_systemd(m: Machine) -> None:
    (m.root / "run/systemd/system").rmdir()


@pytest.mark.parametrize(
    ("break_it", "message"),
    [
        (without_nft, "nft is not installed"),
        (without_resize2fs, "resize2fs is not installed"),
        (without_cgroup2, "cgroup v2"),
        (without_systemd, "systemd is not the init"),
    ],
)
def test_preflight_stops_for_a_missing_part_and_changes_nothing(
    machine: Machine, break_it: Callable[[Machine], None], message: str
) -> None:
    break_it(machine)
    machine.baseline = machine.tree()

    done = machine.install()

    assert done.returncode == 1
    assert message in done.stderr
    changed_nothing(machine)


@pytest.mark.parametrize(
    ("variables", "message"),
    [
        ({"STUB_SYSTEMD": "245"}, "systemd 245 is too old"),
        ({"STUB_UID": "1000"}, "run as root"),
        ({"STUB_NO_KVM_GROUP": "1"}, "the group kvm does not exist"),
    ],
)
def test_preflight_stops_for_a_machine_that_cannot_run_it(
    machine: Machine, variables: dict[str, str], message: str
) -> None:
    done = machine.install(env=variables)

    assert done.returncode == 1
    assert message in done.stderr
    changed_nothing(machine)


def test_a_filesystem_without_reflinks_is_a_warning_not_a_stop(machine: Machine) -> None:
    done = machine.install()

    assert done.returncode == 0, done.stderr
    assert "not on a file system with reflinks" in done.stderr
    assert "34 ms" in done.stderr


def test_a_filesystem_with_reflinks_is_not_warned_about(machine: Machine) -> None:
    done = machine.install(env={"STUB_REFLINK": "1"})

    assert done.returncode == 0, done.stderr
    assert "reflinks" not in done.stderr


def with_foreign_unit(m: Machine) -> None:
    m.unit.write_text("[Unit]\n")


def with_foreign_user(m: Machine) -> None:
    (m.state / "users").mkdir()
    (m.state / "users" / "factory-runner").write_text("x")


def with_foreign_table(m: Machine) -> None:
    (m.state / "nft-table").write_text("x")


def with_foreign_tap(m: Machine) -> None:
    (m.state / "taps").mkdir()
    (m.state / "taps" / "fctap0").write_text("x")


def with_foreign_opt(m: Machine) -> None:
    (m.root / "opt/code-reviewer").mkdir()


def with_foreign_state_dir(m: Machine) -> None:
    (m.root / "var/lib/code-reviewer").mkdir()
    (m.root / "var/lib/code-reviewer/x").write_text("")


@pytest.mark.parametrize(
    ("make", "message"),
    [
        (with_foreign_unit, "this installer did not make"),
        (with_foreign_user, "must own nothing else"),
        (with_foreign_table, "nft table code_reviewer_wall is loaded"),
        (with_foreign_tap, "TAP devices named fctapN"),
        (with_foreign_opt, "was not made by this installer"),
        (with_foreign_state_dir, "is not empty"),
    ],
)
def test_a_second_dispatcher_is_refused_and_what_is_not_ours_is_never_reused(
    machine: Machine, make: Callable[[Machine], None], message: str
) -> None:
    make(machine)
    before = machine.tree()

    done = machine.install()

    assert done.returncode == 1
    assert message in done.stderr
    assert machine.tree() == before
    assert not [call for call in machine.calls() if call.startswith(("useradd", "chown", "curl"))]


def test_an_install_over_an_install_is_refused_without_refresh(installed: Machine) -> None:
    before = installed.tree()

    done = installed.install()

    assert done.returncode == 1
    assert "installed on this machine already" in done.stderr
    assert installed.tree() == before


# -- install --


def test_the_install_makes_the_user_the_artifacts_the_taps_the_table_and_the_units(
    machine: Machine,
) -> None:
    done = machine.install("--labels", "linux,gpu", "--name", "build box")

    assert done.returncode == 0, done.stderr
    assert done.stdout.rstrip().endswith("install: done")
    calls = machine.calls()
    # The service user: a system user in kvm, no shell, no login.
    useradd = next(call for call in calls if call.startswith("useradd"))
    for part in ("--system", "--user-group", "--groups kvm", "--no-create-home", "factory-runner"):
        assert part in useradd
    # The artifacts: root's, read-only for the service (mode and owner).
    artifacts = machine.state_dir / "artifacts"
    assert artifacts.is_symlink() and os.readlink(artifacts) == "artifact-releases/10"
    for name in ("vmlinux", "rootfs.ext4", "dockerdata.ext4"):
        assert stat.S_IMODE((artifacts / name).stat().st_mode) == 0o644
    assert stat.S_IMODE(artifacts.stat().st_mode) == 0o755
    assert "chown -R root:root" in " ".join(calls)
    assert (
        artifacts / "vm.env"
    ).read_text() == f"FACTORY_RUNNER_VM_IMAGE_ID={machine.release.image_id}\n"
    # The service owns vms/ and its lock and nothing else of the state directory.
    assert any(
        call.startswith("chown factory-runner:factory-runner")
        and str(machine.state_dir / "vms") in call
        for call in calls
    )
    assert stat.S_IMODE((machine.state_dir / "vms").stat().st_mode) == 0o700
    # The program, a release with its predecessor kept.
    assert os.readlink(machine.opt / "current") == "releases/1"
    assert (machine.opt / "releases/1/libexec/host.sh").is_file()
    # One TAP device, owned by the user, with the /30 of slot 0.
    assert machine.taps == ["fctap0"]
    assert "ip tuntap add dev fctap0 mode tap user factory-runner group factory-runner" in calls
    assert "ip addr replace 10.250.0.1/30 dev fctap0" in calls
    # The table: checked, loaded, listed; only then is the unit written and started.
    check = next(index for index, call in enumerate(calls) if call.startswith("nft -c -f "))
    load = calls.index(f"nft -f {machine.state_dir}/outer-wall.nft")
    listed = calls.index("nft list table inet code_reviewer_wall", load)
    enabled = calls.index("systemctl enable factory-runner")
    assert check < load < listed < enabled < calls.index("systemctl start factory-runner")
    assert machine.table_loaded
    assert (machine.conf / "install.state").read_text().splitlines()[:1] == ["version=1"]
    assert "user_created=1" in (machine.conf / "install.state").read_text()
    assert "taps=1" in (machine.conf / "install.state").read_text()
    assert "slot_network=10.250.0.0/24" in (machine.conf / "install.state").read_text()


def test_the_unit_is_a_sandboxed_service_of_a_normal_user_with_the_outer_wall_on(
    installed: Machine,
) -> None:
    unit = installed.unit.read_text()

    for line in (
        "User=factory-runner",
        "SupplementaryGroups=kvm",
        "Delegate=yes",
        "Environment=FACTORY_RUNNER_SANDBOX=firecracker",
        "Environment=FACTORY_RUNNER_OUTER_WALL=proxy",
        "ExecStartPre=+/opt/code-reviewer/current/libexec/host.sh prestart",
        "ExecStart=/opt/code-reviewer/current/libexec/host.sh run-service",
        "RestartPreventExitStatus=4 6 9",
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "ProtectHome=yes",
        "PrivateTmp=yes",
        "CapabilityBoundingSet=",
        "DevicePolicy=closed",
        "DeviceAllow=/dev/kvm rw",
        "DeviceAllow=/dev/net/tun rw",
        "ReadWritePaths=/var/lib/code-reviewer/vms /var/lib/code-reviewer/dispatcher.lock "
        "/var/lib/factory-runner",
    ):
        assert line in unit.splitlines(), line
    limit = next(line for line in unit.splitlines() if line.startswith("LimitNOFILE="))
    # The vsock listeners (2 x 4 connections per VM) and the proxy's 256 connections (two each).
    assert int(limit.split("=")[1]) >= 8192
    assert "docker" not in unit.lower()
    assert "--privileged" not in unit and "PrivateDevices" not in unit
    assert "ProtectControlGroups" not in unit.replace(
        "# ", ""
    )  # cgroup writes are the service's job
    env = (installed.conf / "runner.env").read_text()
    assert (
        "FACTORY_RUNNER_PARALLEL_RUNS=1" in env
        and "FACTORY_RUNNER_HOME=/var/lib/factory-runner" in env
    )
    assert "OUTER_WALL" not in env and "TOKEN" not in env and "crc_" not in env
    timer = (installed.unit.parent / "factory-runner-update.timer").read_text()
    assert "OnUnitActiveSec=6h" in timer
    service = (installed.unit.parent / "factory-runner-update.service").read_text()
    assert "host.sh update --scheduled" in service and "Type=oneshot" in service


def test_the_wall_is_in_the_unit_only_after_the_table_was_listed_and_a_failed_listing_fails(
    machine: Machine,
) -> None:
    done = machine.install(env={"STUB_NFT_LIST_FAIL": "1"})

    assert done.returncode == 1
    assert "is not loaded" in done.stderr
    calls = machine.calls()
    # The unit was never written, so never `proxy`; the service never enabled or started.
    assert not machine.unit.exists()
    assert (
        "systemctl enable factory-runner" not in calls
        and "systemctl start factory-runner" not in calls
    )
    assert machine.tree() == machine.baseline
    assert not machine.table_loaded and not machine.user_exists and not machine.taps


def test_a_table_that_does_not_check_on_this_kernel_stops_before_the_network_is_touched(
    machine: Machine,
) -> None:
    done = machine.install(env={"STUB_NFT_CHECK_FAIL": "1"})

    assert done.returncode == 1
    assert "nft_fib" in done.stderr
    assert not any(call.startswith(("nft -f", "ip tuntap")) for call in machine.calls())
    assert machine.tree() == machine.baseline


def test_the_token_is_never_in_an_argument_or_a_file_only_on_standard_input(
    machine: Machine,
) -> None:
    done = machine.install("--labels", "linux")

    assert done.returncode == 0, done.stderr
    assert (machine.state / "register-stdin").read_text() == TOKEN
    assert not [call for call in machine.calls() if TOKEN in call]
    assert not [path for path in machine.tree() if TOKEN in path]
    assert (
        TOKEN not in machine.unit.read_text()
        and TOKEN not in (machine.conf / "runner.env").read_text()
    )
    register = next(
        line for line in (machine.state / "cli.log").read_text().splitlines() if "register" in line
    )
    assert "register --token-file - --labels linux" in register
    assert "FACTORY_RUNNER_TOKEN" not in done.stdout


def test_a_token_argument_is_refused(machine: Machine) -> None:
    done = machine.install("--token", TOKEN, token=False)

    assert done.returncode == 1
    assert "never an argument" in done.stderr
    assert TOKEN not in done.stderr
    changed_nothing(machine)


def test_the_token_can_come_from_a_file_or_standard_input(machine: Machine, tmp_path: Path) -> None:
    done = machine.install("--token-file", "-", token=False, stdin=TOKEN)

    assert done.returncode == 0, done.stderr
    assert (machine.state / "register-stdin").read_text() == TOKEN


def test_without_a_token_the_machine_is_installed_and_the_service_is_not_started(
    machine: Machine,
) -> None:
    done = machine.install(token=False)

    assert done.returncode == 0, done.stderr
    assert "no registration token: the service is installed but not started" in done.stdout
    assert "systemctl start factory-runner" not in machine.calls()
    assert machine.unit.exists() and machine.table_loaded


def test_a_token_that_does_not_register_leaves_the_install_in_place_and_says_so(
    machine: Machine,
) -> None:
    done = machine.install(env={"FACTORY_RUNNER_TOKEN": "not-a-token"})

    assert done.returncode == 1
    assert "does not have the form of a token" in done.stderr
    # Gigabytes were downloaded: a typo does not undo them.
    assert machine.unit.exists() and (machine.opt / "current").is_symlink()
    assert "systemctl start factory-runner" not in machine.calls()


def test_parallel_runs_make_a_tap_device_and_an_address_per_slot_and_scale_the_limits(
    machine: Machine,
) -> None:
    done = machine.install("--parallel-runs", "3")

    assert done.returncode == 0, done.stderr
    assert machine.taps == ["fctap0", "fctap1", "fctap2"]
    calls = machine.calls()
    assert "ip addr replace 10.250.0.5/30 dev fctap1" in calls
    assert "ip addr replace 10.250.0.9/30 dev fctap2" in calls
    assert "FACTORY_RUNNER_PARALLEL_RUNS=3" in (machine.conf / "runner.env").read_text()
    unit = machine.unit.read_text()
    assert "LimitNOFILE=8384" in unit and "TasksMax=1156" in unit


def test_a_hundred_slots_are_refused(machine: Machine) -> None:
    done = machine.install("--parallel-runs", "100")

    assert done.returncode == 1 and "1 to 64" in done.stderr
    changed_nothing(machine)


def test_the_slot_addresses_are_the_ones_the_launcher_derives() -> None:
    from code_reviewer_runner.factory_runner.firecracker.slots import Slot

    network = ipaddress.IPv4Network(FIRST_NETWORK)
    script = SCRIPT.read_text()
    assert "* 4 + 1" in script and 'int_to_ip $(( $(ip_to_int "${network%/*}")' in script
    assert Slot(0, network).host_address == "10.250.0.1"
    assert Slot(63, network).host_address == "10.250.0.253"


@pytest.mark.parametrize(
    ("tamper", "message"),
    [
        ({"program-bad-signature"}, "signature of the program release manifest is not valid"),
        ({"vm-bad-signature"}, "signature of the vm release manifest is not valid"),
    ],
)
def test_a_manifest_that_does_not_verify_stops_the_install_before_any_change(
    machine: Machine, tamper: set[str], message: str
) -> None:
    publish(machine, tamper=tamper)

    done = machine.install()

    assert done.returncode == 1
    assert message in done.stderr
    changed_nothing(machine)


@pytest.mark.parametrize(
    ("tamper", "message"),
    [
        ({"program-flip-byte"}, "does not match the digest"),
        ({"vm-flip-kernel"}, "kernel file does not match the digest"),
        ({"vm-flip-rootfs"}, "rootfs file is not the size"),
        ({"bundle-escape"}, "path outside its own tree"),
        ({"bundle-link-out"}, "link that points out of its tree"),
        ({"bundle-drop:libexec/host.sh"}, "has no libexec/host.sh"),
    ],
)
def test_a_file_that_does_not_match_its_manifest_is_never_installed_and_nothing_is_left(
    machine: Machine, tamper: set[str], message: str
) -> None:
    publish(machine, tamper=tamper)

    done = machine.install()

    assert done.returncode == 1
    assert message in done.stderr
    assert machine.tree() == machine.baseline
    assert not machine.table_loaded and not machine.user_exists and not machine.taps


def test_an_empty_channel_stops_with_no_release_published_and_changes_nothing(
    machine: Machine,
) -> None:
    channel = json.loads(machine.vm_channel.read_text())
    channel.update(baseUrl="", publicKey="")
    machine.vm_channel.write_text(json.dumps(channel))

    done = machine.install()

    assert done.returncode == 1
    assert "no vm release is published yet" in done.stderr
    changed_nothing(machine)


def test_a_channel_that_is_not_https_is_refused(machine: Machine) -> None:
    channel = json.loads(machine.program_channel.read_text())
    channel["baseUrl"] = "http://releases.example/runner/"
    machine.program_channel.write_text(json.dumps(channel))

    done = machine.install()

    assert done.returncode == 1 and "https" in done.stderr
    changed_nothing(machine)


def test_every_download_is_https_from_the_channel_and_nothing_names_the_app_or_docker(
    installed: Machine,
) -> None:
    urls = [
        word for call in installed.calls("curl") for word in call.split() if word.startswith("http")
    ]

    assert urls
    assert all(url.startswith((PROGRAM_BASE, VM_BASE)) for url in urls)
    assert all(
        "--proto =https" in call and "--proto-redir =https" in call
        for call in installed.calls("curl")
    )
    assert not [call for call in installed.calls() if call.startswith("docker")]


def test_a_curl_configuration_for_a_protected_address_is_kept_for_updates_for_root_only(
    machine: Machine, tmp_path: Path
) -> None:
    rc = tmp_path / "login.curlrc"
    rc.write_text('header = "Authorization: Bearer secret-value"\n')

    done = machine.install("--curl-config", str(rc))

    assert done.returncode == 0, done.stderr
    kept = machine.conf / "download.curlrc"
    assert kept.read_text() == rc.read_text() and stat.S_IMODE(kept.stat().st_mode) == 0o600
    assert f"curl -K {rc}" in " ".join(machine.calls("curl"))
    # Made readable by root alone from its first byte (a umask, not a chmod afterwards).
    assert 'umask 077; cat "$CURL_CONFIG"' in SCRIPT.read_text()
    assert "secret-value" not in done.stdout + done.stderr
    update = machine.host("update")
    assert update.returncode == 0, update.stderr
    assert any(f"curl -K {kept}" in call for call in machine.calls("curl"))


def test_the_dry_run_says_what_it_would_do_and_changes_nothing(machine: Machine) -> None:
    done = machine.install("--dry-run")

    assert done.returncode == 0, done.stderr
    assert "dry run: nothing is changed" in done.stdout
    assert machine.tree() == machine.baseline
    assert not [call for call in machine.calls() if call.startswith(MUTATORS)]


def test_a_script_that_is_cut_off_anywhere_changes_nothing(machine: Machine) -> None:
    text = SCRIPT.read_text()
    lines = text.splitlines(keepends=True)
    cuts = [sum(map(len, lines[:count])) for count in range(10, len(lines), 90)]
    cuts += [len(text) - 5, len(text) - 20]
    for cut in cuts:
        done = subprocess.run(
            ["/bin/sh", "-s", "--", "--program-channel-file", str(machine.program_channel)],
            env=machine.environment({"FACTORY_RUNNER_TOKEN": TOKEN}),
            input=text[:cut],
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
            start_new_session=True,
        )
        assert "install: done" not in done.stdout
    changed_nothing(machine)


# -- T02: install, then uninstall --


# #982-T02
def test_install_then_uninstall_leaves_no_table_tap_user_or_file_behind(machine: Machine) -> None:
    # Things that are not ours stay: another directory in /opt, another file in /etc, another user.
    (machine.root / "opt/other").mkdir()
    (machine.root / "opt/other/keep").write_text("mine")
    (machine.root / "etc/other.conf").write_text("mine")
    (machine.state / "users").mkdir()
    (machine.state / "users" / "someone").write_text("x")
    before = machine.tree()
    done = machine.install("--parallel-runs", "2")
    assert done.returncode == 0, done.stderr
    assert machine.table_loaded and machine.user_exists and machine.taps == ["fctap0", "fctap1"]

    gone = machine.host("uninstall")

    assert gone.returncode == 0, gone.stderr
    assert not machine.table_loaded and not machine.user_exists and machine.taps == []
    assert machine.tree() == before
    assert (machine.root / "opt/other/keep").read_text() == "mine"
    assert (machine.state / "users" / "someone").exists()
    calls = machine.calls()
    assert "systemctl disable --now factory-runner" in calls
    assert "nft delete table inet code_reviewer_wall" in calls
    assert "ip link delete fctap0" in calls and "ip link delete fctap1" in calls
    assert "userdel factory-runner" in calls
    assert "revoke this runner in the app" in gone.stdout


def test_uninstall_removes_the_user_only_when_the_installer_made_it(installed: Machine) -> None:
    state = installed.conf / "install.state"
    state.write_text(
        "".join(
            line
            for line in state.read_text().splitlines(keepends=True)
            if not line.startswith("user_created")
        )
    )

    gone = installed.host("uninstall")

    assert gone.returncode == 0, gone.stderr
    assert "userdel" not in " ".join(installed.calls())
    assert installed.user_exists


def test_uninstall_of_a_machine_without_the_runner_does_nothing(machine: Machine) -> None:
    done = machine.run_script(SCRIPT, "--uninstall")

    assert done.returncode == 0 and "nothing to remove" in done.stdout
    assert machine.tree() == machine.baseline


def test_uninstall_removes_what_an_update_and_a_rollback_left_too(installed: Machine) -> None:
    publish(installed, program=2, vm=11)
    assert installed.host("update").returncode == 0
    assert installed.host("switch").returncode == 0
    assert installed.host("rollback").returncode == 0

    gone = installed.host("uninstall")

    assert gone.returncode == 0, gone.stderr
    assert installed.tree() == installed.baseline


def test_uninstall_dry_run_changes_nothing(installed: Machine) -> None:
    before = installed.tree()

    done = installed.host("uninstall", "--dry-run")

    assert done.returncode == 0 and "would remove" in done.stdout
    assert installed.tree() == before and installed.table_loaded and installed.user_exists


# -- updates --


def stage_release_two(machine: Machine) -> None:
    publish(machine, program=2, vm=11)
    done = machine.host("update")
    assert done.returncode == 0, done.stderr


def test_an_update_stages_the_newer_release_and_changes_nothing_that_runs(
    installed: Machine,
) -> None:
    publish(installed, program=2, vm=11)
    restarts = len(installed.calls("systemctl"))

    done = installed.host("update")

    assert done.returncode == 0, done.stderr
    assert (
        "staged the program release 2" in done.stdout
        and "staged the VM artifacts release 11" in done.stdout
    )
    # What runs is untouched: only the marker says there is something to switch to.
    assert os.readlink(installed.opt / "current") == "releases/1"
    assert os.readlink(installed.state_dir / "artifacts") == "artifact-releases/10"
    assert (installed.state_dir / "pending").read_text().splitlines() == [
        "program=2",
        "vm=11",
        "pair=1",
    ]
    assert (installed.opt / "releases/2/bin/factory-runner").is_file()
    assert (installed.state_dir / "artifact-releases/11/vm.env").is_file()
    assert len(installed.calls("systemctl")) == restarts  # nothing was restarted
    assert not (installed.state_dir / "staging").exists()


# #1002-T21: the pair is the program's own statement (`share/release.json`, `vmArtifacts`), not
# "the newest of both".
@pytest.fixture
def paired(tmp_path: Path) -> Machine:
    """Installed with release 1 and VM artifacts 10, on a channel with an address per VM release."""
    machine = new_machine(tmp_path, per_release_vm=True)
    done = machine.install()
    assert done.returncode == 0, done.stderr
    return machine


def test_a_program_is_staged_with_the_vm_artifacts_it_names_not_the_newest_ones(
    paired: Machine,
) -> None:
    # Release 12 exists and is the newest; program 2 was made for 11.
    publish(paired, program=1, vm=12)
    publish(paired, program=2, vm=11)
    paired.log.write_text("")

    done = paired.host("update")

    assert done.returncode == 0, done.stderr
    assert "staged the program release 2" in done.stdout
    assert "staged the VM artifacts release 11" in done.stdout
    assert (paired.state_dir / "pending").read_text().splitlines() == [
        "program=2",
        "vm=11",
        "pair=1",
    ]
    assert not (paired.state_dir / "artifact-releases/12").exists()
    assert "vm/12/" not in " ".join(paired.calls("curl")), "the newest VM release was downloaded"
    assert paired.host("switch").returncode == 0
    assert paired.release_of("artifacts", parent=paired.state_dir) == "11"


def test_a_fresh_install_takes_the_vm_artifacts_the_program_names(tmp_path: Path) -> None:
    machine = new_machine(tmp_path, Release(program=3, vm=2), per_release_vm=True)
    # A newer VM release exists, a program for it does not.
    machine.publish_vm(Release(vm=5, key=machine.release.key))

    done = machine.install()

    assert done.returncode == 0, done.stderr
    assert machine.release_of("artifacts", parent=machine.state_dir) == "2"
    assert machine.release_of("current") == "3"
    assert not (machine.state_dir / "artifact-releases/5").exists()


def test_a_program_published_before_its_vm_artifacts_is_not_taken(paired: Machine) -> None:
    before = tree_without_locks(paired)
    publish(paired, program=2, vm=11)
    for name in (paired.served / "vm/11").iterdir():
        name.unlink()  # the owner published the program first: its VM release is not there yet

    done = paired.host("update")

    assert done.returncode == 1
    assert "VM artifacts release 11" in done.stderr and "program release 2" in done.stderr
    assert "not taken" in done.stderr
    assert tree_without_locks(paired) == before
    assert not (paired.state_dir / "pending").exists()


def test_a_program_whose_vm_artifacts_do_not_verify_is_not_taken(paired: Machine) -> None:
    before = tree_without_locks(paired)
    publish(paired, program=2, vm=11, tamper={"vm-bad-signature"})

    done = paired.host("update")

    assert done.returncode == 1
    assert "signature of the vm release manifest is not valid" in done.stderr
    assert tree_without_locks(paired) == before
    assert not (paired.opt / "releases/2").exists()


def test_a_vm_release_alone_is_never_taken(paired: Machine) -> None:
    # Exact pairing: the current program names VM release 10 and no other, so a newer VM release
    # changes nothing until a program names it.
    publish(paired, program=1, vm=11)
    paired.log.write_text("")

    done = paired.host("update")

    assert done.returncode == 0, done.stderr
    assert not (paired.state_dir / "pending").exists()
    assert not (paired.state_dir / "artifact-releases/11").exists()
    assert "vm/11/" not in " ".join(paired.calls("curl"))


def test_a_program_that_names_the_installed_vm_artifacts_is_staged_alone(paired: Machine) -> None:
    publish(paired, program=2, vm=10)
    paired.log.write_text("")

    done = paired.host("update")

    assert done.returncode == 0, done.stderr
    assert "staged the program release 2" in done.stdout
    assert "staged the VM artifacts" not in done.stdout
    assert (paired.state_dir / "pending").read_text().splitlines() == ["program=2"]
    assert "vm/10/" not in " ".join(paired.calls("curl")), (
        "VM artifacts in place were fetched again"
    )


def test_a_newer_program_replaces_a_staged_pair_with_its_own(paired: Machine) -> None:
    publish(paired, program=2, vm=11)
    assert paired.host("update").returncode == 0
    publish(
        paired, program=3, vm=10
    )  # needs the VM artifacts that are installed: the staged VM 11 goes

    done = paired.host("update")

    assert done.returncode == 0, done.stderr
    assert (paired.state_dir / "pending").read_text().splitlines() == ["program=3"]
    assert paired.host("switch").returncode == 0
    assert paired.release_of("current") == "3"
    assert paired.release_of("artifacts", parent=paired.state_dir) == "10"


def test_a_program_that_names_the_staged_vm_artifacts_keeps_them_as_a_pair(paired: Machine) -> None:
    publish(paired, program=2, vm=11)
    assert paired.host("update").returncode == 0
    publish(paired, program=3, vm=11)

    done = paired.host("update")

    assert done.returncode == 0, done.stderr
    assert (paired.state_dir / "pending").read_text().splitlines() == [
        "program=3",
        "vm=11",
        "pair=1",
    ]


def test_a_program_that_would_take_the_vm_artifacts_back_is_not_taken(tmp_path: Path) -> None:
    machine = new_machine(tmp_path, Release(program=1, vm=10), per_release_vm=True)
    assert machine.install().returncode == 0
    publish(machine, program=2, vm=9)

    done = machine.host("update")

    assert done.returncode == 0, done.stderr
    assert "VM artifacts release 9" in done.stdout and "release 10" in done.stdout
    assert not (machine.state_dir / "pending").exists()
    assert not (machine.opt / "releases/2").exists()


def test_a_program_that_needs_rolled_back_vm_artifacts_waits_for_a_higher_one(
    paired: Machine,
) -> None:
    publish(paired, program=2, vm=11)
    assert paired.host("update").returncode == 0
    assert paired.host("switch").returncode == 0
    assert paired.host("rollback").returncode == 0
    assert paired.host("prestart").returncode == 0
    publish(paired, program=3, vm=11)  # a new program for the VM release that was rolled back

    done = paired.host("update")

    assert done.returncode == 0, done.stderr
    assert "rolled back" in done.stdout
    assert not (paired.state_dir / "pending").exists()
    publish(paired, program=3, vm=12)
    assert paired.host("update").returncode == 0
    assert (paired.state_dir / "pending").read_text().splitlines() == [
        "program=3",
        "vm=12",
        "pair=1",
    ]


def test_a_channel_with_one_directory_serves_only_the_release_it_holds(tmp_path: Path) -> None:
    # No `{release}` in the address: the directory holds one VM release (the newest), and the
    # program names an older one.
    machine = new_machine(tmp_path, Release(program=1, vm=10, needs_vm=9))

    done = machine.install()

    assert done.returncode == 1
    assert "release 10" in done.stderr and "needs release 9" in done.stderr
    changed_nothing(machine)


@pytest.mark.parametrize("tamper", ["bundle-drop:share/release.json", "bundle-vm-not-a-number"])
def test_a_program_that_does_not_name_a_vm_release_is_not_taken(
    tmp_path: Path, tamper: str
) -> None:
    machine = new_machine(tmp_path, Release(tamper={tamper}))

    done = machine.install()

    assert done.returncode == 1
    assert "VM artifacts release" in done.stderr or "not a runner release" in done.stderr
    changed_nothing(machine)


# #982-T03
def test_an_update_with_a_bad_signature_is_refused_and_the_running_version_stays(
    installed: Machine,
) -> None:
    before = tree_without_locks(installed)
    publish(installed, program=2, vm=11, tamper={"program-bad-signature"})

    done = installed.host("update")

    assert done.returncode == 1
    assert "signature of the program release manifest is not valid" in done.stderr
    assert tree_without_locks(installed) == before
    assert os.readlink(installed.opt / "current") == "releases/1"
    assert (
        not (installed.state_dir / "pending").exists()
        and not (installed.opt / "releases/2").exists()
    )
    # And through a signature of the other release: the VM artifacts.
    publish(installed, program=2, vm=11, tamper={"vm-bad-signature"})
    done = installed.host("update")
    assert (
        done.returncode == 1 and "signature of the vm release manifest is not valid" in done.stderr
    )
    assert tree_without_locks(installed) == before


def test_an_update_whose_file_does_not_match_its_digest_stages_nothing(installed: Machine) -> None:
    before = tree_without_locks(installed)
    publish(installed, program=2, vm=10, tamper={"program-flip-byte"})

    done = installed.host("update")

    assert done.returncode == 1 and "does not match the digest" in done.stderr
    assert tree_without_locks(installed) == before


def test_an_update_to_the_same_release_downloads_no_file(installed: Machine) -> None:
    done = installed.host("update")

    assert done.returncode == 0, done.stderr
    assert done.stdout.count("nothing to do") == 1
    downloaded = " ".join(installed.calls("curl")[-4:])
    assert ".tar.zst" not in downloaded and "vmlinux" not in downloaded


def test_an_update_never_takes_an_older_release_than_the_installed_one(installed: Machine) -> None:
    publish(installed, program=1, vm=9)

    done = installed.host("update")

    assert done.returncode == 0 and "nothing to do" in done.stdout
    assert not (installed.state_dir / "pending").exists()


def test_a_scheduled_update_does_not_look_when_the_operator_turned_updates_off(
    installed: Machine,
) -> None:
    (installed.root / "var/lib/factory-runner/config.json").write_text('{"autoUpdate": false}')
    calls = len(installed.calls("curl"))

    done = installed.host("update", "--scheduled")

    assert done.returncode == 0 and "automatic updates are off" in done.stdout
    assert len(installed.calls("curl")) == calls
    # By hand it still works.
    assert installed.host("update").returncode == 0
    assert len(installed.calls("curl")) > calls


def test_an_update_needs_root(installed: Machine) -> None:
    done = installed.host("update", env={"STUB_UID": "1000"})

    assert done.returncode == 1 and "run as root" in done.stderr


def test_an_update_needs_an_installed_runner(tmp_path: Path) -> None:
    bare = new_machine(tmp_path / "bare")

    done = bare.run_script(SCRIPT, "update")

    assert done.returncode == 1 and "not installed" in done.stderr


def test_the_start_switches_to_the_staged_release_and_keeps_the_one_before(
    installed: Machine,
) -> None:
    stage_release_two(installed)

    done = installed.host("prestart")

    assert done.returncode == 0, done.stderr
    assert installed.release_of("current") == "2" and installed.release_of("previous") == "1"
    assert installed.release_of("artifacts", parent=installed.state_dir) == "11"
    assert installed.release_of("artifacts-previous", parent=installed.state_dir) == "10"
    assert not (installed.state_dir / "pending").exists()
    # The one before is kept whole; it is what a rollback goes to.
    assert (installed.opt / "releases/1/bin/factory-runner").is_file()
    assert (installed.state_dir / "artifact-releases/10/vmlinux").is_file()
    # The table is loaded again from the release that is current, and proven.
    calls = installed.calls()
    assert calls.count("nft list table inet code_reviewer_wall") >= 2


def test_only_the_current_the_previous_and_the_waiting_release_are_kept(installed: Machine) -> None:
    stage_release_two(installed)
    assert installed.host("switch").returncode == 0
    publish(installed, program=3, vm=12)
    assert installed.host("update").returncode == 0
    assert installed.host("switch").returncode == 0

    assert sorted(path.name for path in (installed.opt / "releases").iterdir()) == ["2", "3"]
    assert sorted(path.name for path in (installed.state_dir / "artifact-releases").iterdir()) == [
        "11",
        "12",
    ]


def test_a_program_that_does_not_run_is_not_switched_to_and_is_not_taken_again(
    installed: Machine,
) -> None:
    publish(installed, program=2, vm=10, tamper={"program-broken"})
    assert installed.host("update").returncode == 0

    done = installed.host("switch")

    assert done.returncode == 0
    assert "does not run on this machine" in done.stderr
    assert installed.release_of("current") == "1" and not (installed.state_dir / "pending").exists()
    assert (installed.conf / "rejected-program").read_text() == "2\n"
    again = installed.host("update")
    assert "was rolled back" in again.stdout
    assert (
        not (installed.opt / "releases/2").exists()
        or not (installed.state_dir / "pending").exists()
    )


def test_the_start_fails_when_the_table_is_not_loaded_so_the_service_never_runs_without_its_wall(
    installed: Machine,
) -> None:
    done = installed.host("prestart", env={"STUB_NFT_LIST_FAIL": "1"})

    assert done.returncode == 1
    assert "is not loaded" in done.stderr and "does not start" in done.stderr


def test_the_start_makes_the_tap_devices_a_restart_of_the_machine_took(installed: Machine) -> None:
    (installed.state / "taps" / "fctap0").unlink()

    done = installed.host("prestart")

    assert done.returncode == 0, done.stderr
    assert installed.taps == ["fctap0"]


def test_the_service_is_started_with_the_vm_settings_of_the_current_artifacts(
    installed: Machine,
) -> None:
    done = installed.host("run-service")

    assert done.returncode == 0, done.stderr
    last = (installed.state / "cli.log").read_text().splitlines()[-1]
    assert last == f"factory-runner run image={installed.release.image_id} release=1"


def test_the_service_without_vm_artifacts_ends_with_the_configuration_exit_code(
    installed: Machine,
) -> None:
    (installed.state_dir / "artifacts").unlink()

    done = installed.host("run-service")

    assert done.returncode == 6


# -- T04: rollback --


# #982-T04
def test_a_rollback_returns_to_the_previous_release_and_does_not_take_the_one_it_left(
    installed: Machine,
) -> None:
    stage_release_two(installed)
    assert installed.host("switch").returncode == 0
    assert installed.release_of("current") == "2"

    done = installed.host("rollback")

    assert done.returncode == 0, done.stderr
    assert (installed.state_dir / "pending").read_text().splitlines() == ["program=1", "vm=10"]
    assert (installed.conf / "rejected-program").read_text() == "2\n"
    assert (installed.conf / "rejected-vm").read_text() == "11\n"
    # It goes back between two jobs: at the next start.
    assert installed.release_of("current") == "2"
    assert installed.host("prestart").returncode == 0
    assert installed.release_of("current") == "1"
    assert installed.release_of("artifacts", parent=installed.state_dir) == "10"
    # The release left is gone and is not `previous`: a second rollback does not go forward.
    assert not (installed.opt / "previous").exists() and not (installed.opt / "releases/2").exists()
    assert installed.host("rollback").returncode == 1
    # The channel still announces release 2: it is not taken. A higher one is.
    again = installed.host("update")
    assert "was rolled back" in again.stdout and not (installed.state_dir / "pending").exists()
    publish(installed, program=3, vm=12)
    assert installed.host("update").returncode == 0
    assert (installed.state_dir / "pending").read_text().splitlines() == [
        "program=3",
        "vm=12",
        "pair=1",
    ]


def test_a_rollback_with_a_staged_release_cancels_it_instead_of_going_back(
    installed: Machine,
) -> None:
    stage_release_two(installed)

    done = installed.host("rollback")

    assert done.returncode == 0, done.stderr
    assert "cancelled" in done.stdout
    assert (
        not (installed.state_dir / "pending").exists()
        and not (installed.opt / "releases/2").exists()
    )
    assert installed.release_of("current") == "1"
    assert "was rolled back" in installed.host("update").stdout


def test_a_rollback_without_an_earlier_release_says_so(installed: Machine) -> None:
    done = installed.host("rollback")

    assert done.returncode == 1 and "no earlier release" in done.stderr


def test_a_rollback_now_restarts_the_service_and_one_without_it_does_not(
    installed: Machine,
) -> None:
    stage_release_two(installed)
    assert installed.host("switch").returncode == 0
    before = installed.calls("systemctl restart")

    assert installed.host("rollback").returncode == 0
    assert installed.calls("systemctl restart") == before
    assert installed.host("prestart").returncode == 0

    publish(installed, program=3, vm=12)
    assert installed.host("update").returncode == 0
    assert installed.host("switch").returncode == 0
    assert installed.host("rollback", "--now").returncode == 0
    assert installed.calls("systemctl restart") == [*before, "systemctl restart factory-runner"]


def test_status_names_the_current_the_previous_and_the_staged_release(installed: Machine) -> None:
    stage_release_two(installed)

    done = installed.host("status")

    assert done.returncode == 0
    assert "program: current 1, previous none, staged 2, rejected up to 0" in done.stdout
    assert "vm: current 10, previous none, staged 11, rejected up to 0" in done.stdout


# -- the command and a refreshed install --


def test_the_command_hands_update_to_the_root_script_and_everything_else_to_the_service_user(
    installed: Machine,
) -> None:
    command = installed.root / "usr/local/bin/factory-runner"
    assert command.stat().st_mode & stat.S_IXUSR

    config = installed.run_script(command, "config", "show")
    assert config.returncode == 0, config.stderr
    assert "runuser -u factory-runner -- " in " ".join(installed.calls("runuser"))
    assert (
        (installed.state / "cli.log")
        .read_text()
        .splitlines()[-1]
        .startswith("factory-runner config show")
    )

    status = installed.run_script(command, "status")
    assert status.returncode == 0 and "program: current 1" in status.stdout

    someone = installed.run_script(command, "config", "show", env={"STUB_UID": "1000"})
    assert someone.returncode == 1 and "run it with sudo" in someone.stderr


def test_an_install_run_again_with_refresh_is_idempotent_and_never_restarts_a_running_service(
    installed: Machine,
) -> None:
    calls_before = installed.calls()
    registers = [
        line
        for line in (installed.state / "cli.log").read_text().splitlines()
        if " register " in line
    ]
    publish(installed, program=2, vm=11)

    done = installed.install(
        "--refresh", "--labels", "linux,fast", token=False, env={"STUB_REFLINK": "1"}
    )

    assert done.returncode == 0, done.stderr
    assert "this machine is registered already" in done.stdout
    assert "it is not restarted" in done.stdout
    new_calls = installed.calls()[len(calls_before) :]
    assert (
        "systemctl restart factory-runner" not in new_calls
        and "systemctl start factory-runner" not in new_calls
    )
    assert [
        line
        for line in (installed.state / "cli.log").read_text().splitlines()
        if " register " in line
    ] == registers
    assert "config set --labels linux,fast" in (installed.state / "cli.log").read_text()
    # The running service keeps its release: the new one waits for its start.
    assert installed.release_of("current") == "1"
    assert (installed.state_dir / "pending").read_text().splitlines() == [
        "program=2",
        "vm=11",
        "pair=1",
    ]
    assert machine_user_count(installed) == 1


def machine_user_count(machine: Machine) -> int:
    return len([call for call in machine.calls() if call.startswith("useradd")])


def test_a_refresh_with_fewer_slots_removes_the_taps_above(installed: Machine) -> None:
    assert installed.host("uninstall").returncode == 0
    assert installed.install("--parallel-runs", "3").returncode == 0
    assert installed.taps == ["fctap0", "fctap1", "fctap2"]

    done = installed.install("--refresh", "--parallel-runs", "1", token=False)

    assert done.returncode == 0, done.stderr
    assert installed.taps == ["fctap0"]


# -- the interactive prompt (unchanged by this issue; kept proven) --


def run_on_terminal(machine: Machine, *args: str, answers: dict[str, str]) -> tuple[int, str, bool]:
    master, slave = os.openpty()
    process = subprocess.Popen(
        [
            "/bin/sh",
            str(SCRIPT),
            "--program-channel-file",
            str(machine.program_channel),
            "--vm-channel-file",
            str(machine.vm_channel),
            *args,
        ],
        env=machine.environment(),
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 1),
    )
    os.close(slave)
    shown = b""
    pending = dict(answers)
    deadline = time.monotonic() + 60
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 1.0)
            if not ready:
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            shown += chunk
            for prompt, typed in list(pending.items()):
                if prompt.encode() in shown:
                    del pending[prompt]
                    time.sleep(0.3)
                    os.write(master, typed.encode())
        code = process.wait(timeout=30)
        echo = bool(termios.tcgetattr(master)[3] & termios.ECHO)
    finally:
        os.close(master)
    return code, shown.decode(errors="replace"), echo


def test_the_token_is_asked_for_on_the_terminal_without_echo(machine: Machine) -> None:
    code, shown, echo = run_on_terminal(
        machine, answers={'"Add a runner"; input is hidden): ': TOKEN + "\n"}
    )

    assert code == 0, shown
    assert (machine.state / "register-stdin").read_text() == TOKEN
    assert TOKEN not in shown
    assert echo


# -- what the repository holds --


def test_the_release_channels_have_the_shape_the_installer_reads_and_hold_no_secret() -> None:
    program = json.loads((REPOSITORY_ROOT / "runner/release-channel.json").read_text())
    vm = json.loads((REPOSITORY_ROOT / "docker/vm/release-channel.json").read_text())

    assert sorted(program) == ["baseUrl", "manifestAsset", "publicKey", "signatureAsset", "version"]
    assert sorted(vm) == [
        "baseUrl",
        "manifestAsset",
        "publicKey",
        "repository",
        "signatureAsset",
        "version",
    ]
    for channel in (program, vm):
        assert channel["baseUrl"] == "" or str(channel["baseUrl"]).startswith("https://")
        assert (channel["baseUrl"] == "") == (
            channel["publicKey"] == ""
        )  # nothing is published without a key


def test_the_file_names_the_installer_expects_are_the_ones_of_the_release_and_the_launcher() -> (
    None
):
    from code_reviewer_runner.factory_runner.firecracker.settings import (
        settings_from_environment,
    )

    script = SCRIPT.read_text()
    assemble = (REPOSITORY_ROOT / "docker/vm/assemble.sh").read_text()
    for name in ("rootfs.ext4.zst", "dockerdata.ext4.zst"):
        assert name in script and name in assemble
    settings = settings_from_environment(
        {"FACTORY_RUNNER_VM_IMAGE_ID": "x", "FACTORY_RUNNER_VM_STATE_DIR": "/s"}
    )
    # The launcher reads <state>/artifacts: the link the installer makes; the files are its names.
    assert (settings.kernel, settings.rootfs, settings.base_disk) == (
        Path("/s/artifacts/vmlinux"),
        Path("/s/artifacts/rootfs.ext4"),
        Path("/s/artifacts/dockerdata.ext4"),
    )
    assert 'point_link "artifact-releases/$target" "$STATE/artifacts"' in script


def test_the_nft_table_the_program_carries_is_the_one_of_the_repository(installed: Machine) -> None:
    loaded = (installed.state / "nft-table").read_text()
    template = (REPOSITORY_ROOT / "docker/vm/host/outer-wall.nft").read_text()

    # Rendered for the machine's network and nothing else.
    assert loaded == template.replace("@SLOT_NETWORK@", FIRST_NETWORK)
    assert "@SLOT_NETWORK@" not in loaded
    assert "table inet code_reviewer_wall" in loaded


def shape(value: object) -> object:
    if isinstance(value, dict):
        return {key: shape(item) for key, item in sorted(cast("dict[str, object]", value).items())}
    return type(value).__name__


# #982: the sample is also parsed by the verifier's own schema (dispatcher channel.test.ts).
def test_the_manifest_of_these_tests_has_the_shape_the_typescript_verifier_parses(
    machine: Machine,
) -> None:
    sample = json.loads(
        (REPOSITORY_ROOT / "dispatcher/src/vm-artifacts/fixtures/sample-manifest.json").read_text()
    )
    served = json.loads((machine.served / "vm-artifacts-manifest.json").read_text())

    assert shape(served) == shape(sample)
