# SPDX-License-Identifier: LicenseRef-Proprietary

"""The network door's proxy (#745, step 7): an HTTP and HTTPS forward proxy that decides on the host
name of every request by the environment's rule, and connects to the address it checked.

* `CONNECT host:port` is a tunnel (HTTPS): the door never looks inside, no certificate of ours is
  involved. Port 443 and 80 only.
* `METHOD http://host[:port]/path` is plain HTTP, forwarded to the port the URL names (80 when it
  names none) as long as that port is one the door allows, 80 or 443 like for a tunnel; any other
  port is refused (`port_not_allowed`). A plain request to port 443 reaches a TLS port and is of
  no use, but it is the same destination decision as everywhere else. The request line is
  rewritten to its origin form, `Host` is set from the same authority the decision was made on,
  `Connection: close` is forced and the rest of the traffic is relayed without being read, so one
  connection is one destination whatever the client sends next.
* Anything else (a request in origin form, `https://` as a URL, a user name in the authority, a
  malformed line) is refused with 400.

The decision, in this order, and it is the same in every mode: an IP literal is refused; a name
that is no plausible DNS name is refused; a port other than 80 and 443 is refused; the rule must
list the name (mode `list`; `open` lists everything); the name is looked up (only now, so a name
the rule does not list is never sent to a resolver) and every address it has must be public; the
connection is made to one of those addresses. The log has host, port, allowed or refused, a reason
word and the bytes. No body, no header and no path is kept anywhere.
"""

import contextlib
import logging
import re
import socket
import socketserver
import threading
from collections.abc import Callable
from dataclasses import dataclass
from ipaddress import IPv4Network
from typing import Final, cast

from ..network_rule import NetworkRule, RuleMatcher, ascii_name, is_ip_literal
from .addresses import Resolution, Resolver, resolve_public, system_resolver
from .connections import (
    OUTCOME_ALLOWED,
    OUTCOME_REFUSED,
    REASON_BAD_REQUEST,
    REASON_IP_LITERAL,
    REASON_NOT_LISTED,
    REASON_PORT,
    REASON_TOO_MANY,
    REASON_UPSTREAM,
    ConnectionLog,
)

_log = logging.getLogger(__name__)

ALLOWED_PORTS: Final = (80, 443)
MAX_HEAD_BYTES: Final = 16 * 1024
HEAD_SECONDS: Final = 15.0
CONNECT_SECONDS: Final = 10.0
# A tunnel that carries nothing for this long is closed (a package manager that waits on a slow
# server still sends keep-alives; a stuck one is the agent's to retry).
IDLE_SECONDS: Final = 600.0
MAX_CONNECTIONS: Final = 128
CHUNK: Final = 64 * 1024
# The headers the door removes from a forwarded request: hop-by-hop ones and the proxy's own.
_DROPPED = frozenset(
    {
        "connection",
        "keep-alive",
        "proxy-connection",
        "proxy-authorization",
        "proxy-authenticate",
        "te",
        "trailer",
        "upgrade",
        "host",
    }
)

# A method is a token (RFC 7230, 3.2.6): one or more of these characters, no space, no control
# character. The door forwards the method as it was sent, so a line that is not one is refused
# rather than passed to an origin.
_METHOD_TOKEN: Final = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")

Connector = Callable[[str, int, float], socket.socket]


def tcp_connector(address: str, port: int, timeout: float) -> socket.socket:
    return socket.create_connection((address, port), timeout=timeout)


@dataclass(frozen=True)
class Decision:
    """What the door does with a request: the addresses to connect to (allowed), or the word of
    the refusal."""

    addresses: tuple[str, ...] = ()
    reason: str | None = None

    @property
    def allowed(self) -> bool:
        return self.reason is None


class Authority:
    """`host` and `port` of a request, as written (the host not yet in comparison form)."""

    def __init__(self, host: str, port: int) -> None:
        self.host = host
        self.port = port


def split_authority(text: str, default_port: int | None) -> Authority | None:
    """`host[:port]` or `[v6][:port]`. None for anything with a user name, a path, a backslash or a
    space, an empty host or a port that is not a number of at most five digits."""
    if not text or any(c in text for c in "@/\\ \t?#") or not text.isprintable():
        return None
    if text.startswith("["):
        end = text.find("]")
        if end < 0:
            return None
        host, rest = text[: end + 1], text[end + 1 :]
        if rest and not rest.startswith(":"):
            return None
        port_text = rest[1:] if rest else ""
    else:
        host, _, port_text = text.partition(":")
        if ":" in port_text:
            return None
    if not host:
        return None
    if not port_text:
        return None if default_port is None else Authority(host, default_port)
    if not port_text.isascii() or not port_text.isdigit() or len(port_text) > 5:
        return None
    port = int(port_text)
    return Authority(host, port) if port <= 65535 else None


class Decider:
    """The rule, the lookup and the log. One for the whole door."""

    def __init__(
        self,
        rule: NetworkRule,
        log: ConnectionLog,
        *,
        resolver: Resolver = system_resolver,
        test_network: IPv4Network | None = None,
    ) -> None:
        self.matcher = RuleMatcher(rule)
        self.log = log
        self._resolver = resolver
        self._test_network = test_network

    def decide(self, host: str, port: int) -> Decision:
        if is_ip_literal(host):
            return Decision(reason=REASON_IP_LITERAL)
        name = ascii_name(host)
        if name is None:
            return Decision(reason=REASON_BAD_REQUEST)
        if port not in ALLOWED_PORTS:
            return Decision(reason=REASON_PORT)
        if not self.matcher.allows(name):
            return Decision(reason=REASON_NOT_LISTED)
        found: Resolution = resolve_public(name, port, self._resolver, self._test_network)
        if found.reason is not None:
            return Decision(reason=found.reason)
        return Decision(addresses=found.addresses)


_REASON_TEXT: Final = {
    REASON_NOT_LISTED: "the host is not in the environment's network list",
    REASON_IP_LITERAL: "an IP address is never allowed, use a host name",
    REASON_PORT: "only ports 80 and 443 are allowed",
    REASON_BAD_REQUEST: "the request is not one this proxy serves",
    REASON_TOO_MANY: "too many connections at once",
    REASON_UPSTREAM: "the host could not be reached",
    "private_address": "the host resolves to a private or special address",
    "unresolvable": "the host name could not be resolved",
}


def _status_line(code: int) -> str:
    return {
        200: "Connection Established",
        400: "Bad Request",
        403: "Forbidden",
        502: "Bad Gateway",
        503: "Service Unavailable",
    }[code]


def _respond(sock: socket.socket, code: int, reason: str | None = None) -> None:
    """A complete answer; the refusal's body names the reason in plain words, for the person (or
    the agent) reading a failed `npm install`."""
    text = "" if reason is None else _REASON_TEXT.get(reason, reason)
    body = b"" if code == 200 else f"network door: {text}\n".encode("ascii", "replace")
    head = f"HTTP/1.1 {code} {_status_line(code)}\r\n"
    if code != 200:
        head += (
            f"Content-Type: text/plain; charset=us-ascii\r\nContent-Length: {len(body)}\r\n"
            f"X-Network-Door: {reason or 'refused'}\r\nConnection: close\r\n"
        )
    with contextlib.suppress(OSError):
        sock.sendall(head.encode("ascii") + b"\r\n" + body)


class _Head:
    def __init__(self, request_line: str, headers: list[tuple[str, str]], rest: bytes) -> None:
        self.request_line = request_line
        self.headers = headers
        self.rest = rest


def _read_head(sock: socket.socket) -> _Head | None:
    """The request line and headers (up to a blank line, `MAX_HEAD_BYTES`), and any bytes that came
    after them. None for a head that is too long, not ASCII, or cut off."""
    data = b""
    while b"\r\n\r\n" not in data:
        if len(data) > MAX_HEAD_BYTES:
            return None
        try:
            chunk = sock.recv(4096)
        except OSError:
            return None
        if not chunk:
            return None
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    if len(head) > MAX_HEAD_BYTES:
        return None
    try:
        lines = head.decode("ascii").split("\r\n")
    except UnicodeDecodeError:
        return None
    headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        name, colon, value = line.partition(":")
        if not colon or not name or name != name.strip() or not name.isprintable():
            return None
        headers.append((name, value.strip()))
    return _Head(lines[0], headers, rest)


def _origin_form(target: str) -> tuple[Authority, str] | None:
    """`http://authority/path?query` to (authority, path). Only `http`, port 80 unless the URL names
    one (the decision on the port is `Decider.decide`'s), no user name."""
    prefix = "http://"
    if target[: len(prefix)].lower() != prefix:
        return None
    rest = target[len(prefix) :]
    cut = min((i for i in (rest.find("/"), rest.find("?"), rest.find("#")) if i >= 0), default=-1)
    authority_text, path = (rest, "/") if cut < 0 else (rest[:cut], rest[cut:])
    if path.startswith("?"):
        path = "/" + path
    if "#" in path or not path.isprintable() or " " in path:
        return None
    authority = split_authority(authority_text, 80)
    return None if authority is None else (authority, path)


class _Pair:
    """A client socket and the upstream one: bytes both ways until either side ends, counted."""

    def __init__(self, client: socket.socket, upstream: socket.socket) -> None:
        self.client = client
        self.upstream = upstream
        self.to_upstream = 0
        self.to_client = 0

    def _pump(self, source: socket.socket, sink: socket.socket, count: str) -> None:
        try:
            while True:
                data = source.recv(CHUNK)
                if not data:
                    break
                sink.sendall(data)
                setattr(self, count, getattr(self, count) + len(data))
        except OSError:
            pass
        finally:
            with contextlib.suppress(OSError):
                sink.shutdown(socket.SHUT_WR)

    def run(self) -> None:
        self.client.settimeout(IDLE_SECONDS)
        self.upstream.settimeout(IDLE_SECONDS)
        up = threading.Thread(
            target=self._pump, args=(self.client, self.upstream, "to_upstream"), daemon=True
        )
        up.start()
        self._pump(self.upstream, self.client, "to_client")
        # Upstream is done (or broke): a client that is still sending has nobody to send to.
        with contextlib.suppress(OSError):
            self.client.shutdown(socket.SHUT_RD)
        up.join(timeout=5.0)


class _Handler(socketserver.BaseRequestHandler):
    @property
    def proxy(self) -> "ProxyServer":
        return cast("ProxyServer", self.server)

    def handle(self) -> None:
        client: socket.socket = self.request
        proxy = self.proxy
        if not proxy.slots.acquire(blocking=False):
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_TOO_MANY)
            _respond(client, 503, REASON_TOO_MANY)
            return
        try:
            self._serve(client)
        except Exception:
            # A connection never takes the door down; what failed is not the agent's to read.
            _log.warning("the network door could not serve a connection")
        finally:
            proxy.slots.release()
            with contextlib.suppress(OSError):
                client.close()

    def _serve(self, client: socket.socket) -> None:
        proxy = self.proxy
        client.settimeout(HEAD_SECONDS)
        head = _read_head(client)
        if head is None:
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_BAD_REQUEST)
            _respond(client, 400, REASON_BAD_REQUEST)
            return
        parts = head.request_line.split(" ")
        if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_BAD_REQUEST)
            _respond(client, 400, REASON_BAD_REQUEST)
            return
        method, target, _version = parts
        if _METHOD_TOKEN.fullmatch(method) is None:
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_BAD_REQUEST)
            _respond(client, 400, REASON_BAD_REQUEST)
            return
        if method.upper() == "CONNECT":
            authority = split_authority(target, None)
            path = None
        else:
            parsed = _origin_form(target)
            authority, path = (None, None) if parsed is None else parsed
        if authority is None:
            proxy.log.add(
                target.split("/")[0][:80] if method.upper() == "CONNECT" else "",
                0,
                OUTCOME_REFUSED,
                REASON_BAD_REQUEST,
            )
            _respond(client, 400, REASON_BAD_REQUEST)
            return
        decision = proxy.decider.decide(authority.host, authority.port)
        if not decision.allowed:
            proxy.log.add(authority.host, authority.port, OUTCOME_REFUSED, decision.reason)
            _respond(client, 403, decision.reason)
            return
        upstream = self._connect(decision.addresses, authority.port)
        if upstream is None:
            proxy.log.add(authority.host, authority.port, OUTCOME_REFUSED, REASON_UPSTREAM)
            _respond(client, 502, REASON_UPSTREAM)
            return
        try:
            if path is None:
                _respond(client, 200)
                pending = head.rest
            else:
                name = ascii_name(authority.host) or authority.host
                host_header = name if authority.port == 80 else f"{name}:{authority.port}"
                upstream.sendall(_forwarded_head(method, path, host_header, head.headers))
                pending = head.rest
            if pending:
                upstream.sendall(pending)
            pair = _Pair(client, upstream)
            pair.to_upstream += len(pending)
            pair.run()
        finally:
            with contextlib.suppress(OSError):
                upstream.close()
        proxy.log.add(
            authority.host,
            authority.port,
            OUTCOME_ALLOWED,
            None,
            bytes_in=pair.to_client,
            bytes_out=pair.to_upstream,
        )

    def _connect(self, addresses: tuple[str, ...], port: int) -> socket.socket | None:
        """To one of the addresses that were checked, in order; never to the name."""
        for address in addresses:
            try:
                return self.proxy.connector(address, port, CONNECT_SECONDS)
            except OSError:
                continue
        return None


def _forwarded_head(method: str, path: str, host: str, headers: list[tuple[str, str]]) -> bytes:
    lines = [f"{method} {path} HTTP/1.1", f"Host: {host}"]
    for name, value in headers:
        if name.lower() in _DROPPED or "\r" in value or "\n" in value:
            continue
        lines.append(f"{name}: {value}")
    lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii", "replace")


class ProxyServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128

    def __init__(
        self,
        bind: tuple[str, int],
        decider: Decider,
        *,
        connector: Connector = tcp_connector,
        max_connections: int = MAX_CONNECTIONS,
    ) -> None:
        self.decider = decider
        self.log = decider.log
        self.connector = connector
        self.slots = threading.BoundedSemaphore(max_connections)
        super().__init__(bind, _Handler)

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    def start(self) -> "ProxyServer":
        threading.Thread(
            target=self.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True
        ).start()
        return self

    def stop(self) -> None:
        self.shutdown()
        self.server_close()
