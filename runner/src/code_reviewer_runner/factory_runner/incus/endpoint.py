# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's end of a job's environment control (#1007).

Control in instance A connects to the Unix socket `/ctl.sock` that an Incus `proxy` device makes in
A (`bind=instance`); the device's forwarder opens a connection to the socket this class listens on,
on the host, for every connection Control makes. So one socket per job: the connection is the job's
own, and nothing in a message names it. Each connection is one request and one reply, then closed
(the vsock transport's rule, `firecracker/endpoint.py`, whose limits are kept): a connection that is
slow (10 s for its frame), too large or outside the contract is closed and nothing about it is
believed, and the listener serves at most `MAX_CONNECTIONS` at a time so that whatever opens
connections in a loop holds a few descriptors of the service, not all of them."""

import asyncio
import contextlib
import logging
import os
from pathlib import Path

from code_reviewer_runner.factory_runner.firecracker.endpoint import MAX_CONNECTIONS
from code_reviewer_runner.factory_runner.firecracker.session import VmSession
from code_reviewer_runner.factory_runner.firecracker.wire import (
    MAX_CONTROL_FRAME_BYTES,
    ProtocolError,
    encode_frame,
    read_frame,
)

_log = logging.getLogger(__name__)


class ControlListener:
    """The listener of one job, closed when the job is gone."""

    def __init__(self, path: Path, session: VmSession) -> None:
        self._path = path
        self._session = session
        self._server: asyncio.Server | None = None
        self._open = 0

    @property
    def path(self) -> Path:
        return self._path

    async def start(self) -> None:
        """Listen. Raises `OSError` when the socket cannot be made. The socket is the service
        user's (0600): the daemon that connects to it is root."""
        self._server = await asyncio.start_unix_server(self._serve, path=str(self._path))
        os.chmod(self._path, 0o600)

    async def close(self) -> None:
        server, self._server = self._server, None
        if server is not None:
            server.close()
            with contextlib.suppress(Exception):
                await server.wait_closed()
        self._path.unlink(missing_ok=True)

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self._open >= MAX_CONNECTIONS:
            writer.close()
            return
        self._open += 1
        try:
            try:
                document = await read_frame(reader, max_bytes=MAX_CONTROL_FRAME_BYTES)
            except (ProtocolError, TimeoutError, ConnectionError, OSError) as error:
                _log.warning(
                    "%s: a connection was closed (%s)", self._session.vm.vm_id, type(error).__name__
                )
                return
            reply = await self._session.control(document)
            if reply is not None:
                writer.write(encode_frame(reply))
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            self._open -= 1
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()
