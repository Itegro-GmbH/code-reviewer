# SPDX-License-Identifier: LicenseRef-Proprietary

"""The limits a runner works within, as far as R1b enforces them (#854, plan decision 8).

What is enforced now, on the containers the runner starts through the host's Docker:

* **Memory.** The agent's container gets `Memory` and `MemorySwap` of the same size
  (`agent_container.agent_document`), so the kernel kills it when it grows past the limit and
  the host never swaps for it. With no limit configured the agent gets 60% of the machine's memory
  (at most 16 GiB). Below `MIN_AGENT_MEMORY_MB` the agent's container is not worth starting
  (OpenCode and the tools of a repository's tests do not fit, measured on the hosted VMs): the
  runner then reports itself not ready instead of failing every job.
* **CPUs.** `NanoCpus` on the agent's container.
* **One run at a time.** The containers of a turn have fixed names and the model network a fixed
  address, so one daemon runs one turn.

Not enforced yet (R2): a disk budget for the work volume and the session volumes with cleanup (the
configured `diskGb` is announced to the app and checked against the free space at start only),
limits for the containers beside the agent (the reader, the doors), and more than one run at a
time.
"""

from collections.abc import Mapping
from pathlib import Path

from code_reviewer_runner.factory_runner.config import Limits
from code_reviewer_runner.implementer.job_run import MIN_AGENT_MEMORY_MB
from code_reviewer_runner.implementer.runner_profile import AGENT_CPUS_VARIABLE

MEMINFO = "/proc/meminfo"
DEFAULT_MEMORY_SHARE = 0.6
MAX_DEFAULT_MEMORY_MB = 16 * 1024


class LimitsError(Exception):
    """A configured limit cannot work. The message says which and why, with no value."""


def machine_memory_mb(meminfo: str = MEMINFO) -> int:
    """`MemTotal` of the machine in MiB, 0 when it cannot be read."""
    try:
        text = Path(meminfo).read_text(encoding="ascii", errors="replace")
    except OSError:
        return 0
    for line in text.splitlines():
        if line.startswith("MemTotal:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1]) // 1024
    return 0


def agent_memory_mb(limits: Limits, *, machine_mb: int) -> int:
    """The memory of the agent's container in MiB. Raises `LimitsError` when it would be too small
    to work."""
    if limits.memory_mb is not None:
        memory = limits.memory_mb
    else:
        memory = min(int(machine_mb * DEFAULT_MEMORY_SHARE), MAX_DEFAULT_MEMORY_MB)
    if memory < MIN_AGENT_MEMORY_MB:
        raise LimitsError(
            f"the agent's container gets less than {MIN_AGENT_MEMORY_MB} MB of memory "
            "(raise memoryMb, or run on a machine with more memory)"
        )
    return memory


def agent_environment(limits: Limits) -> Mapping[str, str]:
    """The limits as the variables of the job process (`implementer/runner_profile.py`)."""
    return {} if limits.cpus is None else {AGENT_CPUS_VARIABLE: str(limits.cpus)}
