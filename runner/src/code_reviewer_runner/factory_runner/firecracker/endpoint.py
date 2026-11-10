# SPDX-License-Identifier: LicenseRef-Proprietary

"""The host's ends of a VM's vsock (#978).

Firecracker exposes a VM's vsock as one Unix socket `<uds>`. A connection the VM makes to the host
(CID 2) on port P arrives at the Unix socket `<uds>_P`, on which the host must already listen: the
host listens on `_5100` (environment control, `contracts/environment-control.v1.json`) and `_5101`
(vm-init's exit report) **before it starts the VM**. The host reaches the VM the other way: it
connects to `<uds>`, writes `CONNECT 5000\\n`, reads `OK <port>\\n`, and then speaks the protocol of
vm-init's start on that stream (`contracts/vm-init.v1.json`).

Each connection is one request and one reply, then closed. A connection that is slow (10 s for its
frame), too large or outside the contract is closed; nothing about it is believed."""

import asyncio
import contextlib
import logging
import os
from pathlib import Path
from typing import Any, Final

from .session import VmSession
from .wire import (
    CONTROL_PORT,
    MAX_CONTROL_FRAME_BYTES,
    REPORT_PORT,
    START_PORT,
    ProtocolError,
    encode_frame,
    read_frame,
)

_log = logging.getLogger(__name__)

CONNECT_RETRY_SECONDS: Final = 0.1
# A ready line is `OK <port>\n`.
_MAX_LINE_BYTES: Final = 64


def port_path(uds: Path, port: int) -> Path:
    """Where Firecracker hands the host the connections the VM makes to `port`."""
    return Path(f"{uds}_{port}")


class HostListeners:
    """The two listeners of one VM, closed when the VM is gone."""

    def __init__(self, uds: Path, session: VmSession) -> None:
        self._uds = uds
        self._session = session
        self._servers: list[asyncio.Server] = []

    async def start(self) -> None:
        """Listen on both ports. Raises `OSError` when a socket cannot be made."""
        try:
            for port, handler in (
                (CONTROL_PORT, self._control),
                (REPORT_PORT, self._report),
            ):
                path = port_path(self._uds, port)
                server = await asyncio.start_unix_server(handler, path=str(path))
                os.chmod(path, 0o600)
                self._servers.append(server)
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        servers, self._servers = self._servers, []
        for server in servers:
            server.close()
        for server in servers:
            with contextlib.suppress(Exception):
                await server.wait_closed()
        for port in (CONTROL_PORT, REPORT_PORT):
            port_path(self._uds, port).unlink(missing_ok=True)

    async def _control(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await self._serve(reader, writer, self._session.control, MAX_CONTROL_FRAME_BYTES)

    async def _report(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        async def answer(document: dict[str, Any]) -> dict[str, Any] | None:
            return self._session.exit_report(document)

        await self._serve(reader, writer, answer, MAX_CONTROL_FRAME_BYTES)

    async def _serve(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        answer: Any,
        max_bytes: int,
    ) -> None:
        try:
            try:
                document = await read_frame(reader, max_bytes=max_bytes)
            except (ProtocolError, TimeoutError, ConnectionError, OSError) as error:
                _log.warning(
                    "%s: a connection was closed (%s)", self._session.vm.vm_id, type(error).__name__
                )
                return
            reply = await answer(document)
            if reply is not None:
                writer.write(encode_frame(reply))
                await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()


class StartRefused(Exception):
    """vm-init answered `refused` to the start (`invalid_start`): the VM ends by itself."""


class StartNotAnswered(Exception):
    """The VM took no start: it could not be reached in time, or did not answer in time."""


async def send_start(
    uds: Path, frame: bytes, *, connect_seconds: float, ack_seconds: float
) -> None:
    """Connect to the VM's start port and send the start; return when vm-init answers `ack`.

    The connection is retried until `connect_seconds` (Firecracker creates the socket at boot and
    the guest listens a moment later). The `ack` comes after the VM prepared itself (the daemon: up
    to 72 s by the contract), so it is waited for `ack_seconds`. `StartRefused` for `refused`,
    `StartNotAnswered` for the rest."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + connect_seconds
    while True:
        try:
            reader, writer = await asyncio.open_unix_connection(str(uds))
            try:
                writer.write(f"CONNECT {START_PORT}\n".encode("ascii"))
                await writer.drain()
                line = await asyncio.wait_for(reader.readline(), max(deadline - loop.time(), 0.1))
                if line.startswith(b"OK ") and len(line) <= _MAX_LINE_BYTES:
                    break
            except (OSError, TimeoutError):
                pass
            writer.close()
        except OSError:
            pass
        if loop.time() >= deadline:
            raise StartNotAnswered("the VM did not accept a connection in time")
        await asyncio.sleep(CONNECT_RETRY_SECONDS)
    try:
        writer.write(frame)
        await writer.drain()
        try:
            document = await read_frame(
                reader, max_bytes=MAX_CONTROL_FRAME_BYTES, seconds=ack_seconds
            )
        except (ProtocolError, TimeoutError, OSError) as error:
            raise StartNotAnswered(
                f"the VM did not answer the start ({type(error).__name__})"
            ) from None
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
    if document.get("type") == "ack" and document.get("for") == "start":
        return
    if document.get("type") == "refused" and document.get("for") == "start":
        raise StartRefused
    raise StartNotAnswered("the VM's answer to the start is not one of the contract")
