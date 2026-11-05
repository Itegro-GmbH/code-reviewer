# SPDX-License-Identifier: LicenseRef-Proprietary

"""The push guard of a turn that runs on the device's login (#856): before a branch is pushed, the
commits and objects it adds (not the history it started from) are read for the login token and the
spellings the redactor knows, and a branch that holds it is not pushed. Real git, a bare repository
for the provider."""

import base64
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytest

from code_reviewer_runner.implementer.git_process import Outcome
from code_reviewer_runner.implementer.git_workspace import (
    REASON_LOGIN_SECRET,
    REASON_UNCHECKED,
    GitWorkspace,
    PushReport,
)
from workspace_support import BRANCH, Rig, agent_git, commit

# A made-up token of the shape `claude setup-token` prints; it is the guard's secret in these tests.
LOGIN = "sk-" + "ant-" + "oat01-Zq9+/Lm3Xv_Tn8Rk5Wc2-guardtestguardtestguardtest=="
SECONDS = 120.0


def guarded(rig: Rig, **options: Any) -> GitWorkspace:
    workspace = rig.workspace(guard_secrets=(LOGIN,), **options)
    workspace.prepare()
    return workspace


def push(workspace: GitWorkspace) -> PushReport:
    return workspace.push_all(seconds=SECONDS)


def reason_of(report: PushReport, name: str = BRANCH) -> str | None:
    found = [entry for entry in report.branches if entry.name == name]
    assert len(found) == 1, [entry.name for entry in report.branches]
    return found[0].reason


# #856-G01
def test_a_branch_with_the_login_in_a_file_is_not_pushed(rig: Rig) -> None:
    workspace = guarded(rig)
    commit(workspace, "notes.txt", f"the token is {LOGIN}\n")

    report = push(workspace)

    assert reason_of(report) == REASON_LOGIN_SECRET
    assert not report.pushed_any and rig.origin.tip(BRANCH) is None


# #856-G01
@pytest.mark.parametrize(
    "form",
    [
        quote(LOGIN, safe=""),
        base64.b64encode(LOGIN.encode()).decode(),
        base64.urlsafe_b64encode(LOGIN.encode()).decode(),
    ],
    ids=["url-quoted", "base64", "base64-url"],
)
def test_the_spellings_of_the_redactor_are_found_too(rig: Rig, form: str) -> None:
    workspace = guarded(rig)
    commit(workspace, "config.txt", f"value={form}\n")

    assert reason_of(push(workspace)) == REASON_LOGIN_SECRET


# #856-G01
def test_the_login_in_a_commit_message_is_found(rig: Rig) -> None:
    workspace = guarded(rig)
    (workspace.repo / "a.txt").write_text("x\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    assert agent_git(workspace, "commit", "-qm", f"use {LOGIN}").returncode == 0

    assert reason_of(push(workspace)) == REASON_LOGIN_SECRET


# #856-G01
def test_the_login_in_a_file_name_is_found(rig: Rig) -> None:
    workspace = rig.workspace(guard_secrets=("filenametoken0123456789abcdef",))
    workspace.prepare()
    commit(workspace, "filenametoken0123456789abcdef.txt", "x\n")

    assert reason_of(push(workspace)) == REASON_LOGIN_SECRET


# #856-G01
def test_the_login_in_the_name_of_a_branch_is_found(rig: Rig) -> None:
    workspace = rig.workspace(guard_secrets=("agentbranchtokenvalue12345",))
    workspace.prepare()
    commit(workspace, "a.txt")
    assert agent_git(workspace, "branch", "agentbranchtokenvalue12345").returncode == 0
    assert agent_git(workspace, "checkout", "-q", "agentbranchtokenvalue12345").returncode == 0
    commit(workspace, "b.txt")

    report = push(workspace)

    assert reason_of(report, "agentbranchtokenvalue12345") == REASON_LOGIN_SECRET
    assert rig.origin.tip("agentbranchtokenvalue12345") is None


# #856-G02
def test_a_login_that_was_added_and_removed_again_is_still_in_the_history(rig: Rig) -> None:
    workspace = guarded(rig)
    commit(workspace, "oops.txt", f"{LOGIN}\n")
    commit(workspace, "oops.txt", "removed\n")

    assert reason_of(push(workspace)) == REASON_LOGIN_SECRET
    assert rig.origin.tip(BRANCH) is None


# #856-G02
def test_a_large_binary_file_is_read_too(rig: Rig) -> None:
    workspace = guarded(rig)
    blob = workspace.repo / "blob.bin"
    blob.write_bytes(b"\x00" * (3 * 1024 * 1024) + LOGIN.encode() + b"\x00" * 1024)
    assert agent_git(workspace, "add", "-A").returncode == 0
    assert agent_git(workspace, "commit", "-qm", "blob").returncode == 0

    assert reason_of(push(workspace)) == REASON_LOGIN_SECRET


# #856-G03
def test_only_the_branch_that_holds_the_login_is_refused(rig: Rig) -> None:
    workspace = guarded(rig)
    clean = commit(workspace, "a.txt")
    assert (
        agent_git(workspace, "checkout", "-q", "-b", "other", workspace.start_commit).returncode
        == 0
    )
    commit(workspace, "b.txt", f"{LOGIN}\n")

    report = push(workspace)

    assert reason_of(report, "other") == REASON_LOGIN_SECRET
    assert reason_of(report) is None
    assert rig.origin.tip(BRANCH) == clean and rig.origin.tip("other") is None


# #856-G03
def test_a_login_that_was_in_the_repository_before_the_turn_is_not_the_turns(rig: Rig) -> None:
    rig.origin.commit_on("main", "old.txt", f"{LOGIN}\n")
    workspace = guarded(rig)
    tip = commit(workspace, "a.txt")

    report = push(workspace)

    assert reason_of(report) is None and rig.origin.tip(BRANCH) == tip


# #856-G04
def test_a_clean_branch_is_pushed_as_it_was_before_the_guard(rig: Rig) -> None:
    workspace = guarded(rig)
    tip = commit(workspace, "a.txt")

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == tip and report.pushed_any


# #856-G05
def test_a_scan_that_cannot_finish_refuses_the_push_it_does_not_let_it_through(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    commit(workspace, "a.txt")
    real = GitWorkspace._mirror_stream  # pyright: ignore[reportPrivateUsage]

    def stream(self: GitWorkspace, args: list[str], consume: Any, **options: Any) -> Outcome:
        if "cat-file" in args:
            return Outcome(255, "", "git cat-file timed out", unanswered=True)
        return real(self, args, consume, **options)

    monkeypatch.setattr(GitWorkspace, "_mirror_stream", stream)

    report = push(workspace)

    assert reason_of(report) == REASON_UNCHECKED
    assert rig.origin.tip(BRANCH) is None


# #856-G06
def test_without_a_login_nothing_is_scanned(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt", f"{LOGIN}\n")

    def refuse(*args: Any, **options: Any) -> Outcome:
        raise AssertionError("a turn without a login reads nothing for the guard")

    monkeypatch.setattr(GitWorkspace, "_mirror_stream", refuse)

    assert reason_of(push(workspace)) is None


def test_the_report_of_a_refused_branch_does_not_hold_the_login(rig: Rig, tmp_path: Path) -> None:
    workspace = guarded(rig)
    commit(workspace, "a.txt", f"{LOGIN}\n")

    report = push(workspace)

    assert LOGIN not in repr(report)
