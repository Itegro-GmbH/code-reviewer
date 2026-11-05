# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: `scripts/fetch_claude_code.py` does not take a program already in the cache for the pinned
one on its version string alone: only an install made from the tarball that passed the digest
check, whose kept copy still has the digest, is used again. Nothing here runs npm or reaches the
network."""

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
DIGEST = "sha512-" + base64.b64encode(hashlib.sha512(TARBALL).digest()).decode()


@pytest.fixture
def cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A cache with a program that reports the pinned version, and a pin that is `TARBALL`."""
    monkeypatch.setattr(fetcher, "CLAUDE_CODE_INTEGRITY", DIGEST)
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


def test_an_install_with_the_verified_tarball_is_used_again(cache: Path) -> None:
    (cache / fetcher.VERIFIED_TARBALL).write_bytes(TARBALL)

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
    (cache / fetcher.VERIFIED_TARBALL).write_bytes(TARBALL + b" and something else")
    commands: list[list[str]] = []
    monkeypatch.setattr(subprocess, "run", refused_npm(commands))

    with pytest.raises(fetcher.PinError):
        fetcher.fetch(cache)

    assert commands and commands[0][0] == "npm"
