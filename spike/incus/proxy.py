# SPDX-License-Identifier: LicenseRef-Proprietary
"""Spike #1005 stand-in for the outer wall's proxy (#979): a CONNECT-only proxy on the bridge address of the host.

It is NOT the product's proxy (`factory_runner/firecracker/proxy_wall.py`); it exists so that the spike can show an
instance whose only way out is a proxy on the host. It listens on one address, logs every request (peer, target, verdict)
as JSON lines and, like the product's, refuses an address (only names), a port other than 80/443 and a name whose
addresses are not all public. `--allow` limits it to a list of names (the "narrowed" rule); `--allow-file` is read at every
request, so a test can narrow it while a job runs.
"""

import argparse
import asyncio
import ipaddress
import json
import socket
import sys
import time


def verdict(host: str, port: int, allow: set[str] | None) -> tuple[bool, str]:
    try:
        ipaddress.ip_address(host.strip("[]"))
        return False, "address_literal"
    except ValueError:
        pass
    if port not in (80, 443):
        return False, "port"
    if allow is not None and host not in allow:
        return False, "not_in_rule"
    try:
        infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return False, "no_such_name"
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            return False, "not_public"
    return True, "ok"


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle(args: argparse.Namespace, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    peer = writer.get_extra_info("peername")[0]
    try:
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        writer.close()
        return
    line = head.split(b"\r\n", 1)[0].decode("latin1")
    parts = line.split()
    if len(parts) != 3 or parts[0] != "CONNECT" or ":" not in parts[1]:
        writer.write(b"HTTP/1.1 405 Only CONNECT\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    host, _, port_s = parts[1].rpartition(":")
    port = int(port_s) if port_s.isdigit() else 0
    allow = None
    if args.allow_file:
        try:
            allow = set(open(args.allow_file).read().split()) or None
        except OSError:
            allow = None
    elif args.allow:
        allow = set(args.allow)
    if args.upstream:
        # a door: no lookup of its own, the decision about addresses is the upstream proxy's (as the product's doors chain to the outer wall)
        ok, why = (port in (80, 443) and (allow is None or host in allow)), "door"
    else:
        ok, why = await asyncio.get_running_loop().run_in_executor(None, verdict, host, port, allow)
    print(json.dumps({"t": round(time.time(), 3), "peer": peer, "target": f"{host}:{port}", "ok": ok, "why": why}), flush=True)
    if not ok:
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    try:
        if args.upstream:
            uh, _, up = args.upstream.rpartition(":")
            up_r, up_w = await asyncio.wait_for(asyncio.open_connection(uh, int(up)), 10)
            up_w.write(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
            await up_w.drain()
            reply = await asyncio.wait_for(up_r.readuntil(b"\r\n\r\n"), 10)
            if b" 200 " not in reply.split(b"\r\n", 1)[0]:
                raise OSError("upstream refused")
        else:
            up_r, up_w = await asyncio.wait_for(asyncio.open_connection(host, port, family=socket.AF_INET), 10)
    except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError):
        writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
        await writer.drain()
        writer.close()
        return
    writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
    await writer.drain()
    await asyncio.gather(pipe(reader, up_w), pipe(up_r, writer))


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--listen", required=True, help="address to listen on (the bridge address, never 0.0.0.0)")
    p.add_argument("--port", type=int, default=3128)
    p.add_argument("--allow", nargs="*")
    p.add_argument("--allow-file")
    p.add_argument("--upstream", help="host:port of another CONNECT proxy to chain to (makes this a door)")
    args = p.parse_args()
    if args.listen in ("0.0.0.0", "::"):
        sys.exit("refusing to listen on a wildcard address")
    server = await asyncio.start_server(lambda r, w: handle(args, r, w), args.listen, args.port)
    print(json.dumps({"listening": f"{args.listen}:{args.port}"}), flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
