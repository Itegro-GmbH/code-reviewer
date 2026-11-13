# SPDX-License-Identifier: LicenseRef-Proprietary

"""`git upload-pack` of the agent's repository, run in the reader and piped to Control's git (#745,
step 4).

Control's `git fetch --upload-pack=<this module> /work/repo <refspec>` runs it with the repository's
path as its one argument and the fetch's standard streams. This is not the agent's repository on
Control's disk to open: the path is never used. The command that runs is a constant, in the reader
(`reader.READER_REPO`), through the Engine API; the only variable that travels is git's protocol
version, checked against a pattern. The streams are copied both ways and the exit status of the
command is this process's exit status.
"""

import os
import re
import sys
import threading

from .docker_api import DockerApi, DockerError
from .exec_run import exec_document, exit_status
from .reader import (
    CONTROL_REPO,
    DOCKER_SOCKET_OPTION,
    READER_CONTAINER_NAME,
    READER_REPO,
    UPLOAD_PACK_PROTOCOL_VARIABLE,
    reader_argv,
    reader_environment,
)

_PROTOCOL = re.compile(r"version=[0-9]")
_SOCKET = re.compile(r"/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*")
USAGE_ERROR = 2
UNAVAILABLE = 3


def main(
    argv: list[str],
    environment: dict[str, str],
    *,
    api: DockerApi | None = None,
    stdin_descriptor: int = 0,
    stdout_descriptor: int = 1,
) -> int:
    socket_path: str | None = None
    if len(argv) == 2 and argv[0].startswith(DOCKER_SOCKET_OPTION):
        # B's Docker (#1017): the one option, a constant of the runner's own command.
        socket_path = argv[0][len(DOCKER_SOCKET_OPTION) :]
        if not _SOCKET.fullmatch(socket_path):
            return USAGE_ERROR
        argv = argv[1:]
    if argv != [CONTROL_REPO]:
        return USAGE_ERROR
    env = reader_environment()
    protocol = environment.get(UPLOAD_PACK_PROTOCOL_VARIABLE, "")
    if protocol:
        if not _PROTOCOL.fullmatch(protocol):
            return USAGE_ERROR
        env[UPLOAD_PACK_PROTOCOL_VARIABLE] = protocol
    api = api or (DockerApi() if socket_path is None else DockerApi(socket_path))
    try:
        exec_id = api.create_exec(
            READER_CONTAINER_NAME,
            exec_document(
                reader_argv(["upload-pack", READER_REPO]),
                env=env,
                workdir=READER_REPO,
            ),
        )
        streams = api.attach_exec(exec_id)
    except DockerError:
        return UNAVAILABLE

    def feed() -> None:
        try:
            while data := os.read(stdin_descriptor, 65536):
                streams.write(data)
        except OSError:
            pass
        finally:
            streams.close_write()

    threading.Thread(target=feed, daemon=True).start()
    try:
        for chunk in streams.chunks():
            os.write(stdout_descriptor, chunk)
    except OSError:
        return UNAVAILABLE
    finally:
        streams.close()
    code = exit_status(api, exec_id)
    return UNAVAILABLE if code is None else code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:], dict(os.environ)))
