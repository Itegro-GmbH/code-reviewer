# SPDX-License-Identifier: LicenseRef-Proprietary

"""How a customer's runner differs from the hosted Control in what it starts (#854, R1b).

The hosted Control runs the agent, the reader and the setup container under the `sysbox-runc`
runtime that the golden snapshot proved, and the agent has its own Docker. A runner on a customer's
machine may have no Sysbox (decision 3: the agent's own Docker is a capability a runner announces
when its self-test proved it, not part of the base). Without it the containers run under the
daemon's default runtime, `runc`, as an ordinary unprivileged container (no `--privileged`, no
mounts of the host, no socket), and the image's init, which starts the inner Docker, is replaced by
one that only says the container is ready: the agent works, without a Docker of its own.

The runner service names its choice in four variables of the job process's environment. They are
the host's own finding (`factory_runner/service.py` decides them from the daemon and the
configuration); nothing in a job sets them. Unset, everything is as hosted.

- `RUNNER_IMPLEMENTER_AGENT_RUNTIME`: the runtime of the agent, the reader and the setup container
  (default `sysbox-runc`).
- `RUNNER_IMPLEMENTER_AGENT_CPUS`: the CPUs the agent's container and the setup container may use,
  a whole number (default: no limit).

and a fourth, `RUNNER_IMPLEMENTER_RUNNER_ID` (`role_labels.py`): the runner's id, which every
container and network of the job carries as a label so that the runner removes only its own.

A VM on a customer's machine has one more, `RUNNER_OUTER_PROXY` (#994, `outer_proxy.py`): the host's
outer-wall proxy, the VM's only way to the internet. It is not one of the names above: Control sets
it itself for the job process, from the start vm-init read (`job_loop/host.py`), and the container's
own environment cannot. Every client of the job process that dials the internet reads it here:
`git`, the model door, the network door and the Setup container. Unset, all of them dial as hosted.
"""

from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Final

from ..job import JobError
from ..outer_proxy import OuterProxy, OuterProxyError, outer_proxy_of
from ..result import ErrorCode
from .agent_container import AGENT_IMAGE_REFERENCE, AGENT_RUNTIME, AgentSeams
from .door_launcher import DoorSeams
from .netdoor_launcher import NetDoorSeams
from .placement import HOSTED, PLACEMENT_NAMES, SPLIT_RUNTIME, Placement, placement_of
from .reader import ReaderSeams
from .role_labels import RUNNER_ID_VARIABLE
from .setup_container import SetupSeams

AGENT_RUNTIME_VARIABLE: Final = "RUNNER_IMPLEMENTER_AGENT_RUNTIME"
AGENT_CPUS_VARIABLE: Final = "RUNNER_IMPLEMENTER_AGENT_CPUS"
RUNNER_PROFILE_NAMES: Final[tuple[str, ...]] = (
    AGENT_RUNTIME_VARIABLE,
    AGENT_CPUS_VARIABLE,
    RUNNER_ID_VARIABLE,
    # #1017: where the Incus backend's containers live (`placement.py`).
    *PLACEMENT_NAMES,
)
# Under a runtime without Sysbox the image's init (which starts the inner `dockerd`) is replaced by
# one that only says it is ready. The same entry point the test lane uses.
READY_ONLY_ENTRYPOINT: Final[tuple[str, ...]] = (
    "/usr/bin/tini",
    "--",
    "/bin/sh",
    "-c",
    "mkdir -p /run && touch /run/agent-ready && exec sleep infinity",
)
_NANO = 1_000_000_000


def runtime_of(environment: Mapping[str, str]) -> str:
    """The runtime of the agent, the reader and the setup. On the Incus backend (`placement.py`)
    there is no Sysbox in B, so it is `runc` and the containers are privileged (they run their own
    Docker)."""
    given = environment.get(AGENT_RUNTIME_VARIABLE, "").strip()
    if given:
        return given
    return SPLIT_RUNTIME if placement_of(environment).split else AGENT_RUNTIME


def entrypoint_for(runtime: str, placement: Placement = HOSTED) -> Sequence[str] | None:
    """The agent's entry point: the image's own under Sysbox (and in B, where the container is
    privileged and starts its own Docker), the ready-only one otherwise."""
    return None if runtime == AGENT_RUNTIME or placement.split else READY_ONLY_ENTRYPOINT


def nano_cpus_of(environment: Mapping[str, str]) -> int:
    raw = environment.get(AGENT_CPUS_VARIABLE, "").strip()
    return int(raw) * _NANO if raw.isascii() and raw.isdigit() else 0


def agent_seams(environment: Mapping[str, str], base: AgentSeams = AgentSeams()) -> AgentSeams:  # noqa: B008
    runtime = runtime_of(environment)
    placement = placement_of(environment)
    return replace(
        base,
        runtime=runtime,
        entrypoint=entrypoint_for(runtime, placement),
        nano_cpus=nano_cpus_of(environment),
        placement=placement,
        api=placement.environment_api if placement.split else base.api,
    )


def outer_proxy_for_job(environment: Mapping[str, str]) -> OuterProxy | None:
    """The outer wall's proxy Control gave this job process, or None (hosted, or a machine without
    the proxy wall). A value that is set and is not an address of the slots' network ends the turn
    `setup_failed`, free, before anything is started: a process told to use a proxy never dials
    directly because it could not read which one."""
    try:
        return outer_proxy_of(environment)
    except OuterProxyError as error:
        raise JobError(ErrorCode.SETUP_FAILED, f"outer_proxy_invalid: {error}") from None


def setup_seams(environment: Mapping[str, str], base: SetupSeams = SetupSeams()) -> SetupSeams:  # noqa: B008
    runtime = runtime_of(environment)
    placement = placement_of(environment)
    return replace(
        base,
        runtime=runtime,
        entrypoint=entrypoint_for(runtime, placement),
        nano_cpus=nano_cpus_of(environment),
        outer_proxy=outer_proxy_for_job(environment) or base.outer_proxy,
        placement=placement,
        api=placement.environment_api if placement.split else base.api,
        # The walls of B's networks are the NICs of the instances, not rules of ours.
        install_rules=base.install_rules and not placement.split,
    )


def door_seams(environment: Mapping[str, str], base: DoorSeams) -> DoorSeams:
    """The model door's seams with the host's proxy, when this job process has one."""
    proxy = outer_proxy_for_job(environment)
    placement = placement_of(environment)
    if proxy is None and placement == base.placement:
        return base
    return replace(base, outer_proxy=proxy or base.outer_proxy, placement=placement)


def netdoor_seams(environment: Mapping[str, str], base: NetDoorSeams) -> NetDoorSeams:
    """The network door's seams with the host's proxy, when this job process has one."""
    proxy = outer_proxy_for_job(environment)
    placement = placement_of(environment)
    if proxy is None and placement == base.placement:
        return base
    return replace(base, outer_proxy=proxy or base.outer_proxy, placement=placement)


def reader_seams(environment: Mapping[str, str], base: ReaderSeams = ReaderSeams()) -> ReaderSeams:  # noqa: B008
    placement = placement_of(environment)
    return replace(
        base,
        runtime=runtime_of(environment),
        placement=placement,
        api=placement.environment_api if placement.split else base.api,
        # B has the agent's golden image, not the Worker image the hosted readers are made from.
        image=base.image or (AGENT_IMAGE_REFERENCE if placement.split else ""),
    )
