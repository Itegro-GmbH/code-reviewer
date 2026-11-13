# SPDX-License-Identifier: LicenseRef-Proprietary

"""The outer network wall of a job's VM (#979; #978 made the hook).

A job's VM has no direct internet: a static nft table (`docker/vm/host/outer-wall.nft`) lets the
VM's TAP reach only a proxy of this dispatcher, which enforces the wide rule of the setup and then
the job's own rule (decision 7 of ADR 0005). The Worker asks for the job's rule over vsock
(`narrow`) and the host answers `ack` **only once the outer wall holds it**, so the agent never
starts under the setup's wide rule. `FACTORY_RUNNER_OUTER_WALL` chooses the wall:

* `refuse` (the default): `narrow` is answered `refused` (`unavailable`). The Worker ends the job
  `environment_control_failed` before an agent exists. A job that needs the wall does not run
  without it. This stays the default until the installer (#982) has loaded the static nft table
  and verified it (`nft list table`): the dispatcher runs as a normal user and cannot see nft
  state, so it must never assume a wall it cannot check.
* `proxy`: the real wall (`proxy_wall.py`), set by the installer once the table is verified. The
  proxy listens on each slot's TAP address and on nothing else; `admit` gives a VM the wide rule,
  `narrow` swaps in the job's rule, `forget` takes the VM's rule away. It logs a warning at
  startup that it cannot verify the table itself.
* `inner-only`: `narrow` is answered `ack` and a warning says so once per VM. The agent's network is
  then the inner wall (the network door) only, as on the Worker-as-a-process mode. For a machine
  whose owner accepts that."""

import ipaddress
import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

from .slots import DEFAULT_SLOT_NETWORK, Slot
from .wire import NarrowMessage, Refusal

_log = logging.getLogger(__name__)


class OuterWallMode(StrEnum):
    PROXY = "proxy"
    REFUSE = "refuse"
    INNER_ONLY = "inner-only"


@dataclass(frozen=True)
class VmIdentity:
    """Which VM a request is from: the connection is the VM's own (Firecracker makes a vsock device
    for one VM), and the TAP and the guest's address are what the proxy tells jobs apart by.
    `app_host` is the host of the app the job's Worker calls (the one name a narrowed VM needs
    besides GitHub and the model provider) and `app_port` the port it is reached on (None: the
    scheme's default, a web port; the proxy dials 80 and 443 only)."""

    vm_id: str
    slot: Slot
    app_host: str | None = None
    app_port: int | None = None


class OuterWall(Protocol):
    async def admit(self, vm: VmIdentity) -> None:
        """A VM is about to start on `vm.slot`: give it the wide rule of the setup. Called before
        the VMM exists, so that nothing of the VM can reach the wall without a rule; raises when the
        wall cannot (the start fails and the claim is given back)."""
        ...

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        """Make the outer wall of `vm` hold the rule of `message`. None: it does (`ack`); a reason:
        it does not (`refused`)."""
        ...

    async def forget(self, vm: VmIdentity) -> None:
        """The VM is gone: drop whatever the wall holds for it. Never raises."""
        ...


@runtime_checkable
class WallLifecycle(Protocol):
    """A wall with something that runs (the proxy's listeners): started by the launcher's `setup`,
    closed by its `close`. The stand-ins have nothing to run."""

    async def start(self) -> None:
        """Raises `OuterWallUnavailable` (named in the log) when the wall cannot be made."""
        ...

    async def close(self) -> None: ...


class RefusingOuterWall:
    """The operator chose no outer wall at all: the request is refused, and the log says why."""

    async def admit(self, vm: VmIdentity) -> None:
        _ = vm

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        _ = message
        _log.error(
            "%s: narrow refused: this dispatcher has no outer wall "
            "(FACTORY_RUNNER_OUTER_WALL=refuse; =proxy is the outer wall, =inner-only runs jobs "
            "with the inner wall only)",
            vm.vm_id,
        )
        return Refusal.UNAVAILABLE

    async def forget(self, vm: VmIdentity) -> None:
        _ = vm


class InnerWallOnly:
    """The operator chose to run jobs with the inner wall only: `narrow` is acknowledged, and a
    warning says that nothing was narrowed."""

    async def admit(self, vm: VmIdentity) -> None:
        _ = vm

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        _ = message
        _log.warning(
            "%s: narrow acknowledged WITHOUT an outer wall (inner wall only, chosen by "
            "FACTORY_RUNNER_OUTER_WALL=inner-only)",
            vm.vm_id,
        )
        return None

    async def forget(self, vm: VmIdentity) -> None:
        _ = vm


def outer_wall_for(
    mode: OuterWallMode, slots: int = 1, network: ipaddress.IPv4Network = DEFAULT_SLOT_NETWORK
) -> OuterWall:
    """The wall of a mode. `slots` is the number of TAP addresses the proxy listens on, in
    `network`."""
    if mode is OuterWallMode.PROXY:
        from .proxy_wall import ProxyOuterWall  # the proxy imports this module's types

        return ProxyOuterWall(slots, network=network)
    return InnerWallOnly() if mode is OuterWallMode.INNER_ONLY else RefusingOuterWall()
