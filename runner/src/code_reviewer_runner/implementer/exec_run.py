# SPDX-License-Identifier: LicenseRef-Proprietary

"""A command run in a container through the Engine API's exec (#745, step 4): the way Control
reaches into the reader and the agent container without a network and without a `docker` binary.

The command is a list of strings in a JSON document, never a shell line, so nothing that comes from
the agent or from the repository can become an option of a Docker call. Control only ever *starts*
these commands and reads what they print; nothing in the container opens a connection to Control.
"""

import contextlib
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence

from .docker_api import AttachedStreams, DockerApi, DockerError
from .git_process import Outcome

# How long the exit status of a command that has closed its output is waited for.
EXIT_WAIT_SECONDS = 5.0
STREAM_CHUNK_BYTES = 64 * 1024
# The most of a command's output `run_exec` keeps; the rest is read and dropped.
KEEP_BYTES = 256 * 1024


def exec_document(
    argv: Sequence[str],
    *,
    env: Mapping[str, str] | None = None,
    workdir: str | None = None,
    user: str | None = None,
    attach_stdin: bool = True,
) -> dict[str, object]:
    """The exec as the daemon takes it: a constant argv, the stated environment and directory."""
    document: dict[str, object] = {
        "Cmd": list(argv),
        "AttachStdin": attach_stdin,
        "AttachStdout": True,
        "AttachStderr": True,
        "Tty": False,
        "Env": [f"{name}={value}" for name, value in (env or {}).items()],
    }
    if workdir is not None:
        document["WorkingDir"] = workdir
    if user is not None:
        document["User"] = user
    return document


# `head` hands the command exactly `n` bytes of its input and then its end, which is how a command
# on a daemon that cannot be half-closed reads "the end of the input" (`DockerApi.half_close`). The
# exit status of the pipeline is the command's.
FRAME_SCRIPT = 'n=$1; shift; head -c "$n" | "$@"'


def framed_argv(argv: Sequence[str], length: int) -> list[str]:
    """`argv` that reads `length` bytes of its standard input and then sees its end."""
    return ["/bin/sh", "-c", FRAME_SCRIPT, "sh", str(length), *argv]


def exit_status(api: DockerApi, exec_id: str, seconds: float = EXIT_WAIT_SECONDS) -> int | None:
    """The exit status of an exec whose output has closed; None when it never says."""
    end = time.monotonic() + seconds
    while True:
        try:
            state = api.inspect_exec(exec_id)
        except DockerError:
            return None
        code = state.get("ExitCode")
        if state.get("Running") is False and isinstance(code, int) and not isinstance(code, bool):
            return code
        if time.monotonic() >= end:
            return None
        time.sleep(0.02)


def run_exec(
    api: DockerApi,
    container: str,
    argv: Sequence[str],
    *,
    env: Mapping[str, str] | None = None,
    workdir: str | None = None,
    user: str | None = None,
    stdin: bytes | Iterable[bytes] | None = None,
    timeout: float,
    consume: Callable[[bytes], None] | None = None,
    name: str = "command",
) -> Outcome:
    """Run `argv` in `container` and wait for it. The answer is never raised on, as for
    `GitProcess.run`: a command that cannot be started or runs past `timeout` is `unanswered`
    (return code 255), and nothing may be concluded from it.

    With `consume`, the standard output goes to it chunk by chunk and none is kept (the caller
    controls how much it reads; a `consume` that raises ends the command's connection, and the
    exception goes to the caller). Without, up to `KEEP_BYTES` of it are returned. The command's
    standard error is dropped. `stdin` is bytes or an iterable of them."""
    attach_stdin = True
    if not getattr(api, "half_close", True):
        # The end of the input cannot be sent as a half-close here: a command without input
        # attaches none, one with input is told how long it is.
        if stdin is not None and not isinstance(stdin, bytes):
            stdin = b"".join(stdin)
        if stdin:
            argv = framed_argv(argv, len(stdin))
        else:
            stdin, attach_stdin = None, False
    try:
        exec_id = api.create_exec(
            container,
            exec_document(argv, env=env, workdir=workdir, user=user, attach_stdin=attach_stdin),
        )
        streams = api.attach_exec(exec_id)
    except DockerError:
        return Outcome(255, "", f"{name} cannot run", unanswered=True)
    timed_out = threading.Event()

    def expire() -> None:
        timed_out.set()
        streams.close()

    timer = threading.Timer(timeout, expire)
    timer.start()
    kept = bytearray()
    try:
        with contextlib.suppress(OSError):
            if isinstance(stdin, bytes):
                if stdin:
                    streams.write(stdin)
            elif stdin is not None:
                # Written as it is produced; a producer that raises ends the command's connection
                # without the end of its input, and the exception goes to the caller.
                for part in stdin:
                    streams.write(part)
            streams.close_write()
        for chunk in streams.chunks():
            if consume is not None:
                consume(chunk)
            elif len(kept) < KEEP_BYTES:
                kept += chunk[: KEEP_BYTES - len(kept)]
    finally:
        timer.cancel()
        streams.close()
    if timed_out.is_set():
        return Outcome(255, "", f"{name} timed out", unanswered=True)
    code = exit_status(api, exec_id)
    if code is None:
        return Outcome(255, "", f"{name} has no exit status", unanswered=True)
    return Outcome(code, kept.decode("utf-8", errors="replace"), "")


def pump(source: AttachedStreams, write: Callable[[bytes], None]) -> None:
    """Hand everything the command prints to `write` until its output ends."""
    for chunk in source.chunks():
        write(chunk)
