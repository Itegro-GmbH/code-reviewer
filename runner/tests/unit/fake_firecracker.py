# SPDX-License-Identifier: LicenseRef-Proprietary

"""A fake Firecracker for the launcher's tests (not a test file): the executable the launcher starts
(`firecracker --no-api --config-file <json>`), which behaves as a VM with vm-init in it, over the
real Unix sockets Firecracker's vsock uses: it listens on `<uds>` for the host's `CONNECT 5000`,
takes the start, and then talks to the host's `<uds>_5100` and `<uds>_5101` as Control and vm-init
do. What it does is named in the JSON file given as its first argument (`behavior`). It writes what
it saw to `<behavior file>.seen` (JSON). Run with the runner's own interpreter, which has the
package: `python fake_firecracker.py <behavior.json> --no-api --config-file <config.json>`."""

import json
import os
import socket
import sys
import time
from pathlib import Path
from typing import Any

from code_reviewer_runner.vm_init.wire import encode_frame, read_frame


def talk(path: str, document: dict[str, Any], *, again: bool = False) -> dict[str, Any] | None:
    sock = socket.socket(socket.AF_UNIX)
    try:
        sock.settimeout(5)
        sock.connect(path)
        sock.sendall(encode_frame(document))
        reply = read_frame(sock, deadline_seconds=5)
        return reply if isinstance(reply, dict) else None  # pyright: ignore[reportUnknownVariableType]
    except (OSError, TimeoutError, Exception):
        return None
    finally:
        sock.close()


def main() -> int:
    behavior_path = Path(sys.argv[1])
    behavior: dict[str, Any] = json.loads(behavior_path.read_text())
    config = json.loads(Path(sys.argv[sys.argv.index("--config-file") + 1]).read_text())
    uds: str = config["vsock"]["uds_path"]
    seen: dict[str, Any] = {"config": config, "cwd": os.getcwd(), "environ": dict(os.environ)}

    def save() -> None:
        behavior_path.with_suffix(".seen").write_text(json.dumps(seen))

    save()
    mode = behavior.get("mode", "good")
    if behavior.get("log_bytes"):
        # A VMM that is very talkative (a serial console, an error in a loop): what it writes to
        # its stderr, then a last line that the tail must hold.
        line = b"x" * 1023 + b"\n"
        for _ in range(int(behavior["log_bytes"]) // len(line)):
            sys.stderr.buffer.write(line)
        sys.stderr.buffer.write(b"LAST-LINE-OF-THE-VMM\n")
        sys.stderr.buffer.flush()
    if mode == "die_at_boot":
        return 1
    if mode == "report_before_start":
        time.sleep(behavior.get("delay", 0))
        seen["early_report"] = talk(
            uds + "_5101",
            {"version": 1, "type": "exit", "exitCode": 2, "reason": "start_timeout"},
        )
        save()
        return 0
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(uds)
    listener.listen(4)
    listener.settimeout(behavior.get("boot_wait", 20))
    connection, _ = listener.accept()
    connection.settimeout(10)
    line = b""
    while not line.endswith(b"\n"):
        line += connection.recv(1)
    seen["connect_line"] = line.decode()
    if mode == "no_ok":
        time.sleep(60)
        return 0
    connection.sendall(b"OK 1073741824\n")
    start = read_frame(connection, deadline_seconds=10)
    assert isinstance(start, dict)
    seen["start"] = start
    save()
    if mode == "refuse":
        connection.sendall(
            encode_frame(
                {"version": 1, "type": "refused", "for": "start", "reason": "invalid_start"}
            )
        )
        return 0
    if mode == "silent":
        time.sleep(60)
        return 0
    time.sleep(behavior.get("ack_delay", 0))
    connection.sendall(encode_frame({"version": 1, "type": "ack", "for": "start"}))
    connection.close()
    token = start["controlToken"]  # pyright: ignore[reportUnknownVariableType]
    if mode == "hang":
        time.sleep(600)
        return 0
    if mode == "no_report":
        time.sleep(behavior.get("run", 0))
        return 0
    seen["control"] = {}
    if mode == "forged":
        # The agent's container: no token, or another one.
        seen["control"]["forged_narrow_no_token"] = talk(
            uds + "_5100",
            {
                "version": 1,
                "type": "narrow",
                "network": {"mode": "off", "hosts": []},
                "modelHost": "api.example.com",
            },
        )
        seen["control"]["forged_end_wrong"] = talk(
            uds + "_5100", {"version": 1, "type": "end", "exitCode": 0, "token": "x" * 43}
        )
        seen["forged_report_wrong"] = talk(
            uds + "_5101",
            {
                "version": 1,
                "type": "exit",
                "exitCode": 0,
                "reason": "worker_exited",
                "token": "y" * 43,
            },
        )
        seen["forged_report_none"] = talk(
            uds + "_5101", {"version": 1, "type": "exit", "exitCode": 0, "reason": "worker_exited"}
        )
        save()
    if behavior.get("narrow", True):
        rule: dict[str, Any] = behavior.get(
            "rule", {"mode": "list", "hosts": ["registry.npmjs.org"]}
        )
        narrow: dict[str, Any] = {
            "version": 1,
            "type": "narrow",
            "network": rule,
            "modelHost": "api.example.com",
            "token": token,
        }
        seen["control"]["narrow"] = talk(uds + "_5100", narrow)
        seen["control"]["narrow_again"] = talk(uds + "_5100", narrow)
        seen["control"]["narrow_other"] = talk(
            uds + "_5100", {**narrow, "modelHost": "api.other.com"}
        )
    seen["control"]["end"] = talk(
        uds + "_5100",
        {"version": 1, "type": "end", "exitCode": behavior.get("exit", 0), "token": token},
    )
    save()
    time.sleep(behavior.get("run", 0))
    report: dict[str, Any] = {
        "version": 1,
        "type": "exit",
        "exitCode": behavior.get("exit", 0),
        "reason": behavior.get("reason", "worker_exited"),
        "token": token,
    }
    seen["report"] = talk(uds + "_5101", report)
    if mode == "duplicate_report":
        seen["report_again"] = talk(
            uds + "_5101", {**report, "exitCode": 1, "reason": "docker_failed"}
        )
    save()
    if behavior.get("linger"):
        time.sleep(behavior["linger"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
