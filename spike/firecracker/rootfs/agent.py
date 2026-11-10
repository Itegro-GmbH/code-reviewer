#!/usr/bin/python3 -I
"""Spike #970: the guest's vsock endpoint (the production vm-init is #977; this only proves the channel).

  agent.py daemon          listens on vsock port 5000 (host -> guest): one JSON line in, one JSON line out
  agent.py event NAME [k=v ...]   connects to the host (CID 2) port 5001 and sends one event line (guest -> host)

Requests: ping | start (the payload; answers, then reports "exit" to the host) | exec | shutdown
"""
import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
import time

HOST_CID = 2
CMD_PORT = 5000
EVT_PORT = 5001
MAX_OUT = 200_000


def uptime() -> float:
    with open("/proc/uptime") as f:
        return float(f.read().split()[0])


def event(name: str, **fields) -> None:
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.settimeout(5)
    try:
        s.connect((HOST_CID, EVT_PORT))
        msg = {"type": "event", "name": name, "uptime": uptime(), **fields}
        s.sendall((json.dumps(msg) + "\n").encode())
        s.shutdown(socket.SHUT_WR)
        s.recv(16)  # the host's ack
    finally:
        s.close()


def handle(req: dict) -> dict:
    kind = req.get("type")
    if kind == "ping":
        return {"ok": True, "uptime": uptime(), "pid": os.getpid()}
    if kind == "start":
        payload = req.get("payload", {})
        os.makedirs("/run/job", exist_ok=True)
        with open("/run/job/start.json", "w") as f:
            json.dump(payload, f)
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()

        def finish() -> None:
            time.sleep(0.2)  # the "job"
            event("exit", jobId=payload.get("jobId"), code=0, payloadSha256=digest)

        threading.Thread(target=finish, daemon=True).start()
        return {"ok": True, "jobId": payload.get("jobId"), "payloadSha256": digest, "keys": sorted(payload)}
    if kind == "exec":
        timeout = float(req.get("timeout", 60))
        t0 = time.monotonic()
        try:
            p = subprocess.run(
                ["/bin/bash", "-c", req["cmd"]],
                capture_output=True,
                timeout=timeout,
                input=req.get("stdin", "").encode() if req.get("stdin") else None,
            )
            return {
                "ok": True,
                "rc": p.returncode,
                "stdout": p.stdout.decode(errors="replace")[-MAX_OUT:],
                "stderr": p.stderr.decode(errors="replace")[-MAX_OUT:],
                "ms": int((time.monotonic() - t0) * 1000),
            }
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "timeout", "ms": int((time.monotonic() - t0) * 1000)}
    if kind == "shutdown":
        def stop() -> None:
            time.sleep(0.2)
            os.sync()
            with open("/proc/sys/kernel/sysrq", "w") as f:
                f.write("1")
            with open("/proc/sysrq-trigger", "w") as f:
                f.write("b")  # hard reboot: Firecracker exits on a reboot (boot arg reboot=k)

        threading.Thread(target=stop, daemon=True).start()
        return {"ok": True}
    return {"ok": False, "error": f"unknown type {kind!r}"}


def serve(conn: socket.socket) -> None:
    try:
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = conn.recv(65536)
            if not chunk:
                break
            buf += chunk
        resp = handle(json.loads(buf))
        conn.sendall((json.dumps(resp) + "\n").encode())
    except Exception as e:  # noqa: BLE001 - the spike reports every failure to the host
        try:
            conn.sendall((json.dumps({"ok": False, "error": repr(e)}) + "\n").encode())
        except OSError:
            pass
    finally:
        conn.close()


def main() -> None:
    if sys.argv[1] == "event":
        extra = dict(a.split("=", 1) for a in sys.argv[3:])
        event(sys.argv[2], **extra)
        return
    s = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    s.bind((socket.VMADDR_CID_ANY, CMD_PORT))
    s.listen(16)
    while True:
        conn, _ = s.accept()
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    main()
