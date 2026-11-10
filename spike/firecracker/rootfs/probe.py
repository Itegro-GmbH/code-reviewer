#!/usr/bin/python3 -I
"""Spike #970: network probe run INSIDE the guest. Reads a JSON list of targets on stdin, prints a JSON list of results.

target: {"name", "proto": "tcp"|"udp"|"icmp", "addr", "port", "family": 4|6}
result: "connected" (TCP handshake, got the listener's banner), "refused" (RST: the host answered), "answered" (UDP echo / ping reply),
        "blocked" (timeout / unreachable: nothing came back)
"""
import json
import socket
import subprocess
import sys
import time

TIMEOUT = 3.0


def probe(t: dict) -> dict:
    fam = socket.AF_INET6 if t.get("family") == 6 else socket.AF_INET
    t0 = time.monotonic()
    result, detail = "blocked", ""
    try:
        if t["proto"] == "tcp":
            s = socket.socket(fam, socket.SOCK_STREAM)
            s.settimeout(TIMEOUT)
            s.connect((t["addr"], t["port"]))
            try:
                s.sendall(b"GET /health HTTP/1.0\r\nHost: x\r\n\r\n")
                detail = s.recv(120).decode(errors="replace").strip().splitlines()[0]
            except (socket.timeout, IndexError, OSError):
                pass
            result = "connected"
            s.close()
        elif t["proto"] == "udp":
            s = socket.socket(fam, socket.SOCK_DGRAM)
            s.settimeout(TIMEOUT)
            s.sendto(bytes.fromhex(t["hex"]) if t.get("hex") else b"ping", (t["addr"], t["port"]))
            data, _ = s.recvfrom(100)
            result, detail = "answered", data.decode(errors="replace")
            s.close()
        elif t["proto"] == "icmp":
            cmd = ["ping", "-6" if fam == socket.AF_INET6 else "-4", "-c", "1", "-W", "3", t["addr"]]
            p = subprocess.run(cmd, capture_output=True, timeout=10)
            result = "answered" if p.returncode == 0 else "blocked"
    except ConnectionRefusedError:
        result = "refused"
    except (socket.timeout, TimeoutError):
        result = "blocked"
    except OSError as e:
        result, detail = "blocked", f"{e.__class__.__name__}: {e.strerror or e}"
    return {**t, "result": result, "detail": detail, "ms": int((time.monotonic() - t0) * 1000)}


if __name__ == "__main__":
    from concurrent.futures import ThreadPoolExecutor

    targets = json.load(sys.stdin)
    with ThreadPoolExecutor(max_workers=16) as pool:
        print(json.dumps(list(pool.map(probe, targets))))
