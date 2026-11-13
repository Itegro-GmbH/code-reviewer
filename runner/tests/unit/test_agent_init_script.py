# SPDX-License-Identifier: LicenseRef-Proprietary

"""The agent container's init (`runner/docker/agent-init.sh`) and the start of its inner Docker
daemon again (#1009): the setup script runs in the container before the agent does, and the daemon
reads its proxy variables at its start, so the runner asks for one more start with the new ones.

The script is run for real with its paths moved into a temporary folder and a `dockerd` and a
`docker` that are small shell scripts: they record the arguments and the proxy variables of every
start and end on SIGTERM as the daemon does."""

import contextlib
import os
import re
import signal
import subprocess
import time
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "docker" / "agent-init.sh"

FAKE_DOCKERD = """#!/bin/sh
echo "args=$*" >> "$LOG"
echo "http=${HTTP_PROXY-unset} https=${HTTPS_PROXY-unset} no=${NO_PROXY-unset}" >> "$LOG"
echo $$ > "$ROOT/var/run/docker.pid"
trap 'exit 0' TERM
while :; do sleep 0.05; done
"""
FAKE_DOCKER = "#!/bin/sh\nexit 0\n"


def moved(root: Path) -> str:
    """The script with its absolute paths inside `root`."""
    return re.sub(
        r"(?<![\w./-])(/var/run/docker\.pid|/var/log|/var/lib/docker|/run)(?![\w])",
        lambda found: f"{root}{found.group(1)}",
        SCRIPT.read_text(),
    )


class Init:
    def __init__(self, root: Path, environment: dict[str, str]) -> None:
        self.root = root
        for folder in ("run", "var/run", "var/log", "bin"):
            (root / folder).mkdir(parents=True, exist_ok=True)
        self.log = root / "starts.log"
        for name, body in (("dockerd", FAKE_DOCKERD), ("docker", FAKE_DOCKER)):
            tool = root / "bin" / name
            tool.write_text(body)
            tool.chmod(0o755)
        script = root / "agent-init.sh"
        script.write_text(moved(root))
        script.chmod(0o755)
        env = {
            "PATH": f"{root}/bin:{os.environ['PATH']}",
            "LOG": str(self.log),
            "ROOT": str(root),
            **environment,
        }
        self.process = subprocess.Popen(["/bin/sh", str(script)], env=env)

    @property
    def ready(self) -> Path:
        return self.root / "run" / "agent-ready"

    def starts(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def wait_for(self, condition: Callable[[], bool], what: str, seconds: float = 20.0) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if condition():
                return
            time.sleep(0.05)
        raise AssertionError(f"timed out waiting for {what}: {self.starts()}")

    def stop_daemon(self) -> None:
        pid = int((self.root / "var/run/docker.pid").read_text())
        os.kill(pid, signal.SIGTERM)

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait()
        # The fake daemon may outlive a killed init by its sleep.
        pid_file = self.root / "var/run/docker.pid"
        if pid_file.exists():
            with contextlib.suppress(ProcessLookupError, ValueError):
                os.kill(int(pid_file.read_text()), signal.SIGKILL)


@pytest.fixture
def init(tmp_path: Path) -> Iterator[Callable[..., Init]]:
    made: list[Init] = []

    def start(**environment: str) -> Init:
        running = Init(tmp_path, environment)
        made.append(running)
        return running

    yield start
    for running in made:
        running.close()


def test_the_script_is_valid_shell() -> None:
    assert subprocess.run(["/bin/sh", "-n", str(SCRIPT)], check=False).returncode == 0


# #1009-T32
def test_the_daemon_starts_once_with_live_restore_and_the_containers_own_environment(
    init: Callable[..., Init],
) -> None:
    running = init(HTTP_PROXY="http://setup-proxy:3128")
    running.wait_for(running.ready.exists, "the ready file")
    starts = running.starts()
    assert len(starts) == 2
    assert "--live-restore" in starts[0] and "--ipv6=false" in starts[0]
    assert "http=http://setup-proxy:3128" in starts[1], (
        "the first start keeps the setup's variables"
    )


# #1009-T33
def test_a_requested_restart_starts_the_daemon_again_with_the_new_variables_only(
    init: Callable[..., Init],
) -> None:
    running = init(HTTP_PROXY="http://setup-proxy:3128", NO_PROXY="old")
    running.wait_for(running.ready.exists, "the first ready file")
    # What the runner does (`AgentContainer.restart_docker`): the new variables, the flag, no ready
    # file, and the end of the daemon.
    (running.root / "run" / "agent-docker-env").write_text("HTTPS_PROXY=http://door:3128\n")
    (running.root / "run" / "agent-docker-restart").write_text("")
    running.ready.unlink()
    running.stop_daemon()
    running.wait_for(lambda: len(running.starts()) == 4, "the second start")
    running.wait_for(running.ready.exists, "the ready file again")
    second = running.starts()[3]
    assert "https=http://door:3128" in second
    assert "http=unset" in second and "no=unset" in second, "the old variables are gone"
    assert "--live-restore" in running.starts()[2]
    assert running.process.poll() is None, "the container did not end"
    assert not (running.root / "run" / "agent-docker-restart").exists()


# #1009-T34
def test_a_daemon_that_ends_without_a_request_ends_the_container(init: Callable[..., Init]) -> None:
    running = init()
    running.wait_for(running.ready.exists, "the ready file")
    running.stop_daemon()
    assert running.process.wait(timeout=20) == 0
    assert len(running.starts()) == 2, "no second start"
