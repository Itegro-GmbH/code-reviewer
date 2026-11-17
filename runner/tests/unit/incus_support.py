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
    AclInfo,
    ExecResult,
    IncusError,
    InstanceInfo,
    InstanceSpec,
    NetworkInfo,
)
from code_reviewer_runner.factory_runner.incus.launcher import IncusSandbox
from code_reviewer_runner.factory_runner.incus.provision import (
    INNER_NETWORK_CONFIG,
    outer_acl_rules,
    outer_network_config,
)
from code_reviewer_runner.factory_runner.incus.settings import IncusSettings
from code_reviewer_runner.factory_runner.incus.slots import IncusSlot
from code_reviewer_runner.factory_runner.incus.walls import INNER_WALL_PATH
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

    def __init__(self, settings: IncusSettings | None = None, *, pool: str = "pool") -> None:
        settings = settings or IncusSettings(pool=pool, image_id=IMAGE_ID)
        self.instances: dict[str, FakeInstance] = {}
        self.foreign: dict[str, InstanceInfo] = {}
        self.pools = {settings.pool}
        self.images = {"code-reviewer-golden"}
        # The properties an image of the pool carries (`build-golden.sh` records the harnesses).
        self.image_properties_of: dict[str, dict[str, str]] = {}
        self.networks: set[str] = set()
        self.network_configs: dict[str, dict[str, str]] = {}
        self.network_types: dict[str, str] = {}
        self.acls: dict[str, list[Mapping[str, str]]] = {}
        self.calls: list[tuple[str, ...]] = []
        self.fail: dict[str, IncusError] = {}
        self.responder: Responder | None = None
        self.controls: list[FakeExec] = []
        self.control_created = asyncio.Event()
        self.provision(settings)

    def provision(self, settings: IncusSettings) -> "FakeIncus":
        """The bridges and ACLs of the settings' slots, as `provision.py` makes them."""
        for index in range(settings.slots):
            slot = IncusSlot(index, settings.slot_network)
            outer, inner = settings.outer_network(index), settings.inner_network(index)
            self.networks |= {outer, inner}
            self.network_configs[outer] = dict(outer_network_config(slot, outer))
            self.network_configs[inner] = dict(INNER_NETWORK_CONFIG)
            self.acls[outer] = list(outer_acl_rules(slot))
        return self

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

    async def image_properties(self, image: str) -> Mapping[str, str] | None:
        self._note("image_properties")
        if image not in self.images:
            return None
        return dict(self.image_properties_of.get(image, {}))

    async def network_exists(self, name: str) -> bool:
        return name in self.networks

    async def network_info(self, name: str) -> NetworkInfo | None:
        if name not in self.networks:
            return None
        return NetworkInfo(
            self.network_types.get(name, "bridge"), dict(self.network_configs.get(name, {}))
        )

    async def create_network(self, name: str, config: Mapping[str, str]) -> None:
        self._note("create_network", name)
        self.networks.add(name)
        self.network_configs[name] = dict(config)

    async def delete_network(self, name: str) -> None:
        self._note("delete_network", name)
        self.networks.discard(name)
        self.network_configs.pop(name, None)

    async def acl_exists(self, name: str) -> bool:
        return name in self.acls

    async def acl_info(self, name: str) -> AclInfo | None:
        if name not in self.acls:
            return None
        return AclInfo(ingress=(), egress=tuple(self.acls[name]))

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
        if argv[:4] == ("nft", "list", "table", "inet"):
            # What `nft -f` loaded (the real listing leaves out the comments and says the priority
            # in words; the rules are the same).
            return _Done(
                ExecResult(0, self.instances[name].files.get(INNER_WALL_PATH, b"").decode())
            )
        if argv[:3] == ("ip", "-4", "-o"):
            # What systemd-networkd would have applied from the files pushed before the start.
            return _Done(ExecResult(0, _addresses_of(self.instances[name])))
        if argv[:3] == ("docker", "image", "inspect"):
            return _Done(ExecResult(0, IMAGE_ID + "\n"))
        return _Done(ExecResult(0))


def _addresses_of(instance: FakeInstance) -> str:
    lines: list[str] = []
    for path, content in instance.files.items():
        if path.startswith("/etc/systemd/network/"):
            address = next(
                line.removeprefix("Address=")
                for line in content.decode().splitlines()
                if line.startswith("Address=")
            )
            lines.append(f"2: eth: inet {address} scope global eth")
    return "\n".join(lines) + "\n"


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
        self.incus = FakeIncus(self.settings)
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
