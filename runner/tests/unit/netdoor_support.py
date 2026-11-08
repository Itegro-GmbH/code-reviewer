# SPDX-License-Identifier: LicenseRef-Proprietary

"""Doubles for the tests of the Implementer's network door (#745, step 7); not a test file.

The door is the real code (`ProxyServer`, `Decider`) on a real loopback socket. Its lookup is a
table, and its connector is a table of local servers: a name "resolves" to a public-looking address
and the connection is made to a loopback server standing in for it, so the test sees which address
the door asked to connect to and how often it looked a name up.
"""

import contextlib
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from code_reviewer_runner.implementer.netdoor.connections import ConnectionLog
from code_reviewer_runner.implementer.netdoor.intercept import RegistryGate
from code_reviewer_runner.implementer.netdoor.proxy import Decider, ProxyServer
from code_reviewer_runner.implementer.network_rule import NetworkRule

PUBLIC = "93.184.216.34"
OTHER_PUBLIC = "151.101.1.1"


class Origin:
    """A server on loopback that answers each connection with `reply` after reading what the
    client sent up to a blank line (plain HTTP) or at once (a tunnel). It keeps what it received."""

    def __init__(self, reply: bytes = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok") -> None:
        self.reply = reply
        self.received: list[bytes] = []
        self._listener = socket.socket()
        self._listener.bind(("127.0.0.1", 0))
        self._listener.listen(8)
        self.port = self._listener.getsockname()[1]
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self) -> None:
        while True:
            try:
                connection, _ = self._listener.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(connection,), daemon=True).start()

    def _serve(self, connection: socket.socket) -> None:
        data = b""
        try:
            while b"\r\n\r\n" not in data:
                chunk = connection.recv(4096)
                if not chunk:
                    break
                data += chunk
            self.received.append(data)
            connection.sendall(self.reply)
        except OSError:
            pass
        finally:
            connection.close()

    def close(self) -> None:
        self._listener.close()


@dataclass
class Lookups:
    """The resolver and the connector of a test: `table` maps a name to the addresses it has,
    `servers` maps an address to the loopback port that stands in for it."""

    table: dict[str, list[str]] = field(default_factory=lambda: {})
    servers: dict[str, int] = field(default_factory=lambda: {})
    looked_up: list[str] = field(default_factory=lambda: [])
    connected: list[tuple[str, int]] = field(default_factory=lambda: [])
    # A name that answers differently the second time it is asked (a rebinding resolver).
    second_answer: dict[str, list[str]] = field(default_factory=lambda: {})

    def resolve(self, name: str, port: int) -> list[str]:
        _ = port
        asked = self.looked_up.count(name)
        self.looked_up.append(name)
        if asked >= 1 and name in self.second_answer:
            return self.second_answer[name]
        if name not in self.table:
            raise OSError("no such name")
        return self.table[name]

    def connect(self, address: str, port: int, timeout: float) -> socket.socket:
        self.connected.append((address, port))
        if address not in self.servers:
            raise OSError("no route")
        return socket.create_connection(("127.0.0.1", self.servers[address]), timeout=timeout)


@dataclass
class Running:
    server: ProxyServer
    log: ConnectionLog
    lookups: Lookups

    @property
    def port(self) -> int:
        return self.server.port

    def stop(self) -> None:
        self.server.stop()


def start_proxy(
    rule: NetworkRule,
    lookups: Lookups,
    max_connections: int = 128,
    gate: Callable[[ConnectionLog], RegistryGate] | None = None,
) -> Running:
    log = ConnectionLog()
    decider = Decider(rule, log, resolver=lookups.resolve)
    server = ProxyServer(
        ("127.0.0.1", 0),
        decider,
        connector=lookups.connect,
        max_connections=max_connections,
        registry_gate=None if gate is None else gate(log),
    ).start()
    return Running(server, log, lookups)


def talk(
    port: int, request: bytes, *, send_more: Callable[[socket.socket], None] | None = None
) -> bytes:
    """Send `request` to the proxy and read until it closes the connection."""
    client = socket.create_connection(("127.0.0.1", port), timeout=10)
    try:
        client.sendall(request)
        if send_more is not None:
            send_more(client)
        # The client is done sending: the door passes the end on, so an origin that waits for more
        # (a tunnel with nothing in it) answers and closes.
        # A door that already answered and closed (a head over its limit) may have reset the
        # connection; its answer is still in the receive buffer.
        with contextlib.suppress(OSError):
            client.shutdown(socket.SHUT_WR)
        chunks: list[bytes] = []
        while True:
            try:
                chunk = client.recv(65536)
            except (TimeoutError, OSError):
                break
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)
    finally:
        client.close()


def status_of(answer: bytes) -> int:
    return int(answer.split(b" ", 2)[1])
