# SPDX-License-Identifier: LicenseRef-Proprietary

"""The objects of a machine that the launcher needs and no job makes (#1007): per slot an outer
bridge with its ACL and an inner bridge.

The installer (#1011) calls this as root-equivalent (a member of `incus-admin`); the launcher's
`setup` only **checks** that they are there. Every name starts with the settings' prefix; nothing
else is ever created, changed or deleted: not the `default` pool or profile, not `incusbr0`.

* the **outer bridge** `<prefix>-out<N>`: the host's address (where the proxy of the outer wall
  listens) and nothing else: no DHCP, no NAT, no routing, no IPv6, and no DNS (`raw.dnsmasq=port=0`:
  `dns.mode=none` still leaves the bridge's dnsmasq answering on port 53). Its ACL
  `<prefix>-out<N>` lets an instance open a TCP connection to the proxy and nothing else, and drops
  the rest in both directions. What it still leaves open, **port 53 of the host's own addresses**
  (Incus accepts DNS and DHCP of an ACL-protected bridge before the ACL, still so on 7.6), is what
  the host's static nft table closes (#1008);
* the **inner bridge** `<prefix>-in<N>`: no address at all, so the host is not on it."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from .client import IncusClient
from .settings import IncusSettings
from .slots import IncusSlot

PROXY_PORT: Final = "3128"


@dataclass(frozen=True)
class Missing:
    """What a machine lacks."""

    items: tuple[str, ...]

    def __bool__(self) -> bool:
        return bool(self.items)


def outer_network_config(slot: IncusSlot, acl: str) -> Mapping[str, str]:
    return {
        "ipv4.address": slot.cidr,
        "ipv4.nat": "false",
        "ipv4.routing": "false",
        "ipv4.dhcp": "false",
        "ipv6.address": "none",
        "dns.mode": "none",
        "raw.dnsmasq": "port=0",
        "security.acls": acl,
        "security.acls.default.egress.action": "drop",
        "security.acls.default.ingress.action": "drop",
    }


def outer_acl_rules(slot: IncusSlot) -> list[Mapping[str, str]]:
    return [
        {
            "action": "allow",
            "protocol": "tcp",
            "destination": f"{slot.host_address}/32",
            "destination_port": PROXY_PORT,
            "state": "enabled",
        }
    ]


INNER_NETWORK_CONFIG: Final = {"ipv4.address": "none", "ipv6.address": "none"}


async def ensure_objects(client: IncusClient, settings: IncusSettings) -> list[str]:
    """Make what is missing (idempotent: an existing object is left as it is) and return the names
    of what was made, for the log."""
    made: list[str] = []
    for index in range(settings.slots):
        slot = IncusSlot(index, settings.slot_network)
        outer, inner = settings.outer_network(index), settings.inner_network(index)
        if not await client.acl_exists(outer):
            await client.create_acl(outer, outer_acl_rules(slot))
            made.append(f"acl {outer}")
        if not await client.network_exists(outer):
            await client.create_network(outer, outer_network_config(slot, outer))
            made.append(f"network {outer}")
        if not await client.network_exists(inner):
            await client.create_network(inner, INNER_NETWORK_CONFIG)
            made.append(f"network {inner}")
    return made


async def remove_objects(client: IncusClient, settings: IncusSettings) -> list[str]:
    """Delete the networks and ACLs of the prefix's slots (the networks first: an ACL in use cannot
    go). Nothing else."""
    removed: list[str] = []
    for index in range(settings.slots):
        outer, inner = settings.outer_network(index), settings.inner_network(index)
        for network in (outer, inner):
            if await client.network_exists(network):
                await client.delete_network(network)
                removed.append(f"network {network}")
        if await client.acl_exists(outer):
            await client.delete_acl(outer)
            removed.append(f"acl {outer}")
    return removed


async def missing_objects(client: IncusClient, settings: IncusSettings) -> Missing:
    """What the launcher needs and the machine lacks: the pool, the image, the two bridges of every
    slot."""
    lacking: list[str] = []
    if not await client.pool_exists(settings.pool):
        lacking.append(f"storage pool {settings.pool}")
    if not await client.image_exists(settings.image):
        lacking.append(f"image {settings.image}")
    for index in range(settings.slots):
        for network in (settings.outer_network(index), settings.inner_network(index)):
            if not await client.network_exists(network):
                lacking.append(f"network {network}")
    return Missing(tuple(lacking))
