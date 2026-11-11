# SPDX-License-Identifier: LicenseRef-Proprietary

"""Slots of the Incus backend: the number of jobs that run at once, each with two bridges (#1007).

A slot's **outer bridge** is the one network of its instances that leads to the host: the host's
address on it is where the outer wall's proxy listens (#979), instance A has the second address and
instance B (while its setup runs) the third, of a /29 at offset `N*8` of the slots' network. Nothing
else is on the bridge: no DHCP, no NAT, no routing, no DNS (spike #1005, Q4). The **inner bridge**
joins A's second NIC and B's only NIC and has no address on the host: the host is not on it.

The slots' network is a setting of the machine, chosen by the installer so that it overlaps no
address or route the machine has (`FACTORY_RUNNER_SLOT_NETWORK`). The objects themselves (the two
bridges and the ACL of each slot) are made once by `provision.py`; a job never makes a network."""

import ipaddress
from dataclasses import dataclass
from typing import Final

from code_reviewer_runner.factory_runner.firecracker.slots import (
    PRIVATE_NETWORKS,
    Slot,
)

ADDRESSES_PER_SLOT: Final = 8
PREFIX_LENGTH: Final = 29
# 32 slots of 8 addresses are a /24.
MAX_SLOTS: Final = 32
DEFAULT_SLOT_NETWORK: Final = ipaddress.IPv4Network("10.99.0.0/24")
# The inner network of every slot: its own L2, so every slot uses the same two addresses. B reaches
# A's two doors on A's address.
INNER_NETWORK: Final = ipaddress.IPv4Network("10.98.0.0/24")
INNER_A_ADDRESS: Final = "10.98.0.2"
INNER_B_ADDRESS: Final = "10.98.0.3"


def parse_slot_network(text: str, slots: int) -> ipaddress.IPv4Network:
    """The slots' network of a setting: a private IPv4 network (an exact network address) with room
    for `slots` /29 networks. Raises `ValueError` (the message names the rule, never more)."""
    try:
        network = ipaddress.IPv4Network(text.strip(), strict=True)
    except ValueError:
        raise ValueError("an IPv4 network such as 10.250.0.0/24") from None
    if not any(network.subnet_of(private) for private in PRIVATE_NETWORKS):
        raise ValueError("inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16")
    if network.overlaps(INNER_NETWORK):
        raise ValueError(f"not overlapping {INNER_NETWORK}, which the inner bridges use")
    if network.num_addresses < slots * ADDRESSES_PER_SLOT:
        raise ValueError(f"room for {slots} slots ({ADDRESSES_PER_SLOT} addresses each)")
    return network


@dataclass(frozen=True)
class IncusSlot(Slot):
    """A slot of this backend. It is a `Slot` of the Firecracker backend with a /29 instead of a /30
    so that the outer wall (`firecracker/proxy_wall.py`) can serve it unchanged: `host_address` is
    where its proxy listens, `guest_address` is instance A's."""

    @property
    def _base(self) -> int:
        return self.index * ADDRESSES_PER_SLOT

    @property
    def tap(self) -> str:
        """What the outer wall's log calls the slot's device: here, the slot's outer bridge."""
        return f"outer bridge of slot {self.index}"

    @property
    def b_address(self) -> str:
        """Instance B's address on the outer bridge (while its setup has the wide rule)."""
        return self._address(3)

    @property
    def cidr(self) -> str:
        return f"{self.host_address}/{PREFIX_LENGTH}"


class SlotPool:
    """The slots of this machine. A job takes one and gives it back when its instances are gone."""

    def __init__(self, count: int, network: ipaddress.IPv4Network = DEFAULT_SLOT_NETWORK) -> None:
        if not 1 <= count <= MAX_SLOTS:
            raise ValueError(f"the number of slots is 1 to {MAX_SLOTS}")
        if network.num_addresses < count * ADDRESSES_PER_SLOT:
            raise ValueError("the slots' network is too small for the number of slots")
        self._free = [IncusSlot(index, network) for index in range(count)]
        self.capacity = count

    @property
    def free(self) -> int:
        return len(self._free)

    def acquire(self) -> IncusSlot | None:
        return self._free.pop(0) if self._free else None

    def release(self, slot: IncusSlot) -> None:
        if slot not in self._free:
            self._free.append(slot)
            self._free.sort(key=lambda each: each.index)
