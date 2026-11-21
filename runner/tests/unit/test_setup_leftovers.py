# SPDX-License-Identifier: LicenseRef-Proprietary

"""#1126: what the environment's script leaves running is ended before the container is handed to
a harness whose login lives in it (`setup_leftovers.py`). The script that finds the processes is
run for real (`/bin/sh`) against a tree of fake `/proc` directories, so that what stays and what
goes is decided by the very text that runs in the container; the kill is proven on real
processes the test starts and names in the tree (never on the machine's own `/proc`)."""

import os
import signal
import subprocess
from pathlib import Path

import pytest

from code_reviewer_runner.implementer import setup_leftovers as sl

pytestmark = pytest.mark.unit

INIT = 1
AGENT_INIT = 7
DOCKERD = 20
CONTAINERD = 21
MARKER = 1000


def entry(
    proc: Path,
    pid: int,
    name: str,
    ppid: int,
    start: int,
    *,
    exe: str | None = None,
    state: str = "S",
) -> None:
    directory = proc / str(pid)
    directory.mkdir()
    (directory / "status").write_text(f"Name:\t{name}\nState:\t{state}\nPPid:\t{ppid}\n")
    # `pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime
    # stime cutime cstime priority nice threads itrealvalue starttime ...`
    fields = [state, str(ppid)] + ["0"] * 17 + [str(start)] + ["0"] * 5
    assert len(fields) >= 20
    (directory / "stat").write_text(f"{pid} ({name}) " + " ".join(fields) + "\n")
    if exe is not None:
        (directory / "exe").symlink_to(exe)


def baseline(proc: Path) -> None:
    """What the image's init leaves: tini, `agent-init`, `dockerd` with its `containerd`."""
    entry(proc, INIT, "tini", 0, 10, exe="/usr/bin/tini")
    entry(proc, AGENT_INIT, "agent-init", INIT, 20, exe="/usr/bin/dash")
    entry(proc, DOCKERD, "dockerd", AGENT_INIT, 30, exe="/usr/local/bin/dockerd")
    entry(proc, CONTAINERD, "containerd", DOCKERD, 31, exe="/usr/local/bin/containerd")


def run_script(proc: Path, mode: str, marker: int = MARKER) -> list[str]:
    done = subprocess.run(
        ["/bin/sh", "-c", sl.LEFTOVERS_SCRIPT, "leftovers", str(proc), mode, str(marker)],
        capture_output=True,
        text=True,
        timeout=30,
        check=True,
    )
    return done.stdout.splitlines()


def listed(proc: Path) -> set[str]:
    return {line.split(" ", 1)[1] for line in run_script(proc, sl.LIST)}


# #1126-T40
def test_the_marker_is_the_start_time_of_the_newest_process(tmp_path: Path) -> None:
    baseline(tmp_path)
    assert run_script(tmp_path, sl.SNAPSHOT, 0) == ["marker 31"]


# #1126-T41
def test_what_the_script_started_goes_and_what_the_container_started_with_stays(
    tmp_path: Path,
) -> None:
    baseline(tmp_path)
    entry(tmp_path, 200, "postgres", INIT, MARKER + 5, exe="/usr/lib/postgresql/16/bin/postgres")
    entry(tmp_path, 201, "postgres", 200, MARKER + 6)
    entry(tmp_path, 202, "node", 201, MARKER + 7, exe="/opt/node/bin/node")
    entry(tmp_path, 203, "sleep", 1, MARKER + 8)

    assert listed(tmp_path) == {"postgres", "node", "sleep"}
    assert len(run_script(tmp_path, sl.LIST)) == 4


# #1126-T42
def test_a_process_that_takes_a_docker_name_is_still_a_leftover(tmp_path: Path) -> None:
    """A name, or an `agent-init` command line, is what a script can choose; only the start time
    (taken before the script existed) and the shim's own program make a process the container's."""
    baseline(tmp_path)
    entry(tmp_path, 300, "dockerd", INIT, MARKER + 1, exe="/tmp/evil")
    entry(tmp_path, 301, "containerd", INIT, MARKER + 2, exe="/tmp/containerd")
    entry(tmp_path, 302, "agent-init", INIT, MARKER + 3, exe="/usr/bin/dash")
    entry(tmp_path, 303, "child", 300, MARKER + 4)

    assert len(run_script(tmp_path, sl.LIST)) == 4


# #1126-T43
def test_what_dockerd_starts_and_the_inner_containers_stay(tmp_path: Path) -> None:
    """`docker compose up -d` (what #1009 is for): the proxy under `dockerd`, the shim of each inner
    container (it reparents to the init) and everything under the shim."""
    baseline(tmp_path)
    entry(tmp_path, 400, "docker-proxy", DOCKERD, MARKER + 10)
    entry(
        tmp_path,
        410,
        "containerd-shim",
        INIT,
        MARKER + 11,
        exe="/usr/local/bin/containerd-shim-runc-v2",
    )
    entry(tmp_path, 411, "postgres", 410, MARKER + 12)
    entry(tmp_path, 412, "postgres", 411, MARKER + 13)

    assert listed(tmp_path) == set()


# #1126-T44
def test_a_copy_of_a_shim_outside_the_images_directories_is_a_leftover(tmp_path: Path) -> None:
    baseline(tmp_path)
    entry(tmp_path, 420, "containerd-shim", INIT, MARKER + 1, exe="/tmp/containerd-shim-runc-v2")

    assert listed(tmp_path) == {"containerd-shim"}


# #1126-T45
def test_a_zombie_is_not_a_leftover_and_the_sweep_itself_is_not_listed(tmp_path: Path) -> None:
    baseline(tmp_path)
    entry(tmp_path, 500, "defunct", INIT, MARKER + 1, state="Z")

    assert run_script(tmp_path, sl.LIST) == []


# #1126-T46
def test_the_kill_ends_the_leftovers_and_only_them(tmp_path: Path) -> None:
    """Real processes named in the tree: the one the script left dies, the baseline one lives."""
    left = subprocess.Popen(["/bin/sleep", "60"])
    kept = subprocess.Popen(["/bin/sleep", "60"])
    try:
        entry(tmp_path, INIT, "tini", 0, 10)
        entry(tmp_path, left.pid, "sleeper", INIT, MARKER + 1)
        entry(tmp_path, kept.pid, "sleeper", INIT, 50)

        assert run_script(tmp_path, sl.LIST) == [f"{left.pid} sleeper"]
        assert left.poll() is None, "listing ends nothing"
        assert run_script(tmp_path, sl.KILL) == [f"{left.pid} sleeper"]
        assert left.wait(timeout=10) == -signal.SIGKILL
        assert kept.poll() is None
    finally:
        for process in (left, kept):
            if process.poll() is None:
                os.kill(process.pid, signal.SIGKILL)
            process.wait()


def test_a_name_in_a_note_is_printable_and_bounded() -> None:
    clean = sl._clean  # pyright: ignore[reportPrivateUsage]
    assert clean("pg\x00bad") == "pgbad"
    assert clean("x" * 100) == "x" * sl.MAX_NAME_CHARS
    assert clean("\x01") == "?"
    assert "and 10 more" in sl.note([str(n) for n in range(30)])
