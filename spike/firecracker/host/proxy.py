#!/usr/bin/env python3
"""Spike #970: the host proxy the VM's only way out: HTTP CONNECT (and GET /health). Runs as the normal user.
Stands in for the Dispatcher's proxy (#979); it logs every CONNECT with the VM's source address (which VM = which TAP /30)."""
import asyncio
import os
import sys
import time

PORT = int(os.environ.get("PROXY_PORT", "3128"))
LOG = open(os.environ.get("PROXY_LOG", "/dev/stderr"), "a", buffering=1)


def log(msg: str) -> None:
    LOG.write(f"{time.strftime('%H:%M:%S')} {msg}\n")


async def pipe(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    try:
        while data := await r.read(65536):
            w.write(data)
            await w.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        w.close()


async def handle(r: asyncio.StreamReader, w: asyncio.StreamWriter) -> None:
    peer = w.get_extra_info("peername")[0]
    try:
        head = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 10)
        first = head.split(b"\r\n", 1)[0].decode(errors="replace").split()
        if len(first) >= 2 and first[0] == "CONNECT":
            host, _, port = first[1].rpartition(":")
            log(f"{peer} CONNECT {host}:{port}")
            try:
                ur, uw = await asyncio.wait_for(asyncio.open_connection(host, int(port)), 10)
            except Exception as e:  # noqa: BLE001
                log(f"{peer} CONNECT {host}:{port} failed {e!r}")
                w.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                await w.drain()
                return
            w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await w.drain()
            await asyncio.gather(pipe(r, uw), pipe(ur, w))
        elif len(first) >= 2 and first[1] == "/health":
            log(f"{peer} GET /health")
            w.write(b"HTTP/1.0 200 OK\r\nContent-Length: 3\r\n\r\nok\n")
            await w.drain()
        else:
            w.write(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            await w.drain()
    except Exception as e:  # noqa: BLE001
        log(f"{peer} error {e!r}")
    finally:
        w.close()


async def main() -> None:
    srv = await asyncio.start_server(handle, "0.0.0.0", PORT)
    log(f"proxy listening on :{PORT} as uid {os.getuid()}")
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
