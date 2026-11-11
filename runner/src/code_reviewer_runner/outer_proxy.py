# SPDX-License-Identifier: LicenseRef-Proprietary

"""The outer-wall proxy as the software inside a local VM sees it (#994, Runner v2, epic #969, ADR
0005, decision 7).

On a customer's machine the VM has no direct internet: the static nft table lets its TAP reach one
thing, the proxy of the local Dispatcher on the slot's host address (`http://<address>:3128`,
`factory_runner/firecracker/proxy_wall.py`). Every client in the VM that dials the internet has to
go through it. The address is the host's: it reaches the VM in the start payload
(`contracts/vm-init.v1.json`, `outerProxy`), vm-init hands it to Control on its stdin, and Control
hands it to the processes and containers it starts. **A job never names it**: nothing of a job
document is read for it, and a value outside the slots' network is refused.

Fail closed is the rule of every user of this module: a client that has a proxy and is refused by it
(or cannot reach it) fails; none falls back to a direct connection. The proxy does the name lookup
and the public-address check, so a client that is chained to it does not resolve the name itself (a
guest has no name server it can reach).

Standard library only: the doors run this in the Worker image and nothing else of the runner is
needed to import it.
"""

import ipaddress
import re
import socket
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Final

# The variable Control sets in the environment of the job process (never in a job's document).
OUTER_PROXY_VARIABLE: Final = "RUNNER_OUTER_PROXY"
# What the host's address on a slot's TAP may be: a private IPv4 address. The slots' network is
# chosen by the installer for each machine (`firecracker/slots.py`, `outer-wall.nft`), and a VM does
# not know it, so the rule is the one every such network satisfies; the nft table is what lets the
# VM reach exactly its slot's address.
PRIVATE_NETWORKS: Final = (
    ipaddress.IPv4Network("10.0.0.0/8"),
    ipaddress.IPv4Network("172.16.0.0/12"),
    ipaddress.IPv4Network("192.168.0.0/16"),
)
# How a client says no proxy is needed for a destination inside its own namespace (a local socket of
# the container): loopback never leaves it, so it is no way out.
LOOPBACK_NO_PROXY: Final = "localhost,127.0.0.1,::1"
PROXY_VARIABLES: Final = ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")
NO_PROXY_VARIABLES: Final = ("NO_PROXY", "no_proxy")

# A name the tunnel is asked for: the lower-case, ASCII form of a host name (the door's
# `ascii_name`). Never a space or a control character, so a name cannot add a header line.
_TUNNEL_HOST: Final = re.compile(r"[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?")
_STATUS_LINE: Final = re.compile(rb"HTTP/1\.[01] (\d{3})(?: |\r\n)")
# The head of the proxy's answer to a `CONNECT`: a status line and a few headers.
_MAX_HEAD_BYTES: Final = 8 * 1024


class OuterProxyError(ValueError):
    """The proxy address is not one the host could have given. Names the field, never a value."""


class TunnelRefused(OSError):
    """The proxy answered a `CONNECT` with a status other than 200 (the rule does not allow the
    name, or it could not be reached) or with something that is not an answer. `status` is 0 for the
    latter."""

    def __init__(self, status: int) -> None:
        super().__init__(f"the outer wall's proxy refused the tunnel (status {status})")
        self.status = status


@dataclass(frozen=True)
class OuterProxy:
    """The proxy of this VM's slot: a private IPv4 address (the host's on its TAP) and a port."""

    host: str
    port: int

    def __post_init__(self) -> None:
        try:
            address = ipaddress.IPv4Address(self.host)
        except ValueError:
            raise OuterProxyError("the outer proxy's host is not an IPv4 address") from None
        if str(address) != self.host or not any(address in each for each in PRIVATE_NETWORKS):
            raise OuterProxyError("the outer proxy's host is not a private IPv4 address")
        if isinstance(self.port, bool) or not 1 <= self.port <= 65535:
            raise OuterProxyError("the outer proxy's port is not a port")

    @property
    def address(self) -> str:
        return f"{self.host}:{self.port}"

    @property
    def url(self) -> str:
        return f"http://{self.address}"

    def to_json(self) -> dict[str, Any]:
        return {"host": self.host, "port": self.port}

    def tool_environment(self) -> list[str]:
        """`NAME=value` entries for the container of a tool that reads the usual variables (the
        Setup container's script, and the package managers and Docker daemon in it). Both spellings
        are set: tools differ in which one they read. Loopback is not proxied; it never leaves the
        container's own network namespace."""
        return [
            *(f"{name}={self.url}" for name in PROXY_VARIABLES),
            *(f"{name}={LOOPBACK_NO_PROXY}" for name in NO_PROXY_VARIABLES),
        ]

    @classmethod
    def from_json(cls, value: object) -> "OuterProxy":
        """The `{"host", "port"}` of Control's stdin, or `OuterProxyError`."""
        if not isinstance(value, dict):
            raise OuterProxyError("the outer proxy is not an object")
        given: dict[str, Any] = value  # pyright: ignore[reportUnknownVariableType]
        if given.keys() != {"host", "port"}:
            raise OuterProxyError("the outer proxy has other fields than host and port")
        host, port = given["host"], given["port"]
        if not isinstance(host, str):
            raise OuterProxyError("the outer proxy's host is not text")
        if not isinstance(port, int) or isinstance(port, bool):
            raise OuterProxyError("the outer proxy's port is not a number")
        return cls(host, port)

    @classmethod
    def from_address(cls, text: str) -> "OuterProxy":
        """`host:port`, the form of `OUTER_PROXY_VARIABLE`."""
        host, colon, port = text.partition(":")
        if not colon or not port.isascii() or not port.isdigit() or len(port) > 5:
            raise OuterProxyError("the outer proxy is not host:port")
        return cls(host, int(port))


def outer_proxy_of(environment: Mapping[str, str]) -> OuterProxy | None:
    """The proxy Control handed this process, or None when it handed none (hosted, or a local
    machine without the outer wall). Raises `OuterProxyError` for a value that is set and is not
    one: a process that is told to use a proxy and cannot read which one does not dial directly."""
    text = environment.get(OUTER_PROXY_VARIABLE)
    if text is None:
        return None
    return OuterProxy.from_address(text.strip())


Connect = Callable[[tuple[str, int], float], socket.socket]


def _read_head(sock: socket.socket, deadline: float) -> bytes:
    """The answer up to and including the blank line, and nothing more: a proxy that sends bytes
    after its head has sent bytes of the origin before the client spoke, which no origin does."""
    data = b""
    while b"\r\n\r\n" not in data:
        if len(data) > _MAX_HEAD_BYTES:
            raise TunnelRefused(0)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("the proxy did not answer in time")
        sock.settimeout(remaining)
        chunk = sock.recv(4096)
        if not chunk:
            raise TunnelRefused(0)
        data += chunk
    head, _, rest = data.partition(b"\r\n\r\n")
    if rest:
        raise TunnelRefused(0)
    return head


def open_tunnel(
    proxy: OuterProxy,
    host: str,
    port: int,
    timeout: float,
    *,
    connect: Connect = lambda address, seconds: socket.create_connection(address, timeout=seconds),
) -> socket.socket:
    """A tunnel to `host:port` through the proxy: connects to the proxy, asks for `CONNECT
    host:port` and returns the socket once the proxy answered 200. The name is the proxy's to look
    up and to judge; nothing is resolved here. `timeout` bounds the connection and the answer
    together. Raises `TunnelRefused` for any other answer, `OSError` or `TimeoutError` when the
    proxy cannot be reached; the socket is closed then. `ValueError` for a name that is not a host
    name or a port that is not one (nothing is sent)."""
    if _TUNNEL_HOST.fullmatch(host) is None or not 1 <= port <= 65535:
        raise ValueError("not a host and a port a tunnel can be asked for")
    started = time.monotonic()
    raw = connect((proxy.host, proxy.port), timeout)
    try:
        request = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n"
        raw.settimeout(max(timeout - (time.monotonic() - started), 0.001))
        raw.sendall(request.encode("ascii"))
        head = _read_head(raw, started + timeout)
        found = _STATUS_LINE.match(head + b"\r\n")
        status = int(found.group(1)) if found is not None else 0
        if status != 200:
            raise TunnelRefused(status)
    except BaseException:
        raw.close()
        raise
    return raw
