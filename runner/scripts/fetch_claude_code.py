# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fetches the pinned, unmodified Claude Code into a directory and verifies it (#856).

The engine suite runs the real Claude Code against the strict fake provider (the adapter of the
Factory-Runner, `implementer/claude_code`). The pin is the one the install layer builds with
(`claude_code/layer.py`): an exact version and the SHA-512 of its npm tarball. The tarball is
accepted only with that digest, before it is installed from the file, and the installed program must
report the pinned version. A program already in the cache is used again only with the verified
tarball next to it (`VERIFIED_TARBALL`, checked against the pinned digest again) and the pinned
version; the version string alone proves nothing, so anything else is installed anew.

The npm package is only a stub: the program is the platform package it names as an optional
dependency. That one is pinned too (`PLATFORM_INTEGRITY`, the glibc builds for linux x64 and
arm64): its tarball is fetched for the host's architecture and accepted only with its own digest,
and both tarballs are installed from the files with `--offline`, so npm resolves nothing from the
registry on its own. A host with no pinned program (another system, architecture or libc) is
refused.

    uv run python scripts/fetch_claude_code.py [--dest DIR]

Prints the path of the verified executable. Needs Node.js and npm and the internet (the one step of
the engine job that does, like the tiktoken cache and the pinned OpenCode). Claude Code is
Anthropic's proprietary software: it is fetched for the tests, never shipped with the repository or
an image of ours.
"""

import argparse
import base64
import hashlib
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_INTEGRITY,
    CLAUDE_CODE_VERSION,
    MACHINE_ARCHITECTURES,
    PACKAGE,
    PLATFORM_INTEGRITY,
    platform_package,
)

DEFAULT_DESTINATION = Path.home() / ".cache" / "code-reviewer" / "claude-code"
EXECUTABLE = "node_modules/.bin/claude"
# The tarball that passed the digest check, kept beside the install it made.
VERIFIED_TARBALL = "verified-claude-code.tgz"
# The same for the platform program.
VERIFIED_PLATFORM_TARBALL = "verified-claude-code-platform.tgz"
TIMEOUT_SECONDS = 600


class PinError(Exception):
    """The artifact is not the pinned one. The message names the check."""


def integrity_of(path: Path) -> str:
    digest = hashlib.sha512(path.read_bytes()).digest()
    return "sha512-" + base64.b64encode(digest).decode()


def reported_version(executable: Path) -> str:
    done = subprocess.run(
        [str(executable), "--version"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return done.stdout.split(" ")[0].strip()


def host_architecture() -> str:
    """The architecture name of the platform packages for this host, or `PinError`."""
    architecture = MACHINE_ARCHITECTURES.get(platform.machine().lower())
    if platform.system() != "Linux" or architecture is None:
        raise PinError(
            f"no pinned program for {platform.system()} {platform.machine()} "
            "(linux x64 and arm64 with glibc are pinned)"
        )
    return architecture


def platform_pin(architecture: str) -> str:
    pinned = dict(PLATFORM_INTEGRITY).get(architecture)
    if pinned is None:
        raise PinError(f"no pinned program for the architecture {architecture}")
    return pinned


def is_verified_install(destination: Path, platform_integrity: str) -> bool:
    """An install made by this script from the pinned tarballs: both kept tarballs still have
    their pinned digests and the program reports the pinned version."""
    kept, executable = destination / VERIFIED_TARBALL, destination / EXECUTABLE
    kept_platform = destination / VERIFIED_PLATFORM_TARBALL
    if not kept.is_file() or not kept_platform.is_file() or not executable.is_file():
        return False
    return (
        integrity_of(kept) == CLAUDE_CODE_INTEGRITY
        and integrity_of(kept_platform) == platform_integrity
        and reported_version(executable) == CLAUDE_CODE_VERSION
    )


def packed_tarball(spec: str, scratch: str) -> Path:
    """The tarball of a package as `npm pack` fetched it into the empty directory `scratch`."""
    packed = subprocess.run(
        ["npm", "pack", spec, "--pack-destination", scratch],
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    tarballs = sorted(Path(scratch).glob("*.tgz"))
    if packed.returncode != 0 or len(tarballs) != 1:
        raise PinError(f"{spec} could not be fetched with npm")
    return tarballs[0]


def fetch(destination: Path) -> Path:
    architecture = host_architecture()
    platform_integrity = platform_pin(architecture)
    executable = destination / EXECUTABLE
    if is_verified_install(destination, platform_integrity):
        return executable
    destination.mkdir(parents=True, exist_ok=True)
    for kept in (VERIFIED_TARBALL, VERIFIED_PLATFORM_TARBALL):
        (destination / kept).unlink(missing_ok=True)
    shutil.rmtree(destination / "node_modules", ignore_errors=True)
    with (
        tempfile.TemporaryDirectory() as stub_scratch,
        tempfile.TemporaryDirectory() as program_scratch,
    ):
        stub = packed_tarball(f"{PACKAGE}@{CLAUDE_CODE_VERSION}", stub_scratch)
        if integrity_of(stub) != CLAUDE_CODE_INTEGRITY:
            raise PinError("the tarball is not the pinned one (the digest differs)")
        program = packed_tarball(
            f"{platform_package(architecture)}@{CLAUDE_CODE_VERSION}", program_scratch
        )
        if integrity_of(program) != platform_integrity:
            raise PinError("the platform tarball is not the pinned one (the digest differs)")
        installed = subprocess.run(
            [
                "npm",
                "install",
                "--prefix",
                str(destination),
                "--offline",
                "--no-audit",
                "--no-fund",
                str(stub),
                str(program),
            ],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
        if installed.returncode != 0:
            raise PinError("the pinned package could not be installed with npm")
        if not executable.is_file():
            raise PinError("the installed program is not where it is expected")
        shutil.copyfile(stub, destination / VERIFIED_TARBALL)
        shutil.copyfile(program, destination / VERIFIED_PLATFORM_TARBALL)
    if reported_version(executable) != CLAUDE_CODE_VERSION:
        for kept in (VERIFIED_TARBALL, VERIFIED_PLATFORM_TARBALL):
            (destination / kept).unlink(missing_ok=True)
        raise PinError("the installed program does not report the pinned version")
    return executable


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, default=DEFAULT_DESTINATION)
    arguments = parser.parse_args(argv)
    try:
        print(fetch(arguments.dest))
    except (PinError, OSError, subprocess.SubprocessError) as error:
        print(f"fetch_claude_code: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
