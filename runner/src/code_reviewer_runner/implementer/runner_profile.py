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
- `RUNNER_IMPLEMENTER_AGENT_CPUS`: the CPUs the agent's container may use, a whole number (default:
  no limit).

and a fourth, `RUNNER_IMPLEMENTER_RUNNER_ID` (`role_labels.py`): the runner's id, which every
container and network of the job carries as a label so that the runner removes only its own.
"""

from collections.abc import Mapping, Sequence
from dataclasses import replace
from typing import Final

from .agent_container import AGENT_RUNTIME, AgentSeams
from .reader import ReaderSeams
from .role_labels import RUNNER_ID_VARIABLE
from .setup_container import SetupSeams

AGENT_RUNTIME_VARIABLE: Final = "RUNNER_IMPLEMENTER_AGENT_RUNTIME"
AGENT_CPUS_VARIABLE: Final = "RUNNER_IMPLEMENTER_AGENT_CPUS"
RUNNER_PROFILE_NAMES: Final[tuple[str, ...]] = (
    AGENT_RUNTIME_VARIABLE,
    AGENT_CPUS_VARIABLE,
    RUNNER_ID_VARIABLE,
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
    return environment.get(AGENT_RUNTIME_VARIABLE, "").strip() or AGENT_RUNTIME


def entrypoint_for(runtime: str) -> Sequence[str] | None:
    """The agent's entry point: the image's own under Sysbox, the ready-only one otherwise."""
    return None if runtime == AGENT_RUNTIME else READY_ONLY_ENTRYPOINT


def nano_cpus_of(environment: Mapping[str, str]) -> int:
    raw = environment.get(AGENT_CPUS_VARIABLE, "").strip()
    return int(raw) * _NANO if raw.isascii() and raw.isdigit() else 0


def agent_seams(environment: Mapping[str, str], base: AgentSeams = AgentSeams()) -> AgentSeams:  # noqa: B008
    runtime = runtime_of(environment)
    return replace(
        base,
        runtime=runtime,
        entrypoint=entrypoint_for(runtime),
        nano_cpus=nano_cpus_of(environment),
    )


def setup_seams(environment: Mapping[str, str], base: SetupSeams = SetupSeams()) -> SetupSeams:  # noqa: B008
    runtime = runtime_of(environment)
    return replace(base, runtime=runtime, entrypoint=entrypoint_for(runtime))


def reader_seams(environment: Mapping[str, str], base: ReaderSeams = ReaderSeams()) -> ReaderSeams:  # noqa: B008
    return replace(base, runtime=runtime_of(environment))
