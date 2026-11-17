# SPDX-License-Identifier: LicenseRef-Proprietary

"""The MCP door process (#1067): its start document, its refusals, and the proof that the job's
credential is held in the door's memory and nowhere the agent could read: not its environment, not
its command line, not its files, not the process list. The process test starts the real module in a
real subprocess; the app is `FakeApp` on loopback."""

import http.client
import io
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import pytest
from door_support import free_port
from mcp_door_support import (
    JOB_CREDENTIAL,
    JOB_ID,
    SERVER_A,
    SERVER_B,
    FakeApp,
    jsonrpc,
)

from code_reviewer_runner.implementer.mcpdoor.relay import McpRelay
from code_reviewer_runner.implementer.mcpdoor.service import (
    McpStart,
    StartRefused,
    parse_start,
    run_mcp_door,
)

DOOR_COMMAND = [sys.executable, "-m", "code_reviewer_runner.implementer.mcpdoor"]


def start_text(**changes: Any) -> str:
    document: dict[str, Any] = {
        "version": 1,
        "appUrl": "https://app.example",
        "jobId": JOB_ID,
        "credential": JOB_CREDENTIAL,
        "servers": [SERVER_A, SERVER_B],
        "listenPort": 3129,
        "deadlineSeconds": 600,
    }
    document.update(changes)
    return json.dumps({k: v for k, v in document.items() if v is not None})


@pytest.mark.unit
def test_a_start_document_is_read_into_what_the_door_needs() -> None:
    start = parse_start(start_text())

    assert isinstance(start, McpStart)
    assert start.servers == frozenset({SERVER_A, SERVER_B}) and start.port == 3129
    assert start.access.credential == JOB_CREDENTIAL and start.deadline_seconds == 600.0
    assert JOB_CREDENTIAL not in repr(start) and JOB_CREDENTIAL not in repr(start.access)


@pytest.mark.parametrize(
    "changes",
    [
        {"version": 2},
        {"credential": "crc_" + "x" * 43},
        {"credential": "crj_short"},
        {"jobId": "nope"},
        {"appUrl": "ftp://app"},
        {"appUrl": "https://user:pw@app.example"},
        {"appUrl": "https://app.example/?q=1"},
        {"servers": []},
        {"servers": ["nope"]},
        {"servers": [SERVER_A] * 51},
        {"listenPort": 80},
        {"listenPort": "3129"},
        {"deadlineSeconds": 0},
        {"deadlineSeconds": 10**9},
        {"extra": 1},
        {"outerProxy": {"host": "8.8.8.8", "port": 3128}},
    ],
)
@pytest.mark.unit
def test_a_start_document_that_is_not_one_is_refused_and_the_refusal_holds_no_value(
    changes: dict[str, Any],
) -> None:
    with pytest.raises(StartRefused) as caught:
        parse_start(start_text(**changes))

    assert JOB_CREDENTIAL not in str(caught.value) and caught.value.reason == "start_invalid"


@pytest.mark.unit
@pytest.mark.parametrize("text", ["", "not json", "[]", "{" * 5000, "x" * 70_000])
def test_text_that_is_no_document_is_refused(text: str) -> None:
    with pytest.raises(StartRefused):
        parse_start(text)


@pytest.mark.unit
def test_the_door_says_refused_and_prints_no_value_for_a_bad_start() -> None:
    stdout = io.StringIO()

    code = run_mcp_door(io.StringIO(start_text(credential="x") + "\n"), stdout)

    assert code == 2
    assert json.loads(stdout.getvalue()) == {"t": "refused", "reason": "start_invalid"}


@pytest.mark.unit
def test_the_door_says_refused_when_it_cannot_listen() -> None:
    stdout = io.StringIO()
    code = run_mcp_door(
        io.StringIO(start_text() + "\n"), stdout, bind=("203.0.113.1", 3129)
    )  # an address this machine does not have

    assert code == 2
    assert json.loads(stdout.getvalue()) == {"t": "refused", "reason": "listen_failed"}


@pytest.mark.unit
def test_the_door_says_its_last_word_even_when_ending_the_sessions_fails() -> None:
    class Broken(McpRelay):
        def close_sessions(self) -> int:
            self.remember(SERVER_A, "s-1")
            raise RuntimeError("boom")

    stdout = io.StringIO()
    code = run_mcp_door(
        io.StringIO(start_text() + "\n"),  # then the end of stdin: Control is gone
        stdout,
        bind=("127.0.0.1", 0),
        relay_factory=lambda start: Broken(start.access, start.servers),
    )

    last = json.loads(stdout.getvalue().splitlines()[-1])
    assert code == 0
    assert last["final"] is True and last["sessionsLeft"] == 1


# -- the credential is in the door's memory and nowhere the agent could read ---


def read_text(path: Path) -> str:
    try:
        return path.read_bytes().decode("latin-1")
    except OSError:
        return ""


@pytest.mark.integration
def test_the_credential_is_in_no_environment_no_command_line_no_file_and_no_process_list() -> None:
    app = FakeApp()
    port = free_port()
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="mcpdoor-proc-") as directory:
        environment = {"PATH": os.environ.get("PATH", ""), "TMPDIR": directory, "HOME": directory}
        door = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "code_reviewer_runner.implementer.mcpdoor",
                "--bind",
                f"127.0.0.1:{port}",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            cwd=directory,
        )
        try:
            assert door.stdin is not None and door.stdout is not None
            document = start_text(appUrl=app.url)
            door.stdin.write(document.encode() + b"\n")
            door.stdin.flush()
            assert json.loads(door.stdout.readline()) == {"t": "ready"}

            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            connection.request("POST", f"/mcp/{SERVER_A}", body=jsonrpc("initialize"))
            assert connection.getresponse().status == 200
            connection.close()
            assert app.requests[-1].headers["authorization"] == f"Bearer {JOB_CREDENTIAL}", (
                "the door does hold it: it is what it calls the app with"
            )

            # What an agent that could look at this process would try.
            process = Path("/proc") / str(door.pid)
            assert JOB_CREDENTIAL not in read_text(process / "cmdline"), "not in /proc/pid/cmdline"
            assert JOB_CREDENTIAL not in read_text(process / "environ"), "not in /proc/pid/environ"
            listing = subprocess.run(
                ["ps", "-eo", "args"], capture_output=True, text=True, check=True
            ).stdout
            assert JOB_CREDENTIAL not in listing, "not in the process list"
            for file in Path(directory).rglob("*"):
                if file.is_file():
                    assert JOB_CREDENTIAL not in read_text(file), f"not in a file ({file.name})"
            assert JOB_CREDENTIAL not in read_text(process / "status")
        finally:
            assert door.stdin is not None
            door.stdin.close()  # Control is gone: the door ends its sessions and goes
            try:
                door.wait(timeout=20)
            except subprocess.TimeoutExpired:
                door.kill()
                door.wait()
        assert door.returncode == 0
        assert door.stderr is not None and JOB_CREDENTIAL not in door.stderr.read().decode()
        assert door.stdout is not None and JOB_CREDENTIAL not in door.stdout.read().decode()
        deadline = time.monotonic() + 5
        while app.sessions and time.monotonic() < deadline:
            time.sleep(0.05)
        assert app.sessions == set(), "the fake server has no open session after the step"
    app.stop()


@pytest.mark.integration
def test_a_door_whose_deadline_and_stop_are_asked_for_ends_cleanly_with_its_last_word() -> None:
    app = FakeApp()
    port = free_port()
    door = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "code_reviewer_runner.implementer.mcpdoor",
            "--bind",
            f"127.0.0.1:{port}",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        env={"PATH": os.environ.get("PATH", "")},
    )
    try:
        assert door.stdin is not None and door.stdout is not None
        door.stdin.write(start_text(appUrl=app.url).encode() + b"\n")
        door.stdin.flush()
        assert json.loads(door.stdout.readline()) == {"t": "ready"}
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        connection.request("POST", f"/mcp/{SERVER_B}", body=jsonrpc("initialize"))
        assert connection.getresponse().status == 200
        connection.close()

        door.stdin.write(b'{"op":"stop"}\n')
        door.stdin.flush()
        last = json.loads(door.stdout.readline())
        door.wait(timeout=20)
    finally:
        if door.poll() is None:
            door.kill()
            door.wait()
        app.stop()

    assert last == {
        "t": "status",
        "final": True,
        "calls": 1,
        "sessionsOpened": 1,
        "sessionsClosed": 1,
        "sessionsLeft": 0,
    }
    assert door.returncode == 0
