# SPDX-License-Identifier: LicenseRef-Proprietary

"""Fixtures of the lane (#745, step 4): a whole Implementer turn on a real Docker daemon.

The lane needs a daemon, root, the two images and a runtime; anything missing is a failure that
names it, never a skip (`lane_support.preflight`)."""

import sys
from collections.abc import Iterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lane_support import lane_config, preflight, remove_leftovers


@pytest.fixture(scope="session", autouse=True)
def lane() -> Iterator[None]:
    preflight(lane_config())
    remove_leftovers()
    yield
    remove_leftovers()
