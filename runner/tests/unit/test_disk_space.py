# SPDX-License-Identifier: LicenseRef-Proprietary

"""`disk_space`: what the push's room check (`git_workspace`) reads from the mirror's file system."""

import os
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.git_workspace import (
    MIN_FREE_INODES,
    DiskSpace,
    disk_space,
)

pytestmark = pytest.mark.unit


def fake_statvfs(*, files: int, favail: int) -> os.statvfs_result:
    # (bsize, frsize, blocks, bfree, bavail, files, ffree, favail, flag, namemax)
    return os.statvfs_result((4096, 4096, 1000, 800, 700, files, favail, favail, 0, 255))


# #1020-T07
def test_a_file_system_without_an_inode_table_has_room_for_inodes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """btrfs (the Incus pool) has no fixed inode table: it reports no inodes at all (`f_files` 0),
    which the check must not read as a full table, or the job ends `clone_failed` on an empty disk."""
    monkeypatch.setattr(os, "statvfs", lambda _path: fake_statvfs(files=0, favail=0))

    space = disk_space(Path("/"))

    assert space.free_bytes == 700 * 4096
    assert space.free_inodes >= MIN_FREE_INODES


# #1020-T07
def test_a_file_system_with_an_inode_table_reports_the_inodes_that_are_free(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(os, "statvfs", lambda _path: fake_statvfs(files=50_000, favail=123))

    assert disk_space(Path("/")) == DiskSpace(free_bytes=700 * 4096, free_inodes=123)
