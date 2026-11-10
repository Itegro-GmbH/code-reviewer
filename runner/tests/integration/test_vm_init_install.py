# SPDX-License-Identifier: LicenseRef-Proprietary

"""The install hook of vm-init (#977, `runner/vm-init/install.sh`): what it puts into a root file
system, that the program runs from there without the runner, and that the bytes do not change from
one run to the next."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from code_reviewer_runner.vm_init import wire

VM_INIT = Path(__file__).resolve().parents[2] / "vm-init"
CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def _install(root: Path, **environment: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(VM_INIT / "install.sh"), str(root)],
        capture_output=True,
        text=True,
        check=False,
        env={**os.environ, **environment},
    )


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# #977-T01
def test_it_installs_the_program_and_the_seccomp_profile_and_nothing_else(tmp_path: Path) -> None:
    done = _install(tmp_path)

    assert done.returncode == 0, done.stderr
    assert sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*") if p.is_file()) == [
        "etc/code-reviewer/control-seccomp.json",
        "usr/local/sbin/vm-init",
    ]
    program = tmp_path / "usr" / "local" / "sbin" / "vm-init"
    assert program.stat().st_mode & 0o777 == 0o755
    assert program.read_bytes().startswith(b"#!/usr/bin/python3\n")
    assert (tmp_path / "etc/code-reviewer/control-seccomp.json").read_bytes() == (
        VM_INIT / "control-seccomp.json"
    ).read_bytes()


# #977-T01
def test_the_installed_program_runs_without_the_runner(tmp_path: Path) -> None:
    assert _install(tmp_path, VM_INIT_PYTHON=sys.executable).returncode == 0
    program = tmp_path / "usr" / "local" / "sbin" / "vm-init"

    done = subprocess.run(
        [str(program), "--version"],
        capture_output=True,
        text=True,
        check=False,
        # Nothing of the runner's environment: no virtualenv, no path to the package.
        env={"PATH": "/usr/bin:/bin"},
        cwd=tmp_path,
    )

    assert done.returncode == 0, done.stderr
    assert done.stdout == (
        f"vm-init protocol {wire.PROTOCOL_VERSION} start-port {wire.START_PORT} "
        f"report-port {wire.REPORT_PORT} host-cid {wire.HOST_CID} "
        f"max-frame {wire.MAX_FRAME_BYTES}\n"
    )


# #977-T01
def test_the_program_refuses_an_argument_it_does_not_know(tmp_path: Path) -> None:
    assert _install(tmp_path, VM_INIT_PYTHON=sys.executable).returncode == 0
    program = tmp_path / "usr" / "local" / "sbin" / "vm-init"

    done = subprocess.run([str(program), "--nope"], capture_output=True, text=True, check=False)

    assert done.returncode == 64


# #977-T01
def test_the_bytes_are_the_same_on_every_run(tmp_path: Path) -> None:
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()

    assert _install(first).returncode == 0
    assert _install(second).returncode == 0

    for name in ("usr/local/sbin/vm-init", "etc/code-reviewer/control-seccomp.json"):
        assert _digest(first / name) == _digest(second / name)


# #977-T01
def test_the_interpreter_in_the_shebang_is_the_one_the_root_file_system_has(tmp_path: Path) -> None:
    assert _install(tmp_path, VM_INIT_PYTHON="/opt/python/bin/python3").returncode == 0

    program = tmp_path / "usr" / "local" / "sbin" / "vm-init"
    assert program.read_bytes().startswith(b"#!/opt/python/bin/python3\n")


def test_it_refuses_a_directory_that_is_not_one(tmp_path: Path) -> None:
    done = _install(tmp_path / "missing")

    assert done.returncode == 66


def test_the_seccomp_profile_allows_the_vsock_family_and_is_otherwise_docker_defaults() -> None:
    profile = json.loads((VM_INIT / "control-seccomp.json").read_text(encoding="utf-8"))
    rules = [r for r in profile["syscalls"] if "socket" in r["names"]]

    assert profile["defaultAction"] == "SCMP_ACT_ERRNO"
    assert len(rules) == 1
    assert rules[0]["action"] == "SCMP_ACT_ALLOW"
    assert "args" not in rules[0]


def test_the_contract_names_this_package_as_the_program() -> None:
    contract = json.loads((CONTRACTS / "vm-init.v1.json").read_text(encoding="utf-8"))

    assert "runner/src/code_reviewer_runner/vm_init/" in contract["description"]
    pytest.importorskip("code_reviewer_runner.vm_init")
