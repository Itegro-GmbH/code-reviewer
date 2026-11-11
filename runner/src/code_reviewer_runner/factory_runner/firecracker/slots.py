# SPDX-License-Identifier: LicenseRef-Proprietary

"""Slots: the number of VMs that run at once, each with a TAP device made at install (#978).

A TAP device is root's to create and the service user's to attach to (spike #970, Q4), so the
installer (#982) makes one per slot and the number of slots is the number of concurrent jobs
(`parallelRuns`). A slot's TAP is `fctap<N>`; its /30 network is derived from the number, so the
installer (nft rules per TAP, #979), the proxy and this launcher agree on it without a file:
slot N owns `172.31.<N*4 // 256>.<N*4 % 256>/30`, the host side is the first address of it and the
guest's is the second."""

from dataclasses import dataclass
from typing import Final

TAP_PREFIX: Final = "fctap"
NETWORK_PREFIX: Final = "172.31"
PREFIX_LENGTH: Final = 30
# The /16 holds 16384 /30 networks; a machine has a handful of slots.
MAX_SLOTS: Final = 64


@dataclass(frozen=True)
class Slot:
    index: int

    @property
    def tap(self) -> str:
        return f"{TAP_PREFIX}{self.index}"

    @property
    def _base(self) -> int:
        return self.index * 4

    def _address(self, offset: int) -> str:
        base = self._base + offset
        return f"{NETWORK_PREFIX}.{base // 256}.{base % 256}"

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

    def __init__(self, count: int) -> None:
        if not 1 <= count <= MAX_SLOTS:
            raise ValueError(f"the number of slots is 1 to {MAX_SLOTS}")
        self._free = [Slot(index) for index in range(count)]
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
