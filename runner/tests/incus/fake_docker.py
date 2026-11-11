#!/usr/bin/python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""A stand-in for `docker` in the Incus lane (#1007), pushed into every instance of the lane's job.

It answers what the launcher asks of Docker (`info`, `image inspect`, `volume create`) and, for
`run`, **is Control**: it reads the job document on its stdin, serves what the spike (#1005) put
in A (the two doors on A's inner address; a "secret" endpoint and a "Docker API" on every address,
the worst case), and then follows the lane's orders by files in /tmp of A:

    /tmp/go       narrow over /ctl.sock, with the job's token (the real unix transport framing)
    /tmp/finish   report the end over /ctl.sock and exit 0
    /tmp/fill     write past the quota of A and exit with what the write said

It writes /tmp/ready when the servers listen and /tmp/narrow-reply with the host's answer.
Standard library only: it runs in the stock Ubuntu image."""

import json
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

CTL = "/ctl.sock"
DOORS = ("10.98.0.2", (8080, 8081))
EVERYWHERE = ("0.0.0.0", (9000, 2375))
READY, GO, FINISH, FILL = (
    Path("/tmp/ready"),
    Path("/tmp/go"),
    Path("/tmp/finish"),
    Path("/tmp/fill"),
)
REPLY = Path("/tmp/narrow-reply")


def listen(address: str, port: int) -> None:
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((address, port))
    server.listen(8)

    def serve() -> None:
        while True:
            try:
                client, _ = server.accept()
                client.sendall(b"HTTP/1.0 200 OK\r\n\r\nhere:" + str(port).encode())
                client.close()
            except OSError:
                return

    threading.Thread(target=serve, daemon=True).start()


def frame(document: dict[str, Any]) -> bytes:
    body = json.dumps(document, separators=(",", ":")).encode()
    return struct.pack(">I", len(body)) + body


def ask(document: dict[str, Any]) -> dict[str, Any]:
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(30)
    sock.connect(CTL)
    sock.sendall(frame(document))
    (length,) = struct.unpack(">I", sock.recv(4))
    body = b""
    while len(body) < length:
        body += sock.recv(length - len(body))
    sock.close()
    reply: dict[str, Any] = json.loads(body)
    return reply


def control() -> int:
    job: dict[str, Any] = json.loads(sys.stdin.readline())
    token = job["controlToken"]
    for port in DOORS[1]:
        listen(DOORS[0], port)
    for port in EVERYWHERE[1]:
        listen(EVERYWHERE[0], port)
    READY.write_text("1")
    while True:
        if GO.exists() and not REPLY.exists():
            narrow: dict[str, Any] = {
                "version": 1,
                "type": "narrow",
                "network": {"mode": "off", "hosts": []},
                "modelHost": "api.example.com",
                "token": token,
            }
            REPLY.write_text(json.dumps(ask(narrow)))
        if FINISH.exists():
            ask({"version": 1, "type": "end", "exitCode": 0, "token": token})
            return 0
        if FILL.exists():
            done = subprocess.run(
                ["dd", "if=/dev/zero", "of=/fill", "bs=1M", "count=100000"],
                capture_output=True,
                text=True,
                check=False,
            )
            sys.stderr.write(done.stderr)
            return 1
        time.sleep(0.1)


def main() -> int:
    args = sys.argv[1:]
    if args[:1] == ["info"] or args[:2] == ["volume", "create"]:
        return 0
    if args[:2] == ["image", "inspect"]:
        print(Path("/etc/code-reviewer/fake-image-id").read_text().strip())
        return 0
    if args[:1] == ["run"]:
        return control()
    sys.stderr.write("fake docker: not a command of the lane\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
