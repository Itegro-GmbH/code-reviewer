# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the door's proxy and its read-only registry connections (`intercept.py`) both do on the
wire: read the head of a request, and answer with a refusal that says why in plain words."""

import contextlib
import socket
import time
from typing import Final

from .connections import (
    REASON_BAD_REQUEST,
    REASON_HOST_MISMATCH,
    REASON_IP_LITERAL,
    REASON_METHOD,
    REASON_NOT_LISTED,
    REASON_PORT,
    REASON_REGISTRY,
    REASON_TLS,
    REASON_TOO_MANY,
    REASON_UPSTREAM,
)

MAX_HEAD_BYTES: Final = 16 * 1024
HEAD_SECONDS: Final = 15.0

# The headers the door removes from a forwarded request: hop-by-hop ones, the proxy's own and the
# ones some servers read as a change of method (a registry that honoured them would turn the `GET`
# the door allowed into a write).
DROPPED = frozenset(
    {
        "x-http-method-override",
        "x-method-override",
        "x-http-method",
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

REASON_TEXT: Final = {
    REASON_NOT_LISTED: "the host is not in the environment's network list",
    REASON_IP_LITERAL: "an IP address is never allowed, use a host name",
    REASON_PORT: "this port is not allowed (the door dials 80 and 443, a rule may allow fewer)",
    REASON_BAD_REQUEST: "the request is not one this proxy serves",
    REASON_TOO_MANY: "too many connections at once",
    REASON_UPSTREAM: "the host could not be reached",
    REASON_METHOD: "package registries are read-only here: only GET and HEAD go through",
    REASON_HOST_MISMATCH: "the Host header is not the registry this connection was made to",
    REASON_REGISTRY: "package registries are reachable over HTTPS (port 443) only, read-only",
    REASON_TLS: "the TLS connection to the door's certificate was not completed",
    "private_address": "the host resolves to a private or special address",
    "unresolvable": "the host name could not be resolved",
}


def status_line(code: int) -> str:
    return {
        200: "Connection Established",
        400: "Bad Request",
        403: "Forbidden",
        502: "Bad Gateway",
        503: "Service Unavailable",
    }[code]


def respond(
    sock: socket.socket, code: int, reason: str | None = None, voice: str = "network door"
) -> None:
    """A complete answer; the refusal's body names the reason in plain words, for the person (or
    the agent) reading a failed `npm install`. `voice` says who refused (the door, or the outer
    wall's proxy of a customer's machine)."""
    text = "" if reason is None else REASON_TEXT.get(reason, reason)
    body = b"" if code == 200 else f"{voice}: {text}\n".encode("ascii", "replace")
    head = f"HTTP/1.1 {code} {status_line(code)}\r\n"
    if code != 200:
        head += (
            f"Content-Type: text/plain; charset=us-ascii\r\nContent-Length: {len(body)}\r\n"
            f"X-Network-Door: {reason or 'refused'}\r\nConnection: close\r\n"
        )
    with contextlib.suppress(OSError):
        sock.sendall(head.encode("ascii") + b"\r\n" + body)


class Head:
    def __init__(self, request_line: str, headers: list[tuple[str, str]], rest: bytes) -> None:
        self.request_line = request_line
        self.headers = headers
        self.rest = rest


def read_head(sock: socket.socket, seconds: float = HEAD_SECONDS) -> Head | None:
    """The request line and headers (up to a blank line, `MAX_HEAD_BYTES`), and any bytes that came
    after them. None for a head that is too long, not ASCII, cut off, or not complete within
    `seconds` in total (a client that sends a byte at a time does not keep the slot)."""
    data = b""
    end = time.monotonic() + seconds
    while b"\r\n\r\n" not in data:
        if len(data) > MAX_HEAD_BYTES:
            return None
        left = end - time.monotonic()
        if left <= 0:
            return None
        try:
            sock.settimeout(left)
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
    return Head(lines[0], headers, rest)


def forwarded_head(method: str, path: str, host: str, headers: list[tuple[str, str]]) -> bytes:
    lines = [f"{method} {path} HTTP/1.1", f"Host: {host}"]
    for name, value in headers:
        if name.lower() in DROPPED or "\r" in value or "\n" in value:
            continue
        lines.append(f"{name}: {value}")
    lines.append("Connection: close")
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii", "replace")
