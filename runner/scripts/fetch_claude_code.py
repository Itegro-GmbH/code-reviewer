# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fetches the pinned, unmodified Claude Code into a directory and verifies it (#856).

The engine suite runs the real Claude Code against the strict fake provider (the adapter of the
Factory-Runner, `implementer/claude_code`). The pin is the one the install layer builds with
(`claude_code/layer.py`): an exact version and the SHA-512 of its npm tarball. The tarball is
accepted only with that digest, before it is installed from the file, and the installed program must
report the pinned version. A program already in the cache is used again only with the verified
tarball next to it (`VERIFIED_TARBALL`, checked against the pinned digest again) and the pinned
version; the version string alone proves nothing, so anything else is installed anew.

The digest covers the npm package only. It is a stub whose platform binary is an optional
dependency that npm resolves from the registry on its own: **that binary is not pinned here.**

    uv run python scripts/fetch_claude_code.py [--dest DIR]

Prints the path of the verified executable. Needs Node.js and npm and the internet (the one step of
the engine job that does, like the tiktoken cache and the pinned OpenCode). Claude Code is
Anthropic's proprietary software: it is fetched for the tests, never shipped with the repository or
an image of ours.
"""

import argparse
import base64
import hashlib
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from code_reviewer_runner.implementer.claude_code.layer import (
    CLAUDE_CODE_INTEGRITY,
    CLAUDE_CODE_VERSION,
    PACKAGE,
)

DEFAULT_DESTINATION = Path.home() / ".cache" / "code-reviewer" / "claude-code"
EXECUTABLE = "node_modules/.bin/claude"
# The tarball that passed the digest check, kept beside the install it made.
VERIFIED_TARBALL = "verified-claude-code.tgz"
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


def is_verified_install(destination: Path) -> bool:
    """An install made by this script from the pinned tarball: the kept tarball still has the
    pinned digest and the program reports the pinned version."""
    kept, executable = destination / VERIFIED_TARBALL, destination / EXECUTABLE
    if not kept.is_file() or not executable.is_file():
        return False
    return integrity_of(kept) == CLAUDE_CODE_INTEGRITY and (
        reported_version(executable) == CLAUDE_CODE_VERSION
    )


def fetch(destination: Path) -> Path:
    executable = destination / EXECUTABLE
    if is_verified_install(destination):
        return executable
    destination.mkdir(parents=True, exist_ok=True)
    (destination / VERIFIED_TARBALL).unlink(missing_ok=True)
    shutil.rmtree(destination / "node_modules", ignore_errors=True)
    with tempfile.TemporaryDirectory() as scratch:
        packed = subprocess.run(
            ["npm", "pack", f"{PACKAGE}@{CLAUDE_CODE_VERSION}", "--pack-destination", scratch],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
        tarballs = sorted(Path(scratch).glob("*.tgz"))
        if packed.returncode != 0 or len(tarballs) != 1:
            raise PinError("the pinned package could not be fetched with npm")
        if integrity_of(tarballs[0]) != CLAUDE_CODE_INTEGRITY:
            raise PinError("the tarball is not the pinned one (the digest differs)")
        installed = subprocess.run(
            [
                "npm",
                "install",
                "--prefix",
                str(destination),
                "--no-audit",
                "--no-fund",
                str(tarballs[0]),
            ],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
        if installed.returncode != 0:
            raise PinError("the pinned package could not be installed with npm")
        if not (destination / EXECUTABLE).is_file():
            raise PinError("the installed program is not where it is expected")
        shutil.copyfile(tarballs[0], destination / VERIFIED_TARBALL)
    if reported_version(executable) != CLAUDE_CODE_VERSION:
        (destination / VERIFIED_TARBALL).unlink(missing_ok=True)
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
