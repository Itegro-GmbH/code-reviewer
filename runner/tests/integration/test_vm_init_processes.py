# SPDX-License-Identifier: LicenseRef-Proprietary

"""The real processes vm-init starts (#977): `docker run` with the job on stdin, and the commands of
the steps. `docker` here is a script of the test on the PATH; the real Docker, Sysbox and vsock are
proven by the KVM lane of #978."""

import json
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from code_reviewer_runner.vm_init import wire
from code_reviewer_runner.vm_init.control import spawn_docker
from code_reviewer_runner.vm_init.steps import SubprocessRunner
from vm_init_support import CREDENTIAL, LOCAL_CREDENTIAL, start_document


def _fake_docker(directory: Path, body: str) -> None:
    script = directory / "docker"
    script.write_text("#!/bin/sh\n" + body, encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)


# #977-T04
def test_the_job_reaches_the_container_on_stdin_and_the_arguments_are_passed_as_they_are(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    out = tmp_path / "out"
    out.mkdir()
    _fake_docker(
        tmp_path,
        f'printf "%s\\n" "$@" > "{out}/args"\ncat > "{out}/stdin"\nexit 3\n',
    )
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")
    request = wire.parse_start(start_document())

    status = spawn_docker(request.args, request.stdin_document())

    assert status == 3
    assert (out / "args").read_text(encoding="utf-8").split("\n")[:-1] == list(request.args)
    document = json.loads((out / "stdin").read_text(encoding="utf-8"))
    assert document["credential"] == CREDENTIAL
    assert document["localCredential"]["value"] == LOCAL_CREDENTIAL
    assert CREDENTIAL not in (out / "args").read_text(encoding="utf-8")


# #977-T03
def test_a_container_that_never_reads_its_input_does_not_break_the_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_docker(tmp_path, "exit 0\n")
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")

    assert spawn_docker(("run", "x"), b"x" * 1_000_000) == 0


# #977-T03
def test_a_container_killed_by_a_signal_is_its_status_as_a_shell_gives_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _fake_docker(tmp_path, "kill -9 $$\n")
    monkeypatch.setenv("PATH", f"{tmp_path}:{os.environ['PATH']}")

    assert spawn_docker(("run", "x"), b"") == 137


# #977-T03
def test_a_docker_that_cannot_be_started_is_dockers_own_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))

    assert spawn_docker(("run", "x"), b"") == 125


# #977-T02
def test_the_runner_reports_the_status_and_the_output_when_asked() -> None:
    runner = SubprocessRunner()

    assert (
        runner.run((sys.executable, "-c", "print('id')"), timeout=10, capture=True).stdout == "id\n"
    )
    assert runner.run((sys.executable, "-c", "print('id')"), timeout=10, capture=False).stdout == ""
    assert (
        runner.run(
            (sys.executable, "-c", "raise SystemExit(7)"), timeout=10, capture=False
        ).exit_code
        == 7
    )
    assert runner.run(("/nonexistent/command",), timeout=10, capture=False).exit_code == 255


# #977-T02
def test_a_step_that_takes_too_long_is_a_failure() -> None:
    runner = SubprocessRunner()

    done = runner.run(
        (sys.executable, "-c", "import time; time.sleep(5)"), timeout=0.2, capture=True
    )

    assert done.exit_code == 255 and done.stdout == ""


def test_the_step_output_is_never_an_input_of_another_process() -> None:
    done = subprocess.run(
        [sys.executable, "-c", "import sys; print(len(sys.stdin.read()))"],
        input="x",
        capture_output=True,
        text=True,
        check=True,
    )
    assert done.stdout == "1\n"
