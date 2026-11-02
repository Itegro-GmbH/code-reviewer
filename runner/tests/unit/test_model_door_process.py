# SPDX-License-Identifier: LicenseRef-Proprietary

"""The model door as a real process behind the fake Docker Engine (#745, step 3).

`test_model_door_launcher.py` runs the door's code in a thread; here the fake daemon starts it as
the container's process does: `python -m code_reviewer_runner.implementer.door` with the start
document on its stdin and its status on its stdout, in a process of its own that can be killed.
What that proves beyond the thread: the key is in no environment variable, no argument and no open
file of the door's process (the places an agent in another container, or another user, could look:
the memory of the process is the kernel's and the container's to keep), a kill of the process is
reported as the loss of the door with its exit code, a cost limit refuses at the door before any
provider is asked, and Control gone ends the door.

The provider is not reached by any test here: a call that is admitted would need one, and no call is
made that could be."""

import contextlib
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any, BinaryIO

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from door_support import CAPABILITY, free_port, model_access, post
from fakes.docker_engine.server import HOSTNAME, FakeDockerEngine
from native_job_support import API_KEY

from code_reviewer_runner.implementer.docker_api import DockerApi
from code_reviewer_runner.implementer.door_launcher import (
    DOOR_CONTAINER_NAME,
    DoorSeams,
    RunningDoor,
    start_door,
)
from code_reviewer_runner.implementer.session import classify
from code_reviewer_runner.result import ErrorCode


class ProcessRig:
    """The fake daemon whose container is the real door process, listening on loopback."""

    def __init__(self, directory: Path) -> None:
        self.port = free_port()
        self.process: subprocess.Popen[bytes] | None = None
        self.engine = FakeDockerEngine(directory / "docker.sock", self.behave).start()
        self.seams = DoorSeams(
            api=lambda: DockerApi(str(directory / "docker.sock"), timeout=5.0),
            hostname=lambda: HOSTNAME,
            ready_seconds=20.0,
            stop_seconds=5.0,
        )
        self.door_url = f"http://127.0.0.1:{self.port}"
        self.environment = {"PATH": os.environ.get("PATH", "/usr/bin"), "SECRET_FREE": "1"}

    def behave(self, stdin: BinaryIO, stdout: Any, stderr: Any) -> int:
        process = subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-m",
                "code_reviewer_runner.implementer.door",
                "--bind",
                f"127.0.0.1:{self.port}",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.environment,
        )
        self.process = process
        assert process.stdin is not None and process.stdout is not None

        def pump_in() -> None:
            try:
                while data := stdin.read(65536):
                    process.stdin.write(data)  # type: ignore[union-attr]
                    process.stdin.flush()  # type: ignore[union-attr]
            except (OSError, ValueError):
                pass
            with contextlib.suppress(OSError, ValueError):
                process.stdin.close()  # type: ignore[union-attr]

        threading.Thread(target=pump_in, daemon=True).start()
        for line in process.stdout:
            stdout.write(line.decode())
        code = process.wait()
        return 128 + -code if code < 0 else code

    def start(self, **options: Any) -> RunningDoor:
        arguments: dict[str, Any] = {
            "model_access": model_access(),
            "capability": CAPABILITY,
            "deadline_seconds": 600.0,
            "port": 10180,
            "environment": {},
            "seams": self.seams,
        }
        arguments.update(options)
        return start_door(**arguments)

    def stop(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
        self.engine.stop()


@pytest.fixture
def rig() -> Iterator[ProcessRig]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="door-proc-") as directory:
        made = ProcessRig(Path(directory))
        yield made
        made.stop()


def wait(condition: Any, seconds: float = 10.0) -> bool:
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if condition():
            return True
        time.sleep(0.02)
    return bool(condition())


def every_readable_place(pid: int) -> dict[str, bytes]:
    """What any process of the container could read of the door's: its environment, its command
    line, the files it holds open and its working directory's names. (The memory of a process is
    the kernel's to keep from other users and other containers.)"""
    found: dict[str, bytes] = {}
    root = Path("/proc") / str(pid)
    for name in ("environ", "cmdline", "status"):
        with contextlib.suppress(OSError):
            found[name] = (root / name).read_bytes()
    for descriptor in (root / "fd").iterdir():
        with contextlib.suppress(OSError):
            target = os.readlink(descriptor)
            found[f"fd:{descriptor.name}->{target}"] = target.encode()
            path = Path(target)
            if path.is_file():
                found[f"file:{target}"] = path.read_bytes()
    with contextlib.suppress(OSError):
        found["cwd"] = "\n".join(str(p) for p in Path(os.readlink(root / "cwd")).iterdir()).encode()
    return found


# #745-T16
def test_the_key_is_in_no_environment_argument_or_open_file_of_the_door_process(
    rig: ProcessRig,
) -> None:
    door = rig.start()
    assert rig.process is not None
    pid = rig.process.pid

    places = every_readable_place(pid)

    assert places, "the process was looked at"
    for name, content in places.items():
        assert API_KEY.encode() not in content, f"the key is in {name}"
    assert API_KEY.encode() not in places["cmdline"], "no argument"
    assert b"modelAccess" not in places["cmdline"]
    door.stop()


# #745-T16
def test_the_door_process_started_as_the_container_starts_it_says_ready_and_reports(
    rig: ProcessRig,
) -> None:
    door = rig.start()

    assert wait(lambda: door.state.status is not None)
    seen = door.state.status
    assert seen is not None and seen.model_used is False and seen.failure is None
    door.stop()
    assert door.state.end is not None and door.state.end.exit_code == 0
    assert door.state.end.unexpected is False


# #745-T17
def test_the_cost_limit_refuses_at_the_door_process_and_control_reads_why(
    rig: ProcessRig,
) -> None:
    door = rig.start(model_access=model_access(max_cost=0.000001))

    status, _ = post(rig.door_url)

    assert status >= 400
    assert wait(lambda: door.state.failure() is not None)
    failure = door.state.failure()
    assert failure is not None
    assert failure.code is ErrorCode.DYNAMIC_BUDGET_EXCEEDED
    assert failure.detail == "the cost limit is used up"
    assert door.state.model_used is False, "refused before the provider: nothing was spent"
    door.stop()


# #745-T18
def test_a_killed_door_process_is_the_loss_of_the_door_with_its_exit_code(
    rig: ProcessRig,
) -> None:
    door = rig.start()
    assert rig.process is not None

    rig.process.send_signal(signal.SIGKILL)

    assert wait(lambda: door.state.lost is not None)
    failure = door.state.failure()
    assert failure is not None and failure.code is ErrorCode.RUNNER_ERROR
    assert "model door" in failure.detail and "137" in failure.detail
    code, _ = classify(failure, used_model=door.state.model_used)
    assert code is ErrorCode.RUNNER_ERROR, "free: the model was not used"
    door.stop()
    assert rig.engine.container(DOOR_CONTAINER_NAME).removed


# #745-T18
def test_a_door_whose_control_is_gone_ends_itself(rig: ProcessRig) -> None:
    door = rig.start()
    assert rig.process is not None

    door._streams.close_write()  # pyright: ignore[reportPrivateUsage]

    assert wait(lambda: rig.process is not None and rig.process.poll() is not None)
    assert rig.process.returncode == 0, "the end of stdin is a clean end"
    door.stop()


# #745-T16
def test_a_start_document_the_door_refuses_is_refused_by_the_process_with_a_word(
    rig: ProcessRig,
) -> None:
    access = model_access()
    access["llm"]["apiKey"] = ""

    from code_reviewer_runner.job import JobError

    with pytest.raises(JobError) as error:
        rig.start(model_access=access)

    assert error.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert API_KEY not in error.value.detail
