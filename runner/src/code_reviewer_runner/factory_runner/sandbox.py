# SPDX-License-Identifier: LicenseRef-Proprietary

"""How the local dispatcher starts a Worker (#974, Runner v2): the start hand-over and the sandbox.

The dispatcher claims a job and gets the id and the credential of its Worker, nothing else. It hands
the Worker `{appUrl, jobId, credential}` on its standard input (`WorkerStart`) and, when the job
asks for a credential that exists only on this device (a Claude Code subscription), that one
credential too (`localEnvironment`): never through the app, never in an argument or in the
environment of the dispatcher. The Worker fetches the job itself over the Worker API
(`/api/workers/v1`), so the git token and the key of the workspace are only ever in the Worker and
the containers it starts.

`WorkerSandbox` is the seam: start a Worker where it runs, wait for its exit, stop it. The
Firecracker launcher (#978, `firecracker/launcher.py`) runs it in a microVM, one per slot.
`ProcessSandbox`, the fallback until #982, starts the Worker as a process of the runner's own
container (the image is the Worker image) on the host's Docker, with an environment made for it: the
plain variables and the ones that say how its containers are made, never the runner's credential.
"""

import json
import sys
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final, Protocol

from code_reviewer_runner.job_loop.process import (
    ProcessLauncher,
    ProcessSpec,
    RunningProcess,
)

# What `python -m` runs for a Worker the dispatcher starts (`local_worker.py`).
WORKER_MODULE: Final = "code_reviewer_runner.factory_runner.local_worker"
# What a Worker's stdout may hold at most: nothing is expected, the result goes to the app.
_STDOUT_KEEP_BYTES: Final = 4 * 1024


@dataclass(frozen=True)
class WorkerStart:
    """The hand-over to a Worker: where the app is, which job, the credential of its claim and, for
    a job that needs one, the credential of this device (`localEnvironment`, as the variables the
    job reads). Nothing here is printed: `repr` shows the job."""

    app_url: str
    job_id: str
    credential: str = field(repr=False)
    local_environment: Mapping[str, str] = field(default_factory=dict[str, str], repr=False)

    def document(self) -> bytes:
        """The start document of the Worker (`worker.parse_request`; `localEnvironment` is read by
        `local_worker` and ignored by a hosted Worker)."""
        document: dict[str, object] = {
            "appUrl": self.app_url,
            "jobId": self.job_id,
            "credential": self.credential,
        }
        if self.local_environment:
            document["localEnvironment"] = dict(self.local_environment)
        return json.dumps(document, separators=(",", ":")).encode("ascii")


@dataclass(frozen=True)
class WorkerOutcome:
    """How a Worker ended: its exit code (negative: the signal) and the end of what it logged (its
    own log lines, masked by the Worker; never a value of the job)."""

    exit_code: int
    log_tail: str


class SandboxInUse(Exception):
    """Another dispatcher of this machine holds the sandbox (its VMs, its cgroups, its slots). The
    message is for the log: it names no path and no value."""


class RunningWorker(Protocol):
    async def wait(self) -> WorkerOutcome: ...

    async def stop(self) -> None:
        """End the Worker: it is asked to stop (it gives the job back, `runner_shutdown`) and killed
        when it does not within its grace."""
        ...


class WorkerSandbox(Protocol):
    @property
    def capacity(self) -> int:
        """The Workers that may run at once (the dispatcher claims only with a free one)."""
        ...

    @property
    def free(self) -> int:
        """The Workers that can be started now: `capacity` less the slots that are in use or out of
        use (a VMM that would not die keeps its slot). The dispatcher claims only when this is
        above zero: a job it cannot start is a job that loses an attempt."""
        ...

    @property
    def uses_host_docker(self) -> bool:
        """Whether the Worker's containers run on this machine's Docker (the dispatcher then
        takes the lock on the daemon and tidies it). A VM sandbox has its own Docker inside."""
        ...

    async def setup(self) -> None:
        """Before the first claim: whatever the sandbox must find or make clean (a VM sandbox
        removes the leftovers of an earlier service). Raises when the sandbox cannot be used."""
        ...

    async def start(self, start: WorkerStart) -> RunningWorker: ...

    async def close(self) -> None:
        """After the last Worker ended (or when the run could not begin): let go of what `setup`
        took. Never raises."""
        ...


class _ProcessWorker:
    def __init__(self, process: RunningProcess) -> None:
        self._process = process

    async def wait(self) -> WorkerOutcome:
        outcome = await self._process.wait()
        return WorkerOutcome(
            exit_code=outcome.exit_code,
            log_tail=outcome.stderr.decode("utf-8", errors="replace"),
        )

    async def stop(self) -> None:
        await self._process.terminate()


class ProcessSandbox:
    """The Worker as a process of the runner's own container, on the host's Docker (what it was
    before the Firecracker launcher): `python -m
    code_reviewer_runner.factory_runner.local_worker`, the start document on its standard input
    and an environment of its own."""

    def __init__(
        self,
        launcher: ProcessLauncher,
        environment: Mapping[str, str],
        *,
        grace_seconds: float,
    ) -> None:
        self._launcher = launcher
        self._environment = dict(environment)
        self._grace = grace_seconds

    capacity = 1
    # The dispatcher runs one Worker at a time here (one slot), so a free one is always there when
    # it asks.
    free = 1
    uses_host_docker = True

    async def setup(self) -> None:
        """A process of this container needs nothing made."""

    async def close(self) -> None:
        """Nothing was taken."""

    async def start(self, start: WorkerStart) -> RunningWorker:
        spec = ProcessSpec(
            argv=(sys.executable, "-m", WORKER_MODULE),
            env=self._environment,
            stdin=start.document(),
            stdout_keep_bytes=_STDOUT_KEEP_BYTES,
            terminate_grace=self._grace,
        )
        return _ProcessWorker(await self._launcher.start(spec))
