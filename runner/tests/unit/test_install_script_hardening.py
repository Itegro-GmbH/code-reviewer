# SPDX-License-Identifier: LicenseRef-Proprietary

"""The fix round of the installer (#982, review of PR #1001): no lock across a download, one pair
staged and switched together, the outer wall checked while the service runs, the slots' network
chosen at install, nothing of the operator's removed, interrupted installs undone, a curl
configuration kept safely, every check before the first change, a hard limit on downloads. Run
against the same stand-ins as `test_install_script.py`."""

import fcntl
import stat
from collections.abc import Callable
from pathlib import Path

import pytest
from host_install_support import (
    FIRST_NETWORK,
    SCRIPT,
    Machine,
    Release,
    new_machine,
)

pytestmark = pytest.mark.unit

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


def publish(machine: Machine, **changes: object) -> Release:
    release = Release(
        program=int(str(changes.pop("program", 1))),
        vm=int(str(changes.pop("vm", 10))),
        key=machine.release.key,
        tamper=set(changes.pop("tamper", ())),  # type: ignore[call-overload]
    )
    release.publish(machine.served)
    return release


def changed_nothing(machine: Machine) -> None:
    assert machine.tree() == machine.baseline
    assert not [call for call in machine.calls() if call.startswith(MUTATORS)]
    assert not machine.table_loaded and not machine.user_exists and not machine.taps


def left_nothing(machine: Machine) -> None:
    """What an install that was undone leaves: it changed the machine and put it back."""
    assert machine.tree() == machine.baseline
    assert not machine.table_loaded and not machine.user_exists and not machine.taps


def lock_path(machine: Machine) -> Path:
    return machine.state_dir / "switch.lock"


# -- 1: the switch lock is held for the moves only ---


# #982-T50
def test_an_update_with_a_slow_vm_download_does_not_stop_the_service_from_starting_or_rolling_back(
    installed: Machine,
) -> None:
    publish(installed, program=2, vm=11)
    free, switched = installed.state / "lock-free", installed.state / "switch-ran"
    nothing_yet = installed.state / "no-pending-yet"
    # While the kernel of the new VM release downloads, a start of the service (`switch`) and a
    # rollback must get the lock at once, and nothing may be staged for a switch yet.
    hook = (
        f'flock -n "{lock_path(installed)}" true && echo free >"{free}"; '
        f'[ ! -e "{installed.state_dir / "pending"}" ] && echo yes >"{nothing_yet}"; '
        f'timeout 20 sh "{installed.host_script}" switch && echo done >"{switched}"; '
        f'timeout 20 sh "{installed.host_script}" rollback >/dev/null 2>&1; true'
    )

    done = installed.host("update", env={"STUB_CURL_HOOK_ON": "vmlinux", "STUB_CURL_HOOK": hook})

    assert done.returncode == 0, done.stderr
    assert free.exists(), "the switch lock was held while the VM artifacts downloaded"
    assert switched.exists(), "a start of the service waited for the update"
    assert nothing_yet.exists()
    # The update itself completed: both parts are there and staged as a pair.
    assert (installed.state_dir / "pending").read_text().splitlines() == [
        "program=2",
        "vm=11",
        "pair=1",
    ]


# #982-T50
def test_a_rollback_during_the_download_is_respected_by_the_commit(installed: Machine) -> None:
    publish(installed, program=2, vm=11)
    rejected = installed.conf / "rejected-program"
    hook = f'echo 2 >"{rejected}"'

    done = installed.host("update", env={"STUB_CURL_HOOK_ON": "vmlinux", "STUB_CURL_HOOK": hook})

    assert done.returncode == 0, done.stderr
    assert "is not taken any more" in done.stdout
    assert not (installed.opt / "releases/2").exists()
    # The VM artifacts, which nothing rejected, are staged alone.
    assert (installed.state_dir / "pending").read_text().splitlines() == ["vm=11"]


# #982-T51
def test_a_failed_vm_stage_does_not_switch_or_stage_the_program(installed: Machine) -> None:
    publish(installed, program=2, vm=11, tamper={"vm-flip-kernel"})

    done = installed.host("update")

    assert done.returncode == 1
    assert "does not match the digest" in done.stderr
    assert installed.release_of("current") == "1"
    assert not (installed.state_dir / "pending").exists()
    assert not (installed.opt / "releases/2").exists(), "a program of a pair that failed is staged"
    assert not (installed.state_dir / "artifact-releases/11").exists()
    assert (
        not (installed.opt / "staging").exists() and not (installed.state_dir / "staging").exists()
    )


# #982-T51
def test_a_pair_whose_program_does_not_run_is_dropped_whole(installed: Machine) -> None:
    publish(installed, program=2, vm=11, tamper={"program-broken"})
    assert installed.host("update").returncode == 0

    done = installed.host("switch")

    assert done.returncode == 0
    assert "does not run on this machine" in done.stderr
    assert "came with the program release that was dropped" in done.stderr
    assert installed.release_of("current") == "1"
    assert (
        installed.release_of("artifacts", parent=installed.state_dir)
        == "artifact-releases/10"[len("artifact-releases/") :]
    )
    assert not (installed.state_dir / "pending").exists()
    assert (installed.conf / "rejected-program").read_text() == "2\n"
    assert (installed.conf / "rejected-vm").read_text() == "11\n"


# -- 2: the outer wall while the service runs ---


# #982-T52
def test_the_unit_follows_nftables_and_a_root_timer_looks_at_the_wall(installed: Machine) -> None:
    unit = installed.unit.read_text()
    check = installed.path("etc/systemd/system/factory-runner-wall.service").read_text()
    timer = installed.path("etc/systemd/system/factory-runner-wall.timer").read_text()

    assert "After=network-online.target nftables.service" in unit
    assert "PartOf=nftables.service" in unit
    assert "ExecStart=/opt/code-reviewer/current/libexec/host.sh check-wall" in check
    assert "User=" not in check, "the service user cannot read nft: the check runs as root"
    assert "OnUnitActiveSec=10s" in timer
    assert "systemctl enable factory-runner-wall.timer" in installed.calls("systemctl")


# #982-T52
def test_the_check_restarts_a_running_service_whose_table_is_gone(installed: Machine) -> None:
    (installed.state / "active").touch()
    before = installed.calls("systemctl restart")

    quiet = installed.host("check-wall")
    (installed.state / "nft-table").unlink()
    loud = installed.host("check-wall")

    restarts = installed.calls("systemctl restart")
    assert quiet.returncode == 0 and restarts == [*before, "systemctl restart factory-runner"]
    assert "gone while the service runs" in loud.stderr


# #982-T52
def test_the_check_does_nothing_for_a_service_that_is_not_running(installed: Machine) -> None:
    (installed.state / "active").unlink(missing_ok=True)
    (installed.state / "nft-table").unlink()
    before = installed.calls("systemctl restart")

    done = installed.host("check-wall")

    assert done.returncode == 0 and installed.calls("systemctl restart") == before


# -- 3: the network of the slots ---

OVERLAPS = [
    ("", "10.250.0.0/24"),
    ("10.250.0.0/24 dev tun0 scope link\n", "10.251.0.0/24"),
    ("10.0.0.0/16 dev eth0 proto kernel\n10.250.0.0/16 via 10.0.0.1 dev eth0\n", "10.251.0.0/24"),
    ("default via 10.0.0.1 dev eth0\n", "10.250.0.0/24"),
    ("172.31.0.0/20 dev eth0 proto kernel\n", "10.250.0.0/24"),
    ("local 10.250.0.5 dev lo table local proto kernel\n", "10.251.0.0/24"),
    ("unreachable 10.250.0.0/24\n10.251.0.7 dev lo\n", "10.252.0.0/24"),
    ("10.0.0.0/8 via 100.64.0.1 dev tailscale0\n", "192.168.250.0/24"),
    ("10.0.0.0/8 dev vpn0\n192.168.250.0/23 dev eth1\n", "192.168.252.0/24"),
]


# #982-T53
@pytest.mark.parametrize(("routes", "expected"), OVERLAPS)
def test_the_first_candidate_that_overlaps_no_route_is_the_network(
    machine: Machine, routes: str, expected: str
) -> None:
    done = machine.install(env={"STUB_IP_ROUTES": routes})

    assert done.returncode == 0, done.stderr
    assert f"slot_network={expected}" in (machine.conf / "install.state").read_text()
    assert f"FACTORY_RUNNER_SLOT_NETWORK={expected}" in (machine.conf / "runner.env").read_text()
    base = expected.split("/")[0].rsplit(".", 1)[0]
    assert f"ip addr replace {base}.1/30 dev fctap0" in machine.calls()
    table = (machine.state / "nft-table").read_text()
    assert expected in table and "@SLOT_NETWORK@" not in table and "172.31" not in table


# #982-T53
def test_an_address_of_the_machine_counts_like_a_route(machine: Machine) -> None:
    addresses = "2: eth0    inet 10.250.0.9/24 brd 10.250.0.255 scope global eth0\n"

    done = machine.install(env={"STUB_IP_ADDRS": addresses})

    assert done.returncode == 0, done.stderr
    assert "slot_network=10.251.0.0/24" in (machine.conf / "install.state").read_text()


# #982-T53
def test_the_default_vpc_range_of_aws_is_never_a_candidate() -> None:
    candidates = next(
        line for line in SCRIPT.read_text().splitlines() if line.startswith("SLOT_CANDIDATES=")
    )

    assert "172." not in candidates and "100.64" not in candidates


# #982-T53
def test_without_any_free_network_the_install_refuses_and_changes_nothing(machine: Machine) -> None:
    done = machine.install(env={"STUB_IP_ROUTES": "10.0.0.0/8 dev a\n192.168.0.0/16 dev b\n"})

    assert done.returncode == 1
    assert "no network is free for the VMs" in done.stderr and "--slot-network" in done.stderr
    changed_nothing(machine)


# #982-T53
def test_a_network_named_by_the_operator_is_used_when_it_is_free_and_refused_when_it_is_not(
    machine: Machine,
) -> None:
    taken = machine.install(
        "--slot-network",
        "10.77.5.0/24",
        env={"STUB_IP_ROUTES": "10.77.0.0/16 dev wg0\n"},
    )
    changed_nothing(machine)
    free = machine.install("--slot-network", "10.77.5.0/24")

    assert taken.returncode == 1 and "overlaps an address or a route" in taken.stderr
    assert free.returncode == 0, free.stderr
    assert "slot_network=10.77.5.0/24" in (machine.conf / "install.state").read_text()
    assert "ip addr replace 10.77.5.1/30 dev fctap0" in machine.calls()


# #982-T53
@pytest.mark.parametrize(
    "value", ["172.31.0.0/24", "10.1.2.0/16", "10.1.2.3/24", "10.300.0.0/24", "192.168.1/24", "x"]
)
def test_a_network_that_is_not_a_private_slash_24_is_refused(machine: Machine, value: str) -> None:
    done = machine.install("--slot-network", value)

    assert done.returncode == 1 and "--slot-network is a /24" in done.stderr
    changed_nothing(machine)


# #982-T53
def test_a_refresh_keeps_the_network_even_when_a_route_has_appeared_in_it_since(
    installed: Machine,
) -> None:
    done = installed.install("--refresh", env={"STUB_IP_ROUTES": "10.250.0.0/24 dev x\n"})

    assert done.returncode == 0, done.stderr
    assert "slot_network=10.250.0.0/24" in (installed.conf / "install.state").read_text()
    assert (
        "FACTORY_RUNNER_SLOT_NETWORK=10.250.0.0/24" in (installed.conf / "runner.env").read_text()
    )


# #982-T53
def test_the_prestart_renders_the_table_for_the_stored_network(installed: Machine) -> None:
    (installed.state / "nft-table").unlink()

    done = installed.host("prestart")

    assert done.returncode == 0, done.stderr
    assert FIRST_NETWORK in (installed.state / "nft-table").read_text()


# -- 4: nothing that is not ours ---


def with_foreign_conf(m: Machine) -> None:
    (m.root / "etc/code-reviewer").mkdir()


def with_foreign_home(m: Machine) -> None:
    (m.root / "var/lib/factory-runner").mkdir()


def with_foreign_command(m: Machine) -> None:
    (m.root / "usr/local/bin/factory-runner").write_text("#!/bin/sh\n")


def with_foreign_update_unit(m: Machine) -> None:
    (m.root / "etc/systemd/system/factory-runner-update.timer").write_text("")


def with_foreign_wall_unit(m: Machine) -> None:
    (m.root / "etc/systemd/system/factory-runner-wall.service").write_text("")


@pytest.mark.parametrize(
    ("make", "message"),
    [
        (with_foreign_conf, "/etc/code-reviewer exists and was not made by this installer"),
        (with_foreign_home, "/var/lib/factory-runner exists and was not made by this installer"),
        (with_foreign_command, "/usr/local/bin/factory-runner exists"),
        (with_foreign_update_unit, "factory-runner-update.timer exists"),
        (with_foreign_wall_unit, "factory-runner-wall.service exists"),
    ],
)
def test_an_install_refuses_a_path_it_would_later_delete_that_is_not_its_own(
    machine: Machine, make: Callable[[Machine], None], message: str
) -> None:
    make(machine)
    before = machine.tree()

    done = machine.install()

    assert done.returncode == 1 and message in done.stderr
    assert machine.tree() == before
    assert not [call for call in machine.calls() if call.startswith(MUTATORS)]


# #982-T54
def test_the_uninstall_of_a_machine_without_the_record_removes_nothing(machine: Machine) -> None:
    (machine.root / "opt/code-reviewer").mkdir()
    (machine.root / "opt/code-reviewer/theirs").write_text("keep")
    before = machine.tree()

    done = machine.run_script(SCRIPT, "--uninstall")

    assert done.returncode == 0 and "nothing to remove" in done.stdout
    assert machine.tree() == before


# #982-T54
def test_an_empty_state_directory_of_the_operator_stays_and_its_lost_and_found_is_not_touched(
    machine: Machine,
) -> None:
    state_dir = machine.root / "var/lib/code-reviewer"
    (state_dir / "lost+found").mkdir(parents=True)

    done = machine.install()
    assert done.returncode == 0, done.stderr
    gone = machine.run_script(machine.host_script, "uninstall")

    assert gone.returncode == 0, gone.stderr
    assert state_dir.is_dir(), "a directory that was there before is the operator's"
    assert not (state_dir / "artifacts").exists() and not (state_dir / "pending").exists()
    assert not (machine.root / "etc/code-reviewer").exists()


# -- 5: interrupted installs ---


# #982-T55
def test_a_tap_that_cannot_be_made_half_way_leaves_nothing_of_the_ones_before_it(
    machine: Machine,
) -> None:
    done = machine.install("--parallel-runs", "3", env={"STUB_TUNTAP_FAIL_AT": "fctap2"})

    assert done.returncode == 1 and "fctap2 could not be made" in done.stderr
    assert any(call.startswith("ip tuntap add dev fctap1") for call in machine.calls())
    left_nothing(machine)


# #982-T55
def test_a_signal_in_the_middle_of_the_taps_undoes_the_install_and_removes_the_work_directory(
    machine: Machine,
) -> None:
    done = machine.install("--parallel-runs", "3", env={"STUB_TUNTAP_SIGNAL_AT": "fctap1"})

    assert done.returncode == 143
    assert "interrupted" in done.stderr
    left_nothing(machine)


# #982-T55
def test_the_number_of_taps_is_in_the_state_before_the_first_one_is_made(
    installed: Machine,
) -> None:
    script = SCRIPT.read_text()

    body = script[script.index("ensure_taps() {") :]
    assert body.index('set_state taps "$total"') < body.index("ip tuntap add")
    assert "trap 'on_signal 143' TERM" in script


# -- 6: the curl configuration ---


# #982-T56
def test_a_curl_configuration_is_written_with_a_restrictive_umask_and_a_new_one_wins(
    machine: Machine, tmp_path: Path
) -> None:
    old, new = tmp_path / "old.curlrc", tmp_path / "new.curlrc"
    old.write_text('header = "X-Token: old"\n')
    new.write_text('header = "X-Token: new"\n')
    assert machine.install("--curl-config", str(old)).returncode == 0
    kept = machine.conf / "download.curlrc"

    done = machine.host("update", "--curl-config", str(new))

    assert done.returncode == 0, done.stderr
    assert kept.read_text() == new.read_text() and stat.S_IMODE(kept.stat().st_mode) == 0o600
    last = machine.calls("curl")[-1]
    assert f"-K {new}" in last and f"-K {kept}" not in last
    assert not list(machine.conf.glob("download.curlrc.*")), "no temporary copy is left"


# #982-T56
def test_a_redirect_to_another_host_is_not_followed_while_headers_are_in_use(
    machine: Machine, tmp_path: Path
) -> None:
    rc = tmp_path / "login.curlrc"
    rc.write_text('header = "Authorization: Bearer secret-value"\n')

    done = machine.install(
        "--curl-config", str(rc), env={"STUB_REDIRECT_TO": "https://elsewhere.example/x"}
    )

    assert done.returncode == 1
    assert "redirect to another host is not followed" in done.stderr
    assert not any("elsewhere.example" in call for call in machine.calls("curl"))
    assert "secret-value" not in done.stdout + done.stderr
    changed_nothing(machine)


# #982-T56
def test_a_redirect_within_the_same_host_is_followed_while_headers_are_in_use(
    machine: Machine, tmp_path: Path
) -> None:
    rc = tmp_path / "login.curlrc"
    rc.write_text('header = "Authorization: Bearer secret-value"\n')

    done = machine.install("--curl-config", str(rc), env={"STUB_REDIRECT_ONCE": "1"})

    assert done.returncode == 0, done.stderr
    assert any(call.endswith("?again") for call in machine.calls("curl"))


# -- 7: every check before the first change ---


# #982-T57
def test_a_machine_without_the_tun_device_is_refused_before_anything_changes(
    machine: Machine,
) -> None:
    (machine.root / "dev/net/tun").unlink()
    machine.baseline = machine.tree()

    done = machine.install()

    assert done.returncode == 1 and "/dev/net/tun is missing" in done.stderr
    changed_nothing(machine)


# #982-T57
def test_a_table_that_does_not_load_on_this_kernel_stops_before_the_user_or_a_directory(
    machine: Machine,
) -> None:
    done = machine.install(env={"STUB_NFT_CHECK_FAIL": "1"})

    assert done.returncode == 1 and "nft_fib" in done.stderr
    changed_nothing(machine)


# #982-T57
@pytest.mark.parametrize("tamper", ["bundle-escape", "bundle-link-out", "program-flip-byte"])
def test_a_program_that_fails_its_checks_stops_before_the_user_or_a_directory(
    tmp_path: Path, tamper: str
) -> None:
    machine = new_machine(tmp_path, Release(tamper={tamper}))

    done = machine.install()

    assert done.returncode == 1
    changed_nothing(machine)


# #982-T57
def test_a_refresh_does_not_touch_the_staging_directory_while_an_update_holds_its_lock(
    installed: Machine,
) -> None:
    staging = installed.state_dir / "staging"
    staging.mkdir()
    (staging / "in-use").write_text("another updater's")
    with (installed.state_dir / "update.lock").open("w") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)

        done = installed.install("--refresh")

    assert done.returncode == 1 and "an update is running" in done.stderr
    assert (staging / "in-use").read_text() == "another updater's"


# -- 8: a hard limit on what a download may write ---


# #982-T58
def test_a_server_that_sends_more_than_its_manifest_named_cannot_fill_the_disk(
    tmp_path: Path,
) -> None:
    machine = new_machine(tmp_path, Release(tamper={"vm-oversize-kernel"}))

    done = machine.install()

    assert done.returncode == 1
    assert "kernel file could not be downloaded" in done.stderr
    assert machine.tree() == machine.baseline


# #982-T58
def test_every_download_and_every_unpacking_runs_under_a_limit_of_its_own_size() -> None:
    script = SCRIPT.read_text()

    assert "capped()" in script and "ulimit -S -f" in script
    assert 'capped "$3" curl' in script and 'capped "$3" fetch_same_host' in script
    assert 'capped "$usize" zstd' in script and 'capped "$MAX_PROGRAM_FILE" sh -c' in script


# -- 1 (again): the script alone never holds the lock over a fetch ---


# #982-T50
def test_no_function_that_downloads_takes_the_switch_lock() -> None:
    script = SCRIPT.read_text()
    for name in ("stage_program", "stage_vm", "fetch_artifact", "fetch", "fetch_same_host"):
        start = script.index(f"\n{name}() {{")
        body = script[start : script.index("\n}\n", start)]
        assert "lock_switch" not in body, name
    commit = script[script.index("\ncommit_staged() {") :]
    assert "lock_switch" in commit[: commit.index("\n}\n")]


def test_a_signal_handler_is_installed_for_interrupt_hangup_and_terminate() -> None:
    script = SCRIPT.read_text()

    for name, status in (("INT", 130), ("HUP", 129), ("TERM", 143)):
        assert f"trap 'on_signal {status}' {name}" in script
    # The prompt for the token sets its own traps and must give these back.
    assert "  set_signal_traps\n" in script[script.index("ask_for_token() {") :]
