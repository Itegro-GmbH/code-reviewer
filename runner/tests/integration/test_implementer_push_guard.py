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

from code_reviewer_runner.implementer import git_workspace
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


# #856-G05
def test_a_list_of_objects_beyond_what_the_guard_keeps_is_not_pushed(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    commit(workspace, "a.txt")
    monkeypatch.setattr(git_workspace, "GUARD_LISTING_MAX_BYTES", 16)

    report = push(workspace)

    assert reason_of(report) == REASON_UNCHECKED
    assert rig.origin.tip(BRANCH) is None


# #856-G05
def test_content_beyond_what_the_guard_reads_is_not_pushed(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    commit(workspace, "a.txt", "x" * 4096)
    monkeypatch.setattr(git_workspace, "GUARD_READ_MAX_BYTES", 1024)

    report = push(workspace)

    assert reason_of(report) == REASON_UNCHECKED
    assert rig.origin.tip(BRANCH) is None


# #856-G05
def test_a_branch_within_both_limits_is_still_pushed(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    tip = commit(workspace, "a.txt")
    monkeypatch.setattr(git_workspace, "GUARD_LISTING_MAX_BYTES", 4096)
    monkeypatch.setattr(git_workspace, "GUARD_READ_MAX_BYTES", 4096)

    assert reason_of(push(workspace)) is None and rig.origin.tip(BRANCH) == tip


class Clock:
    """A clock the test moves; the workspace asks it instead of the real one."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Seen:
    """What the final push gave each of its phases: the deadline of the fetch, the seconds of each
    read of the guard, the deadline of the push."""

    def __init__(self) -> None:
        self.fetch: list[float] = []
        self.guard: list[float] = []
        self.listing: list[float] = []
        self.push: list[float] = []


def timed(
    workspace: GitWorkspace,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
    guard_costs: tuple[float, ...] = (),
) -> Seen:
    """Run the phases with the clock under the test's hand: the fetch of a branch uses all the time
    it was given, the push uses none, the listing of the guard uses what `guard_costs` says for
    each branch in turn (none by default). Records what each was given."""
    seen = Seen()
    costs = list(guard_costs)
    workspace._clock = clock  # pyright: ignore[reportPrivateUsage]
    take_over = GitWorkspace._take_over  # pyright: ignore[reportPrivateUsage]
    real_stream = GitWorkspace._mirror_stream  # pyright: ignore[reportPrivateUsage]
    push_one = GitWorkspace._push  # pyright: ignore[reportPrivateUsage]

    def fetch(self: GitWorkspace, name: str, scratch: str, deadline: float) -> Any:
        seen.fetch.append(deadline)
        taken = take_over(self, name, scratch, deadline)
        clock.now = max(clock.now, deadline - 0.5)
        return taken

    def stream(self: GitWorkspace, args: list[str], consume: Any, **options: Any) -> Outcome:
        if "rev-list" in args or "cat-file" in args:
            seen.guard.append(options["timeout"])
        if "rev-list" in args:
            seen.listing.append(options["timeout"])
            clock.now += costs.pop(0) if costs else 0.0
        return real_stream(self, args, consume, **options)

    def push(self: GitWorkspace, scratch: str, name: str, deadline: float) -> Any:
        seen.push.append(deadline)
        return push_one(self, scratch, name, deadline)

    monkeypatch.setattr(GitWorkspace, "_take_over", fetch)
    monkeypatch.setattr(GitWorkspace, "_mirror_stream", stream)
    monkeypatch.setattr(GitWorkspace, "_push", push)
    return seen


# #856-G09
def test_the_guard_keeps_a_slice_of_the_push_time_that_the_fetch_cannot_use(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    tip = commit(workspace, "a.txt")
    clock = Clock()
    seen = timed(workspace, clock, monkeypatch)
    start = clock.now

    report = workspace.push_all(seconds=20.0)

    slice_ = 20.0 * git_workspace.GUARD_SHARE
    assert seen.fetch == [pytest.approx(start + 20.0 - slice_)]  # pyright: ignore[reportUnknownMemberType]
    # The fetch used everything it had, and the guard still has its whole slice to read with.
    assert seen.guard and all(seconds >= slice_ - 0.6 for seconds in seen.guard[:1])
    assert reason_of(report) is None and rig.origin.tip(BRANCH) == tip


# #856-G09
def test_what_the_guard_did_not_use_goes_back_to_the_push_of_the_last_branch(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    commit(workspace, "a.txt")
    clock = Clock()
    seen = timed(workspace, clock, monkeypatch)
    start = clock.now

    workspace.push_all(seconds=20.0)

    assert seen.push == [pytest.approx(start + 20.0)]  # pyright: ignore[reportUnknownMemberType]


# #856-G09
def test_a_turn_without_a_login_keeps_no_slice(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    clock = Clock()
    seen = timed(workspace, clock, monkeypatch)
    start = clock.now

    workspace.push_all(seconds=20.0)

    assert seen.fetch == [pytest.approx(start + 20.0)]  # pyright: ignore[reportUnknownMemberType]
    assert seen.guard == []


# #856-G09
def test_the_guard_of_a_stop_has_a_slice_that_fits_the_pushing_time_of_a_stop(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    from code_reviewer_runner.implementer.session import STOP_PUSH_SECONDS

    workspace = guarded(rig)
    commit(workspace, "a.txt")
    clock = Clock()
    seen = timed(workspace, clock, monkeypatch)
    start = clock.now

    workspace.push_all(seconds=STOP_PUSH_SECONDS)

    # A branch with one commit is read in well under a second; the slice is there for a large one.
    assert seen.guard[0] >= STOP_PUSH_SECONDS * git_workspace.GUARD_SHARE - 0.6
    # What the slice leaves is still the time a fetch needs: the fetch was given at least 10 s.
    assert seen.fetch[0] - start >= 10.0


def two_branches(workspace: GitWorkspace) -> tuple[str, str]:
    """The tips of two branches with a commit of their own: the form's branch and `other`."""
    first = commit(workspace, "a.txt")
    assert (
        agent_git(workspace, "checkout", "-q", "-b", "other", workspace.start_commit).returncode
        == 0
    )
    return first, commit(workspace, "b.txt")


# #856-G09
def test_the_slice_is_shared_by_the_branches_what_one_reads_the_next_does_not_get_again(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    first, second = two_branches(workspace)
    clock = Clock()
    # The guard needs 3 s to list the objects of the first branch.
    seen = timed(workspace, clock, monkeypatch, guard_costs=(3.0,))
    start = clock.now

    report = workspace.push_all(seconds=20.0)

    slice_ = 20.0 * git_workspace.GUARD_SHARE
    assert len(seen.listing) == 2
    assert seen.listing[0] == pytest.approx(slice_)  # pyright: ignore[reportUnknownMemberType]
    # The second branch reads with what the first left of the slice, not with a slice of its own.
    assert seen.listing[1] == pytest.approx(slice_ - 3.0)  # pyright: ignore[reportUnknownMemberType]
    # The fetch and the push of the first branch stop before what is still kept; the last has it all.
    assert seen.fetch[1] == pytest.approx(start + 20.0 - (slice_ - 3.0))  # pyright: ignore[reportUnknownMemberType]
    assert seen.push[0] == pytest.approx(start + 20.0 - (slice_ - 3.0))  # pyright: ignore[reportUnknownMemberType]
    assert seen.push[1] == pytest.approx(start + 20.0)  # pyright: ignore[reportUnknownMemberType]
    assert rig.origin.tip(BRANCH) == first and rig.origin.tip("other") == second
    assert reason_of(report) is None and reason_of(report, "other") is None


# #856-G09
def test_a_slice_the_first_branch_used_up_leaves_the_next_one_the_time_of_the_push(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = guarded(rig)
    first, second = two_branches(workspace)
    clock = Clock()
    # The first branch needs the whole slice of 8 s.
    seen = timed(workspace, clock, monkeypatch, guard_costs=(8.0,))
    start = clock.now

    report = workspace.push_all(seconds=20.0)

    # Nothing is kept any more: the second branch is read within what the push has left (a read
    # has one second at the least), is still guarded, and the last push keeps its deadline.
    assert seen.listing[0] == pytest.approx(20.0 * git_workspace.GUARD_SHARE)  # pyright: ignore[reportUnknownMemberType]
    assert len(seen.listing) == 2 and seen.listing[1] <= 1.0
    assert seen.push[1] == pytest.approx(start + 20.0)  # pyright: ignore[reportUnknownMemberType]
    assert reason_of(report) is None and reason_of(report, "other") is None
    assert rig.origin.tip(BRANCH) == first and rig.origin.tip("other") == second


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
