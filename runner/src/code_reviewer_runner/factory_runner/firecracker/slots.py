# SPDX-License-Identifier: LicenseRef-Proprietary

"""Slots: the number of VMs that run at once, each with a TAP device made at install (#978).

A TAP device is root's to create and the service user's to attach to (spike #970, Q4), so the
installer (#982) makes one per slot and the number of slots is the number of concurrent jobs
(`parallelRuns`). A slot's TAP is `fctap<N>`; its /30 network is derived from the number and from
the slots' network, so the installer (the nft table, #979), the proxy and this launcher agree on it
without a file: slot N owns the /30 at offset `N*4` of the slots' network, the host side is the
first address of it and the guest's is the second.

The slots' network is a setting of the machine, chosen by the installer so that it overlaps no
address or route the machine has (`FACTORY_RUNNER_SLOT_NETWORK`, a /24: 64 slots of 4 addresses).
`DEFAULT_SLOT_NETWORK` is for the tests and the KVM lane; an installed machine has its own."""

import ipaddress
from dataclasses import dataclass, field
from typing import Final

TAP_PREFIX: Final = "fctap"
PREFIX_LENGTH: Final = 30
# 64 slots of 4 addresses are a /24.
MAX_SLOTS: Final = 64
DEFAULT_SLOT_NETWORK: Final = ipaddress.IPv4Network("172.31.0.0/16")
# What a slot network may be: private addresses, as the installer chooses them.
PRIVATE_NETWORKS: Final = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)


def is_private_address(address: ipaddress.IPv4Address) -> bool:
    return any(address in network for network in PRIVATE_NETWORKS)


def parse_slot_network(text: str, slots: int) -> ipaddress.IPv4Network:
    """The slots' network of a setting: a private IPv4 network (an exact network address) with room
    for `slots` /30 networks. Raises `ValueError` (the message names the rule, never more)."""
    try:
        network = ipaddress.IPv4Network(text.strip(), strict=True)
    except ValueError:
        raise ValueError("an IPv4 network such as 10.250.0.0/24") from None
    if not any(network.subnet_of(private) for private in PRIVATE_NETWORKS):
        raise ValueError("inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16")
    if network.num_addresses < slots * 4:
        raise ValueError(f"room for {slots} slots (4 addresses each)")
    return network


@dataclass(frozen=True)
class Slot:
    index: int
    network: ipaddress.IPv4Network = field(default=DEFAULT_SLOT_NETWORK, compare=False)

    @property
    def tap(self) -> str:
        return f"{TAP_PREFIX}{self.index}"

    @property
    def _base(self) -> int:
        return self.index * 4

    def _address(self, offset: int) -> str:
        return str(self.network.network_address + self._base + offset)

    @property
    def host_address(self) -> str:
        return self._address(1)

    @property
    def guest_address(self) -> str:
        return self._address(2)

    @property
    def guest_mac(self) -> str:
        """06:00 and the four bytes of the guest's address (the locally administered range)."""
        return "06:00:" + ":".join(f"{int(part):02x}" for part in self.guest_address.split("."))


class SlotPool:
    """The slots of this machine. A job takes one and gives it back when its VM is gone."""

    def __init__(self, count: int, network: ipaddress.IPv4Network = DEFAULT_SLOT_NETWORK) -> None:
        if not 1 <= count <= MAX_SLOTS:
            raise ValueError(f"the number of slots is 1 to {MAX_SLOTS}")
        if network.num_addresses < count * 4:
            raise ValueError("the slots' network is too small for the number of slots")
        self._free = [Slot(index, network) for index in range(count)]
        self.capacity = count

    @property
    def free(self) -> int:
        return len(self._free)

    def acquire(self) -> Slot | None:
        return self._free.pop(0) if self._free else None

    def release(self, slot: Slot) -> None:
        if slot not in self._free:
            self._free.append(slot)
            self._free.sort(key=lambda each: each.index)
