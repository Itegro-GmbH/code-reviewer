# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fixtures of the integration tests."""

from collections.abc import Iterator
from pathlib import Path

import pytest

from git_support import Origin, guard_git
from workspace_support import Rig


@pytest.fixture
def rig(tmp_path: Path) -> Iterator[Rig]:
    git = guard_git()
    yield Rig(tmp_path, git, Origin(tmp_path, git))
