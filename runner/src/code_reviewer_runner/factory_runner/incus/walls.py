# SPDX-License-Identifier: LicenseRef-Proprietary

"""The two walls of a job's instances and the files that give them their network (#1007).

**The inner wall** is an nft table **inside instance A** (Control, the model door, the network
door),
in A's own network namespace: B (setup, then agent) is on the other side of A's second NIC and may
open a TCP connection to exactly the two doors; nothing else of A and nothing through A. Incus's own
ACLs do not do this between two ports of one bridge (they need `br_netfilter`, which a host may not
have: spike #1005, Q3), so the table is ours. B cannot change it: it is another instance with
another
network namespace. A's own root can, and A is the trusted side, as Control's VM was. A's outer NIC
takes nothing in either: only the answers to what A asked (the proxy of the host).

**The outer wall** is the proxy of this dispatcher (`firecracker/proxy_wall.py`) and, on the host, a
static nft table (#1008). Here is only what the launcher does at `narrow`: after the wall holds the
job's rule, B's outer NIC is **hot-unplugged**; B has no way to the host then. A change of a NIC's
`security.*` settings does not apply to a running NIC on Incus 7.6, which is why `narrow` is an
unplug and never a toggle (spike #1005).

**The network files** make an instance's addresses a property of the instance, not of what ran in it
at start: a NIC change re-creates the interface, and an address set by hand is gone (spike #1005,
Q4).
The files are pushed before the instance starts, and systemd-networkd of the image applies them."""

import contextlib
import logging
from collections import Counter
from collections.abc import Awaitable, Callable
from typing import Final

from code_reviewer_runner.factory_runner.firecracker.outer_wall import OuterWall, VmIdentity
from code_reviewer_runner.factory_runner.firecracker.proxy_wall import SlotAddresses
from code_reviewer_runner.factory_runner.firecracker.slots import Slot
from code_reviewer_runner.factory_runner.firecracker.wire import NarrowMessage, Refusal

from .slots import INNER_A_ADDRESS, INNER_B_ADDRESS, INNER_NETWORK, PREFIX_LENGTH, IncusSlot

_log = logging.getLogger(__name__)

# The names of the NICs inside the instances.
OUTER_NIC: Final = "eth0"
INNER_NIC_A: Final = "eth1"
# B's own NICs: the inner one first (it stays), the outer one second (it is unplugged at `narrow`).
INNER_NIC_B: Final = "eth0"
OUTER_NIC_B: Final = "eth1"
# The device names in Incus (the same as the names inside, set with `name=`).
DEVICE_OUTER: Final = "eth0"
DEVICE_INNER: Final = "eth1"
# The doors B may reach on A (the model door and the network door, spike #1005).
DOOR_PORTS: Final = (8080, 8081)
INNER_PREFIX: Final = INNER_NETWORK.prefixlen
INNER_WALL_TABLE: Final = "cr_inner"
NETWORK_DIRECTORY: Final = "/etc/systemd/network"
INNER_WALL_PATH: Final = "/etc/code-reviewer/inner-wall.nft"


def inner_wall_ruleset(
    *, b_address: str = INNER_B_ADDRESS, doors: tuple[int, ...] = DOOR_PORTS
) -> str:
    """The inner wall, loaded in A with `nft -f` in one transaction. Priority -10 runs before the
    chains Docker makes in A. `policy accept` is for A's own traffic (Docker in A, the doors, the
    answers); every rule that matters names a NIC of the wall."""
    ports = ", ".join(str(port) for port in doors)
    return f"""\
# SPDX-License-Identifier: LicenseRef-Proprietary
#
# The inner wall of one job (#1007), loaded inside instance A. B (setup, then agent) reaches the two
# doors of A and nothing else of A and nothing through A. `eth1` is the NIC on the inner bridge,
# `eth0` the one on the outer bridge (the host's proxy): A takes nothing in on it but answers.
table inet {INNER_WALL_TABLE} {{
  chain input {{
    type filter hook input priority -10; policy accept;
    iifname "{INNER_NIC_A}" ct state established,related accept
    iifname "{INNER_NIC_A}" ip saddr {b_address} tcp dport {{ {ports} }} accept
    iifname "{INNER_NIC_A}" drop
    iifname "{OUTER_NIC}" ct state established,related accept
    iifname "{OUTER_NIC}" drop
  }}
  chain forward {{
    type filter hook forward priority -10; policy accept;
    iifname "{INNER_NIC_A}" drop
    oifname "{INNER_NIC_A}" ct state established,related accept
    oifname "{INNER_NIC_A}" drop
    iifname "{OUTER_NIC}" ct state established,related accept
    iifname "{OUTER_NIC}" drop
  }}
}}
"""


def _rule_lines(text: str) -> Counter[str]:
    """The rules of a ruleset or of nft's listing of it, one entry per rule line: not the comments,
    the braces or the chain declarations (nft's listing names a priority in words)."""
    rules: Counter[str] = Counter()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", "table ", "chain ", "type ")) or line in ("{", "}"):
            continue
        rules[line] += 1
    return rules


def inner_wall_holds(listing: str, *, b_address: str = INNER_B_ADDRESS) -> bool:
    """Whether `nft list table inet cr_inner` shows the inner wall: every rule of the ruleset the
    launcher loaded (the doors' accept and every drop) is in the listing, as often as it was
    loaded. A table that is empty, or lost a drop, is not the wall."""
    wanted = _rule_lines(inner_wall_ruleset(b_address=b_address))
    found = _rule_lines(listing)
    return all(found[line] >= count for line, count in wanted.items())


def _network_file(nic: str, address: str, prefix: int) -> tuple[str, bytes]:
    path = f"{NETWORK_DIRECTORY}/05-code-reviewer-{nic}.network"
    text = (
        f"[Match]\nName={nic}\n\n"
        f"[Network]\nAddress={address}/{prefix}\n"
        "LinkLocalAddressing=no\nIPv6AcceptRA=no\nDHCP=no\n"
    )
    return path, text.encode("ascii")


def network_files_a(slot: IncusSlot) -> list[tuple[str, bytes]]:
    """Instance A: its outer address on the slot's /29 (the proxy of the host is on-link: no
    gateway, no default route: nothing is routed) and its inner address."""
    return [
        _network_file(OUTER_NIC, slot.guest_address, PREFIX_LENGTH),
        _network_file(INNER_NIC_A, INNER_A_ADDRESS, INNER_PREFIX),
    ]


def network_files_b(slot: IncusSlot) -> list[tuple[str, bytes]]:
    """Instance B: its inner address and, for the setup, its outer address. The outer file stays
    after the NIC is gone; with no NIC nothing applies it."""
    return [
        _network_file(INNER_NIC_B, INNER_B_ADDRESS, INNER_PREFIX),
        _network_file(OUTER_NIC_B, slot.b_address, PREFIX_LENGTH),
    ]


def slot_addresses(slot: Slot) -> SlotAddresses:
    """Where the proxy of a slot listens and who may use it: the host's address on the slot's outer
    bridge, A's address and B's (the outer wall of `firecracker/proxy_wall.py` serves a slot's
    addresses and no other source)."""
    each = IncusSlot(slot.index, slot.network)
    return SlotAddresses(each.host_address, each.guest_address, (each.b_address,))


def outer_nic(outer_network: str, address: str, name: str) -> dict[str, str]:
    """A NIC on the slot's outer bridge: a static address, the host's source filtering (a packet
    must come from this address and this MAC), and **port isolation**: an isolated port reaches only
    the bridge's own address, so A and B cannot reach each other there (spike #1005, Q3)."""
    return {
        "type": "nic",
        "network": outer_network,
        "name": name,
        "ipv4.address": address,
        "security.ipv4_filtering": "true",
        "security.mac_filtering": "true",
        "security.port_isolation": "true",
    }


def inner_nic(inner_network: str, name: str) -> dict[str, str]:
    """A NIC on the slot's inner bridge, which has no address on the host."""
    return {
        "type": "nic",
        "network": inner_network,
        "name": name,
        "security.mac_filtering": "true",
    }


class JobWall:
    """The `OuterWall` of one job: the dispatcher's wall, and at `narrow` the unplug of B's outer
    NIC once the wall holds the job's rule. The answer is `ack` only after both, so the agent never
    starts with a way to the host: a wall that refuses leaves the NIC in place and the Worker ends
    the job `environment_control_failed` before an agent exists. When the unplug itself fails, B
    keeps a way to the host: the job is **ended by the launcher** (`unplug_failed`: stopped, Control
    killed, both instances deleted), not left to a Worker that may not end it."""

    def __init__(
        self,
        wall: OuterWall,
        unplug: Callable[[], Awaitable[None]],
        unplug_failed: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        self._wall = wall
        self._unplug = unplug
        # What the launcher does when B's NIC stays: it ends the job itself (the Worker's own end
        # of the job is not something to rely on for a wall that did not close).
        self._unplug_failed = unplug_failed

    async def admit(self, vm: VmIdentity) -> None:
        await self._wall.admit(vm)

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        refusal = await self._wall.narrow(vm, message)
        if refusal is not None:
            return refusal
        try:
            await self._unplug()
        except Exception as error:
            _log.error(
                "%s: narrow refused: B's outer NIC could not be unplugged (%s)",
                vm.vm_id,
                type(error).__name__,
            )
            if self._unplug_failed is not None:
                with contextlib.suppress(Exception):
                    await self._unplug_failed()
            return Refusal.UNAVAILABLE
        return None

    async def forget(self, vm: VmIdentity) -> None:
        await self._wall.forget(vm)
