# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: `scripts/fetch_claude_code.py` does not take a program already in the cache for the pinned
one on its version string alone: only an install made from the two tarballs (the npm stub and the
platform program) that passed their digest checks, whose kept copies still have the digests, is
used again; a changed digest of either fails the fetch before anything is installed. Nothing here
runs npm or reaches the network (a double stands in for npm)."""

import base64
import hashlib
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "fetch_claude_code.py"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("fetch_claude_code", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["fetch_claude_code"] = module
    spec.loader.exec_module(module)
    return module


fetcher = load_script()
TARBALL = b"the pinned tarball"
PLATFORM_TARBALL = b"the pinned program"
ARCHITECTURE = "x64"


def digest_of(data: bytes) -> str:
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


DIGEST = digest_of(TARBALL)
PLATFORM_DIGEST = digest_of(PLATFORM_TARBALL)


@pytest.fixture
def cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A cache with a program that reports the pinned version, and pins that are `TARBALL` and
    `PLATFORM_TARBALL` (on a host of the architecture `ARCHITECTURE`)."""
    monkeypatch.setattr(fetcher, "CLAUDE_CODE_INTEGRITY", DIGEST)
    monkeypatch.setattr(fetcher, "PLATFORM_INTEGRITY", ((ARCHITECTURE, PLATFORM_DIGEST),))
    monkeypatch.setattr(fetcher, "host_architecture", lambda: ARCHITECTURE)
    pinned_version: Any = fetcher.CLAUDE_CODE_VERSION

    def reported(_path: Path) -> str:
        return str(pinned_version)

    monkeypatch.setattr(fetcher, "reported_version", reported)
    executable = tmp_path / fetcher.EXECUTABLE
    executable.parent.mkdir(parents=True)
    executable.write_text("#!/bin/sh\n")
    return tmp_path


def refused_npm(commands: list[list[str]]) -> Any:
    def run(argv: list[str], **_options: Any) -> subprocess.CompletedProcess[str]:
        commands.append(argv)
        return subprocess.CompletedProcess(argv, 1, "", "")

    return run


def fake_npm(commands: list[list[str]], *, stub: bytes, platform: bytes, tmp_path: Path) -> Any:
    """`npm pack` writes the tarball of the package into the pack destination, `npm install`
    makes the executable; every command is recorded."""

    def run(argv: list[str], **_options: Any) -> subprocess.CompletedProcess[str]:
        commands.append(argv)
        if argv[1] == "pack":
            data = platform if "-linux-" in argv[2] else stub
            name = "platform.tgz" if "-linux-" in argv[2] else "stub.tgz"
            (Path(argv[4]) / name).write_bytes(data)
        if argv[1] == "install":
            (tmp_path / fetcher.EXECUTABLE).parent.mkdir(parents=True, exist_ok=True)
            (tmp_path / fetcher.EXECUTABLE).write_text("#!/bin/sh\n")
        return subprocess.CompletedProcess(argv, 0, "", "")

    return run


def keep_both(cache: Path) -> None:
    (cache / fetcher.VERIFIED_TARBALL).write_bytes(TARBALL)
    (cache / fetcher.VERIFIED_PLATFORM_TARBALL).write_bytes(PLATFORM_TARBALL)


def test_an_install_with_both_verified_tarballs_is_used_again(cache: Path) -> None:
    keep_both(cache)

    assert fetcher.fetch(cache) == cache / fetcher.EXECUTABLE


def test_a_program_with_the_pinned_version_string_alone_is_installed_anew(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", refused_npm(commands))

    with pytest.raises(fetcher.PinError):
        fetcher.fetch(cache)

    assert commands and commands[0][0] == "npm", "the version string is no proof: fetched again"
    assert not (cache / fetcher.EXECUTABLE).exists(), "the unproven install was removed"


def test_a_kept_tarball_that_lost_its_digest_is_installed_anew(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    keep_both(cache)
    (cache / fetcher.VERIFIED_TARBALL).write_bytes(TARBALL + b" and something else")
    commands: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", refused_npm(commands))

    with pytest.raises(fetcher.PinError):
        fetcher.fetch(cache)

    assert commands and commands[0][0] == "npm"


# #856-T13
def test_an_install_without_its_verified_platform_tarball_is_installed_anew(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cache made when only the stub was pinned has the stub's tarball and no program's."""
    (cache / fetcher.VERIFIED_TARBALL).write_bytes(TARBALL)
    commands: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", refused_npm(commands))

    with pytest.raises(fetcher.PinError):
        fetcher.fetch(cache)

    assert commands and commands[0][0] == "npm"


# #856-T13
def test_a_kept_platform_tarball_that_lost_its_digest_is_installed_anew(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    keep_both(cache)
    (cache / fetcher.VERIFIED_PLATFORM_TARBALL).write_bytes(PLATFORM_TARBALL + b"!")
    commands: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", refused_npm(commands))

    with pytest.raises(fetcher.PinError):
        fetcher.fetch(cache)

    assert commands and commands[0][0] == "npm"


# #856-T13
def test_both_tarballs_with_their_digests_are_installed_from_the_files_and_kept(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        fake_npm(commands, stub=TARBALL, platform=PLATFORM_TARBALL, tmp_path=cache),
    )
    (cache / fetcher.EXECUTABLE).unlink()

    assert fetcher.fetch(cache) == cache / fetcher.EXECUTABLE

    packed = [c[2] for c in commands if c[1] == "pack"]
    assert packed == [
        f"{fetcher.PACKAGE}@{fetcher.CLAUDE_CODE_VERSION}",
        f"{fetcher.PACKAGE}-linux-{ARCHITECTURE}@{fetcher.CLAUDE_CODE_VERSION}",
    ]
    install = next(c for c in commands if c[1] == "install")
    assert "--offline" in install and sum(a.endswith(".tgz") for a in install) == 2
    assert (cache / fetcher.VERIFIED_TARBALL).read_bytes() == TARBALL
    assert (cache / fetcher.VERIFIED_PLATFORM_TARBALL).read_bytes() == PLATFORM_TARBALL


# #856-T13
def test_a_platform_tarball_with_another_digest_fails_the_fetch_before_any_install(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        fake_npm(commands, stub=TARBALL, platform=b"a changed program", tmp_path=cache),
    )

    with pytest.raises(fetcher.PinError, match="platform"):
        fetcher.fetch(cache)

    assert not [c for c in commands if c[1] == "install"]
    assert not (cache / fetcher.VERIFIED_PLATFORM_TARBALL).exists()


# #856-T13
def test_a_stub_tarball_with_another_digest_fails_the_fetch_before_any_install(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(
        subprocess,
        "run",
        fake_npm(commands, stub=b"a changed stub", platform=PLATFORM_TARBALL, tmp_path=cache),
    )

    with pytest.raises(fetcher.PinError, match="digest differs"):
        fetcher.fetch(cache)

    assert not [c for c in commands if c[1] == "install"]


# #856-T13
def test_a_host_with_no_pinned_program_fails_the_fetch_without_running_npm(
    cache: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", refused_npm(commands))
    monkeypatch.setattr(fetcher, "PLATFORM_INTEGRITY", (("arm64", PLATFORM_DIGEST),))

    with pytest.raises(fetcher.PinError, match="no pinned program"):
        fetcher.fetch(cache)

    assert commands == []


def test_the_host_architecture_names_are_those_of_the_platform_packages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(fetcher.platform, "system", lambda: "Linux")
    for machine, expected in (("x86_64", "x64"), ("aarch64", "arm64"), ("arm64", "arm64")):
        monkeypatch.setattr(fetcher.platform, "machine", lambda m=machine: m)
        assert fetcher.host_architecture() == expected
    monkeypatch.setattr(fetcher.platform, "machine", lambda: "riscv64")
    with pytest.raises(fetcher.PinError):
        fetcher.host_architecture()
