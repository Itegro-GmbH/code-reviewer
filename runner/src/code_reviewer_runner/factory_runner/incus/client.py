# SPDX-License-Identifier: LicenseRef-Proprietary

"""The client of the `incus` program (#1007): everything the launcher asks of Incus, as methods, so
that the launcher's tests run against a fake and no test needs Incus.

The real one runs the `incus` command line as the service's own user (a member of `incus-admin`,
which is root-equivalent: documented in `docs/runner.md`). Three rules that the spike (#1005) found:

* **`incus init` and `incus launch` read an instance config from stdin when it is not a terminal and
  wait for its end**, so a pipe that never closes hangs them forever. Every call that is not an
  `exec` with input starts with stdin closed (`/dev/null`); an `exec` with input gets exactly the
  bytes and then end of file.
* **The environment is bare** (`PATH` and `HOME`): the dispatcher's own environment holds its
  credential and `incus` needs none of it. No argument ever carries a secret, so what `incus` prints
  on a failure is safe to log.
* **Every call has a limit of time**; one that runs over is killed and is an `IncusError`.
"""

import asyncio
import contextlib
import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, Protocol, cast

# What an `incus exec` keeps of its output: the end of it (the log tail of a failed job).
STDOUT_KEEP_BYTES: Final = 64 * 1024
STDERR_KEEP_BYTES: Final = 16 * 1024
_READ_CHUNK: Final = 64 * 1024
# The part of a failed call's own error output that an `IncusError` carries.
_ERROR_KEEP_BYTES: Final = 2000


class IncusError(Exception):
    """A call to Incus failed. `operation` names it (`init`, `delete`, ...) and `detail` is what
    `incus` printed, cut short; neither holds a value of a job."""

    def __init__(self, operation: str, detail: str, *, not_found: bool = False) -> None:
        super().__init__(f"incus {operation} failed: {detail}" if detail else f"incus {operation}")
        self.operation = operation
        self.detail = detail
        self.not_found = not_found


@dataclass(frozen=True)
class InstanceSpec:
    """An instance to create: from the image, on the pool, with the config and devices given and
    **no profile**: the `default` profile (and its network) is never applied."""

    name: str
    image: str
    pool: str
    config: Mapping[str, str] = field(default_factory=dict[str, str])
    # Size of the root disk in GiB: the quota (it counts what the instance shares with its image).
    disk_gib: int | None = None


@dataclass(frozen=True)
class InstanceInfo:
    name: str
    status: str
    config: Mapping[str, str]


@dataclass(frozen=True)
class ExecResult:
    """How an `incus exec` ended. `exit_code` is the command's (`incus` passes it on; a signal is
    128 plus its number); `stdout` and `stderr` are the ends of the two streams."""

    exit_code: int
    stdout: str = ""
    stderr: str = ""


class ExecProcess(Protocol):
    """A command running in an instance."""

    async def wait(self) -> ExecResult: ...

    async def kill(self) -> None:
        """End the command now (the local `incus exec` client is killed: the instance is deleted
        right after, and what runs in it dies with it)."""
        ...


class IncusClient(Protocol):
    async def version(self) -> str: ...

    async def pool_exists(self, pool: str) -> bool: ...

    async def image_exists(self, image: str) -> bool: ...

    async def network_exists(self, name: str) -> bool: ...

    async def create_network(self, name: str, config: Mapping[str, str]) -> None: ...

    async def delete_network(self, name: str) -> None: ...

    async def acl_exists(self, name: str) -> bool: ...

    async def create_acl(self, name: str, egress: Sequence[Mapping[str, str]]) -> None: ...

    async def delete_acl(self, name: str) -> None: ...

    async def create(self, spec: InstanceSpec) -> None: ...

    async def start(self, name: str) -> None: ...

    async def delete(self, name: str) -> None:
        """Delete the instance, stopping it first. An instance that is not there is deleted."""
        ...

    async def list_instances(self) -> list[InstanceInfo]: ...

    async def push_file(
        self, name: str, path: str, content: bytes, *, mode: str = "0644"
    ) -> None: ...

    async def add_device(self, name: str, device: str, config: Mapping[str, str]) -> None: ...

    async def remove_device(self, name: str, device: str) -> None: ...

    async def start_exec(
        self, name: str, argv: Sequence[str], *, stdin: bytes | None = None
    ) -> ExecProcess: ...


def _tail(raw: bytes, keep: int) -> str:
    return raw[-keep:].decode("utf-8", errors="replace")


async def _keep_end(stream: asyncio.StreamReader | None, keep: int) -> bytes:
    """Read a stream to its end and keep the last `keep` bytes of it."""
    if stream is None:
        return b""
    kept = bytearray()
    while chunk := await stream.read(_READ_CHUNK):
        kept += chunk
        del kept[:-keep]
    return bytes(kept)


class _CliExec:
    def __init__(self, process: asyncio.subprocess.Process, writer: "asyncio.Future[None] | None"):
        self._process = process
        self._writer = writer
        self._out = asyncio.ensure_future(_keep_end(process.stdout, STDOUT_KEEP_BYTES))
        self._err = asyncio.ensure_future(_keep_end(process.stderr, STDERR_KEEP_BYTES))

    async def wait(self) -> ExecResult:
        status = await self._process.wait()
        out, err = await asyncio.gather(self._out, self._err, return_exceptions=True)
        if self._writer is not None:
            await asyncio.gather(self._writer, return_exceptions=True)
        return ExecResult(
            128 - status if status < 0 else status,
            _tail(out if isinstance(out, bytes) else b"", STDOUT_KEEP_BYTES),
            _tail(err if isinstance(err, bytes) else b"", STDERR_KEEP_BYTES),
        )

    async def kill(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._process.kill()


class CliIncusClient:
    """The real client: the `incus` command line."""

    def __init__(self, program: str = "incus", *, call_seconds: float = 120.0) -> None:
        self._program = program
        self._call_seconds = call_seconds

    # -- the one way to run it ---

    @staticmethod
    def _environment() -> dict[str, str]:
        keep = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LC_ALL": "C.UTF-8"}
        if "HOME" in os.environ:
            keep["HOME"] = os.environ["HOME"]
        return keep

    async def _spawn(
        self, argv: Sequence[str], *, stdin: bytes | None
    ) -> asyncio.subprocess.Process:
        return await asyncio.create_subprocess_exec(
            self._program,
            *argv,
            # Closed unless the call has input: `init` and `launch` wait for the end of a stdin
            # that is not a terminal (#1005).
            stdin=asyncio.subprocess.DEVNULL if stdin is None else asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self._environment(),
        )

    async def _run(
        self,
        operation: str,
        argv: Sequence[str],
        *,
        stdin: bytes | None = None,
        check: bool = True,
    ) -> ExecResult:
        process = await self._spawn(argv, stdin=stdin)
        writer = asyncio.ensure_future(_feed(process, stdin)) if stdin is not None else None
        try:
            async with asyncio.timeout(self._call_seconds):
                out, err = await asyncio.gather(
                    _keep_end(process.stdout, STDOUT_KEEP_BYTES),
                    _keep_end(process.stderr, _ERROR_KEEP_BYTES),
                )
                status = await process.wait()
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()
            raise IncusError(operation, f"no answer in {self._call_seconds:g} s") from None
        finally:
            if writer is not None:
                writer.cancel()
                await asyncio.gather(writer, return_exceptions=True)
        result = ExecResult(status, _tail(out, STDOUT_KEEP_BYTES), _tail(err, _ERROR_KEEP_BYTES))
        if check and status != 0:
            detail = result.stderr.strip().splitlines()[-1:] or [f"exit status {status}"]
            raise IncusError(
                operation,
                detail[0],
                not_found="not found" in result.stderr.lower(),
            )
        return result

    # -- the server ---

    async def version(self) -> str:
        return (await self._run("version", ["--version"])).stdout.strip()

    async def pool_exists(self, pool: str) -> bool:
        return (
            await self._run("storage show", ["storage", "show", pool], check=False)
        ).exit_code == 0

    async def image_exists(self, image: str) -> bool:
        return (await self._run("image info", ["image", "info", image], check=False)).exit_code == 0

    async def network_exists(self, name: str) -> bool:
        return (
            await self._run("network show", ["network", "show", name], check=False)
        ).exit_code == 0

    async def create_network(self, name: str, config: Mapping[str, str]) -> None:
        await self._run(
            "network create", ["network", "create", name, *(f"{k}={v}" for k, v in config.items())]
        )

    async def delete_network(self, name: str) -> None:
        await self._run_tolerating_missing("network delete", ["network", "delete", name])

    async def acl_exists(self, name: str) -> bool:
        return (
            await self._run("network acl show", ["network", "acl", "show", name], check=False)
        ).exit_code == 0

    async def create_acl(self, name: str, egress: Sequence[Mapping[str, str]]) -> None:
        await self._run("network acl create", ["network", "acl", "create", name])
        for rule in egress:
            await self._run(
                "network acl rule add",
                [
                    "network",
                    "acl",
                    "rule",
                    "add",
                    name,
                    "egress",
                    *(f"{k}={v}" for k, v in rule.items()),
                ],
            )

    async def delete_acl(self, name: str) -> None:
        await self._run_tolerating_missing("network acl delete", ["network", "acl", "delete", name])

    async def _run_tolerating_missing(self, operation: str, argv: Sequence[str]) -> None:
        try:
            await self._run(operation, argv)
        except IncusError as error:
            if not error.not_found:
                raise

    # -- instances ---

    async def create(self, spec: InstanceSpec) -> None:
        argv = ["init", spec.image, spec.name, "--no-profiles", "--storage", spec.pool]
        for key, value in spec.config.items():
            argv += ["--config", f"{key}={value}"]
        if spec.disk_gib is not None:
            argv += ["--device", f"root,size={spec.disk_gib}GiB"]
        await self._run("init", argv)

    async def start(self, name: str) -> None:
        await self._run("start", ["start", name])

    async def delete(self, name: str) -> None:
        await self._run_tolerating_missing("delete", ["delete", "--force", name])

    async def list_instances(self) -> list[InstanceInfo]:
        result = await self._run("list", ["list", "--format", "json"])
        try:
            document = cast("list[dict[str, Any]]", json.loads(result.stdout))
            return [
                InstanceInfo(
                    str(entry["name"]),
                    str(entry.get("status", "")),
                    {str(k): str(v) for k, v in dict(entry.get("config") or {}).items()},
                )
                for entry in document
            ]
        except (ValueError, KeyError, TypeError, AttributeError):
            raise IncusError("list", "the answer is not a list of instances") from None

    async def push_file(self, name: str, path: str, content: bytes, *, mode: str = "0644") -> None:
        await self._run(
            "file push", ["file", "push", "--create-dirs", "--mode", mode, "-", f"{name}{path}"], stdin=content
        )

    async def add_device(self, name: str, device: str, config: Mapping[str, str]) -> None:
        await self._run(
            "config device add",
            ["config", "device", "add", name, device, *(f"{k}={v}" for k, v in config.items())],
        )

    async def remove_device(self, name: str, device: str) -> None:
        await self._run("config device remove", ["config", "device", "remove", name, device])

    async def start_exec(
        self, name: str, argv: Sequence[str], *, stdin: bytes | None = None
    ) -> ExecProcess:
        process = await self._spawn(
            ["exec", name, "--force-noninteractive", "--", *argv], stdin=stdin
        )
        writer = asyncio.ensure_future(_feed(process, stdin)) if stdin is not None else None
        return _CliExec(process, writer)


async def _feed(process: asyncio.subprocess.Process, data: bytes | None) -> None:
    """Write the input of a call and close the pipe: the end of file is what lets the command
    go on."""
    stdin = process.stdin
    if stdin is None or data is None:
        return
    try:
        stdin.write(data)
        await stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        with contextlib.suppress(Exception):
            stdin.close()
            await stdin.wait_closed()


async def run_exec(
    client: IncusClient,
    name: str,
    argv: Sequence[str],
    *,
    stdin: bytes | None = None,
    timeout: float,
) -> ExecResult:
    """A command in an instance to its end, within `timeout` seconds (killed after that: exit code
    -9 and no output)."""
    process = await client.start_exec(name, argv, stdin=stdin)
    try:
        async with asyncio.timeout(timeout):
            return await process.wait()
    except TimeoutError:
        await process.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(process.wait(), 5.0)
        return ExecResult(-9, "", "timeout")
