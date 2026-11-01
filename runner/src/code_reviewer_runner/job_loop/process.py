# SPDX-License-Identifier: LicenseRef-Proprietary

"""One process per job: start it, bound what it can write, and end it together with its children.

The job goes in on stdin (never in the arguments, never in the environment), the result comes out
as the last line on stdout, diagnostics on stderr. Both streams are read continuously and only the
newest bytes are kept, so a process that writes hundreds of megabytes cannot grow the runner's
memory. The process is the leader of its own process group: ending a job ends the group, so a
helper the process started cannot outlive it.

The group is only ever signalled while its leader is still unreaped (`process_group.py`, #202): a
reaped leader frees its pid, and a later `killpg` could end an unrelated process group that was
given the same number. asyncio's subprocess reaps the child by itself the moment it exits, so the
process is a plain `subprocess.Popen` whose pipes are read through asyncio, and this module decides
when it is reaped (last, after the group is ended; #233).
"""

import asyncio
import contextlib
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Protocol

from code_reviewer_runner.lease_check import (
    LEASE_CHECK_FD_VARIABLE,
    QUESTION,
    LeaseState,
)
from code_reviewer_runner.process_group import end_group, has_exited
from code_reviewer_runner.supersede import SUPERSEDE_SIGNAL

# The result line of a job is small (a log tail of 4 KB and a few numbers). Anything above this
# is not a result.
JOB_WORKDIR_PREFIX = "cr-job-"
STDOUT_KEEP_BYTES = 256 * 1024
STDERR_KEEP_BYTES = 64 * 1024
_READ_CHUNK = 64 * 1024
# After the leader has exited, a helper that keeps a pipe open must not hold the job up.
_DRAIN_SECONDS = 2.0
# How often the leader is looked at (without reaping it) while the job runs.
_EXIT_POLL_SECONDS = 0.02


class StreamTail:
    """The newest `keep` bytes of a stream, in bounded memory."""

    def __init__(self, keep: int) -> None:
        self._keep = keep
        self._buffer = bytearray()
        self.total = 0
        self.peak = 0

    def add(self, chunk: bytes) -> None:
        self.total += len(chunk)
        self._buffer += chunk
        if len(self._buffer) > 2 * self._keep:
            del self._buffer[: len(self._buffer) - self._keep]
        self.peak = max(self.peak, len(self._buffer))

    def value(self) -> bytes:
        return bytes(self._buffer[-self._keep :])

    @property
    def truncated(self) -> bool:
        return self.total > self._keep


@dataclass(frozen=True)
class ProcessSpec:
    argv: tuple[str, ...]
    env: Mapping[str, str]
    stdin: bytes
    # (uid, gid) the process drops to, with no other group; None runs it as the loop's own user.
    # A runner whose loop is root (the Dynamic runner) uses it so that PR-Agent never runs as root.
    run_as: tuple[int, int] | None = None
    # #260: the loop's answer to "is this job still ours?". When set, the process is handed one
    # descriptor (`RUNNER_LEASE_CHECK_FD`) it can ask over; it holds no lease token itself.
    lease_check: Callable[[], Awaitable[LeaseState]] | None = None
    # How much of the end of its stdout is kept. The result line of an Implementer turn carries
    # its commits and files and can be megabytes; every other job prints a line of a few KB.
    stdout_keep_bytes: int = STDOUT_KEEP_BYTES
    # How long a terminated process may take before SIGKILL; the launcher's own when None. A turn of
    # the Implementer pushes its work inside it (#765).
    terminate_grace: float | None = None


@dataclass(frozen=True)
class ProcessOutcome:
    # The exit code; negative means the signal that ended the process.
    exit_code: int
    stdout: bytes
    stderr: bytes
    stdout_truncated: bool
    stderr_truncated: bool


class RunningProcess(Protocol):
    async def wait(self) -> ProcessOutcome: ...

    async def terminate(self) -> None:
        """End the process and everything it started: SIGTERM first, SIGKILL after the grace."""
        ...

    def notify_superseded(self) -> bool:
        """Tell the process that its run was superseded (#396): `SIGUSR1` to the leader only, never
        the group. False when the signal could not be sent (the process has ended, or the signal
        was refused): the caller logs it, and the drain bound is then the only stop."""
        ...


class ProcessLauncher(Protocol):
    async def start(self, spec: ProcessSpec) -> RunningProcess: ...


async def _connect_reader(
    loop: asyncio.AbstractEventLoop, pipe: IO[bytes]
) -> tuple[asyncio.StreamReader, asyncio.BaseTransport]:
    reader = asyncio.StreamReader(limit=_READ_CHUNK, loop=loop)
    transport, _ = await loop.connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader, loop=loop), pipe
    )
    return reader, transport


async def _connect_writer(loop: asyncio.AbstractEventLoop, pipe: IO[bytes]) -> asyncio.StreamWriter:
    transport, protocol = await loop.connect_write_pipe(
        lambda: asyncio.StreamReaderProtocol(asyncio.StreamReader(loop=loop), loop=loop), pipe
    )
    return asyncio.StreamWriter(transport, protocol, None, loop)


@dataclass(frozen=True)
class _Pipes:
    stdin: asyncio.StreamWriter
    stdout: asyncio.StreamReader
    stderr: asyncio.StreamReader
    transports: tuple[asyncio.BaseTransport, ...]

    def close(self) -> None:
        # A helper that keeps a pipe open would otherwise keep the descriptor open for good.
        for transport in self.transports:
            transport.close()


@dataclass(frozen=True)
class _LeaseChannel:
    """The loop's end of the descriptor pair a process asks "is this job still ours?" over."""

    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    check: Callable[[], Awaitable[LeaseState]]

    async def serve(self) -> None:
        try:
            while await self.reader.readline() == QUESTION:
                try:
                    state = await self.check()
                except Exception:
                    # Never "held" for an answer that could not be made.
                    state = LeaseState.UNCONFIRMED
                self.writer.write(state.value.encode("ascii") + b"\n")
                await self.writer.drain()
        except (ConnectionError, ValueError, asyncio.LimitOverrunError):
            pass  # the process went away, or sent something that is not the question

    def close(self) -> None:
        with contextlib.suppress(Exception):
            self.writer.close()


class _SubprocessJob:
    def __init__(
        self,
        process: subprocess.Popen[bytes],
        stdin: bytes,
        pipes: _Pipes,
        workdir: Path,
        terminate_grace: float,
        lease: _LeaseChannel | None = None,
        stdout_keep_bytes: int = STDOUT_KEEP_BYTES,
    ) -> None:
        self._process = process
        self._pipes = pipes
        self._lease = lease
        self._workdir = workdir
        self._terminate_grace = terminate_grace
        # Whoever ends the group holds it, so one cannot signal after the other has reaped.
        self._group_lock = threading.Lock()
        self._stdout = StreamTail(stdout_keep_bytes)
        self._stderr = StreamTail(STDERR_KEEP_BYTES)
        self._readers = [
            asyncio.create_task(self._write_stdin(stdin)),
            asyncio.create_task(self._read(pipes.stdout, self._stdout)),
            asyncio.create_task(self._read(pipes.stderr, self._stderr)),
        ]
        self._lease_server = asyncio.create_task(lease.serve()) if lease is not None else None
        self._collected = asyncio.create_task(self._collect())

    @property
    def streams(self) -> tuple[StreamTail, StreamTail]:
        return self._stdout, self._stderr

    async def _write_stdin(self, data: bytes) -> None:
        stream = self._pipes.stdin
        try:
            stream.write(data)
            await stream.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass  # the process ended before it read the job; its exit code says what happened
        finally:
            with contextlib.suppress(Exception):
                stream.close()

    @staticmethod
    async def _read(stream: asyncio.StreamReader, tail: StreamTail) -> None:
        while chunk := await stream.read(_READ_CHUNK):
            tail.add(chunk)

    def _end_group(self, grace: float) -> None:
        """End the group, then reap the leader. A no-op once the leader was reaped."""
        with self._group_lock:
            end_group(self._process, grace)

    async def _collect(self) -> ProcessOutcome:
        try:
            while not has_exited(self._process):
                await asyncio.sleep(_EXIT_POLL_SECONDS)
            # The leader is gone but not reaped, so its group id is still ours: whatever is left in
            # the group is a helper nobody waits for.
            await asyncio.to_thread(self._end_group, 0)
            _, pending = await asyncio.wait(self._readers, timeout=_DRAIN_SECONDS)
            for task in pending:
                task.cancel()
            await asyncio.gather(*self._readers, return_exceptions=True)
        finally:
            if self._lease_server is not None and self._lease is not None:
                self._lease_server.cancel()
                await asyncio.gather(self._lease_server, return_exceptions=True)
                self._lease.close()
            self._pipes.close()
            shutil.rmtree(self._workdir, ignore_errors=True)
        exit_code = self._process.returncode
        return ProcessOutcome(
            exit_code=1 if exit_code is None else exit_code,
            stdout=self._stdout.value(),
            stderr=self._stderr.value(),
            stdout_truncated=self._stdout.truncated,
            stderr_truncated=self._stderr.truncated,
        )

    async def wait(self) -> ProcessOutcome:
        return await asyncio.shield(self._collected)

    def notify_superseded(self) -> bool:
        # Under the lock that guards the end of the group, and only while the leader is unreaped: a
        # reaped leader frees its pid (#233).
        with self._group_lock:
            if has_exited(self._process):
                return False
            try:
                os.kill(self._process.pid, SUPERSEDE_SIGNAL)
            except (ProcessLookupError, PermissionError):
                return False
            return True

    async def terminate(self) -> None:
        # SIGTERM first and SIGKILL after the grace; also after a clean exit of the leader, so a
        # helper that ignores SIGTERM goes too.
        await asyncio.to_thread(self._end_group, self._terminate_grace)
        await self.wait()


class SubprocessLauncher:
    def __init__(self, terminate_grace: float = 5.0) -> None:
        self._terminate_grace = terminate_grace

    async def start(self, spec: ProcessSpec) -> RunningProcess:
        # A directory of its own per job: PR-Agent reads `[tool.pr-agent]` from a pyproject.toml in
        # its working directory, so that directory must hold nothing the runner did not put there.
        workdir = Path(tempfile.mkdtemp(prefix=JOB_WORKDIR_PREFIX))
        process: subprocess.Popen[bytes] | None = None
        # The unprivileged job user (a root loop only), with none of the loop's other groups.
        uid, gid = spec.run_as if spec.run_as is not None else (None, None)
        environment = dict(spec.env)
        # The two ends of the lease question (#260): the process gets one, the loop keeps the other.
        ends = socket.socketpair() if spec.lease_check is not None else None
        lease: _LeaseChannel | None = None
        try:
            if uid is not None and gid is not None:
                os.chown(workdir, uid, gid)
            pass_fds: tuple[int, ...] = ()
            if ends is not None:
                pass_fds = (ends[1].fileno(),)
                environment[LEASE_CHECK_FD_VARIABLE] = str(ends[1].fileno())
            # `SIGUSR1` (a run that was superseded) ends a process that has no handler yet. It is
            # blocked in this thread while the process is made: the mask survives the exec, a
            # signal that comes early stays pending, and the process unblocks it once its handler
            # exists (`supersede.handling_the_signal`).
            previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {SUPERSEDE_SIGNAL})
            try:
                process = subprocess.Popen(
                    spec.argv,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    env=environment,
                    cwd=workdir,
                    start_new_session=True,
                    pass_fds=pass_fds,
                    user=uid,
                    group=gid,
                    extra_groups=[] if uid is not None else None,
                )
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
            pipes = await _connect_pipes(process)
            if ends is not None and spec.lease_check is not None:
                ends[1].close()  # the process holds its end now
                reader, writer = await asyncio.open_connection(sock=ends[0])
                lease = _LeaseChannel(reader, writer, spec.lease_check)
        except BaseException:
            try:
                if process is not None:
                    await asyncio.shield(asyncio.to_thread(end_group, process, 0))
            finally:
                # Also when the start is cancelled a second time while the group is being ended.
                shutil.rmtree(workdir, ignore_errors=True)
                for end in ends or ():
                    end.close()
            raise
        return _SubprocessJob(
            process,
            spec.stdin,
            pipes,
            workdir,
            self._terminate_grace if spec.terminate_grace is None else spec.terminate_grace,
            lease,
            stdout_keep_bytes=spec.stdout_keep_bytes,
        )


async def _connect_pipes(process: subprocess.Popen[bytes]) -> _Pipes:
    stdin, stdout, stderr = process.stdin, process.stdout, process.stderr
    assert stdin is not None and stdout is not None and stderr is not None  # all three are PIPE
    loop = asyncio.get_running_loop()
    transports: list[asyncio.BaseTransport] = []
    try:
        out, out_transport = await _connect_reader(loop, stdout)
        transports.append(out_transport)
        err, err_transport = await _connect_reader(loop, stderr)
        transports.append(err_transport)
        writer = await _connect_writer(loop, stdin)
    except BaseException:
        # A failed start must not leave the files open until the garbage collector finds them.
        for transport in transports:
            transport.close()
        for pipe in (stdin, stdout, stderr):
            pipe.close()
        raise
    return _Pipes(writer, out, err, (out_transport, err_transport, writer.transport))
