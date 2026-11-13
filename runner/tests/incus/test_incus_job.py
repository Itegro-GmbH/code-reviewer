# SPDX-License-Identifier: LicenseRef-Proprietary

"""A job in two real Incus instances (#1007), started by the launcher of the local Dispatcher: the
limits and the quota the instances really have, the inner wall in a real network namespace (each
probe with a control that reached without the wall), `narrow` as the unplug of B's outer NIC, the
write past the quota, and the clean-up after a crash. The Worker image and Docker are stand-ins
(`fake_docker.py`, the host's `nft`): the real image is the golden image's smoke test, not this.

Run it with `-m incus --force-enable-socket` and the variables of `incus_lane.py`."""

import asyncio
import json
import time
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from incus_lane import StandInClient, probe, reaches

from code_reviewer_runner.factory_runner.incus.launcher import (
    EXIT_DISK_QUOTA,
    IncusSandbox,
    IncusWorker,
)
from code_reviewer_runner.factory_runner.incus.settings import IncusSettings
from code_reviewer_runner.factory_runner.sandbox import WorkerStart

pytestmark = pytest.mark.incus

A_INNER = "10.98.0.2"
B_INNER = "10.98.0.3"
# A source address that is not B's: what a spoofing agent would put on its packets.
SPOOFED = "10.98.0.9"
HOST = "10.99.0.1"
# A forwards and masquerades what leaves its outer NIC: the way "through A" if the wall did not
# stop it.
ROUTE_THROUGH_A = (
    "sysctl -w net.ipv4.ip_forward=1 && nft add table ip cr_probe && "
    "nft 'add chain ip cr_probe post { type nat hook postrouting priority 100; }' && "
    "nft add rule ip cr_probe post oifname eth0 masquerade"
)
SLOT_OUTER_A = "10.99.0.2"


def go(scenario: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
    return asyncio.run(scenario())


def start(number: int = 1) -> WorkerStart:
    return WorkerStart(
        "http://app.example.com", f"00000000-0000-4000-8000-{number:012d}", "crj_" + "k" * 40
    )


async def names(client: StandInClient, settings: IncusSettings) -> list[str]:
    return sorted(
        instance.name
        for instance in await client.list_instances()
        if instance.name.startswith((f"{settings.name_prefix}-a-", f"{settings.name_prefix}-b-"))
    )


async def until(client: StandInClient, instance: str, command: str, seconds: float = 30.0) -> None:
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        if (await probe(client, instance, command)).exit_code == 0:
            return
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"{command!r} did not succeed in {instance}")
        await asyncio.sleep(0.25)


async def running_job(
    client: StandInClient, settings: IncusSettings
) -> tuple[IncusSandbox, IncusWorker, str, str]:
    sandbox = IncusSandbox(settings, client)
    try:
        await sandbox.setup()
        began = time.monotonic()
        worker = await sandbox.start(start())
        # The start budget: nothing to Control running, two instances, the doors maybe not yet.
        print(f"lane: start() took {time.monotonic() - began:.1f} s", flush=True)
        a, b = await names(client, settings)
        await until(client, a, "test -e /tmp/ready")
    except BaseException:
        # Let go of the lock: the next test of the session needs it.
        await sandbox.close()
        raise
    return sandbox, worker, a, b


# #1007-T01
def test_two_instances_with_their_limits_and_quota_that_are_deleted_at_the_end(
    client: StandInClient, settings: IncusSettings
) -> None:
    async def scenario() -> Any:
        sandbox, worker, a, b = await running_job(client, settings)
        try:
            seen = {
                "names": [a, b],
                "cpus": [(await probe(client, n, "nproc")).stdout.strip() for n in (a, b)],
                "memory": [
                    (await probe(client, n, "cat /sys/fs/cgroup/memory.max")).stdout.strip()
                    for n in (a, b)
                ],
                "pids": (await probe(client, b, "cat /sys/fs/cgroup/pids.max")).stdout.strip(),
                "user": (await probe(client, b, "cat /proc/self/uid_map")).stdout.split(),
                "marks": [
                    i.config.get("user.cr.job")
                    for i in await client.list_instances()
                    if i.name in (a, b)
                ],
            }
            await probe(client, a, "touch /tmp/finish")
            outcome = await worker.wait()
        finally:
            await sandbox.close()
        return seen, outcome, await names(client, settings)

    seen, outcome, left = go(scenario)

    assert seen["cpus"] == ["2", "2"]
    assert seen["memory"] == [str(2048 * 1024 * 1024)] * 2
    assert seen["pids"] == "4096"
    # An unprivileged instance: root inside is a host id above 65535, in a range of its own.
    assert seen["user"][0] == "0" and int(seen["user"][1]) >= 65536
    assert seen["marks"] == ["00000000-0000-4000-8000-000000000001"] * 2
    assert outcome.exit_code == 0
    assert left == []


# #1007-T01
def test_a_job_that_crashes_the_dispatcher_is_cleaned_up_by_its_mark(
    client: StandInClient, settings: IncusSettings
) -> None:
    async def scenario() -> Any:
        crashed, _, _a, _b = await running_job(client, settings)
        before = await names(client, settings)
        # The dispatcher "crashes": its lock goes with the process, its instances stay.
        await crashed.close()
        await asyncio.sleep(0.1)
        survivor = IncusSandbox(settings, client)
        try:
            await survivor.setup()
        finally:
            await survivor.close()
        return before, survivor.reaped, await names(client, settings)

    before, reaped, left = go(scenario)

    assert len(before) == 2 and sorted(reaped.instances) == before and left == []


# #1007-T02
def test_narrow_unplugs_bs_outer_nic_and_the_proxy_of_the_host_is_unreachable_from_b(
    client: StandInClient, settings: IncusSettings
) -> None:
    async def scenario() -> Any:
        sandbox, worker, a, b = await running_job(client, settings)
        try:
            # The setup's phase: the proxy of the host answers, the rest of the host does not.
            before = {
                "proxy": await reaches(client, b, HOST, 3128),
                "sshd": await reaches(client, b, HOST, 22),
                "nic": (await probe(client, b, "ip -br addr show eth1")).exit_code,
            }
            await probe(client, a, "touch /tmp/go")
            await until(client, a, "test -s /tmp/narrow-reply")
            reply = json.loads((await probe(client, a, "cat /tmp/narrow-reply")).stdout)
            after = {
                "proxy": await reaches(client, b, HOST, 3128),
                "nic": (await probe(client, b, "ip -br addr show eth1")).exit_code,
                "route": (await probe(client, b, "ip route")).stdout,
            }
            await probe(client, a, "touch /tmp/finish")
            await worker.wait()
        finally:
            await sandbox.close()
        return before, reply, after

    before, reply, after = go(scenario)

    assert before == {"proxy": True, "sshd": False, "nic": 0}
    assert reply == {"version": 1, "type": "ack", "for": "narrow"}
    assert after["proxy"] is False and after["nic"] != 0
    assert HOST not in after["route"]


# #1007-T03
def test_the_inner_wall_lets_b_reach_only_the_two_doors_of_a(
    client: StandInClient, settings: IncusSettings
) -> None:
    async def scenario() -> Any:
        sandbox, worker, a, b = await running_job(client, settings)
        try:
            targets = {"door-8080": 8080, "door-8081": 8081, "secrets": 9000, "docker-api": 2375}

            async def view() -> dict[str, bool]:
                return {
                    name: await reaches(client, b, A_INNER, port) for name, port in targets.items()
                }

            walled = await view()
            icmp_walled = (await probe(client, b, f"ping -c1 -W2 {A_INNER}")).exit_code == 0
            routed_walled = await reaches(client, b, "1.1.1.1", 443)

            # Routing through A, for real: B has no other NIC, its default route is A, and A
            # forwards and masquerades. The host's proxy address is what A's outer NIC reaches.
            await client.remove_device(b, "eth1")
            setup = await probe(
                client, b, f"ip route replace default via {A_INNER} dev eth0 && ip route"
            )
            assert setup.exit_code == 0, setup.stderr
            prepared = await probe(client, a, ROUTE_THROUGH_A)
            assert prepared.exit_code == 0, prepared.stderr
            # B has the second address that a spoofing agent would use.
            spoof = await probe(client, b, f"ip addr add {SPOOFED}/24 dev eth0")
            assert spoof.exit_code == 0, spoof.stderr
            through_walled = await reaches(client, b, HOST, 3128)
            spoofed_walled = await probe(client, b, f"nc -z -w3 -s {SPOOFED} {A_INNER} 8080")

            # The control: the same probes with the wall's table deleted must reach.
            await probe(client, a, "nft delete table inet cr_inner")
            open_view = await view()
            icmp_open = (await probe(client, b, f"ping -c1 -W2 {A_INNER}")).exit_code == 0
            through_open = await reaches(client, b, HOST, 3128)
            spoofed_open = await probe(client, b, f"nc -z -w3 -s {SPOOFED} {A_INNER} 8080")
            # The wall again.
            await probe(client, a, "nft -f /etc/code-reviewer/inner-wall.nft")
            again = await view()
            through_again = await reaches(client, b, HOST, 3128)
            spoofed_again = await probe(client, b, f"nc -z -w3 -s {SPOOFED} {A_INNER} 8080")
            await probe(client, a, "touch /tmp/finish")
            await worker.wait()
        finally:
            await sandbox.close()
        return (
            walled,
            icmp_walled,
            routed_walled,
            open_view,
            icmp_open,
            again,
            (through_walled, through_open, through_again),
            (spoofed_walled.exit_code, spoofed_open.exit_code, spoofed_again.exit_code),
        )

    walled, icmp_walled, routed_walled, open_view, icmp_open, again, through, spoofed = go(scenario)

    assert walled == {"door-8080": True, "door-8081": True, "secrets": False, "docker-api": False}
    assert icmp_walled is False and routed_walled is False
    # Each block has a control that reached.
    assert open_view == {"door-8080": True, "door-8081": True, "secrets": True, "docker-api": True}
    assert icmp_open is True
    assert again == walled
    # Through A to the host's proxy: stopped by the wall, reached without it (the control), stopped
    # again once it is back.
    assert through == (False, True, False)
    # From a source that is not B's address to a door: dropped, then reached, then dropped.
    assert spoofed[0] != 0 and spoofed[1] == 0 and spoofed[2] != 0


# #1007-T04
def test_a_write_past_the_quota_fails_with_edquot_and_the_job_ends_with_a_stable_code(
    client: StandInClient, settings: IncusSettings
) -> None:
    async def scenario() -> Any:
        sandbox, worker, a, b = await running_job(client, settings)
        try:
            # B's quota, from inside B.
            quota = await probe(
                client,
                b,
                "dd if=/dev/zero of=/blob bs=1M count=100000 2>&1 | grep -i quota",
                seconds=120,
            )
            # A write that does not pass the quota still works (the control).
            small = await probe(
                client, b, "rm -f /blob && dd if=/dev/zero of=/small bs=1M count=10"
            )
            # A's quota, from Control: the job ends with the launcher's stable code.
            await probe(client, a, "touch /tmp/fill")
            outcome = await asyncio.wait_for(worker.wait(), 180)
        finally:
            await sandbox.close()
        return quota, small, outcome

    quota, small, outcome = go(scenario)

    assert "Disk quota exceeded" in quota.stdout
    assert small.exit_code == 0
    assert outcome.exit_code == EXIT_DISK_QUOTA
    assert outcome.log_tail.startswith("disk_quota_exceeded:")


# #1007-T01
def test_the_launcher_ignores_the_operators_own_incus_configuration(
    client: StandInClient,
    settings: IncusSettings,
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A personal remote as the default (here one that does not exist) must not matter: the client
    has a private configuration and talks to the local daemon's `default` project."""
    home = tmp_path / "home"
    (home / ".config" / "incus").mkdir(parents=True)
    (home / ".config" / "incus" / "config.yml").write_text(
        "default-remote: nowhere\nremotes:\n  nowhere:\n    addr: https://192.0.2.1:8443\n"
        "    protocol: incus\n"
    )
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("INCUS_CONF", str(home / ".config" / "incus"))
    monkeypatch.setenv("INCUS_PROJECT", "nowhere")

    async def scenario() -> Any:
        return await client.pool_exists(settings.pool), await client.network_info(
            settings.outer_network(0)
        )

    pool, network = go(scenario)

    assert pool is True and network is not None and network.type == "bridge"
