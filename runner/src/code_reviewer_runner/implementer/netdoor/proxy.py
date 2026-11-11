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

**Chained to the outer wall's proxy** (#994, a door in a VM on a customer's machine): the VM has no
direct internet and no name server, so the door makes no lookup and no connection to an address of
its own. After the rule and the port are decided it asks the host's proxy for `CONNECT <name>:<port>`
(`chained_connector`) and relays through that tunnel, for a plain `http://` request too (a tunnel to
port 80 and the request in origin form). The proxy does the lookup, judges every address and
connects to one it checked, with the same decision (it is this class's decision). A proxy that
refuses, or cannot be reached, is the same `502 upstream_failed` the agent gets for a host that does
not answer: the door never dials anything but the proxy, and its own firewall says so
(`netdoor_launcher.egress_rules`).

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

from code_reviewer_runner.outer_proxy import Connect, OuterProxy, open_tunnel

from ..network_rule import NetworkRule, RuleMatcher, ascii_name, is_ip_literal
from .addresses import Resolution, Resolver, resolve_public, system_resolver
from .connections import (
    OUTCOME_ALLOWED,
    OUTCOME_REFUSED,
    REASON_BAD_REQUEST,
    REASON_IP_LITERAL,
    REASON_NOT_LISTED,
    REASON_PORT,
    REASON_REGISTRY,
    REASON_RULE_CHANGED,
    REASON_TOO_MANY,
    REASON_UPSTREAM,
    ConnectionLog,
)
from .intercept import RegistryGate
from .registries import is_registry_name
from .wire import forwarded_head, read_head, respond

_log = logging.getLogger(__name__)

CONNECT_SECONDS: Final = 10.0
# A tunnel that carries nothing for this long is closed (a package manager that waits on a slow
# server still sends keep-alives; a stuck one is the agent's to retry).
IDLE_SECONDS: Final = 600.0
MAX_CONNECTIONS: Final = 128
CHUNK: Final = 64 * 1024
# A method is a token (RFC 7230, 3.2.6): one or more of these characters, no space, no control
# character. The door forwards the method as it was sent, so a line that is not one is refused
# rather than passed to an origin.
_METHOD_TOKEN: Final = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")

Connector = Callable[[str, int, float], socket.socket]


def tcp_connector(address: str, port: int, timeout: float) -> socket.socket:
    return socket.create_connection((address, port), timeout=timeout)


def chained_connector(proxy: OuterProxy, connect: Connect | None = None) -> Connector:
    """A connector that dials the host's outer-wall proxy and asks it for a tunnel to the name it
    is given (the "address" of a chained door's decision is the name: see `Decider`). It never
    dials anything else, and a refusal is an `OSError`, which the door answers as it answers a host
    that does not answer. `connect` is for a test."""

    def connector(name: str, port: int, timeout: float) -> socket.socket:
        if connect is None:
            return open_tunnel(proxy, name, port, timeout)
        return open_tunnel(proxy, name, port, timeout, connect=connect)

    return connector


@dataclass(frozen=True)
class Decision:
    """What the door does with a request: the addresses to connect to (allowed; for a chained door
    the one entry is the checked name, which the outer wall's proxy resolves), or the word of the
    refusal. `generation` is the version of the rule the decision was made under (0 for the
    door, whose rule never changes; the outer wall's rule is swapped at `narrow`, and a decision of
    an earlier generation is dropped by `ProxyServer.is_current`)."""

    addresses: tuple[str, ...] = ()
    reason: str | None = None
    generation: int = 0

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
        excluded: Callable[[str], bool] | None = None,
        chained: bool = False,
    ) -> None:
        self.matcher = RuleMatcher(rule)
        self._rule = rule
        self.log = log
        self._resolver = resolver
        self._test_network = test_network
        self._excluded = excluded
        # A door chained to the outer wall's proxy decides on the name, the port and the rule and
        # leaves the lookup and the public-address check to that proxy, which makes them with this
        # same decision (a VM has no name server it can reach).
        self._chained = chained

    def decide(self, host: str, port: int) -> Decision:
        if is_ip_literal(host):
            return Decision(reason=REASON_IP_LITERAL)
        name = ascii_name(host)
        if name is None:
            return Decision(reason=REASON_BAD_REQUEST)
        if not self._rule.allows_port(port):
            return Decision(reason=REASON_PORT)
        if not self.matcher.allows(name):
            return Decision(reason=REASON_NOT_LISTED)
        if self._chained:
            return Decision(addresses=(name,))
        found: Resolution = resolve_public(
            name, port, self._resolver, self._test_network, self._excluded
        )
        if found.reason is not None:
            return Decision(reason=found.reason)
        return Decision(addresses=found.addresses)


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

    def _refuse(self, client: socket.socket, code: int, reason: str | None) -> None:
        respond(client, code, reason, self.proxy.voice)

    def handle(self) -> None:
        client: socket.socket = self.request
        proxy = self.proxy
        if not proxy.slots.acquire(blocking=False):
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_TOO_MANY)
            self._refuse(client, 503, REASON_TOO_MANY)
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
        head = read_head(client)
        if head is None:
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_BAD_REQUEST)
            self._refuse(client, 400, REASON_BAD_REQUEST)
            return
        parts = head.request_line.split(" ")
        if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_BAD_REQUEST)
            self._refuse(client, 400, REASON_BAD_REQUEST)
            return
        method, target, _version = parts
        if _METHOD_TOKEN.fullmatch(method) is None:
            proxy.log.add("", 0, OUTCOME_REFUSED, REASON_BAD_REQUEST)
            self._refuse(client, 400, REASON_BAD_REQUEST)
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
            self._refuse(client, 400, REASON_BAD_REQUEST)
            return
        decision = proxy.decider.decide(authority.host, authority.port)
        if not decision.allowed:
            proxy.log.add(authority.host, authority.port, OUTCOME_REFUSED, decision.reason)
            self._refuse(client, 403, decision.reason)
            return
        if not self._current(decision, authority):
            self._refuse(client, 403, REASON_RULE_CHANGED)
            return
        name = ascii_name(authority.host) or authority.host
        gate = proxy.registry_gate
        if gate is not None and is_registry_name(name):
            self._registry(client, gate, name, authority, path, decision.addresses, head.rest)
            return
        upstream = self._connect(decision.addresses, authority.port)
        if upstream is None:
            proxy.log.add(authority.host, authority.port, OUTCOME_REFUSED, REASON_UPSTREAM)
            self._refuse(client, 502, REASON_UPSTREAM)
            return
        try:
            # Nothing of the client's, read before this point, is sent under a rule that is gone.
            if not self._current(decision, authority):
                self._refuse(client, 403, REASON_RULE_CHANGED)
                return
            if path is None:
                respond(client, 200)
                pending = head.rest
            else:
                host_header = name if authority.port == 80 else f"{name}:{authority.port}"
                upstream.sendall(forwarded_head(method, path, host_header, head.headers))
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

    def _current(self, decision: Decision, authority: Authority) -> bool:
        """Whether the rule the decision was made under still holds; a refusal is logged here."""
        if self.proxy.is_current(decision):
            return True
        self.proxy.log.add(authority.host, authority.port, OUTCOME_REFUSED, REASON_RULE_CHANGED)
        return False

    def _registry(
        self,
        client: socket.socket,
        gate: RegistryGate,
        name: str,
        authority: Authority,
        path: str | None,
        addresses: tuple[str, ...],
        pending: bytes,
    ) -> None:
        """A package registry (#784): a tunnel to it on port 443 is ended here and read as HTTP,
        GET and HEAD only; plain HTTP and port 80 are refused (a registry is served over HTTPS).
        A client that sent bytes after its `CONNECT` before the answer (a TLS hello in a hurry) is
        refused: nothing is replayed into the handshake."""
        proxy = self.proxy
        if path is not None or authority.port != 443:
            proxy.log.add(name, authority.port, OUTCOME_REFUSED, REASON_REGISTRY)
            self._refuse(client, 403, REASON_REGISTRY)
            return
        if pending:
            proxy.log.add(name, authority.port, OUTCOME_REFUSED, REASON_BAD_REQUEST)
            self._refuse(client, 400, REASON_BAD_REQUEST)
            return
        respond(client, 200)
        gate.serve(client, name, addresses, self._connect)

    def _connect(self, addresses: tuple[str, ...], port: int) -> socket.socket | None:
        """To one of the addresses that were checked, in order; never to the name."""
        for address in addresses:
            try:
                return self.proxy.connector(address, port, CONNECT_SECONDS)
            except OSError:
                continue
        return None


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
        registry_gate: RegistryGate | None = None,
        voice: str = "network door",
    ) -> None:
        # Who speaks in the body of a refusal: the outer wall's proxy (#979) is this class too.
        self.voice = voice
        self.decider = decider
        self.registry_gate = registry_gate
        self.log = decider.log
        self.connector = connector
        self.slots = threading.BoundedSemaphore(max_connections)
        super().__init__(bind, _Handler)

    def is_current(self, decision: Decision) -> bool:
        """Whether `decision` was made under the rule that holds now. The door's rule never changes
        (always); the outer wall's does, and says so here."""
        _ = decision
        return True

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
