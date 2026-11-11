# SPDX-License-Identifier: LicenseRef-Proprietary

"""The parts of the Incus launcher (#1007) that are data and rules: slots, the settings, the inner
wall and the network files, Control's arguments for the unix transport, the objects of a machine,
the checks `run` makes and the choice of the sandbox."""

import asyncio
import io
import ipaddress
import json
from collections import Counter
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from incus_support import IMAGE_ID, TOKEN, FakeIncus, Rig, short_directory

from code_reviewer_runner.factory_runner import cli, config
from code_reviewer_runner.factory_runner.config import RunnerConfig
from code_reviewer_runner.factory_runner.firecracker.control_run import (
    ControlRunError,
    load_template,
)
from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import ProxyOuterWall, SlotAddresses
from code_reviewer_runner.factory_runner.incus.control_run import build_control, unix_arguments
from code_reviewer_runner.factory_runner.incus.prepare import prepare_incus
from code_reviewer_runner.factory_runner.incus.provision import (
    ensure_objects,
    missing_objects,
    remove_objects,
)
from code_reviewer_runner.factory_runner.incus.settings import (
    IncusSettings,
    SettingsError,
    settings_from_environment,
)
from code_reviewer_runner.factory_runner.incus.slots import (
    INNER_NETWORK,
    IncusSlot,
    SlotPool,
    parse_slot_network,
)
from code_reviewer_runner.factory_runner.incus.walls import (
    DOOR_PORTS,
    inner_wall_ruleset,
    network_files_a,
    outer_nic,
    slot_addresses,
)
from code_reviewer_runner.factory_runner.selftest import Check

pytestmark = pytest.mark.unit

NETWORK = ipaddress.IPv4Network("10.99.0.0/24")


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


# -- slots ---


def test_a_slot_is_a_29_with_the_hosts_address_first_then_a_then_b() -> None:
    zero, three = IncusSlot(0, NETWORK), IncusSlot(3, NETWORK)

    assert (zero.host_address, zero.guest_address, zero.b_address) == (
        "10.99.0.1",
        "10.99.0.2",
        "10.99.0.3",
    )
    assert (three.host_address, three.guest_address, three.b_address) == (
        "10.99.0.25",
        "10.99.0.26",
        "10.99.0.27",
    )
    assert zero.cidr == "10.99.0.1/29"


def test_the_slots_do_not_overlap_and_fit_the_network() -> None:
    addresses = [
        address
        for index in range(32)
        for address in (
            IncusSlot(index, NETWORK).host_address,
            IncusSlot(index, NETWORK).guest_address,
            IncusSlot(index, NETWORK).b_address,
        )
    ]

    assert len(set(addresses)) == len(addresses) == 96
    assert all(ipaddress.IPv4Address(each) in NETWORK for each in addresses)


def test_the_pool_hands_out_the_lowest_free_slot_and_takes_it_back() -> None:
    pool = SlotPool(2, NETWORK)
    first, second = pool.acquire(), pool.acquire()

    assert (first, second) == (IncusSlot(0, NETWORK), IncusSlot(1, NETWORK))
    assert pool.acquire() is None and pool.free == 0
    assert first is not None and second is not None
    pool.release(second)
    pool.release(first)
    assert pool.acquire() == first
    with pytest.raises(ValueError, match="1 to 32"):
        SlotPool(33, NETWORK)
    with pytest.raises(ValueError, match="too small"):
        SlotPool(32, ipaddress.IPv4Network("10.99.0.0/25"))


@pytest.mark.parametrize(
    ("text", "slots", "problem"),
    [
        ("nonsense", 1, "an IPv4 network"),
        ("8.8.8.0/24", 1, "inside 10.0.0.0/8"),
        ("10.98.0.0/24", 1, "not overlapping"),
        ("10.99.0.0/28", 3, "room for 3 slots"),
    ],
)
def test_a_slot_network_must_be_private_roomy_and_clear_of_the_inner_bridges(
    text: str, slots: int, problem: str
) -> None:
    with pytest.raises(ValueError, match=problem):
        parse_slot_network(text, slots)

    assert parse_slot_network("10.99.0.0/24", 32) == NETWORK


# -- the settings ---


def environment(**values: str) -> dict[str, str]:
    base = {
        "FACTORY_RUNNER_INCUS_POOL": "crpool",
        "FACTORY_RUNNER_VM_IMAGE_ID": IMAGE_ID,
        "FACTORY_RUNNER_SLOT_NETWORK": "10.99.0.0/24",
    }
    base.update(values)
    return base


def test_the_settings_come_from_the_environment_the_limits_and_the_workers_timeout() -> None:
    settings = settings_from_environment(
        environment(
            FACTORY_RUNNER_OUTER_WALL="proxy",
            FACTORY_RUNNER_INCUS_PREFIX="cr1007",
            FACTORY_RUNNER_VM_VCPUS="4",
        ),
        parallel_runs=3,
        disk_gb=20,
        job_environment={"RUNNER_JOB_TIMEOUT_SECONDS": "900"},
    )

    assert settings.pool == "crpool" and settings.prefix == "cr1007"
    assert settings.slots == 3 and settings.disk_gib == 20 and settings.vcpus == 4
    assert settings.job_timeout_seconds == 900 and settings.outer_wall is OuterWallMode.PROXY
    assert settings.memory_mib == 4 * 2048
    assert settings.instance_a("0-ab") == "cr1007-a-0-ab"
    assert settings.outer_network(2) == "cr1007-out2" and settings.inner_network(2) == "cr1007-in2"


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"FACTORY_RUNNER_INCUS_POOL": ""}, "INCUS_POOL"),
        ({"FACTORY_RUNNER_VM_IMAGE_ID": ""}, "IMAGE_ID"),
        ({"FACTORY_RUNNER_OUTER_WALL": "wide-open"}, "OUTER_WALL"),
        ({"FACTORY_RUNNER_SLOT_NETWORK": "10.98.0.0/24"}, "SLOT_NETWORK"),
        ({"FACTORY_RUNNER_INCUS_PREFIX": "Bad Prefix"}, "prefix"),
        ({"FACTORY_RUNNER_VM_VCPUS": "3"}, "vcpus"),
        ({"FACTORY_RUNNER_INCUS_A_DISK_GB": "many"}, "not a whole number"),
    ],
)
def test_a_setting_that_is_missing_or_wrong_is_named_never_valued(
    changes: dict[str, str], problem: str
) -> None:
    with pytest.raises(SettingsError, match=problem):
        settings_from_environment(environment(**changes))


def test_the_wall_clock_is_the_job_timeout_plus_the_stop_timeout_plus_the_preparation() -> None:
    settings = IncusSettings(pool="p", image_id=IMAGE_ID, job_timeout_seconds=3600)

    assert settings.wall_clock_seconds(150) == 3600 + 150 + 300


# -- the walls ---


def test_the_inner_wall_lets_b_reach_the_two_doors_and_nothing_else_of_a() -> None:
    text = inner_wall_ruleset()

    assert "table inet cr_inner" in text
    doors = ", ".join(map(str, DOOR_PORTS))
    assert f'iifname "eth1" ip saddr 10.98.0.3 tcp dport {{ {doors} }} accept' in text
    # Everything else that comes in from B is dropped, and nothing is forwarded to or from B but
    # the answers to what B's own side asked.
    lines = [line.strip() for line in text.splitlines()]
    assert 'iifname "eth1" drop' in lines
    forward = lines[lines.index("chain forward {") :]
    assert 'iifname "eth1" drop' in forward and 'oifname "eth1" drop' in forward
    # A's outer NIC takes nothing in either but answers.
    assert 'iifname "eth0" drop' in lines
    # The order is the rule: every accept comes before the drop of its NIC.
    input_chain = lines[lines.index("chain input {") : lines.index("chain forward {")]
    assert input_chain.index('iifname "eth1" drop') > max(
        i for i, line in enumerate(input_chain) if line.endswith("accept") and "eth1" in line
    )


def test_the_inner_wall_names_the_address_it_is_given() -> None:
    assert "ip saddr 10.98.0.9 tcp dport { 1 }" in inner_wall_ruleset(
        b_address="10.98.0.9", doors=(1,)
    )


def test_the_inner_network_is_not_in_the_slot_geometry() -> None:
    assert ipaddress.IPv4Address("10.98.0.2") in INNER_NETWORK
    assert ipaddress.IPv4Address(IncusSlot(0, NETWORK).host_address) not in INNER_NETWORK


def test_an_outer_nic_has_an_address_filtering_and_port_isolation() -> None:
    nic = outer_nic("cr-out0", "10.99.0.2", "eth0")

    assert nic == {
        "type": "nic",
        "network": "cr-out0",
        "name": "eth0",
        "ipv4.address": "10.99.0.2",
        "security.ipv4_filtering": "true",
        "security.mac_filtering": "true",
        "security.port_isolation": "true",
    }


def test_the_files_of_a_set_no_ip_of_the_slot_besides_its_own() -> None:
    files = dict(network_files_a(IncusSlot(2, NETWORK)))

    assert b"Address=10.99.0.18/29" in files["/etc/systemd/network/05-code-reviewer-eth0.network"]


def test_the_proxy_of_a_slot_serves_a_and_b_and_nobody_else() -> None:
    ends = slot_addresses(IncusSlot(1, NETWORK))

    assert ends == SlotAddresses("10.99.0.9", "10.99.0.10", ("10.99.0.11",))


def test_the_outer_wall_accepts_b_of_the_slot_and_refuses_an_address_of_another_slot() -> None:
    """The proxy checks the source of a connection: A and B of the slot, no other address."""

    async def scenario() -> list[Any]:
        wall = ProxyOuterWall(
            2,
            network=NETWORK,
            addresses=lambda slot: SlotAddresses("127.0.0.1", "127.0.0.1", ("127.0.0.2",)),
            port=0,
        )
        try:
            await wall.start()
        except Exception as error:  # the machine has no such address: skip the part that needs it
            return [type(error).__name__]
        try:
            server = wall._servers[0]  # pyright: ignore[reportPrivateUsage]
            return [
                server.verify_request(None, ("127.0.0.1", 1)),
                server.verify_request(None, ("127.0.0.2", 1)),
                server.verify_request(None, ("127.0.0.9", 1)),
            ]
        finally:
            await wall.close()

    result = go(scenario)
    if result == ["OuterWallUnavailable"]:
        pytest.skip("this machine cannot bind two loopback addresses")
    assert result == [True, True, False]


# -- Control's arguments for the unix transport ---


def launch(**changes: Any) -> Any:
    values: dict[str, Any] = {
        "app_url": "http://10.99.0.1",
        "job_id": "00000000-0000-4000-8000-000000000001",
        "credential": "crj_x" * 8,
        "token": TOKEN,
        "image_id": IMAGE_ID,
        "timeout_seconds": 3600,
        "vcpus": 2,
        "reserve_gib": 2,
    }
    values.update(changes)
    return build_control(load_template(), **values)


def test_control_gets_the_unix_variable_the_socket_mount_and_no_vsock_profile() -> None:
    template = load_template().fill(job_id="j", image=IMAGE_ID, timeout_seconds=1, vcpus=2)

    arguments = unix_arguments(template)

    assert "RUNNER_ENVIRONMENT_CONTROL=vsock" in template
    assert "RUNNER_ENVIRONMENT_CONTROL=unix" in arguments
    assert "RUNNER_ENVIRONMENT_CONTROL=vsock" not in arguments
    assert not any(each.startswith("seccomp=") for each in arguments)
    mount = "type=bind,source=/ctl.sock,target=/ctl.sock"
    assert arguments[arguments.index(mount) - 1] == "--mount"
    # Everything else is the renderer's: exactly these items differ, no more.
    assert Counter(arguments) - Counter(template) == Counter(
        {"RUNNER_ENVIRONMENT_CONTROL=unix": 1, "--mount": 1, mount: 1}
    )
    assert Counter(template) - Counter(arguments) == Counter(
        {
            "RUNNER_ENVIRONMENT_CONTROL=vsock": 1,
            "--security-opt": 1,
            "seccomp=/etc/code-reviewer/control-seccomp.json": 1,
        }
    )


def test_arguments_without_the_expected_shape_are_refused_not_guessed() -> None:
    with pytest.raises(ControlRunError, match="expected shape"):
        unix_arguments(["run", "--env", "A=b", IMAGE_ID, "worker-once"])


def test_the_launch_is_the_one_vm_init_would_have_started() -> None:
    result = launch()
    document = json.loads(result.stdin)

    assert result.arguments[0] == "run" and IMAGE_ID in result.arguments
    assert document["controlToken"] == TOKEN and document["jobId"].endswith("0001")
    assert result.volume_name == "code-reviewer-work-00000000-0000-4000-8000-000000000001"
    assert result.image_reference == "code-reviewer-worker:golden"
    assert "outerProxy" not in document
    assert launch(outer_proxy={"host": "10.99.0.1", "port": 3128}).stdin.count(b"outerProxy") == 1


def test_a_credential_that_would_land_in_an_argument_is_refused() -> None:
    with pytest.raises(ControlRunError):
        launch(credential="bad credential with spaces")


# -- the objects of a machine ---


def test_the_objects_of_every_slot_are_made_once_and_only_what_is_missing() -> None:
    with short_directory() as root:
        rig = Rig(root, slots=2)
        rig.incus.networks.clear()

        async def scenario() -> tuple[list[str], list[str], Any]:
            first = await ensure_objects(rig.incus, rig.settings)
            second = await ensure_objects(rig.incus, rig.settings)
            return first, second, await missing_objects(rig.incus, rig.settings)

        first, second, lacking = go(scenario)

        assert sorted(first) == sorted(
            [
                "acl cr-out0",
                "network cr-out0",
                "network cr-in0",
                "acl cr-out1",
                "network cr-out1",
                "network cr-in1",
            ]
        )
        assert second == [] and not lacking
        (rule,) = rig.incus.acls["cr-out0"]
        assert rule["destination"] == "10.99.0.1/32" and rule["destination_port"] == "3128"
        assert rule["action"] == "allow" and rule["protocol"] == "tcp"


def test_removing_the_objects_touches_the_prefixs_networks_and_acls_and_nothing_else() -> None:
    with short_directory() as root:
        rig = Rig(root, slots=1)
        rig.incus.networks |= {"incusbr0", "docker0"}
        rig.incus.acls["someone-elses"] = []

        async def scenario() -> Any:
            await ensure_objects(rig.incus, rig.settings)
            return await remove_objects(rig.incus, rig.settings)

        removed = go(scenario)

        assert sorted(removed) == ["acl cr-out0", "network cr-in0", "network cr-out0"]
        assert rig.incus.networks == {"incusbr0", "docker0"} and "someone-elses" in rig.incus.acls
        deleted = [call[1] for call in rig.incus.calls if call[0].startswith("delete_")]
        assert set(deleted) == {"cr-out0", "cr-in0"}


def test_missing_objects_are_named() -> None:
    incus = FakeIncus(slots=1)
    incus.pools.clear()
    incus.networks.discard("cr-in0")
    settings = IncusSettings(pool="pool", image_id=IMAGE_ID)

    lacking = go(lambda: missing_objects(incus, settings))

    assert lacking.items == ("storage pool pool", "network cr-in0")


# -- what `run` checks, and the choice of the sandbox ---


def runner_config(parallel: int = 1) -> RunnerConfig:
    return RunnerConfig(
        url="https://app.example.com",
        credential="crr_" + "x" * 40,
        limits=config.Limits(parallel_runs=parallel),
    )


def test_a_machine_that_has_everything_is_ready() -> None:
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")
        env = environment(FACTORY_RUNNER_VM_STATE_DIR=str(root))

        prepared = prepare_incus(runner_config(), env, client=lambda settings: incus)

        names = {check.name: check.ok for check in prepared.selftest.checks}
        assert names["incus"] and names["incus-objects"] and names["state-dir"]


def test_a_machine_that_lacks_something_says_what() -> None:
    with short_directory() as root:
        incus = FakeIncus(pool="crpool")
        incus.images.clear()
        env = environment(FACTORY_RUNNER_VM_STATE_DIR=str(root))

        prepared = prepare_incus(runner_config(), env, client=lambda settings: incus)

        failed = [check for check in prepared.selftest.checks if not check.ok]
        assert [check.name for check in failed] == ["incus-objects"]
        assert "image code-reviewer-golden" in failed[0].detail


def test_incus_that_does_not_answer_is_one_failed_check_and_nothing_more() -> None:
    from code_reviewer_runner.factory_runner.incus.client import IncusError

    incus = FakeIncus(pool="crpool")
    incus.fail["version"] = IncusError("version", "permission denied")

    prepared = prepare_incus(runner_config(), environment(), client=lambda settings: incus)

    failed = [check for check in prepared.selftest.checks if not check.ok]
    assert [check.name for check in failed] == ["incus"]
    assert "incus-admin" in failed[0].detail


def test_wrong_settings_are_a_failed_check_not_an_exception() -> None:
    prepared = prepare_incus(runner_config(), {})

    assert [check.name for check in prepared.selftest.checks] == ["incus-settings"]
    assert not prepared.selftest.checks[0].ok


def test_the_incus_sandbox_allows_as_many_jobs_as_slots_up_to_32() -> None:
    assert config.check_limits({"parallelRuns": 32}, max_parallel=config.MAX_INCUS_PARALLEL_RUNS)
    with pytest.raises(config.ConfigError, match="at most 32"):
        config.check_limits({"parallelRuns": 33}, max_parallel=config.MAX_INCUS_PARALLEL_RUNS)


def test_run_prepares_and_starts_the_sandbox_the_environment_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    chosen: list[str] = []
    ready = Check("incus", True, "")

    def fake_prepare(kind: str) -> Callable[[RunnerConfig, Any], Any]:
        def prepare(each: RunnerConfig, env: Any) -> Any:
            chosen.append(kind)
            raise RuntimeError(kind)

        return prepare

    def load(_environment: Any) -> RunnerConfig:
        return runner_config()

    seams = cli.CliSeams(
        prepare_incus=fake_prepare("incus"), prepare_vm=fake_prepare("firecracker")
    )
    _ = ready
    for sandbox in ("incus", "firecracker"):
        env = {
            "FACTORY_RUNNER_SANDBOX": sandbox,
            "FACTORY_RUNNER_TOKEN": "x",
            "HOME": "/nonexistent",
        }
        monkeypatch.setattr(cli, "load_config", load)
        with pytest.raises(RuntimeError, match=sandbox):
            cli.main(
                ["run", "--once"],
                environment=env,
                seams=seams,
                out=io.StringIO(),
                err=io.StringIO(),
                require_sandbox=True,
            )

    assert chosen == ["incus", "firecracker"]


def test_run_refuses_any_other_sandbox_and_names_incus() -> None:
    err = io.StringIO()

    code = cli.main(
        ["run", "--once"],
        environment={"FACTORY_RUNNER_SANDBOX": "process"},
        out=io.StringIO(),
        err=err,
        require_sandbox=True,
    )

    assert code == cli.EXIT_CONFIG and "FACTORY_RUNNER_SANDBOX=incus" in err.getvalue()
