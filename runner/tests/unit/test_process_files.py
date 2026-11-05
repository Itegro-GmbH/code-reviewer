# SPDX-License-Identifier: LicenseRef-Proprietary

"""The files a real job process starts with (#840): the stored session of a follow-up turn lands in
the directory the process starts in, owner-only, and nowhere else."""

import asyncio
import json
import stat
import sys
from pathlib import Path

import pytest

from code_reviewer_runner.job_loop.process import (
    ProcessSpec,
    SubprocessLauncher,
    _put_file,  # pyright: ignore[reportPrivateUsage]
)

pytestmark = pytest.mark.unit

LISTING = (
    "import json, os, stat;"
    "print(json.dumps({n: [os.path.getsize(n), stat.S_IMODE(os.stat(n).st_mode), "
    "open(n,'rb').read(8).hex()] for n in sorted(os.listdir('.'))}))"
)


def run(spec: ProcessSpec) -> dict[str, list[object]]:
    async def scenario() -> dict[str, list[object]]:
        running = await SubprocessLauncher().start(spec)
        outcome = await running.wait()
        assert outcome.exit_code == 0, outcome.stderr
        return json.loads(outcome.stdout)

    return asyncio.run(scenario())


# #840-T120
def test_the_file_is_in_the_directory_the_process_starts_in_with_the_mode_of_its_owner() -> None:
    data = bytes(range(256)) * 10

    listing = run(
        ProcessSpec(
            argv=(sys.executable, "-c", LISTING),
            env={},
            stdin=b"",
            files={"resume-session.gz": data},
        )
    )

    assert listing == {"resume-session.gz": [len(data), 0o600, data[:8].hex()]}


# #840-T121
def test_a_process_without_files_starts_in_an_empty_directory() -> None:
    assert run(ProcessSpec(argv=(sys.executable, "-c", LISTING), env={}, stdin=b"")) == {}


# #840-T122
def test_a_file_is_made_new_and_never_through_a_link(tmp_path: Path) -> None:
    target = tmp_path / "elsewhere"
    target.write_bytes(b"keep")
    link = tmp_path / "resume-session.gz"
    link.symlink_to(target)

    with pytest.raises(OSError):
        _put_file(link, b"overwritten", None, None)

    assert target.read_bytes() == b"keep"
    plain = tmp_path / "plain"
    _put_file(plain, b"one", None, None)
    assert stat.S_IMODE(plain.stat().st_mode) == 0o600
    with pytest.raises(FileExistsError):
        _put_file(plain, b"two", None, None)


# #840-T123
def test_a_file_that_cannot_be_written_is_not_a_failed_start() -> None:
    listing = run(
        ProcessSpec(
            argv=(sys.executable, "-c", LISTING),
            env={},
            stdin=b"",
            files={"no-such-directory/resume-session.gz": b"x", "kept.bin": b"y"},
        )
    )

    assert list(listing) == ["kept.bin"]
