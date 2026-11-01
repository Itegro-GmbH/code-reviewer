# SPDX-License-Identifier: LicenseRef-Proprietary

"""Which half of the engine suite a test file belongs to (#713). Not a test file.

CI runs the engine suite as two jobs next to the privileged one: the files that start the real,
pinned OpenCode (`--engine-shard=opencode`), and every other engine test, which start the real
PR-Agent (`--engine-shard=pragent`). The PR-Agent shard is "everything that is not in the OpenCode
list", so a new engine test file that nobody lists still runs in CI; the only way to drop a test is
to name its file here, and `tests/unit/test_engine_shards.py` checks that every name is a file.
"""

from pathlib import Path
from typing import Protocol

SHARDS = ("pragent", "opencode")

# The files of tests/engine that run the pinned OpenCode (directly, or through the native job).
OPENCODE_FILES = frozenset(
    {
        "test_engine_implementer.py",
        "test_engine_native_job.py",
        "test_engine_opencode.py",
        "test_engine_opencode_anthropic.py",
        "test_engine_opencode_caching.py",
        "test_engine_opencode_cost_policy.py",
        "test_engine_opencode_job_entry.py",
        "test_engine_opencode_native.py",
        "test_engine_opencode_passthrough.py",
        "test_engine_opencode_skills.py",
        "test_engine_plain_final.py",
        "test_native_support.py",
    }
)


def shard_of(path: Path) -> str:
    """The shard of one test file under tests/engine."""
    return "opencode" if path.name in OPENCODE_FILES else "pragent"


class HasPath(Protocol):
    @property
    def path(self) -> Path: ...


def split_by_shard[Item: HasPath](
    items: list[Item], shard: str | None, tests_root: Path
) -> tuple[list[Item], list[Item]]:
    """(kept, dropped) for `--engine-shard`: only files under tests/engine are ever dropped."""
    if shard is None:
        return items, []
    engine_root = tests_root / "engine"
    kept: list[Item] = []
    dropped: list[Item] = []
    for item in items:
        in_engine = item.path.is_relative_to(engine_root)
        (dropped if in_engine and shard_of(item.path) != shard else kept).append(item)
    return kept, dropped
