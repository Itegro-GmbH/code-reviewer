# SPDX-License-Identifier: LicenseRef-Proprietary

"""Doubles for the tests of the Implementer's model door (#745, step 3); not a test file.

The door is the real code (`run_door`, `ModelDoor`) with the provider behind the `Upstream` seam
replaced by a script and the bind address moved to loopback; the daemon is the fake Docker Engine
of `fakes/docker_engine`. A request to the door is a real HTTP request on a real loopback socket.
"""

import http.client
import json
import os
import socket
import sys
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO, TextIO
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from native_job_support import API_KEY, ENTRY, MANAGED_COST, MODEL
from passthrough_support import ScriptedUpstream, streamed

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.implementer.door.service import run_door

CAPABILITY = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo"
FAMILY = WireFamily.ANTHROPIC_MESSAGES


def model_access(max_cost: float = 2.5) -> dict[str, Any]:
    """The model access of a task as the job text has it (`ImplementerInput.model_access`)."""
    return {
        "llm": {
            "provider": "anthropic",
            "model": MODEL,
            "apiKey": API_KEY,
            "maxCostUsd": max_cost,
        },
        "modelEntry": json.loads(json.dumps(ENTRY)),
        "cost": json.loads(json.dumps(MANAGED_COST)),
    }


def start_document(
    *, max_cost: float = 2.5, deadline: float = 600.0, port: int = 10180, **overrides: Any
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "version": 1,
        "modelAccess": model_access(max_cost),
        "capability": CAPABILITY,
        "deadlineSeconds": deadline,
        "listenPort": port,
        "environment": {},
    }
    document.update(overrides)
    return document


def request_body(size: int = 6000, **overrides: Any) -> bytes:
    document: dict[str, Any] = {
        "model": MODEL,
        "stream": True,
        "max_tokens": 1000,
        "messages": [{"role": "user", "content": "x" * size}],
    }
    document.update(overrides)
    return json.dumps(document).encode()


def post(
    url: str, body: bytes | None = None, *, capability: str | None = CAPABILITY
) -> tuple[int, bytes]:
    """One model call as the agent makes it: the bearer it was given, the route of its SDK."""
    spec = spec_of(FAMILY)
    parts = urlsplit(url)
    connection = http.client.HTTPConnection(parts.hostname or "", parts.port, timeout=10)
    payload = request_body() if body is None else body
    headers = {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "Content-Length": str(len(payload)),
    }
    if capability is not None:
        headers[spec.key_header] = spec.key_value(capability)
    try:
        connection.request("POST", spec.engine_target(MODEL), payload, headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def scripted_provider(calls: int = 3) -> ScriptedUpstream:
    return ScriptedUpstream(*[streamed(FAMILY, call) for call in range(1, calls + 1)])


@dataclass
class DoorProcess:
    """A door the way the container runs it, with pipes for its streams and a thread for its
    process. `lines` are what it printed so far."""

    upstream: ScriptedUpstream
    stdin: TextIO
    lines: list[dict[str, Any]] = field(default_factory=lambda: [])
    exit_code: list[int] = field(default_factory=lambda: [])
    thread: threading.Thread | None = None
    reader: threading.Thread | None = None
    url: str = ""
    refused: bool = False

    def send(self, text: str) -> None:
        self.stdin.write(text)
        self.stdin.flush()

    def end_of_input(self) -> None:
        self.stdin.close()

    def wait(self, seconds: float = 10.0) -> int:
        assert self.thread is not None and self.reader is not None
        self.thread.join(seconds)
        assert not self.thread.is_alive(), "the door did not end"
        # Its output is read by another thread: every line it printed is in `lines` after this.
        self.reader.join(seconds)
        return self.exit_code[0]


def run_door_here(
    upstream: ScriptedUpstream | None = None,
    *,
    document: str | None = None,
    poll: float = 0.02,
) -> DoorProcess:
    """`run_door` in a thread on loopback, reading from a pipe this test writes to. Returns once
    it has printed its first line (`ready` or `refused`)."""
    provider = upstream or scripted_provider()
    port = free_port()
    in_read, in_write = os.pipe()
    out_read, out_write = os.pipe()
    stdin_here = os.fdopen(in_write, "w", encoding="utf-8")
    process = DoorProcess(provider, stdin_here, url=f"http://127.0.0.1:{port}")
    door_in = os.fdopen(in_read, "r", encoding="utf-8")
    door_out = os.fdopen(out_write, "w", encoding="utf-8")
    seen = threading.Event()

    def main() -> None:
        process.exit_code.append(
            run_door(
                door_in,
                door_out,
                bind=("127.0.0.1", port),
                upstream_for=lambda _destination: provider,
                poll_seconds=poll,
            )
        )
        door_out.close()

    def read() -> None:
        reader = os.fdopen(out_read, "r", encoding="utf-8")
        for line in reader:
            process.lines.append(json.loads(line))
            if len(process.lines) == 1:
                seen.set()
        seen.set()

    process.reader = threading.Thread(target=read, daemon=True)
    process.reader.start()
    process.thread = threading.Thread(target=main, daemon=True)
    process.thread.start()
    process.send((json.dumps(start_document()) if document is None else document) + "\n")
    assert seen.wait(10)
    process.refused = process.lines[0]["t"] == "refused"
    return process


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


Behaviour = Callable[[BinaryIO, Any, Callable[[str], None]], int]


EXAMPLE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "examples"
    / "implementer"
    / "RunnerJobInput.json"
)


def implementer_job_text(
    *, max_cost: float | None = 2.5, git_token: str = "ghs_dummy-token-0123456789"
) -> str:
    """The contract's example job with the model of these tests: the key of Anthropic, its entry
    and the managed cost policy, and the cost limit the app sends with the claim."""
    document: dict[str, Any] = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    access = model_access(2.5 if max_cost is None else max_cost)
    document["llm"] = (
        access["llm"]
        if max_cost is not None
        else {key: value for key, value in access["llm"].items() if key != "maxCostUsd"}
    )
    document["implementer"]["modelEntry"] = access["modelEntry"]
    document["implementer"]["cost"] = access["cost"]
    document["git"]["token"] = git_token
    return json.dumps(document)
