# SPDX-License-Identifier: LicenseRef-Proprietary

"""Git is free inside the agent's container and the one push at the end is the runner's, on a real
Docker daemon (#745, step 4): E06 and E07 of the plan's table, against the real reader."""

from collections.abc import Mapping
from pathlib import Path
from typing import Any

from fakes.wire.formats import Turn
from lane_support import BRANCH, bash, commit, lane_turn, says, write_file

from code_reviewer_runner.implementer.git_workspace import (
    REASON_NOT_FAST_FORWARD,
    REASON_WORKFLOWS,
)
from git_support import Origin, raw


def subjects_ahead(origin: Origin, branch: str) -> list[str]:
    return raw(
        "log", "--reverse", "--format=%s", f"main..{branch}", cwd=origin.path, git=origin.git
    ).splitlines()


# #745-E06
def test_git_is_free_in_the_workspace_and_every_local_branch_arrives_at_the_end(
    tmp_path: Path,
) -> None:
    side = "e06-side"
    seen: list[list[str]] = []
    holder: list[Origin] = []

    def judge(headers: Mapping[str, str], body: Mapping[str, Any]) -> None:
        # Whatever the agent does, nothing is on the remote while it works.
        if body.get("tools") and holder:
            seen.append(holder[0].branches())

    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "a.txt", "a\n"),
            commit("First"),
            bash("git commit --amend -q -m Amended; echo '[amend]' $?"),
            bash(
                f"git switch -q -c {side} && echo side > side.txt && git add -A "
                "&& git commit -q -m Side; echo '[side]' $?"
            ),
            bash(f"git switch -q {BRANCH}; echo '[back]' $?"),
            write_file(repo, "b.txt", "b\n"),
            commit("Second"),
            bash("git reset -q --hard HEAD~1; echo '[reset]' $?"),
            write_file(repo, "c.txt", "c\n"),
            bash(
                "git -c core.hooksPath=/dev/null add -A && git -c core.hooksPath=/dev/null "
                "commit -q -m Third; echo '[bypass]' $?"
            ),
            bash("git push origin HEAD 2>&1; echo '[push]' $?"),
            bash(
                "GIT_TERMINAL_PROMPT=0 git push file:///no/such/e06.git "
                "HEAD:refs/heads/e06-direct 2>&1; echo '[push-direct]' $?"
            ),
            says("Rewrote some history, made a side branch, and added c.txt."),
        ]

    with lane_turn(
        tmp_path, script, judge=judge, origin_setup=lambda origin: holder.append(origin)
    ) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        # What the history became in the workspace is what arrived: the amended first commit and
        # the third on the task's branch, the amended one and the side commit on the side branch.
        # The reset dropped "Second" before anything was pushed.
        assert subjects_ahead(turned.origin, BRANCH) == ["Amended", "Third"]
        assert subjects_ahead(turned.origin, side) == ["Amended", "Side"]
        assert turned.origin_tip("e06-direct") is None
        assert all("refs/heads/" + BRANCH not in refs for refs in seen), seen
        assert seen, "the remote was looked at while the agent worked"
        shown = turned.tool_results()
        for attempt in ("amend", "side", "back", "reset", "bypass"):
            assert f"[{attempt}] 0" in shown, attempt
        # a push by name fails because the repository has no remote, a push to an address fails
        assert "[push] 128" in shown or "[push] 1" in shown
        assert "'origin' does not appear to be a git repository" in shown
        assert "[push-direct] 128" in shown
        assert [(b.name, b.pushed) for b in result.branches] == [(BRANCH, True), (side, True)]
        # The agent switched back to the task's branch before it ended (#837).
        assert result.checked_out == BRANCH


# #837
def test_the_branch_the_agent_ends_on_is_reported_as_the_one_checked_out(tmp_path: Path) -> None:
    side = "e837-side"

    def script(_repo: Path) -> list[Turn]:
        return [
            bash(
                f"git switch -q -c {side} && echo x > x.txt && git add -A "
                "&& git commit -q -m Side; echo '[side]' $?"
            ),
            says("Worked on a branch of my own."),
        ]

    with lane_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert [(b.name, b.pushed) for b in result.branches] == [(side, True)]
        assert result.checked_out == side
        assert result.implementer_block()["checkedOut"] == side


# #837
def test_work_on_a_detached_head_is_saved_and_that_branch_is_the_one_checked_out(
    tmp_path: Path,
) -> None:
    def script(_repo: Path) -> list[Turn]:
        return [
            bash(
                "git checkout -q --detach && echo y > y.txt && git add -A "
                "&& git commit -q -m Loose; echo '[loose]' $?"
            ),
            says("Committed on a detached HEAD."),
        ]

    with lane_turn(tmp_path, script) as turned:
        result = turned.result

        assert result.ok or result.branches, (result.error_code, result.error_detail, result.notes)
        saved = [b.name for b in result.branches if b.name.startswith(f"{BRANCH}-leftover-")]
        assert len(saved) == 1 and result.branches[0].pushed
        assert result.checked_out == saved[0]


# #745-E07
def test_a_rewrite_of_a_branch_on_the_remote_and_a_workflow_file_are_each_rejected_for_their_branch(
    tmp_path: Path,
) -> None:
    existing = "e07-existing"
    # Not called "workflow": the runner reads the reason the provider gives, never the name.
    workflow = "e07-ci-file"

    def setup(origin: Origin) -> None:
        base = origin.tip("main") or ""
        raw("update-ref", f"refs/heads/{existing}", base, cwd=origin.path, git=origin.git)
        origin.reject_ref_with_hook(
            f"refs/heads/{workflow}",
            "refusing to allow a GitHub App to create or update workflow "
            "`.github/workflows/smoke.yml` without `workflows` permission",
        )

    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "a.txt", "a\n"),
            commit("Good"),
            bash(
                f"git switch -q --orphan {existing} && git rm -rfq . ; echo fresh > fresh.txt "
                "&& git add -A && git commit -q -m Rewritten; echo '[rewrite]' $?"
            ),
            bash(f"git switch -q {BRANCH}; echo '[back]' $?"),
            bash(
                f"git switch -q -c {workflow} && mkdir -p .github/workflows "
                "&& echo 'on: push' > .github/workflows/smoke.yml && git add -A "
                "&& git commit -q -m Workflow; echo '[workflow]' $?"
            ),
            bash(f"git switch -q {BRANCH}; echo '[back-again]' $?"),
            says("Done."),
        ]

    with lane_turn(tmp_path, script, origin_setup=setup) as turned:
        result = turned.result
        base = turned.origin.tip("main")

        # The task's own branch arrived, so the turn succeeded; the others are rejected ones.
        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert subjects_ahead(turned.origin, BRANCH) == ["Good"]
        by_name = {b.name: b for b in result.branches}
        assert by_name[BRANCH].pushed
        assert not by_name[existing].pushed and by_name[existing].reason == REASON_NOT_FAST_FORWARD
        assert not by_name[workflow].pushed and by_name[workflow].reason == REASON_WORKFLOWS
        # Never forced: the existing branch is where it was, and the workflow branch is not there.
        assert turned.origin_tip(existing) == base
        assert turned.origin_tip(workflow) is None
