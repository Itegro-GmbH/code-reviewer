# SPDX-License-Identifier: LicenseRef-Proprietary

"""A package registry through the door, read-only (#784): the TLS connection of a `CONNECT` to a
registry name (`registries.py`) is ended in the door instead of tunnelled, and what is inside it
is read as HTTP.

* The client sees the door's certificate for the name it `CONNECT`ed to (`authority.py`) and must
  send that name as its server name; a handshake that does not is over before a byte of HTTP.
* One connection is **one request**. `GET` and `HEAD` go on; every other method is refused with a
  `403` (`method_not_allowed`), so `npm publish` (`PUT`), `twine upload` (`POST`), `cargo publish`
  and `gem push` never leave the door. A request in absolute form, a `Host` that is not the name
  of the connection (`host_mismatch`), a body (a `GET` with `Content-Length` other than 0 or with
  `Transfer-Encoding`) and a request that is not HTTP/1.x are refused. Bytes that follow the head
  are never forwarded.
* The door opens a **new** TLS connection to the registry: to an address it checked (the proxy's
  decision, never the name again), with the registry's name as server name, and the registry's
  certificate has to verify for that name against the door's own trust store. Whatever else is at
  the CDN address does not answer to it, which is what closes "another tenant on the same
  addresses". The request is forwarded with `Host` set to the name, `Connection: close` and without
  the hop-by-hop headers.
* The answer comes back with its head rewritten to `Connection: close` (the client opens a
  new connection for the next request) and its body relayed unread until the registry closes.

The log has host, 443, allowed or refused, a reason word and the bytes; no path, no header and no
body is kept.
"""

import contextlib
import re
import socket
import ssl
from collections.abc import Callable
from typing import Final

from ..network_rule import ascii_name
from .authority import Authority
from .connections import (
    OUTCOME_ALLOWED,
    OUTCOME_REFUSED,
    REASON_BAD_REQUEST,
    REASON_HOST_MISMATCH,
    REASON_METHOD,
    REASON_TLS,
    REASON_UPSTREAM,
    ConnectionLog,
)
from .registries import READ_METHODS
from .wire import HEAD_SECONDS, MAX_HEAD_BYTES, Head, forwarded_head, read_head, respond

HTTPS_PORT: Final = 443
CHUNK: Final = 64 * 1024
# A registry that sends nothing for this long is given up on; a download that is slow still sends.
IDLE_SECONDS: Final = 120.0
CONNECT_SECONDS: Final = 10.0
# Headers of a request that the door never forwards besides the hop-by-hop ones: the framing of a
# body (a read has none) and the wait for a `100 Continue`.
_NOT_FORWARDED = frozenset({"content-length", "transfer-encoding", "expect"})
# Headers of an answer that the door replaces: the connection is closed after it.
_ANSWER_DROPPED = frozenset({"connection", "keep-alive", "proxy-connection", "upgrade"})
_METHOD_TOKEN: Final = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
_STATUS_LINE: Final = re.compile(rb"HTTP/1\.[01] (\d{3})(?: |$)")

Connect = Callable[[tuple[str, ...], int], socket.socket | None]
UpstreamTls = Callable[[socket.socket, str], socket.socket]

_default_context: ssl.SSLContext | None = None


def system_upstream_tls(sock: socket.socket, name: str) -> socket.socket:
    """TLS to the registry: the door's trust store, certificate and host name verified for `name`,
    HTTP/1.1. Raises `ssl.SSLError` (or `OSError`) when the handshake or the check fails."""
    global _default_context
    if _default_context is None:
        context = ssl.create_default_context()
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.set_alpn_protocols(["http/1.1"])
        _default_context = context
    return _default_context.wrap_socket(sock, server_hostname=name)


def _host_is(values: list[str], name: str) -> bool:
    """Whether the request has exactly one `Host` and it names `name` (port 443 allowed)."""
    if len(values) != 1:
        return False
    host = values[0].lower()
    if host.endswith(":443"):
        host = host[:-4]
    return ascii_name(host) == name


def _target_is_origin_form(target: str) -> bool:
    return (
        target.startswith("/")
        and not target.startswith("//")
        and target.isprintable()
        and " " not in target
        and "#" not in target
    )


def _answer_head(raw: bytes) -> bytes | None:
    """The registry's answer head with `Connection: close`; None when it is not an HTTP/1 answer
    that is final (1xx answers, 101 included, are never relayed: nothing was asked for them)."""
    lines = raw.split(b"\r\n")
    found = _STATUS_LINE.match(lines[0])
    if found is None or int(found.group(1)) < 200:
        return None
    kept = [lines[0]]
    for line in lines[1:]:
        name = line.partition(b":")[0].strip().lower()
        if name.decode("latin-1") in _ANSWER_DROPPED:
            continue
        kept.append(line)
    kept.append(b"Connection: close")
    return b"\r\n".join(kept) + b"\r\n\r\n"


class RegistryGate:
    """Serves the connections to registry names. One for the whole door."""

    def __init__(
        self,
        authority: Authority,
        log: ConnectionLog,
        *,
        upstream_tls: UpstreamTls = system_upstream_tls,
    ) -> None:
        self._authority = authority
        self._log = log
        self._upstream_tls = upstream_tls

    @property
    def ca_pem(self) -> bytes:
        return self._authority.ca_pem

    def serve(
        self, client: socket.socket, name: str, addresses: tuple[str, ...], connect: Connect
    ) -> None:
        """The request on a `CONNECT` to `name` that was allowed (the `200` is sent). Closes
        `client` (it is wrapped by TLS here)."""
        try:
            client.settimeout(HEAD_SECONDS)
            tls = self._authority.server_context(name).wrap_socket(client, server_side=True)
        except (OSError, ValueError):
            # `ssl.SSLError` is an `OSError`: the client does not trust the door's certificate, sent
            # no or another server name, or spoke no TLS.
            self._refuse(name, REASON_TLS)
            return
        try:
            self._request(tls, name, addresses, connect)
        finally:
            with contextlib.suppress(OSError):
                tls.close()

    def _refuse(
        self,
        name: str,
        reason: str,
        answer: socket.socket | None = None,
        code: int = 403,
    ) -> None:
        self._log.add(name, HTTPS_PORT, OUTCOME_REFUSED, reason)
        if answer is not None:
            respond(answer, code, reason)

    def _request(
        self, tls: socket.socket, name: str, addresses: tuple[str, ...], connect: Connect
    ) -> None:
        head = read_head(tls)
        if head is None:
            self._refuse(name, REASON_BAD_REQUEST, tls, 400)
            return
        parts = head.request_line.split(" ")
        if (
            len(parts) != 3
            or not parts[2].startswith("HTTP/1.")
            or not _METHOD_TOKEN.fullmatch(parts[0])
        ):
            self._refuse(name, REASON_BAD_REQUEST, tls, 400)
            return
        method, target, _version = parts
        if method not in READ_METHODS:
            self._refuse(name, REASON_METHOD, tls)
            return
        problem = self._check(head, name, target)
        if problem is not None:
            code = 403 if problem == REASON_HOST_MISMATCH else 400
            self._refuse(name, problem, tls, code)
            return
        upstream = self._open(name, addresses, connect)
        if upstream is None:
            self._refuse(name, REASON_UPSTREAM, tls, 502)
            return
        try:
            self._forward(tls, upstream, name, method, target, head)
        finally:
            with contextlib.suppress(OSError):
                upstream.close()

    @staticmethod
    def _check(head: Head, name: str, target: str) -> str | None:
        """The reason word of a request that is not a plain read of `name`, else None."""
        if not _target_is_origin_form(target):
            return REASON_BAD_REQUEST
        hosts = [value for key, value in head.headers if key.lower() == "host"]
        if not _host_is(hosts, name):
            return REASON_HOST_MISMATCH
        for key, value in head.headers:
            lowered = key.lower()
            if lowered == "transfer-encoding" or (lowered == "content-length" and value != "0"):
                return REASON_BAD_REQUEST
        return None

    def _open(
        self, name: str, addresses: tuple[str, ...], connect: Connect
    ) -> socket.socket | None:
        """TLS to the registry at one of the addresses that were checked."""
        raw = connect(addresses, HTTPS_PORT)
        if raw is None:
            return None
        try:
            raw.settimeout(CONNECT_SECONDS)
            upstream = self._upstream_tls(raw, name)
            upstream.settimeout(IDLE_SECONDS)
            return upstream
        except (OSError, ValueError):
            with contextlib.suppress(OSError):
                raw.close()
            return None

    def _forward(
        self,
        tls: socket.socket,
        upstream: socket.socket,
        name: str,
        method: str,
        target: str,
        head: Head,
    ) -> None:
        tls.settimeout(IDLE_SECONDS)
        sent = [(k, v) for k, v in head.headers if k.lower() not in _NOT_FORWARDED]
        request = forwarded_head(method, target, name, sent)
        try:
            upstream.sendall(request)
            answer = self._read_answer_head(upstream)
        except OSError:
            answer = None
        if answer is None:
            self._refuse(name, REASON_UPSTREAM, tls, 502)
            return
        rewritten, rest = answer
        to_client = 0
        try:
            tls.sendall(rewritten)
            to_client += len(rewritten)
            if rest:
                tls.sendall(rest)
                to_client += len(rest)
            while True:
                data = upstream.recv(CHUNK)
                if not data:
                    break
                tls.sendall(data)
                to_client += len(data)
        except OSError:
            pass
        self._log.add(
            name,
            HTTPS_PORT,
            OUTCOME_ALLOWED,
            None,
            bytes_in=to_client,
            bytes_out=len(request),
        )

    @staticmethod
    def _read_answer_head(upstream: socket.socket) -> tuple[bytes, bytes] | None:
        """The registry's answer head, rewritten, and the body bytes that came with it."""
        data = b""
        while b"\r\n\r\n" not in data:
            if len(data) > MAX_HEAD_BYTES:
                return None
            chunk = upstream.recv(4096)
            if not chunk:
                return None
            data += chunk
        raw, _, rest = data.partition(b"\r\n\r\n")
        rewritten = _answer_head(raw)
        return None if rewritten is None else (rewritten, rest)
