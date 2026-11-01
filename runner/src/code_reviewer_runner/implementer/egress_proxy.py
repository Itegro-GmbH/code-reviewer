# SPDX-License-Identifier: LicenseRef-Proprietary

"""The loopback CONNECT proxy through which the Implementer agent reaches package registries (#763).

The root supervisor runs one of these for the agent phase. The engine user's nft rules let it open
connections to loopback ports only (the model proxy, the engine's own port and this one,
`netguard.py`), so every tool of the agent (npm, pip, cargo) that honours `HTTPS_PROXY` comes
here, and a tool that ignores the variable has no network at all.

What the proxy does with a connection:

* reads one request head (bounded in size and time) and accepts nothing but `CONNECT host:443`
  with a name on the allowlist (`egress_policy.py`); plain HTTP, other methods, other ports, IP
  literals and user information are refused with a status and no lookup;
* resolves the name itself, judges **every** address it resolves to (loopback, private, link-local,
  metadata and the other special ranges are refused: `passthrough/address.py`) and connects to an
  address it judged, never to the name again, so a name that changes its answer cannot send a
  tunnel somewhere else;
* answers 200 and relays bytes both ways without reading them. A redirect inside the tunnel is the
  client's: its next request is a new CONNECT and meets the same rules.

Limits bound the work an agent can make the supervisor do: open connections (including those
still sending their head), concurrent tunnels, the time for a head, a lookup and a connection, and
the time a tunnel may stay silent. The job log gets one line when the proxy stops: the tunnels per
host, and the refusals per reason with the (sanitised) hosts asked for; never a path, a header, a
byte count or any content.

The resolver and the connector are injectable for tests; the defaults are the real ones. Nothing
here reads the environment or a file: the allowlist and the limits come from the caller.
"""

import contextlib
import errno
import logging
import re
import select
import socket
import threading
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from .egress_policy import (
    DEFAULT_ALLOWLIST,
    EgressAllowlist,
    EgressRefused,
    Refusal,
    check_resolved,
    judge_authority,
)

LOOPBACK: Final = "127.0.0.1"
_CHUNK: Final = 65536
_MAX_REFUSED_HOSTS: Final = 10
# Seconds to wait after an `accept` that failed (out of descriptors, an aborted connection), so a
# failure that stays cannot turn the acceptor into a busy loop.
_ACCEPT_BACKOFF: Final = 0.1
_SAFE_HOST: Final = re.compile(r"^[a-z0-9][a-z0-9.-]{0,252}$")
_HEADER_NAME: Final = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
_VERSIONS: Final = ("HTTP/1.0", "HTTP/1.1")
_log = logging.getLogger(__name__)

Resolver = Callable[[str], list[str]]
Connector = Callable[[tuple[str, int], float], socket.socket]


@dataclass(frozen=True)
class EgressLimits:
    """What an agent can make the supervisor hold or wait for."""

    # Concurrent tunnels, and all open client connections (heads still being read included).
    max_tunnels: int = 32
    max_connections: int = 64
    # Seconds: for the request head, for a name lookup, for the connection to the target, and a
    # tunnel's silence in both directions.
    head_timeout: float = 10.0
    resolve_timeout: float = 10.0
    connect_timeout: float = 10.0
    idle_timeout: float = 120.0
    max_head_bytes: int = 8192


def system_resolve(host: str) -> list[str]:
    found = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    # The scope of a link-local IPv6 address (`%eth0`) is no part of the address.
    return list(dict.fromkeys(str(entry[4][0]).split("%")[0] for entry in found))


def tcp_connect(address: tuple[str, int], timeout: float) -> socket.socket:
    return socket.create_connection(address, timeout=timeout)


class _Done(Exception):
    """The connection is answered (or not worth an answer); the handler ends."""


@dataclass(frozen=True)
class _Request:
    authority: str
    host_header: str | None


def _status_of(reason: Refusal) -> tuple[int, str]:
    if reason in (Refusal.MALFORMED, Refusal.USERINFO):
        return 400, "Bad Request"
    if reason is Refusal.UNRESOLVED:
        return 502, "Bad Gateway"
    return 403, "Forbidden"


def _logged_host(authority: str) -> str:
    """The host of a refused target in a form that is safe in a log line, else `(invalid)`."""
    host = authority.rpartition(":")[0].lower().removesuffix(".")
    return host if _SAFE_HOST.fullmatch(host) else "(invalid)"


class EgressProxy:
    """One allowlist proxy on a loopback port. `start` binds, `stop` ends everything and logs."""

    def __init__(
        self,
        *,
        allowlist: EgressAllowlist = DEFAULT_ALLOWLIST,
        port: int = 0,
        limits: EgressLimits | None = None,
        resolve: Resolver = system_resolve,
        connect: Connector = tcp_connect,
    ) -> None:
        self.allowlist = allowlist
        self.limits = limits or EgressLimits()
        self._requested_port = port
        self._resolve, self._connect = resolve, connect
        self._lock = threading.Lock()
        self._listener: socket.socket | None = None
        self._acceptor: threading.Thread | None = None
        self._stopping = threading.Event()
        # Every socket to close at stop (clients and targets), and how many clients are open.
        self._open: set[socket.socket] = set()
        self._connections = 0
        self._handlers: set[threading.Thread] = set()
        self._tunnels = 0
        self._tunnelled: Counter[str] = Counter()
        self._refused: Counter[str] = Counter()
        self._refused_hosts: dict[str, None] = {}

    # -- lifecycle ------------------------------------------------------------

    @property
    def port(self) -> int:
        if self._listener is None:
            return self._requested_port
        return int(self._listener.getsockname()[1])

    @property
    def address(self) -> tuple[str, int]:
        return LOOPBACK, self.port

    def start(self) -> None:
        listener = socket.socket()
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind((LOOPBACK, self._requested_port))
            listener.listen(self.limits.max_connections)
        except OSError:
            listener.close()
            raise
        listener.settimeout(0.1)
        self._listener = listener
        self._acceptor = threading.Thread(target=self._accept_loop, daemon=True)
        self._acceptor.start()

    def stop(self) -> None:
        """End the listener and every open connection, then log the counts once. Idempotent."""
        if self._stopping.is_set():
            return
        self._stopping.set()
        try:
            if self._acceptor is not None:
                self._acceptor.join(2)
            if self._listener is not None:
                with contextlib.suppress(OSError):
                    self._listener.close()
            with self._lock:
                sockets = list(self._open)
                handlers = list(self._handlers)
            for sock in sockets:
                self._close(sock)
            for handler in handlers:
                # A thread that never started has no ident and cannot be joined.
                if handler.ident is not None:
                    handler.join(2)
        finally:
            self._log_summary()

    def __enter__(self) -> "EgressProxy":
        self.start()
        return self

    def __exit__(self, *exception: object) -> None:
        self.stop()

    # -- counts ---------------------------------------------------------------

    def tunnel_counts(self) -> dict[str, int]:
        with self._lock:
            return dict(self._tunnelled)

    def refused_counts(self) -> dict[str, int]:
        with self._lock:
            return dict(self._refused)

    def _log_summary(self) -> None:
        with self._lock:
            tunnels = " ".join(f"{host}={count}" for host, count in self._tunnelled.items())
            refused = " ".join(f"{reason}={count}" for reason, count in self._refused.items())
            hosts = " ".join(self._refused_hosts)
        _log.info(
            "egress proxy: tunnels per host: %s; refused per reason: %s; refused hosts: %s",
            tunnels or "none",
            refused or "none",
            hosts or "none",
        )

    # -- accepting ------------------------------------------------------------

    def _accept_loop(self) -> None:
        listener = self._listener
        assert listener is not None
        failing = False
        while not self._stopping.is_set():
            try:
                client, _ = listener.accept()
            except TimeoutError:
                continue
            except OSError as error:
                if self._stopping.is_set() or listener.fileno() == -1:
                    return
                # An aborted connection, no descriptors left, no buffers: the listener is fine and
                # the next client must still be served. Wait a moment so a failure that stays
                # does not spin, and say it once per streak.
                if not failing:
                    name = errno.errorcode.get(error.errno or 0, type(error).__name__)
                    _log.warning("egress proxy: accept failed (%s); going on", name)
                failing = True
                self._stopping.wait(_ACCEPT_BACKOFF)
                continue
            failing = False
            with self._lock:
                full = self._connections >= self.limits.max_connections
                if not full:
                    self._connections += 1
                    self._open.add(client)
            if full:
                self._reply(client, 503, "Service Unavailable")
                self._close(client)
                continue
            handler = threading.Thread(target=self._serve, args=(client,), daemon=True)
            # Registered before it runs: a handler that ends at once removes itself, and a
            # registration after the start could outlive it.
            with self._lock:
                self._handlers.add(handler)
            try:
                handler.start()
            except RuntimeError:
                # No thread to be had (the pids limit): this client pays, the acceptor goes on.
                with self._lock:
                    self._handlers.discard(handler)
                    self._connections -= 1
                    self._refused[Refusal.LIMIT.value] += 1
                self._reply(client, 503, "Service Unavailable")
                self._close(client)
                self._stopping.wait(_ACCEPT_BACKOFF)

    def _serve(self, client: socket.socket) -> None:
        try:
            self._handle(client)
        except _Done:
            pass
        except OSError:
            pass
        finally:
            self._close(client)
            with self._lock:
                self._connections -= 1
                self._handlers.discard(threading.current_thread())

    def _close(self, sock: socket.socket) -> None:
        with self._lock:
            self._open.discard(sock)
        with contextlib.suppress(OSError):
            sock.shutdown(socket.SHUT_RDWR)
        with contextlib.suppress(OSError):
            sock.close()

    # -- one connection -------------------------------------------------------

    def _reply(self, client: socket.socket, status: int, phrase: str, *headers: str) -> None:
        head = "\r\n".join(
            [f"HTTP/1.1 {status} {phrase}", "Content-Length: 0", "Connection: close", *headers]
        )
        with contextlib.suppress(OSError):
            client.settimeout(1)
            client.sendall(f"{head}\r\n\r\n".encode("ascii"))

    def _refuse(self, client: socket.socket, status: int, phrase: str, *headers: str) -> _Done:
        self._reply(client, status, phrase, *headers)
        return _Done()

    def _count_refusal(self, reason: Refusal, authority: str | None = None) -> None:
        with self._lock:
            self._refused[reason.value] += 1
            if authority is not None and len(self._refused_hosts) < _MAX_REFUSED_HOSTS:
                self._refused_hosts.setdefault(_logged_host(authority), None)

    def _handle(self, client: socket.socket) -> None:
        head, leftover = self._read_head(client)
        request = self._parse(client, head)
        try:
            host = judge_authority(request.authority, self.allowlist)
            self._check_host_header(request, host)
        except EgressRefused as refused:
            self._count_refusal(refused.reason, request.authority)
            status, phrase = _status_of(refused.reason)
            raise self._refuse(client, status, phrase) from None
        with self._lock:
            if self._tunnels >= self.limits.max_tunnels:
                self._refused[Refusal.LIMIT.value] += 1
                busy = True
            else:
                self._tunnels += 1
                busy = False
        if busy:
            raise self._refuse(client, 503, "Service Unavailable")
        try:
            upstream = self._open_upstream(client, host)
            try:
                self._tunnel(client, upstream, host, leftover)
            finally:
                self._close(upstream)
        finally:
            with self._lock:
                self._tunnels -= 1

    def _read_head(self, client: socket.socket) -> tuple[bytes, bytes]:
        deadline = time.monotonic() + self.limits.head_timeout
        data = b""
        while b"\r\n\r\n" not in data:
            if len(data) > self.limits.max_head_bytes:
                self._count_refusal(Refusal.MALFORMED)
                raise self._refuse(client, 431, "Request Header Fields Too Large")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise self._refuse(client, 408, "Request Timeout")
            client.settimeout(remaining)
            try:
                chunk = client.recv(4096)
            except TimeoutError:
                raise self._refuse(client, 408, "Request Timeout") from None
            if not chunk:
                raise _Done
            data += chunk
        head, _, leftover = data.partition(b"\r\n\r\n")
        if len(head) > self.limits.max_head_bytes:
            self._count_refusal(Refusal.MALFORMED)
            raise self._refuse(client, 431, "Request Header Fields Too Large")
        return head, leftover

    def _parse(self, client: socket.socket, head: bytes) -> _Request:
        try:
            lines = head.decode("ascii").split("\r\n")
        except UnicodeDecodeError:
            self._count_refusal(Refusal.MALFORMED)
            raise self._refuse(client, 400, "Bad Request") from None
        parts = lines[0].split(" ")
        if len(parts) != 3 or parts[2] not in _VERSIONS or not all(parts):
            self._count_refusal(Refusal.MALFORMED)
            raise self._refuse(client, 400, "Bad Request")
        if parts[0] != "CONNECT":
            # Plain HTTP through the proxy, or any other method: only tunnels are served.
            self._count_refusal(Refusal.NOT_CONNECT)
            raise self._refuse(client, 405, "Method Not Allowed", "Allow: CONNECT")
        hosts: list[str] = []
        for line in lines[1:]:
            name, separator, value = line.partition(":")
            if not separator or _HEADER_NAME.fullmatch(name) is None:
                self._count_refusal(Refusal.MALFORMED)
                raise self._refuse(client, 400, "Bad Request")
            if name.lower() == "host":
                hosts.append(value.strip())
        if len(hosts) > 1:
            self._count_refusal(Refusal.HOST_HEADER, parts[1])
            raise self._refuse(client, 400, "Bad Request")
        return _Request(parts[1], hosts[0] if hosts else None)

    def _check_host_header(self, request: _Request, host: str) -> None:
        """A `Host` header, when there is one, must name the target (no second name)."""
        if request.host_header is None:
            return
        named = request.host_header.lower().removesuffix(":443").removesuffix(".")
        if named != host:
            raise EgressRefused(Refusal.HOST_HEADER)

    def _open_upstream(self, client: socket.socket, host: str) -> socket.socket:
        """Resolve `host`, judge every address and connect to one that was judged."""
        try:
            addresses = self._lookup(host)
            check_resolved(addresses)
        except EgressRefused as refused:
            self._count_refusal(refused.reason, f"{host}:443")
            status, phrase = _status_of(refused.reason)
            raise self._refuse(client, status, phrase) from None
        except TimeoutError:
            self._count_refusal(Refusal.UNRESOLVED, f"{host}:443")
            raise self._refuse(client, 504, "Gateway Timeout") from None
        deadline = time.monotonic() + self.limits.connect_timeout
        timed_out = False
        for address in dict.fromkeys(addresses):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                break
            try:
                upstream = self._connect((address, 443), remaining)
            except TimeoutError:
                timed_out = True
                continue
            except OSError:
                continue
            with self._lock:
                self._open.add(upstream)
            return upstream
        self._count_refusal(Refusal.UNREACHABLE, f"{host}:443")
        if timed_out:
            raise self._refuse(client, 504, "Gateway Timeout")
        raise self._refuse(client, 502, "Bad Gateway")

    def _lookup(self, host: str) -> list[str]:
        """The addresses of `host`. `getaddrinfo` has no timeout, so the lookup runs in a thread
        that is given up on after `resolve_timeout` (it is a daemon and ends with its lookup)."""
        found: list[list[str]] = []
        failed: list[BaseException] = []

        def lookup() -> None:
            try:
                found.append(self._resolve(host))
            except BaseException as error:
                failed.append(error)

        thread = threading.Thread(target=lookup, daemon=True)
        thread.start()
        thread.join(self.limits.resolve_timeout)
        if thread.is_alive():
            raise TimeoutError
        if failed or not found:
            raise EgressRefused(Refusal.UNRESOLVED)
        return found[0]

    def _tunnel(
        self, client: socket.socket, upstream: socket.socket, host: str, leftover: bytes
    ) -> None:
        client.settimeout(self.limits.idle_timeout)
        upstream.settimeout(self.limits.idle_timeout)
        client.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        with self._lock:
            self._tunnelled[host] += 1
        if leftover:
            # A client that sent its first bytes right behind the request head, before our 200.
            upstream.sendall(leftover)
        self._relay(client, upstream)

    def _relay(self, client: socket.socket, upstream: socket.socket) -> None:
        """Copy bytes both ways until both sides ended or the tunnel stayed silent too long."""
        peers = {client: upstream, upstream: client}
        reading = [client, upstream]
        while reading:
            try:
                ready, _, _ = select.select(reading, [], [], self.limits.idle_timeout)
            except (OSError, ValueError):
                return  # a socket was closed under us: the proxy is stopping
            if not ready:
                return  # idle
            for source in ready:
                data = source.recv(_CHUNK)
                if not data:
                    reading.remove(source)
                    with contextlib.suppress(OSError):
                        peers[source].shutdown(socket.SHUT_WR)
                    continue
                peers[source].sendall(data)
