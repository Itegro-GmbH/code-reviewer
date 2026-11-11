# SPDX-License-Identifier: LicenseRef-Proprietary

"""Doubles for the tests of the Incus launcher (not a test file): a fake Incus (`FakeIncus`) that
keeps instances, devices and files and answers `exec` from a table, a wall that records, and a rig
with a short state directory (a Unix socket path holds at most 107 bytes)."""

import asyncio
import shutil
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from code_reviewer_runner.factory_runner.firecracker.wire import Refusal, encode_frame, read_frame
from code_reviewer_runner.factory_runner.incus.client import (
    ExecResult,
    IncusError,
    InstanceInfo,
    InstanceSpec,
)
from code_reviewer_runner.factory_runner.incus.launcher import IncusSandbox
from code_reviewer_runner.factory_runner.incus.settings import IncusSettings
from code_reviewer_runner.factory_runner.sandbox import WorkerStart
from code_reviewer_runner.job_loop.local_credential import LocalCredential

CREDENTIAL = "crj_credential-that-must-never-leak-0123456789"
LOCAL_CREDENTIAL = "local-credential-that-must-never-leak-0123456789"
IMAGE_ID = "sha256:" + "ab" * 32
TOKEN = "t" * 43


def start_for(
    number: int = 1, *, local: bool = False, app_url: str = "http://10.99.0.1"
) -> WorkerStart:
    return WorkerStart(
        app_url,
        f"00000000-0000-4000-8000-{number:012d}",
        CREDENTIAL,
        LocalCredential("CLAUDE_CODE_OAUTH_TOKEN", LOCAL_CREDENTIAL) if local else None,
    )


class short_directory:
    """A short temporary directory, removed on exit."""

    def __enter__(self) -> Path:
        self._path = Path(tempfile.mkdtemp(prefix="inc"))
        return self._path

    def __exit__(self, *_: object) -> None:
        shutil.rmtree(self._path, ignore_errors=True)


@dataclass
class FakeInstance:
    spec: InstanceSpec
    devices: dict[str, dict[str, str]] = field(default_factory=dict[str, dict[str, str]])
    files: dict[str, bytes] = field(default_factory=dict[str, bytes])
    running: bool = False


class FakeExec:
    """A command that runs until the test (or a kill) ends it."""

    def __init__(self, name: str, argv: Sequence[str], stdin: bytes | None) -> None:
        self.name, self.argv, self.stdin = name, tuple(argv), stdin
        self.killed = False
        self._done = asyncio.Event()
        self._result = ExecResult(0)

    def finish(self, exit_code: int = 0, stderr: str = "", stdout: str = "") -> None:
        self._result = ExecResult(exit_code, stdout, stderr)
        self._done.set()

    async def wait(self) -> ExecResult:
        await self._done.wait()
        return self._result

    async def kill(self) -> None:
        self.killed = True
        self.finish(-9)


Responder = Callable[[str, tuple[str, ...]], ExecResult | None]


class FakeIncus:
    """What the launcher asks of Incus, in memory. `calls` is the order of everything it was asked;
    `fail` makes an operation raise; `responder` answers a command in an instance (None: the
    default, which makes the instance look healthy)."""

    def __init__(self, *, slots: int = 1, prefix: str = "cr", pool: str = "pool") -> None:
        self.instances: dict[str, FakeInstance] = {}
        self.foreign: dict[str, InstanceInfo] = {}
        self.pools = {pool}
        self.images = {"code-reviewer-golden"}
        self.networks: set[str] = set()
        self.acls: dict[str, list[Mapping[str, str]]] = {}
        self.calls: list[tuple[str, ...]] = []
        self.fail: dict[str, IncusError] = {}
        self.responder: Responder | None = None
        self.controls: list[FakeExec] = []
        self.control_created = asyncio.Event()
        for index in range(slots):
            self.networks |= {f"{prefix}-out{index}", f"{prefix}-in{index}"}

    def _note(self, *call: str) -> None:
        self.calls.append(call)
        key = call[0]
        if key in self.fail:
            raise self.fail[key]

    # -- objects ---

    async def version(self) -> str:
        self._note("version")
        return "7.6"

    async def pool_exists(self, pool: str) -> bool:
        return pool in self.pools

    async def image_exists(self, image: str) -> bool:
        return image in self.images

    async def network_exists(self, name: str) -> bool:
        return name in self.networks

    async def create_network(self, name: str, config: Mapping[str, str]) -> None:
        self._note("create_network", name)
        self.networks.add(name)

    async def delete_network(self, name: str) -> None:
        self._note("delete_network", name)
        self.networks.discard(name)

    async def acl_exists(self, name: str) -> bool:
        return name in self.acls

    async def create_acl(self, name: str, egress: Sequence[Mapping[str, str]]) -> None:
        self._note("create_acl", name)
        self.acls[name] = list(egress)

    async def delete_acl(self, name: str) -> None:
        self._note("delete_acl", name)
        self.acls.pop(name, None)

    # -- instances ---

    async def create(self, spec: InstanceSpec) -> None:
        self._note("create", spec.name)
        self.instances[spec.name] = FakeInstance(spec)

    async def start(self, name: str) -> None:
        self._note("start", name)
        self.instances[name].running = True

    async def delete(self, name: str) -> None:
        self._note("delete", name)
        self.instances.pop(name, None)

    async def list_instances(self) -> list[InstanceInfo]:
        return [
            *(InstanceInfo(n, "Running", dict(i.spec.config)) for n, i in self.instances.items()),
            *self.foreign.values(),
        ]

    async def push_file(self, name: str, path: str, content: bytes, *, mode: str = "0644") -> None:
        self._note("push_file", name, path)
        self.instances[name].files[path] = content

    async def add_device(self, name: str, device: str, config: Mapping[str, str]) -> None:
        self._note("add_device", name, device)
        self.instances[name].devices[device] = dict(config)

    async def remove_device(self, name: str, device: str) -> None:
        self._note("remove_device", name, device)
        del self.instances[name].devices[device]

    async def start_exec(
        self, name: str, argv: Sequence[str], *, stdin: bytes | None = None
    ) -> Any:
        self._note("exec", name, *argv)
        if name not in self.instances:
            return _Done(ExecResult(1, "", "Instance not found"))
        argv = tuple(argv)
        if argv[:2] == ("docker", "run"):
            control = FakeExec(name, argv, stdin)
            self.controls.append(control)
            self.control_created.set()
            return control
        if self.responder is not None:
            answer = self.responder(name, argv)
            if answer is not None:
                return _Done(answer)
        if argv[:3] == ("docker", "image", "inspect"):
            return _Done(ExecResult(0, IMAGE_ID + "\n"))
        return _Done(ExecResult(0))


class _Done:
    def __init__(self, result: ExecResult) -> None:
        self._result = result

    async def wait(self) -> ExecResult:
        return self._result

    async def kill(self) -> None: ...


class RecordingWall:
    """An outer wall that holds what it is told and answers `narrow` as the test decides."""

    def __init__(
        self, narrow: Refusal | None = None, sink: list[tuple[str, ...]] | None = None
    ) -> None:
        self.events: list[tuple[str, str]] = []
        self.answer = narrow
        # Where `admit` is also noted, to see its place among the calls to Incus.
        self.sink = sink

    async def admit(self, vm: Any) -> None:
        self.events.append(("admit", vm.vm_id))
        if self.sink is not None:
            self.sink.append(("wall-admit",))

    async def narrow(self, vm: Any, message: Any) -> Refusal | None:
        self.events.append(("narrow", vm.vm_id))
        return self.answer

    async def forget(self, vm: Any) -> None:
        self.events.append(("forget", vm.vm_id))


class Rig:
    """A machine with a fake Incus."""

    def __init__(self, root: Path, **settings: Any) -> None:
        self.root = root
        values: dict[str, Any] = {
            "pool": "pool",
            "image_id": IMAGE_ID,
            "state_dir": root,
            "ready_seconds": 2.0,
        }
        values.update(settings)
        self.settings = IncusSettings(**values)
        self.incus = FakeIncus(slots=self.settings.slots, prefix=self.settings.prefix)
        self.wall = RecordingWall(sink=self.incus.calls)

    def sandbox(self, **changes: Any) -> IncusSandbox:
        values: dict[str, Any] = {"wall": self.wall, "new_token": lambda: TOKEN}
        values.update(changes)
        return IncusSandbox(self.settings, self.incus, **values)


async def ask(socket: Path, document: dict[str, Any]) -> dict[str, Any]:
    """One request of Control on the job's control socket: a frame in, a frame out."""
    reader, writer = await asyncio.open_unix_connection(str(socket))
    try:
        writer.write(encode_frame(document))
        await writer.drain()
        return await read_frame(reader, max_bytes=65536)
    finally:
        writer.close()
