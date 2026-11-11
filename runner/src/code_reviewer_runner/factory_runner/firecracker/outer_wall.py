# SPDX-License-Identifier: LicenseRef-Proprietary

"""The hook for the outer network wall (#979 builds it; #978 answers for it).

A job's VM has no direct internet: a static nft table lets the VM's TAP reach only a proxy of this
dispatcher, which enforces the wide rule of the setup and then the job's own rule (decision 7 of ADR
0005). The Worker asks for the job's rule over vsock (`narrow`) and the host answers `ack` **only
once the outer wall holds it**, so the agent never starts under the setup's wide rule.

#979 implements `OuterWall`. Until it does there is no wall to switch, so the answer is a decision
of the operator, never a silent `ack`:

* `refuse` (the default): `narrow` is answered `refused` (`unavailable`). The Worker ends the job
  `environment_control_failed` before an agent exists. A job that needs the wall does not run
  without it.
* `inner-only` (`FACTORY_RUNNER_OUTER_WALL=inner-only`): `narrow` is answered `ack` and a warning
  says so once per VM. The agent's network is then the inner wall (the network door) only, as on
  the Worker-as-a-process mode. For a machine whose owner accepts that, and for the KVM lane."""

import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from .slots import Slot
from .wire import NarrowMessage, Refusal

_log = logging.getLogger(__name__)


class OuterWallMode(StrEnum):
    REFUSE = "refuse"
    INNER_ONLY = "inner-only"


@dataclass(frozen=True)
class VmIdentity:
    """Which VM a request is from: the connection is the VM's own (Firecracker makes a vsock device
    for one VM), and the TAP and the guest's address are what the proxy tells jobs apart by."""

    vm_id: str
    slot: Slot


class OuterWall(Protocol):
    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        """Make the outer wall of `vm` hold the rule of `message`. None: it does (`ack`); a reason:
        it does not (`refused`)."""
        ...

    async def forget(self, vm: VmIdentity) -> None:
        """The VM is gone: drop whatever the wall holds for it. Never raises."""
        ...


class RefusingOuterWall:
    """There is no outer wall to narrow (before #979): the request is refused, and the log says
    why."""

    async def narrow(self, vm: VmIdentity, message: NarrowMessage) -> Refusal | None:
        _ = message
        _log.error(
            "%s: narrow refused: this dispatcher has no outer wall yet "
            "(FACTORY_RUNNER_OUTER_WALL=inner-only runs jobs with the inner wall only)",
            vm.vm_id,
        )
        return Refusal.UNAVAILABLE

    async def forget(self, vm: VmIdentity) -> None:
        _ = vm


class InnerWallOnly:
    """The operator chose to run jobs with the inner wall only: `narrow` is acknowledged, and a
    warning says that nothing was narrowed."""

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


def outer_wall_for(mode: OuterWallMode) -> OuterWall:
    return InnerWallOnly() if mode is OuterWallMode.INNER_ONLY else RefusingOuterWall()
