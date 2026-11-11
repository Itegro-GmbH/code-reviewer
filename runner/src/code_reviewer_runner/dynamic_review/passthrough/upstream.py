# SPDX-License-Identifier: LicenseRef-Proprietary

"""The connection from the supervisor to the provider (#550): https, pinned, no redirect.

`HttpsUpstream` is the only thing that holds the real key's destination. One job has one trusted
base URL (`address.check_base_url`). Every call opens its own connection and:

1. resolves the name and judges **every** address it resolves to (one non-public address refuses the
   name: the connection may pick any of them);
2. connects to an address that was judged, port 443, and never to the name again, so a name that
   changes its answer between the check and the connection cannot redirect the key;
3. speaks TLS to the name (certificate and name verified), and sends the request without following a
   redirect: a 3xx is a status like any other and its `Location` is never read.

Every wait is bounded by the **budget of the call** (`send`'s `timeout`, which the proxy takes as
the smaller of its own limit and the time the job has left): the name lookup (a thread that is
given up on after the budget: `getaddrinfo` has no timeout of its own), each connection attempt
(the budget that is left after the attempts before it, never a fallback), the TLS handshake (what is
left after the connection) and then each read of the answer. A call with no budget makes no
lookup and no connection.

**Through the outer wall's proxy** (#994, a model door in a VM on a customer's machine, `proxy`):
the VM has no direct internet and no name server, so the door does not resolve the name or connect
to an address itself. It asks the host's proxy for `CONNECT <name>:443` and speaks TLS to the name
through the tunnel (certificate and name verified as ever); the proxy looks the name up, judges
every address and connects to one it checked, which is this module's own check done by the same
decision (`implementer/netdoor/proxy.py`). A proxy that refuses, or cannot be reached, is a call
that never left (`address_refused` for a refusal, `unreachable` otherwise): nothing falls back to a
direct connection.

The seam (`Upstream`) is what the proxy sees; tests put a loopback double behind it. The
resolver, the TCP connect, the TLS wrap and the clock are injectable for the same reason, and the
defaults are the real ones.
"""

import http.client
import socket
import ssl
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol
from urllib.parse import urlsplit

from code_reviewer_runner.dynamic_review.passthrough.address import (
    check_base_url,
    is_public_address,
)
from code_reviewer_runner.outer_proxy import OuterProxy, TunnelRefused, open_tunnel


class UpstreamFailure(StrEnum):
    # The name resolves to nothing, the connection or the TLS handshake failed, or the answer is
    # not HTTP.
    UNREACHABLE = "unreachable"
    TIMEOUT = "timeout"
    # An address of the name is not public: nothing was sent.
    ADDRESS_REFUSED = "address_refused"
    # The answer ended before it was complete.
    CUT = "cut"


class UpstreamError(Exception):
    """A call without an answer, or an answer that stopped. The text never names the destination."""

    def __init__(self, kind: UpstreamFailure, *, sent: bool = False) -> None:
        super().__init__(kind.value)
        self.kind = kind
        # Whether the request had been sent: a call that never left may be given back, one that
        # did may have been billed.
        self.sent = sent


@dataclass(frozen=True)
class UpstreamRequest:
    """`path` is below the job's base URL (a route and its query). The key is among the headers."""

    path: str
    headers: Mapping[str, str]
    body: bytes


class UpstreamResponse(Protocol):
    status: int
    headers: list[tuple[str, str]]

    def read(self, size: int, timeout: float | None = None) -> bytes:
        """The next bytes of the body as they arrive, `b""` at the end. `timeout` is how long this
        read may wait (the proxy sets it before every read, to the budget of the call or what the
        job has left). `UpstreamError` when the connection stops before the body is complete."""
        ...

    def close(self) -> None: ...


class Upstream(Protocol):
    def send(self, request: UpstreamRequest, timeout: float) -> UpstreamResponse:
        """Send a POST and return as soon as the status and headers are in. `timeout` is the wait
        for connecting and for each read. Raises `UpstreamError`."""
        ...


Resolver = Callable[[str], list[str]]
Connector = Callable[[tuple[str, int], float], Any]
TlsWrapper = Callable[[Any, str], Any]


def _system_resolve(host: str) -> list[str]:
    found = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    # The scope of a link-local IPv6 address (`%eth0`) is no part of the address.
    return list(dict.fromkeys(str(entry[4][0]).split("%")[0] for entry in found))


def _tcp_connect(address: tuple[str, int], timeout: float) -> socket.socket:
    return socket.create_connection(address, timeout=timeout)


def _resolve_within(resolve: Resolver, host: str, budget: float) -> list[str]:
    """The addresses of `host`, or a timeout when the lookup takes longer than `budget`.

    `getaddrinfo` cannot be given a timeout, so the lookup runs in a thread that is given up on
    (it is a daemon and ends with its lookup). At most one call is in flight per job, and a call
    waits for this at most once, so a hanging resolver costs one idle thread per call.
    """
    found: list[list[str]] = []
    failed: list[BaseException] = []

    def lookup() -> None:
        try:
            found.append(resolve(host))
        except BaseException as error:
            failed.append(error)

    thread = threading.Thread(target=lookup, daemon=True)
    thread.start()
    thread.join(budget)
    if thread.is_alive():
        raise UpstreamError(UpstreamFailure.TIMEOUT)
    if failed or not found:
        raise UpstreamError(UpstreamFailure.UNREACHABLE)
    return found[0]


def _checked_addresses(host: str, resolve: Resolver, budget: float) -> list[str]:
    literal = host.startswith("[") or host.replace(".", "").isdigit()
    addresses = [host.strip("[]")] if literal else _resolve_within(resolve, host, budget)
    if not addresses:
        raise UpstreamError(UpstreamFailure.UNREACHABLE)
    if not all(is_public_address(address) for address in addresses):
        raise UpstreamError(UpstreamFailure.ADDRESS_REFUSED)
    return addresses


class _PinnedConnection(http.client.HTTPSConnection):
    """An HTTPS connection that connects to an address it judged itself, not to the name. Through
    the outer wall's proxy (`proxy`) it connects to a tunnel the proxy made to the name, and judges
    nothing itself: the proxy does."""

    def __init__(
        self,
        host: str,
        timeout: float,
        resolve: Resolver,
        connect: Connector,
        tls: TlsWrapper,
        clock: Callable[[], float],
        proxy: OuterProxy | None = None,
    ) -> None:
        super().__init__(host, 443, timeout=timeout)
        self._resolve, self._connect, self._tls, self._clock = resolve, connect, tls, clock
        self._proxy = proxy

    def connect(self) -> None:
        budget = float(self.timeout or 0)
        started = self._clock()

        def left() -> float:
            remaining = budget - (self._clock() - started)
            if remaining <= 0:
                raise UpstreamError(UpstreamFailure.TIMEOUT)
            return remaining

        if self._proxy is not None:
            self._secure(self._tunnel(self._proxy, left()), left, budget)
            return
        failure = UpstreamError(UpstreamFailure.UNREACHABLE)
        for address in _checked_addresses(self.host, self._resolve, left()):
            try:
                raw = self._connect((address, 443), left())
            except TimeoutError:
                failure = UpstreamError(UpstreamFailure.TIMEOUT)
                continue
            except OSError:
                continue
            self._secure(raw, left, budget)
            return
        raise failure

    def _tunnel(self, proxy: OuterProxy, seconds: float) -> Any:
        """A tunnel to the name through the proxy. The name is the proxy's to look up and to judge;
        a refusal is a call that never left."""
        try:
            return open_tunnel(proxy, self.host, 443, seconds, connect=self._connect)
        except TunnelRefused as refused:
            kind = UpstreamFailure.ADDRESS_REFUSED if refused.status == 403 else None
            raise UpstreamError(kind or UpstreamFailure.UNREACHABLE) from None
        except TimeoutError:
            raise UpstreamError(UpstreamFailure.TIMEOUT) from None
        except (OSError, ValueError):
            raise UpstreamError(UpstreamFailure.UNREACHABLE) from None

    def _secure(self, raw: Any, left: Callable[[], float], budget: float) -> None:
        try:
            # What is left of the budget bounds the handshake; then each read gets the budget.
            raw.settimeout(left())
            self.sock = self._tls(raw, self.host)
            self.sock.settimeout(budget)
        except UpstreamError:
            raw.close()
            raise
        except TimeoutError:
            raw.close()
            raise UpstreamError(UpstreamFailure.TIMEOUT) from None
        except OSError:
            raw.close()
            raise UpstreamError(UpstreamFailure.UNREACHABLE) from None


class HttpUpstreamResponse:
    def __init__(
        self, connection: http.client.HTTPConnection, response: http.client.HTTPResponse
    ) -> None:
        self._connection = connection
        self._response = response
        self.status = response.status
        self.headers = list(response.getheaders())
        length = response.getheader("Content-Length")
        # `read1` does not notice an answer that ends before its stated length: count it here.
        self._missing = (
            int(length)
            if length is not None and length.isdigit() and not response.chunked
            else None
        )

    def read(self, size: int, timeout: float | None = None) -> bytes:
        sock = self._connection.sock
        if timeout is not None and sock is not None:
            sock.settimeout(timeout)
        try:
            data = self._response.read1(size)
        except TimeoutError:
            raise UpstreamError(UpstreamFailure.TIMEOUT, sent=True) from None
        except (http.client.HTTPException, OSError):
            raise UpstreamError(UpstreamFailure.CUT, sent=True) from None
        if self._missing is not None:
            if not data and self._missing > 0:
                raise UpstreamError(UpstreamFailure.CUT, sent=True)
            self._missing -= len(data)
        return data

    def close(self) -> None:
        self._response.close()
        self._connection.close()


class HttpsUpstream:
    """The provider of one job. Built at job start: a base URL that may not hold the key raises
    `UpstreamRefused` then, before any call."""

    def __init__(
        self,
        base_url: str,
        *,
        resolve: Resolver = _system_resolve,
        connect: Connector = _tcp_connect,
        tls: TlsWrapper | None = None,
        clock: Callable[[], float] = time.monotonic,
        proxy: OuterProxy | None = None,
    ) -> None:
        parts = urlsplit(check_base_url(base_url))
        self._host = parts.netloc
        self._base_path = parts.path
        self._resolve, self._connect, self._clock = resolve, connect, clock
        self._proxy = proxy
        context = ssl.create_default_context()
        self._tls: TlsWrapper = tls or (
            lambda raw, hostname: context.wrap_socket(raw, server_hostname=hostname)
        )

    def send(self, request: UpstreamRequest, timeout: float) -> UpstreamResponse:
        if timeout <= 0:
            # No budget is no wait at all (a falsy timeout once fell back to 120 seconds).
            raise UpstreamError(UpstreamFailure.TIMEOUT)
        connection = _PinnedConnection(
            self._host, timeout, self._resolve, self._connect, self._tls, self._clock, self._proxy
        )
        try:
            # Connecting first, apart from sending, tells a call that never left from one that did.
            connection.connect()
        except UpstreamError:
            connection.close()
            raise
        try:
            connection.request(
                "POST",
                self._base_path + request.path,
                body=request.body,
                headers=dict(request.headers),
            )
            response = connection.getresponse()
        except TimeoutError:
            connection.close()
            raise UpstreamError(UpstreamFailure.TIMEOUT, sent=True) from None
        except (http.client.HTTPException, OSError):
            connection.close()
            raise UpstreamError(UpstreamFailure.CUT, sent=True) from None
        return HttpUpstreamResponse(connection, response)
