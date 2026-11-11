# SPDX-License-Identifier: LicenseRef-Proprietary

"""The objects of a machine that the launcher needs and no job makes (#1007): per slot an outer
bridge with its ACL and an inner bridge.

The installer (#1011) calls this as root-equivalent (a member of `incus-admin`); the launcher's
`setup` only **checks** that they are there. Every name starts with the settings' prefix; nothing
else is ever created, changed or deleted: not the `default` pool or profile, not `incusbr0`.

* the **outer bridge** `<prefix>-<owner>-o<N>`: the host's address (where the proxy of the outer
  wall listens) and nothing else: no DHCP, no NAT, no routing, no IPv6, and no DNS
  (`raw.dnsmasq=port=0`: `dns.mode=none` still leaves the bridge's dnsmasq answering on port 53).
  Its ACL `<prefix>-<owner>-o<N>` lets an instance open a TCP connection to the proxy and nothing
  else, and drops the rest in both directions. What it still leaves open, **port 53 of the host's
  own addresses** (Incus accepts DNS and DHCP of an ACL-protected bridge before the ACL, still so on
  7.6), is what the host's static nft table closes (#1008);
* the **inner bridge** `<prefix>-<owner>-i<N>`: no address at all, so the host is not on it.

The owner (`settings.owner`) is in every name so that two dispatchers on one daemon have objects of
their own. An object that is there is **checked, never changed**: a bridge or ACL of that name with
another configuration (a NAT that is on, a DHCP, an ACL with more rules) is a foreign object or a
drifted one, and `misconfigured_objects` names what differs; `setup`, `run`'s checks and
`ensure_objects` fail on it. Two owners on one machine need two slot networks (the host's address of
a slot's outer bridge is on the host): the installer chooses them."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final

from .client import IncusClient
from .settings import IncusSettings
from .slots import IncusSlot

PROXY_PORT: Final = "3128"


class ProvisionError(Exception):
    """An object is there with another configuration than the launcher needs. The message names the
    object and the setting, never more."""


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
    of what was made, for the log. Raises `ProvisionError` when an object that is there has another
    configuration than the launcher needs (it is not changed)."""
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
    wrong = await misconfigured_objects(client, settings)
    if wrong:
        raise ProvisionError("; ".join(wrong))
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


def _differences(
    kind: str, name: str, found: Mapping[str, str], expected: Mapping[str, str]
) -> list[str]:
    lines: list[str] = []
    for key, wanted in expected.items():
        if key not in found:
            lines.append(f"{kind} {name}: {key} is not set, expected '{wanted}'")
        elif found[key] != wanted:
            lines.append(f"{kind} {name}: {key} is '{found[key]}', expected '{wanted}'")
    return lines


def _same_rules(found: Sequence[Mapping[str, str]], expected: Sequence[Mapping[str, str]]) -> bool:
    """The ACL has exactly the rules wanted: as many, and each has the wanted values (Incus adds
    keys of its own, such as an empty description)."""
    return len(found) == len(expected) and all(
        all(rule.get(key) == value for key, value in want.items())
        for rule, want in zip(found, expected, strict=True)
    )


async def misconfigured_objects(client: IncusClient, settings: IncusSettings) -> list[str]:
    """What is there but not as the launcher needs it, one line each (empty: all as wanted). Only
    objects that exist are looked at (`missing_objects` names what does not). Nothing is changed."""
    wrong: list[str] = []
    for index in range(settings.slots):
        slot = IncusSlot(index, settings.slot_network)
        outer, inner = settings.outer_network(index), settings.inner_network(index)
        for name, expected in (
            (outer, outer_network_config(slot, outer)),
            (inner, INNER_NETWORK_CONFIG),
        ):
            network = await client.network_info(name)
            if network is None:
                continue
            if network.type != "bridge":
                wrong.append(f"network {name}: type is '{network.type}', expected 'bridge'")
            wrong += _differences("network", name, network.config, expected)
        acl = await client.acl_info(outer)
        if acl is None:
            continue
        if acl.ingress or not _same_rules(acl.egress, outer_acl_rules(slot)):
            wrong.append(
                f"acl {outer}: the rules are not exactly one egress rule that lets a TCP "
                f"connection to {slot.host_address}:{PROXY_PORT} through"
            )
    return wrong
