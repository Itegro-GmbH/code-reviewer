# SPDX-License-Identifier: LicenseRef-Proprietary

"""The `repos` of the implementer block (#1093, epic #1090, ADR 0006): one entry per repository, the
old fields copies of the first, the size budget and the cut with its counters, and the texts of the
entries held to the bounds and scrubbed of secrets like the old fields."""

import json
from dataclasses import replace
from typing import Any

import pytest

from code_reviewer_runner.implementer.history import ChangeKind, CommitInfo, FileChange
from code_reviewer_runner.implementer.report import (
    CUT_STEP,
    MAX_REPO_COMMITS,
    MAX_REPO_FILES,
    REPOS_BUDGET_BYTES,
    body_fits,
    escaped_size,
    fit_block,
    fit_repos,
    valid_block,
)
from code_reviewer_runner.implementer.turn_result import RepoOutcome, TurnResult
from code_reviewer_runner.job_loop.reporting import _short_block  # pyright: ignore[reportPrivateUsage]
from code_reviewer_runner.result import Usage

pytestmark = pytest.mark.unit

BASE = "1" * 40


def sha(number: int) -> str:
    return f"{number:040x}"


def outcome(
    name: str, *, commits: int = 1, files: int = 1, path: str = "src/a.ts", **changes: Any
) -> RepoOutcome:
    listed = tuple(CommitInfo(sha(number + 1), f"change {number}") for number in range(commits))
    head = listed[-1].sha if listed else BASE
    values: dict[str, Any] = {
        "name": name,
        "full_name": f"acme/{name}",
        "base": "main",
        "branch": f"feature/{name}",
        "created": True,
        "base_commit": BASE,
        "head_commit": head,
        "pushed": True,
        "commits": listed,
        "files_changed": tuple(
            FileChange(f"{path}{number}", ChangeKind.ADDED) for number in range(files)
        ),
        "branches": (),
    }
    return RepoOutcome(**{**values, **changes})


def turn(*repos: RepoOutcome) -> TurnResult:
    first = repos[0]
    return TurnResult(
        error_code=None,
        error_detail=None,
        base_commit=first.base_commit,
        head_commit=first.head_commit,
        pushed=first.pushed,
        branches=(),
        branches_dropped=(0, 0),
        commits=first.commits,
        files_changed=first.files_changed,
        summary="Done.",
        opencode_session_id=None,
        opencode_version="1",
        usage=Usage(None, 0, 0, 0, 0, False, None),
        repos=repos,
    )


def block_of(*repos: RepoOutcome) -> dict[str, Any]:
    return turn(*repos).implementer_block()


# #1093-T50
def test_the_old_fields_are_copies_of_the_first_repository_and_the_block_is_valid() -> None:
    block = block_of(outcome("app", commits=3, files=2), outcome("lib"))

    assert valid_block(block) is not None
    first = block["repos"][0]
    for key in ("baseCommit", "headCommit", "pushed", "commits", "filesChanged"):
        assert block[key] == first[key], key
    assert [entry["name"] for entry in block["repos"]] == ["app", "lib"]


# #1093-T51
def test_a_block_whose_old_fields_differ_from_the_first_entry_is_refused() -> None:
    block = block_of(outcome("app"), outcome("lib"))
    block["headCommit"] = sha(99)

    assert valid_block(block) is None


# #1093-T52
def test_a_repository_twice_or_eleven_repositories_are_refused() -> None:
    assert valid_block(block_of(outcome("app"), outcome("APP"))) is None
    assert valid_block(block_of(*(outcome(f"r{n}") for n in range(11)))) is None
    assert valid_block(block_of(*(outcome(f"r{n}") for n in range(10)))) is not None


# #1093-T53
def test_an_entry_has_at_most_100_commits_and_250_files_and_counts_what_it_left_out() -> None:
    block = block_of(outcome("app", commits=130, files=300))

    entry = block["repos"][0]
    assert (
        len(entry["commits"]) == MAX_REPO_COMMITS and len(entry["filesChanged"]) == MAX_REPO_FILES
    )
    assert entry["commitsTruncated"] == 30 and entry["filesTruncated"] == 50
    # The newest commits stay, the head last.
    assert entry["commits"][-1]["sha"] == sha(130)
    assert valid_block(block) is not None


# #1093-T54
def test_a_head_commit_that_is_not_the_last_of_the_commits_is_refused() -> None:
    block = block_of(outcome("app", commits=2), outcome("lib", commits=2))
    block["repos"][1]["headCommit"] = sha(1)

    assert valid_block(block) is None


# #1093-T55
def test_pushed_without_a_head_commit_is_refused_in_an_entry() -> None:
    block = block_of(outcome("app"), outcome("lib", commits=0, head_commit=None, pushed=True))

    assert valid_block(block) is None


# #1093-T56
def test_a_report_that_fits_is_left_as_it_is() -> None:
    block = block_of(outcome("app", commits=5, files=5), outcome("lib"))

    assert fit_block(block, 1000) == block


# #1093-T57
def test_over_its_budget_the_largest_entry_gives_up_files_first_ten_at_a_time() -> None:
    long = "d" * 4000
    block = block_of(
        outcome("app", files=250, path=long),
        outcome("lib", files=250, path=long),
        outcome("mid", files=250, path=long),
        outcome("x"),
    )
    before = escaped_size(block["repos"]) + escaped_size(
        {"commits": block["commits"], "filesChanged": block["filesChanged"]}
    )
    assert before > REPOS_BUDGET_BYTES

    fitted = fit_repos(block, 1000)

    after = escaped_size(fitted["repos"]) + escaped_size(
        {"commits": fitted["commits"], "filesChanged": fitted["filesChanged"]}
    )
    assert after <= REPOS_BUDGET_BYTES
    for entry in fitted["repos"][:3]:
        cut = int(entry.get("filesTruncated", 0))
        assert cut % CUT_STEP == 0 and len(entry["filesChanged"]) == 250 - cut
    assert fitted["repos"][3]["filesChanged"] == block["repos"][3]["filesChanged"]
    # Nothing is dropped without a counter, and the old fields stay copies of the first entry.
    assert fitted["filesChanged"] == fitted["repos"][0]["filesChanged"]
    assert valid_block(fitted) is not None


# #1093-T58
def test_when_the_files_are_gone_the_commits_go_from_the_oldest_end_and_the_head_stays() -> None:
    # Ten repositories with 100 commits of 500 characters each, outside the Basic Multilingual
    # Plane (twelve bytes each escaped): far over 3 MiB.
    wide = "\U0001f600" * 500
    commits = tuple(CommitInfo(sha(n + 1), wide) for n in range(100))
    entries = [
        outcome(f"r{n}", files=0, commits=0, head_commit=commits[-1].sha, base_commit=BASE)
        for n in range(10)
    ]
    entries = [replace(entry, commits=commits) for entry in entries]
    block = block_of(*entries)
    assert escaped_size(block["repos"]) > REPOS_BUDGET_BYTES

    fitted = fit_repos(block, 1000)

    for entry in fitted["repos"]:
        assert entry["commits"][-1]["sha"] == commits[-1].sha, "the head always stays"
        assert entry.get("commitsTruncated", 0) % CUT_STEP == 0
        assert len(entry["commits"]) + entry.get("commitsTruncated", 0) == 100
    assert any(entry.get("commitsTruncated", 0) for entry in fitted["repos"])
    assert valid_block(fitted) is not None


# #1093-T59
def test_the_short_report_keeps_the_copies_equal_to_the_first_entry() -> None:
    block = block_of(outcome("app", commits=4, files=3), outcome("lib", commits=2))

    short = _short_block(block)

    assert short["commits"] == short["repos"][0]["commits"]
    assert short["filesChanged"] == short["repos"][0]["filesChanged"] == []
    assert valid_block(short) is not None


# #1093-T60
def test_a_repository_that_may_not_push_has_no_head_no_commits_and_no_branches() -> None:
    entry = RepoOutcome(
        name="app",
        full_name="acme/app",
        base="main",
        branch="feature/x",
        created=True,
        base_commit=BASE,
        head_commit=None,
        pushed=False,
    ).block()

    assert entry["headCommit"] is None and entry["commits"] == [] and "branches" not in entry
    assert (
        valid_block(block_of(outcome("app", head_commit=None, pushed=False, commits=0))) is not None
    )


# #1093-T61
def test_the_entries_are_json_the_runner_can_write() -> None:
    json.dumps(block_of(outcome("app"), outcome("lib")))


# #1093-T68
def test_the_cut_counts_what_surrounds_the_block_so_that_the_body_stays_within_its_budget() -> None:
    long = "d" * 4000
    block = block_of(
        outcome("app", files=250, path=long),
        outcome("lib", files=250, path=long),
    )
    # A result around the block that takes most of the 1 MiB the 3 MiB budget leaves: the body
    # budget (4 MiB) is what decides, not the 3 MiB of `repos` alone.
    around = 2 * 1024 * 1024
    plain = fit_repos(block, 1000)

    fitted = fit_repos(block, around)

    assert escaped_size(fitted["repos"]) < escaped_size(plain["repos"])
    assert body_fits(fitted, around)
    assert not body_fits(plain, around)
    assert valid_block(fitted) is not None
    assert fitted["filesChanged"] == fitted["repos"][0]["filesChanged"]


# #1093-T69
def test_a_body_that_cannot_be_cut_to_fit_is_said_not_to_fit_and_a_smaller_budget_cuts_more() -> (
    None
):
    block = block_of(outcome("app", files=250, path="d" * 4000), outcome("lib"))

    fitted = fit_repos(block, 1000, body_budget=1024 * 1024)

    assert escaped_size(fitted) + 1000 <= 1024 * 1024
    # Nothing left to cut and still too large: the caller is told (and leaves the report out).
    assert body_fits(fitted, 1000, body_budget=1024 * 1024)
    assert not body_fits(fitted, 5 * 1024 * 1024)
