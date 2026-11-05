# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fetches the pinned, unmodified Claude Code into a directory and verifies it (#856).

The engine suite runs the real Claude Code against the strict fake provider (the adapter of the
Factory-Runner, `implementer/claude_code`). The pin is the one the install layer builds with
(`claude_code/layer.py`): an exact version and the SHA-512 of its npm tarball. The tarball is
accepted only with that digest, before it is installed from the file, and the installed program must
report the pinned version.

    uv run python scripts/fetch_claude_code.py [--dest DIR]

Prints the path of the verified executable. Needs Node.js and npm and the internet (the one step of
the engine job that does, like the tiktoken cache and the pinned OpenCode). Claude Code is
Anthropic's proprietary software: it is fetched for the tests, never shipped with the repository or
an image of ours.
"""

import argparse
import base64
import hashlib
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


def fetch(destination: Path) -> Path:
    executable = destination / EXECUTABLE
    if executable.is_file() and reported_version(executable) == CLAUDE_CODE_VERSION:
        return executable
    destination.mkdir(parents=True, exist_ok=True)
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
    if not executable.is_file() or reported_version(executable) != CLAUDE_CODE_VERSION:
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
