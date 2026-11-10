# SPDX-License-Identifier: LicenseRef-Proprietary

"""The vsock ends of vm-init: where it listens for the start and where it connects for the exit
report. The real one is AF_VSOCK; the agent takes the `Vsock` port, so every test brings its own
(a socket pair per connection) and no unit test opens a real AF_VSOCK socket. The real path is
proven
by the KVM lane of #978."""

import socket
from typing import Final, Protocol

from .wire import HOST_CID, StreamSocket

# Listening addresses (linux/vm_sockets.h): any CID of this VM.
_CID_ANY: Final = 0xFFFFFFFF
_BACKLOG: Final = 4


class Listener(Protocol):
    def accept(self, timeout: float) -> StreamSocket | None:
        """The next connection, or None when none came within `timeout` seconds."""
        ...

    def close(self) -> None: ...


class Vsock(Protocol):
    """What vm-init needs of the VM's vsock."""

    def listen(self, port: int) -> Listener:
        """Starts to listen on `port` of this VM. A connection made from now on waits in the queue
        until it is accepted."""
        ...

    def connect_host(self, port: int, timeout: float) -> StreamSocket:
        """A connection to `port` of the host (CID 2). Raises `OSError` when it cannot be made."""
        ...


class _SocketListener:
    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock

    def accept(self, timeout: float) -> StreamSocket | None:
        self._sock.settimeout(timeout)
        try:
            connection, _ = self._sock.accept()
        except TimeoutError:
            return None
        return connection

    def close(self) -> None:
        self._sock.close()


class RealVsock:
    """AF_VSOCK of this kernel (`socket.AF_VSOCK`, Linux)."""

    @staticmethod
    def _family() -> int:
        family = getattr(socket, "AF_VSOCK", None)
        if family is None:
            raise OSError("this platform has no AF_VSOCK")
        return int(family)

    def listen(self, port: int) -> Listener:
        sock = socket.socket(self._family(), socket.SOCK_STREAM)
        try:
            sock.bind((_CID_ANY, port))
            sock.listen(_BACKLOG)
        except BaseException:
            sock.close()
            raise
        return _SocketListener(sock)

    def connect_host(self, port: int, timeout: float) -> StreamSocket:
        sock = socket.socket(self._family(), socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            sock.connect((HOST_CID, port))
        except BaseException:
            sock.close()
            raise
        return sock
