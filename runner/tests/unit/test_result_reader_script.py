# SPDX-License-Identifier: LicenseRef-Proprietary

"""The command the reader runs to read the result file (#843), run for real on a local directory.

The agent can put anything where the result file is: a link to a file it should not reveal, a named
pipe that blocks the reader, a directory. The script is a constant (`READ_RESULT_SCRIPT`); what
these tests hold is its behaviour on a real file system, with no Docker: only a plain file that is
not a link is read, and at most the bound."""

import os
import subprocess
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.result_channel import READ_RESULT_SCRIPT


def read(path: Path, limit: int = 1000) -> tuple[int, bytes]:
    done = subprocess.run(
        ["/bin/sh", "-c", READ_RESULT_SCRIPT, "read", str(path), str(limit)],
        capture_output=True,
        timeout=5,
        check=False,
        stdin=subprocess.DEVNULL,
    )
    return done.returncode, done.stdout


@pytest.mark.unit
def test_a_plain_file_is_read_up_to_the_bound(tmp_path: Path) -> None:
    result = tmp_path / "result.json"
    result.write_bytes(b'{"a": 1}' + b" " * 100)

    assert read(result) == (0, result.read_bytes())
    assert read(result, 8) == (0, b'{"a": 1}')


@pytest.mark.unit
def test_a_link_is_not_followed_whatever_it_points_to(tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_bytes(b"not for the agent's result")
    link = tmp_path / "result.json"
    link.symlink_to(secret)
    dangling = tmp_path / "dangling.json"
    dangling.symlink_to(tmp_path / "nowhere")

    for path in (link, dangling):
        code, out = read(path)
        assert code != 0 and out == b""


@pytest.mark.unit
def test_a_named_pipe_is_not_opened_so_it_cannot_hold_the_reader(tmp_path: Path) -> None:
    pipe = tmp_path / "result.json"
    os.mkfifo(pipe)

    code, out = read(pipe)  # the 5 s timeout of `read` fails the test if the script blocks

    assert code != 0 and out == b""


@pytest.mark.unit
def test_a_directory_and_a_missing_file_are_no_result(tmp_path: Path) -> None:
    directory = tmp_path / "result.json"
    directory.mkdir()
    (directory / "inner").write_bytes(b"x")

    assert read(directory) == (1, b"")
    assert read(tmp_path / "missing.json") == (1, b"")
