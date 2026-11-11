# SPDX-License-Identifier: LicenseRef-Proprietary

"""Shared pytest setup.

The level of a test is decided by its directory (tests/unit, tests/integration, tests/contract,
tests/engine, tests/privileged, tests/lane, tests/kvm, tests/incus), so the marker can never
drift from where the file lives. A test outside those directories is a collection error: it would
otherwise run unmarked and escape every level.
"""

import os
from pathlib import Path
from typing import cast

import pytest

from engine_shards import SHARDS, split_by_shard

# LiteLLM fetches its price list from GitHub when it is imported, unless told to use the bundled
# one. Tests import PR-Agent (and with it LiteLLM) while the collection of tests is still running,
# so this must be set here, before any test module is imported.
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

_LEVELS = ("unit", "integration", "contract", "engine", "privileged", "lane", "kvm", "incus")
_TESTS_ROOT = Path(__file__).parent
# Seconds per test, by level (pytest-timeout). Integration and contract tests start processes
# and servers; engine tests run the real PR-Agent; privileged tests start the real engine user.
_TIMEOUTS = {
    "unit": 10,
    "integration": 60,
    "contract": 60,
    "engine": 180,
    "privileged": 180,
    "lane": 900,
    "kvm": 1200,
    "incus": 900,
}


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--engine-shard",
        choices=SHARDS,
        default=None,
        help="run only this half of tests/engine: the files that start OpenCode, or all the others",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    shard = cast("str | None", config.getoption("--engine-shard"))  # pyright: ignore[reportUnknownMemberType]
    kept, dropped = split_by_shard(items, shard, _TESTS_ROOT)
    if dropped:
        config.hook.pytest_deselected(items=dropped)
        items[:] = kept
    for item in items:
        relative = Path(item.path).relative_to(_TESTS_ROOT)
        level = relative.parts[0]
        if level not in _LEVELS:
            raise pytest.UsageError(
                f"{relative} is not under tests/{{{','.join(_LEVELS)}}}; "
                "place the test in the directory of its level"
            )
        item.add_marker(getattr(pytest.mark, level))
        item.add_marker(pytest.mark.timeout(_TIMEOUTS[level]))
