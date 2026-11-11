# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's static nft table of the Incus outer wall (#1008) on a real Incus (7.6, a btrfs pool),
as root, with the host's own Docker running a container: the CI lane of `.github/workflows/ci.yml`
(`incus-wall`), set up by `ci-setup.sh`. Run it with `-m incus --force-enable-socket` and the
variables of `incus_lane.py`.

Two instances, A and B, sit on the real outer bridge of slot 0 (the launcher's own objects and
`outer_nic`, the lane's stand-in proxy on the bridge's address). Every probe runs from both, in four
**phases**, because a probe that is blocked proves nothing unless the same probe reached once:

| phase   | Incus ACL | routing | our table | what it is                                          |
|---------|-----------|---------|-----------|-----------------------------------------------------|
| control | off       | on      | absent    | nothing stops a packet: every probe must reach      |
| acl     | on        | off     | absent    | Incus alone: port 53 of host addresses reaches |
| table   | off       | on      | loaded    | our table alone: all but the proxy is dropped |
| full    | on        | off     | loaded    | the production wall                                 |

The instances get a default route through the host (an agent that is root of its instance can add
one), so an address that is not on their bridge is sent, not refused by their own routing table."""

import asyncio
import ipaddress
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Coroutine, Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import pytest
from host_wall_lane import (
    INTERNET_ADDRESS,
    LAB_ADDRESS,
    METADATA_ADDRESS,
    Decoys,
    DecoyTcp,
    DecoyUdp,
    allow_forwarding_through_dockers_chain,
    forget_forwarding,
    lab_down,
    lab_up,
    other_tables,
    our_counter,
    ping6_verdict,
    reached,
    send_udp,
    sh,
    table_of,
    tcp_verdict,
)
from incus_lane import Machine, incus_available, load_machine

from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWallMode
from code_reviewer_runner.factory_runner.incus.client import (
    CliIncusClient,
    InstanceSpec,
    run_exec,
)
from code_reviewer_runner.factory_runner.incus.host_wall import (
    HostWallGate,
    HostWallSpec,
    apply,
    check,
    run_nft,
    spec_for,
)
from code_reviewer_runner.factory_runner.incus.launcher import IncusNotReady, IncusSandbox
from code_reviewer_runner.factory_runner.incus.provision import (
    ensure_objects,
    misconfigured_objects,
    outer_network_config,
    remove_objects,
)
from code_reviewer_runner.factory_runner.incus.settings import IncusSettings
from code_reviewer_runner.factory_runner.incus.slots import IncusSlot
from code_reviewer_runner.factory_runner.incus.walls import outer_nic

pytestmark = pytest.mark.incus

PROXY_PORT = 3128
DECOY_PORT = 9999
FIRST_SLOT, OTHER_SLOT = 0, 1
CONTAINER = "crwall-web"
PUBLISHED = 18080
PHASES = ("control", "acl", "table", "full")


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


@dataclass(frozen=True)
class Target:
    name: str
    host: str
    port: int
    # Which phases the probe reaches in: the proxy everywhere, port 53 of host addresses in the
    # phases without our table (that is #1008's gap), everything else only without any wall.
    reaches: tuple[str, ...]


@dataclass
class Lab:
    settings: IncusSettings
    spec: HostWallSpec
    client: CliIncusClient
    status: Path
    slot: IncusSlot
    other: IncusSlot
    outer: str
    other_outer: str
    instances: dict[str, str]
    incusbr0: str
    primary: str
    docker0: str | None
    proxy: DecoyTcp
    decoys: Decoys
    dns_udp: DecoyUdp
    ipv6_host: str | None = None
    targets: list[Target] = field(default_factory=list[Target])


def _incus(*arguments: str) -> str:
    return sh("incus", *arguments)


def _wait_until(check_it: Callable[[], bool], seconds: float, what: str) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check_it():
            return
        time.sleep(0.5)
    raise AssertionError(f"{what} did not happen within {seconds:g} s")


# -- the lab ---


@pytest.fixture(scope="session")
def machine() -> Machine:
    """The lane's machine (not the launcher lane's fixture, which also needs the stand-ins of its
    jobs: this lane makes its own instances)."""
    found = load_machine()
    if found is None:
        pytest.skip("CR_INCUS_LANE_POOL, _IMAGE and _STATE are not set")
    if not incus_available():
        pytest.skip("`incus` does not answer for this user")
    return found


@pytest.fixture(scope="session")
def client(settings: IncusSettings) -> Iterator[CliIncusClient]:
    """The real client, with the bridges and ACLs of the lane's two slots made for the module and
    removed after it (only the lane's own prefix)."""
    incus = CliIncusClient(
        settings.incus, call_seconds=settings.call_seconds, state_dir=settings.state_dir
    )
    asyncio.run(ensure_objects(incus, settings))
    try:
        yield incus
    finally:
        asyncio.run(remove_objects(incus, settings))


@pytest.fixture(scope="module")
def lab(machine: Machine, settings: IncusSettings, client: CliIncusClient) -> Iterator[Lab]:
    # The outer wall's own proxy is not started here (the lane's stand-in listens on the bridge's
    # address); the sandbox of the gate test below is made with the wall `refuse`.
    settings = replace(settings, outer_wall=OuterWallMode.REFUSE)
    spec = spec_for(settings)
    slot, other = (
        IncusSlot(FIRST_SLOT, settings.slot_network),
        IncusSlot(OTHER_SLOT, settings.slot_network),
    )
    outer, other_outer = settings.outer_network(FIRST_SLOT), settings.outer_network(OTHER_SLOT)
    status = machine.state / "host-wall.json"
    # The lane's machine has nothing of ours loaded; a table of an earlier run is gone.
    sh("nft", "delete", "table", "inet", spec.table, check=False)
    decoys = Decoys()
    server = lab_up()
    names = {
        "A": f"{settings.name_prefix}-a-wall",
        "B": f"{settings.name_prefix}-b-wall",
    }
    incusbr0_address = _incus("network", "get", "incusbr0", "ipv4.address").strip().split("/")[0]
    primary = sh("ip", "-4", "route", "get", "1.1.1.1").split(" src ")[1].split()[0]
    docker0 = _address_of("docker0")
    try:
        proxy = decoys.tcp(slot.host_address, PROXY_PORT)
        decoys.tcp(slot.host_address, 22)
        decoys.tcp(slot.host_address, 53)
        decoys.tcp("0.0.0.0", DECOY_PORT)
        decoys.tcp(other.host_address, PROXY_PORT)
        dns_udp = decoys.udp(slot.host_address, 53)
        for letter, address in (("A", slot.guest_address), ("B", slot.b_address)):
            go(lambda n=names[letter], a=address: _make_instance(client, settings, outer, n, a))
        found = Lab(
            settings,
            spec,
            client,
            status,
            slot,
            other,
            outer,
            other_outer,
            names,
            incusbr0_address,
            primary,
            docker0,
            proxy,
            decoys,
            dns_udp,
        )
        found.targets = _targets(found)
        yield found
    finally:
        for name in names.values():
            go(lambda n=name: client.delete(n))
        sh("nft", "delete", "table", "inet", spec.table, check=False)
        _acl(settings, outer, on=True)
        _routing(outer, on=False)
        forget_forwarding(outer)
        decoys.close()
        lab_down(server)


def _address_of(device: str) -> str | None:
    found = subprocess.run(
        ["ip", "-4", "-o", "addr", "show", device],
        capture_output=True,
        text=True,
        check=False,
        stdin=subprocess.DEVNULL,
    ).stdout.split()
    return found[found.index("inet") + 1].split("/")[0] if "inet" in found else None


async def _make_instance(
    client: CliIncusClient, settings: IncusSettings, outer: str, name: str, address: str
) -> None:
    await client.create(
        InstanceSpec(
            name,
            image=settings.image,
            pool=settings.pool,
            config={"security.privileged": "false", "security.idmap.isolated": "true"},
            disk_gib=3,
        )
    )
    await client.add_device(name, "eth0", outer_nic(outer, address, "eth0"))
    await client.start(name)
    await _wait(client, name, "ip link show eth0")
    # The image's own network manager would fight a hand-made address; there is no DHCP here.
    await run_exec(
        client,
        name,
        (
            "sh",
            "-c",
            "systemctl stop systemd-networkd.service systemd-networkd.socket 2>/dev/null; true",
        ),
        timeout=60.0,
    )
    gateway = str(ipaddress.IPv4Address(address) - (int(address.split(".")[-1]) % 8) + 1)
    commands = (
        f"ip addr flush dev eth0; ip addr add {address}/29 dev eth0; ip link set eth0 up; "
        f"ip route add default via {gateway} dev eth0"
    )
    done = await run_exec(client, name, ("sh", "-c", commands), timeout=60.0)
    assert done.exit_code == 0, done.stderr


async def _wait(client: CliIncusClient, instance: str, command: str, seconds: float = 60.0) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        done = await run_exec(client, instance, ("sh", "-c", command), timeout=20.0)
        if done.exit_code == 0:
            return
        await asyncio.sleep(0.5)
    raise AssertionError(f"{command!r} did not succeed in {instance}")


def _targets(lab: Lab) -> list[Target]:
    everything_off = ("control",)
    dns = ("control", "acl")
    found = [
        Target("proxy", lab.slot.host_address, PROXY_PORT, PHASES),
        Target("host :22", lab.slot.host_address, 22, everything_off),
        Target("decoy port", lab.slot.host_address, DECOY_PORT, everything_off),
        Target("bridge :53", lab.slot.host_address, 53, dns),
        Target("incusbr0 :53", lab.incusbr0, 53, dns),
        Target("incusbr0 decoy", lab.incusbr0, DECOY_PORT, everything_off),
        Target("primary address", lab.primary, DECOY_PORT, everything_off),
        Target("other slot proxy", lab.other.host_address, PROXY_PORT, everything_off),
        Target("lan", LAB_ADDRESS, 8000, everything_off),
        Target("metadata", METADATA_ADDRESS, 80, everything_off),
        Target("internet", INTERNET_ADDRESS, 8000, everything_off),
    ]
    if lab.docker0:
        found.append(Target("docker0 decoy", lab.docker0, DECOY_PORT, everything_off))
    return found


# -- phases ---


def _acl(settings: IncusSettings, outer: str, *, on: bool) -> None:
    if on:
        slot = IncusSlot(FIRST_SLOT, settings.slot_network)
        wanted = outer_network_config(slot, outer)
        for key in (
            "security.acls",
            "security.acls.default.egress.action",
            "security.acls.default.ingress.action",
        ):
            _incus("network", "set", outer, f"{key}={wanted[key]}")
        return
    for key in (
        "security.acls",
        "security.acls.default.egress.action",
        "security.acls.default.ingress.action",
    ):
        _incus("network", "unset", outer, key)


def _routing(outer: str, *, on: bool) -> None:
    _incus("network", "set", outer, f"ipv4.routing={'true' if on else 'false'}")


def _table(lab: Lab, *, loaded: bool) -> None:
    if loaded:
        apply(lab.spec, lab.status, run=run_nft)
    else:
        sh("nft", "delete", "table", "inet", lab.spec.table, check=False)


def set_phase(lab: Lab, phase: str) -> None:
    acl_on = phase in ("acl", "full")
    table_on = phase in ("table", "full")
    routing = phase in ("control", "table")
    _acl(lab.settings, lab.outer, on=acl_on)
    _routing(lab.outer, on=routing)
    _table(lab, loaded=table_on)
    if routing:
        allow_forwarding_through_dockers_chain(lab.outer)
    else:
        forget_forwarding(lab.outer)
    if phase == "full":
        # The production configuration is what `provision.py` checks for: the lane's switches put
        # every object back as it was.
        assert go(lambda: misconfigured_objects(lab.client, lab.settings)) == []


async def _probe_all(lab: Lab, phase: str) -> list[tuple[str, str, str, str]]:
    async def one(who: str, target: Target) -> tuple[str, str, str, str]:
        verdict = await tcp_verdict(lab.client, lab.instances[who], target.host, target.port)
        return phase, who, target.name, verdict

    return list(
        await asyncio.gather(*(one(who, target) for who in lab.instances for target in lab.targets))
    )


def _expect(rows: list[tuple[str, str, str, str]], lab: Lab) -> None:
    by_name = {target.name: target for target in lab.targets}
    wrong: list[str] = []
    for phase, who, name, verdict in rows:
        target = by_name[name]
        if verdict == "unreachable":
            wrong.append(f"{phase} {who} {name}: no route, nothing was sent (the lane is wrong)")
        elif reached(verdict) != (phase in target.reaches):
            wrong.append(
                f"{phase} {who} {name}: {verdict}, expected "
                f"{'reached' if phase in target.reaches else 'blocked'}"
            )
    assert not wrong, "\n".join(wrong) + "\n\n" + table_of(rows)


# #1008-T01
def test_from_a_and_b_only_the_proxy_reaches_and_each_blocked_probe_reached_without_the_wall(
    lab: Lab,
) -> None:
    rows: list[tuple[str, str, str, str]] = []
    for phase in PHASES:
        set_phase(lab, phase)
        rows += go(lambda p=phase: _probe_all(lab, p))
        _expect([row for row in rows if row[0] == phase], lab)
    print("\n" + table_of(rows))

    # The control phase reached every target from both instances (no blocked row without a control).
    control = [row for row in rows if row[0] == "control"]
    assert len(control) == 2 * len(lab.targets) and all(reached(row[3]) for row in control)
    # The key row (#1008): port 53 of the bridge's address and of another bridge's address reached
    # with Incus's ACL alone (its implicit DNS accept) and does not with our table.
    for name in ("bridge :53", "incusbr0 :53"):
        for who in lab.instances:
            verdicts = {row[0]: row[3] for row in rows if row[1:3] == (who, name)}
            assert reached(verdicts["acl"]) and not reached(verdicts["full"]), (who, name, verdicts)


# #1008-T01
def test_dns_over_udp_reaches_without_our_table_and_is_dropped_with_it(lab: Lab) -> None:
    results: dict[str, list[int]] = {}
    for phase in ("acl", "full"):
        set_phase(lab, phase)
        for instance in lab.instances.values():
            before = len(lab.dns_udp.hits)
            go(lambda i=instance: send_udp(lab.client, i, lab.slot.host_address, 53))
            time.sleep(1.0)
            results.setdefault(phase, []).append(len(lab.dns_udp.hits) - before)
    assert results["acl"] == [1, 1], results
    assert results["full"] == [0, 0], results


# #1008-T01
def test_ipv6_to_the_host_is_dropped_and_reached_without_the_table(lab: Lab) -> None:
    # The bridge has no IPv6 (`ipv6.address=none` disables it): the control turns it on.
    sysctl = f"net.ipv6.conf.{lab.outer}.disable_ipv6"
    before = sh("sysctl", "-n", sysctl).strip()
    sh("sysctl", "-qw", f"{sysctl}=0")
    try:
        _wait_until(
            lambda: bool(sh("ip", "-6", "addr", "show", "dev", lab.outer, "scope", "link").strip()),
            10,
            "a link-local address on the bridge",
        )
        local = sh("ip", "-6", "-o", "addr", "show", "dev", lab.outer, "scope", "link").split()
        host = local[local.index("inet6") + 1].split("/")[0]
        verdicts: dict[tuple[str, str], str] = {}
        for phase in ("control", "table", "full"):
            set_phase(lab, phase)
            for who, instance in lab.instances.items():
                verdicts[(phase, who)] = go(
                    lambda i=instance: ping6_verdict(lab.client, i, host, "eth0")
                )
        for who in lab.instances:
            assert verdicts[("control", who)] == "open", verdicts
            assert verdicts[("table", who)] == "timeout" and verdicts[("full", who)] == "timeout"
        listing = sh("nft", "list", "table", "inet", lab.spec.table)
        assert our_counter(listing, "no IPv6") > 0
    finally:
        sh("sysctl", "-qw", f"{sysctl}={before}")


# #1008-T01
def test_the_drops_and_the_proxy_accept_are_counted(lab: Lab) -> None:
    set_phase(lab, "full")
    go(lambda: _probe_all(lab, "full"))
    listing = sh("nft", "list", "table", "inet", lab.spec.table)

    assert our_counter(listing, f"slot {FIRST_SLOT}: the proxy") > 0
    assert our_counter(listing, "all else to the host") > 0
    assert our_counter(listing, "an instance forwards to nothing") > 0


# -- T02: the host's Docker ---


def _docker(*arguments: str, check: bool = True) -> str:
    return sh("docker", *arguments, check=check)


def _docker_works() -> list[str]:
    """What must still work with Docker's networking: the published port, and a container that
    reaches the lab (forwarded and masqueraded through the host). Returns what is wrong."""
    problems: list[str] = []
    code = sh(
        "curl",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "5",
        f"http://127.0.0.1:{PUBLISHED}/",
        check=False,
    ).strip()
    if code in ("", "000"):
        problems.append("the published port of the container does not answer")
    out = subprocess.run(
        [
            "docker",
            "exec",
            CONTAINER,
            "wget",
            "-q",
            "-T",
            "5",
            "-O",
            "-",
            f"http://{LAB_ADDRESS}:8000/",
        ],
        capture_output=True,
        text=True,
        check=False,
        stdin=subprocess.DEVNULL,
    )
    if out.returncode != 0:
        problems.append(f"the container does not reach the lab: {out.stderr.strip()}")
    return problems


@pytest.fixture(scope="module")
def container(lab: Lab) -> Iterator[str]:
    image = "public.ecr.aws/docker/library/busybox:1.37"
    if subprocess.run(["docker", "pull", "-q", image], capture_output=True, check=False).returncode:
        image = "busybox:1.37"
        _docker("pull", "-q", image)
    _docker("rm", "-f", CONTAINER, check=False)
    _docker(
        "run",
        "-d",
        "--restart",
        "unless-stopped",
        "--name",
        CONTAINER,
        "-p",
        f"127.0.0.1:{PUBLISHED}:80",
        image,
        "httpd",
        "-f",
        "-p",
        "80",
        "-h",
        "/tmp",
    )
    _wait_until(lambda: not _docker_works(), 30, "the container serving")
    try:
        yield CONTAINER
    finally:
        _docker("rm", "-f", CONTAINER, check=False)


# #1008-T02
def test_with_dockers_container_running_dockers_networking_works_and_the_probes_stay_blocked(
    lab: Lab, container: str
) -> None:
    set_phase(lab, "control")
    assert _docker_works() == []

    set_phase(lab, "full")

    # Docker still works with the table loaded ...
    assert _docker_works() == []
    # ... and the instances' probes are blocked as before, the bridge of Docker among them.
    rows = go(lambda: _probe_all(lab, "full"))
    _expect(rows, lab)
    if lab.docker0:
        verdicts = {row[3] for row in rows if row[2] == "docker0 decoy"}
        assert verdicts == {"timeout"}, verdicts


# #1008-T02
def test_applying_and_removing_the_table_changes_no_other_table(lab: Lab, container: str) -> None:
    _table(lab, loaded=False)
    without = other_tables(lab.spec.table)

    _table(lab, loaded=True)
    with_ours = other_tables(lab.spec.table)
    _table(lab, loaded=False)
    after = other_tables(lab.spec.table)

    assert without == with_ours == after
    _table(lab, loaded=True)


# -- T03: restarts and a table that is gone ---


async def _dns_of_other_bridge(lab: Lab) -> list[str]:
    return [
        await tcp_verdict(lab.client, instance, lab.incusbr0, 53)
        for instance in lab.instances.values()
    ]


def _holds(lab: Lab) -> None:
    """The table is loaded as it was, the check says so, the gate lets jobs in, the instances' port
    53 probes are blocked."""
    assert check(lab.spec, lab.status, run=run_nft).ok
    gate = HostWallGate(lab.spec, lab.status)
    assert gate.verify().ok, gate.verify().reason
    rows = go(lambda: _dns_of_other_bridge(lab))
    assert rows == ["timeout", "timeout"], rows


# #1008-T03
def test_the_table_survives_a_restart_of_the_incus_daemon(lab: Lab) -> None:
    set_phase(lab, "full")

    sh("systemctl", "restart", "incus.service")
    _wait_until(
        lambda: (
            subprocess.run(
                ["incus", "info"], capture_output=True, check=False, stdin=subprocess.DEVNULL
            ).returncode
            == 0
        ),
        60,
        "incus answering",
    )

    sh("nft", "list", "table", "inet", lab.spec.table)
    _holds(lab)


# #1008-T03
def test_the_table_survives_a_restart_of_docker_and_dockers_networking_comes_back(
    lab: Lab, container: str
) -> None:
    set_phase(lab, "full")
    before = other_tables(lab.spec.table)

    sh("systemctl", "restart", "docker.service")
    _wait_until(
        lambda: (
            subprocess.run(
                ["docker", "info"], capture_output=True, check=False, stdin=subprocess.DEVNULL
            ).returncode
            == 0
        ),
        60,
        "docker answering",
    )
    _wait_until(lambda: not _docker_works(), 60, "Docker's networking coming back")

    sh("nft", "list", "table", "inet", lab.spec.table)
    assert other_tables(lab.spec.table).keys() == before.keys()
    _holds(lab)


# #1008-T03
def test_a_table_that_is_gone_or_lost_a_rule_is_found_the_gate_refuses_and_reapply_puts_it_back(
    lab: Lab,
) -> None:
    set_phase(lab, "full")
    sandbox = IncusSandbox(lab.settings, lab.client, host_wall=HostWallGate(lab.spec, lab.status))

    # The whole table is gone (a flush of the machine's rules would do this).
    sh("nft", "delete", "table", "inet", lab.spec.table)
    found = check(lab.spec, lab.status, run=run_nft)
    assert not found.ok and "is not loaded" in found.reason
    gate = HostWallGate(lab.spec, lab.status)
    assert not gate.verify().ok
    assert sandbox.free == 0
    with pytest.raises(IncusNotReady, match="outer wall"):
        go(sandbox.setup)
    # The probe that needs the table is open again: that is the window `check --reapply` closes.
    verdict = go(lambda: tcp_verdict(lab.client, lab.instances["A"], lab.incusbr0, 53))
    assert reached(verdict)

    repaired = check(lab.spec, lab.status, reapply=True, run=run_nft)
    assert repaired.ok and repaired.reapplied
    assert gate.verify().ok and sandbox.free == lab.settings.slots
    _holds(lab)

    # One rule is gone (the last one of the input chain, the catch-all drop).
    listing = sh("nft", "-a", "list", "chain", "inet", lab.spec.table, "input")
    handle = next(
        line.rsplit("# handle ", 1)[1].strip()
        for line in listing.splitlines()
        if 'comment "all else to the host' in line
    )
    sh("nft", "delete", "rule", "inet", lab.spec.table, "input", "handle", handle)
    found = check(lab.spec, lab.status, run=run_nft)
    assert not found.ok and "differs" in found.reason
    assert not HostWallGate(lab.spec, lab.status).verify().ok
    repaired = check(lab.spec, lab.status, reapply=True, run=run_nft)
    assert repaired.ok and repaired.reapplied and "differs" in repaired.reason
    _holds(lab)

    go(sandbox.close)


# #1008-T03
def test_the_installed_command_applies_and_checks_the_table_the_way_the_installer_will(
    lab: Lab,
) -> None:
    command = shutil.which("factory-runner") or str(Path(sys.executable).parent / "factory-runner")
    common = [
        command,
        "host-wall",
        "{}",
        "--user",
        "root",
        "--state-dir",
        str(lab.settings.state_dir),
        "--prefix",
        lab.settings.prefix,
        "--slot-network",
        str(lab.settings.slot_network),
        "--status-file",
        str(lab.status),
    ]

    def call(action: str, *more: str) -> subprocess.CompletedProcess[str]:
        arguments = [action if part == "{}" else part for part in common] + list(more)
        return subprocess.run(
            arguments, capture_output=True, text=True, check=False, stdin=subprocess.DEVNULL
        )

    sh("nft", "delete", "table", "inet", lab.spec.table, check=False)
    assert call("check").returncode == 1
    assert call("status").returncode == 1
    loaded = call("apply")
    assert loaded.returncode == 0, loaded.stderr
    assert call("check").stdout.startswith("ok: ")
    assert call("status").returncode == 0
    sh("nft", "delete", "table", "inet", lab.spec.table)
    repaired = call("check", "--reapply")
    assert repaired.returncode == 0 and repaired.stdout.startswith("reapplied: "), repaired.stderr
    # The table the command loaded is the one the generator prints for these settings.
    printed = call("print")
    assert printed.stdout == lab.spec.ruleset()
