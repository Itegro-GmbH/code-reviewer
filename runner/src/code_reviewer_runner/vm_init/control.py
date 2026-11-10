# SPDX-License-Identifier: LicenseRef-Proprietary

"""Running the Control container: `docker run` of the arguments the Dispatcher rendered, with the
job
document on stdin. Nothing else carries the credential: not an argument, not the environment, not a
file (the hosted launcher's rule, `sandbox-host.ts`: "written to the pipe and the pipe closed")."""

import subprocess
from collections.abc import Callable
from typing import Final

# (arguments after `docker`, bytes for stdin) -> the exit status of `docker run`, which is the
# container's (0 to 255; a signal is 128 plus its number) or docker's own (125, 126, 127).
Spawn = Callable[[tuple[str, ...], bytes], int]

DOCKER: Final = "docker"
_LAUNCH_FAILED: Final = 125


def spawn_docker(args: tuple[str, ...], stdin: bytes) -> int:
    """The real one. The container's output is dropped: Control reports to the app through the
    Worker
    API and to the host through the environment control, and a log line here could only be a
    leak."""
    try:
        process = subprocess.Popen(
            (DOCKER, *args),
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )
    except OSError:
        return _LAUNCH_FAILED
    try:
        if process.stdin is not None:
            try:
                process.stdin.write(stdin)
                process.stdin.close()
            except BrokenPipeError:
                # The container ended before it read its input; its exit status says why.
                pass
        status = process.wait()
    except BaseException:
        process.kill()
        process.wait()
        raise
    return 128 - status if status < 0 else status
