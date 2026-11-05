# SPDX-License-Identifier: LicenseRef-Proprietary

"""The fake Docker Engine answers a start only once the container runs (#827). It used to send the
204 first and set `running` after it: a client that asked for the container's state or waited for
its end right after the answer could see it not running, which ended a Setup run `unavailable` ("the
container ended before its Docker was ready") and made the readers' restart test read a stale flag,
on a loaded host (the flakes of #825 and #826)."""

import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.docker_engine.server import IMAGE_ID, FakeDockerEngine

from code_reviewer_runner.implementer.docker_api import DockerApi


@pytest.fixture
def engine() -> Iterator[tuple[FakeDockerEngine, DockerApi]]:
    with tempfile.TemporaryDirectory(dir="/tmp", prefix="fake-engine-") as directory:
        socket_path = Path(directory) / "docker.sock"
        made = FakeDockerEngine(socket_path).start()
        yield made, DockerApi(str(socket_path), timeout=5.0)
        made.stop()


# #827-T09
def test_a_container_runs_when_its_start_is_answered_whatever_the_servers_thread_does_next(
    engine: tuple[FakeDockerEngine, DockerApi],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    made, api = engine
    real = FakeDockerEngine._reply  # pyright: ignore[reportPrivateUsage]

    def slow(self: Any, connection: Any, status: int, document: Any = None) -> None:
        real(self, connection, status, document)
        if status == 204:
            # The thread of the server is not scheduled for a moment after it answered.
            threading.Event().wait(0.3)

    monkeypatch.setattr(FakeDockerEngine, "_reply", slow)
    container = api.create_container({"Image": IMAGE_ID}, "c")

    api.start_container(container)

    state: Any = api.inspect_container(container)["State"]
    assert state["Running"] is True
    # And the wait that a watcher starts right after the start blocks until the container ends.
    ended = threading.Event()
    threading.Thread(
        target=lambda: (api.wait_container(container, timeout=5.0), ended.set()), daemon=True
    ).start()
    assert not ended.wait(0.2), "the container was reported as ended while it runs"
    made.kill("c", exit_code=0)


# #827-N4: an answer that cannot be sent (the client went away) leaves the container with its
# behaviour, as the real engine's container is: running while it runs, ended when it ends
def test_a_start_whose_answer_cannot_be_sent_still_runs_the_behaviour_of_the_container(
    engine: tuple[FakeDockerEngine, DockerApi],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    made, api = engine
    ran = threading.Event()
    made.behaviour = lambda stdin, stdout, stderr: ran.set() or 0
    real = FakeDockerEngine._reply  # pyright: ignore[reportPrivateUsage]

    def broken(self: Any, connection: Any, status: int, document: Any = None) -> None:
        if status == 204:
            raise BrokenPipeError("the client went away")
        real(self, connection, status, document)

    monkeypatch.setattr(FakeDockerEngine, "_reply", broken)
    container = api.create_container({"Image": IMAGE_ID}, "c")

    with pytest.raises(Exception):  # noqa: B017 - the client sees a start that was not answered
        api.start_container(container)

    assert ran.wait(5.0), "the behaviour never ran"
    deadline = time.monotonic() + 5.0
    while made.containers[container].running and time.monotonic() < deadline:
        time.sleep(0.01)
    assert made.containers[container].running is False, "running with nothing behind it"
