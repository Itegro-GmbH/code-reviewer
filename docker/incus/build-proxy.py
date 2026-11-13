#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""The only way out of the golden image's build instance (#1020): a forward proxy for apt.

The build instance sits on a bridge of its own with no NAT and no routing (on the DevBox, which runs
another user's Docker, NATed traffic of an Incus bridge does not leave the host; spike #1005 built
its image through a host proxy for the same reason), and its packages come from the Ubuntu
archive. This proxy listens on the host's address of that bridge only, serves plain `GET` with an
absolute URI and `CONNECT`, and only to the hosts named on the command line, port 80 and 443, and
only to a public IPv4 address. It writes nothing but a line per refusal to standard error.
Standard library only.

    build-proxy.py <listen address> <port> <allowed host> [<allowed host> ...]"""

import contextlib
import ipaddress
import socket
import sys
import threading
from urllib.parse import urlsplit

PORTS = (80, 443)
HEAD_LIMIT = 16384


def public_address(host: str, allowed: frozenset[str]) -> str | None:
    if host.lower() not in allowed:
        return None
    for family, _, _, _, sockaddr in socket.getaddrinfo(host, None, socket.AF_INET):
        _ = family
        address = ipaddress.ip_address(sockaddr[0])
        if address.is_global:
            return str(address)
    return None


def relay(source: socket.socket, target: socket.socket) -> None:
    try:
        while data := source.recv(65536):
            target.sendall(data)
    except OSError:
        pass
    finally:
        for each in (source, target):
            with contextlib.suppress(OSError):
                each.shutdown(socket.SHUT_RDWR)


def serve(client: socket.socket, allowed: frozenset[str]) -> None:
    with client:
        client.settimeout(60)
        head = b""
        try:
            while b"\r\n\r\n" not in head and len(head) < HEAD_LIMIT:
                chunk = client.recv(4096)
                if not chunk:
                    return
                head += chunk
        except OSError:
            return
        request_line, _, rest = head.partition(b"\r\n")
        try:
            method, target, version = request_line.decode("ascii").split(" ")
            if method == "CONNECT":
                host, _, port_text = target.rpartition(":")
                port = int(port_text)
                path = ""
            else:
                parts = urlsplit(target)
                host, port = parts.hostname or "", parts.port or 80
                path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        except ValueError:
            client.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return
        address = public_address(host, allowed) if port in PORTS else None
        if address is None:
            sys.stderr.write(f"build-proxy: refused {method} {host}:{port}\n")
            client.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n")
            return
        try:
            upstream = socket.create_connection((address, port), timeout=30)
        except OSError:
            client.sendall(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n")
            return
        client.settimeout(None)
        upstream.settimeout(None)
        if method == "CONNECT":
            client.sendall(b"HTTP/1.1 200 Connection established\r\n\r\n")
            leftover = rest.partition(b"\r\n\r\n")[2]
            if leftover:
                upstream.sendall(leftover)
        else:
            headers = [
                line
                for line in rest.split(b"\r\n")
                if line and not line.lower().startswith((b"proxy-", b"connection:"))
            ]
            # apt's requests have no body.
            upstream.sendall(
                f"{method} {path} {version}\r\n".encode()
                + b"\r\n".join(headers)
                + b"\r\nConnection: close\r\n\r\n"
            )
        threading.Thread(target=relay, args=(upstream, client), daemon=True).start()
        relay(client, upstream)


def main(arguments: list[str]) -> int:
    if len(arguments) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    address, port = arguments[0], int(arguments[1])
    allowed = frozenset(name.lower() for name in arguments[2:])
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((address, port))
    listener.listen(32)
    print("ready", flush=True)
    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client, allowed), daemon=True).start()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
