# SPDX-License-Identifier: LicenseRef-Proprietary

"""The workspace of a follow-up turn (#838, part of #745): the branches the earlier turn left on the
provider are fetched into the mirror, the agent's repository has a local branch for each and the
right one checked out, a branch that moved on the provider is taken at its new tip, and the start
tip is kept per branch so that a branch the agent did not touch is not pushed again.

Everything runs against a bare repository on the file system standing in for GitHub (`Origin`), as
the other tests of the git workspace do; the token path over HTTP has one test of its own.
"""

import pytest

from code_reviewer_runner.implementer.git_workspace import BranchMoved, GitWorkspace
from code_reviewer_runner.job import ImplementerResume, JobError, ResumeBranch
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, HttpOrigin, files_mentioning, raw
from workspace_support import BRANCH, Rig, agent_git, commit, head_of

GHOST = "c" * 40


def resume_of(
    *branches: tuple[str, str | None], checkout: str | None = None, turn: int = 2
) -> ImplementerResume:
    """A resume that names these branches and the tips the earlier turn pushed. A tip of None is the
    tip the origin has right now (nothing moved)."""
    return ImplementerResume(
        turn=turn,
        branches=tuple(ResumeBranch(name, head or GHOST) for name, head in branches),
        checkout=checkout,
    )


def tips_of_the_repo(workspace: GitWorkspace) -> dict[str, str]:
    listed = raw(
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        "refs/heads/",
        cwd=workspace.repo,
        git=workspace.git,
    )
    return {line.split()[0]: line.split()[1] for line in listed.splitlines()}


def checked_out(workspace: GitWorkspace) -> str:
    return raw("symbolic-ref", "--short", "HEAD", cwd=workspace.repo, git=workspace.git)


def pushed_names(workspace: GitWorkspace) -> list[str]:
    report = workspace.push_all(seconds=120.0)
    return [entry.name for entry in report.branches if entry.pushed]


@pytest.fixture
def three(rig: Rig) -> dict[str, str]:
    """The session branch and two other branches on the provider, one commit of their own each."""
    return {
        BRANCH: rig.origin.commit_on(BRANCH, "session.txt"),
        "feature/x": rig.origin.commit_on("feature/x", "x.txt"),
        "feature/y": rig.origin.commit_on("feature/y", "y.txt"),
    }


def resume_of_three(tips: dict[str, str], checkout: str | None) -> ImplementerResume:
    return resume_of(*tips.items(), checkout=checkout)


# -- fetching and checking out -------------------------------------------------------------------


# #838-T10
def test_every_branch_of_the_session_is_a_local_branch_of_the_agent_and_one_is_checked_out(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout="feature/x"))

    tips = tips_of_the_repo(workspace)
    assert {name: tips[name] for name in three} == three
    assert tips["main"] == rig.origin.tip("main")
    assert checked_out(workspace) == "feature/x"
    assert head_of(workspace) == three["feature/x"]
    repo = workspace.repo
    assert (repo / "x.txt").exists() and not (repo / "y.txt").exists()
    assert (repo / "README.md").read_text() == "# demo\n"
    assert raw("status", "--porcelain", cwd=repo, git=rig.git) == ""
    assert raw("remote", cwd=repo, git=rig.git) == ""
    assert workspace.resume_moved == () and workspace.resume_missing == ()


# #838-T11
def test_each_branch_is_fetched_into_the_mirror_as_a_branch_of_its_own(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout=BRANCH))

    for name, tip in three.items():
        assert raw("rev-parse", f"refs/heads/{name}", cwd=workspace.mirror, git=rig.git) == tip
    assert checked_out(workspace) == BRANCH


# #838-T12
def test_no_checkout_means_the_session_branch(rig: Rig, three: dict[str, str]) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout=None))

    assert checked_out(workspace) == BRANCH
    assert head_of(workspace) == three[BRANCH]


# #838-T13
def test_the_session_branch_that_never_arrived_is_made_at_the_base_tip_and_another_is_checked_out(
    rig: Rig, three: dict[str, str]
) -> None:
    others = {name: tip for name, tip in three.items() if name != BRANCH}
    workspace = rig.prepared(resume=resume_of(*others.items(), checkout="feature/y"))

    tips = tips_of_the_repo(workspace)
    assert tips[BRANCH] == rig.origin.tip("main")
    assert checked_out(workspace) == "feature/y"
    assert workspace.start_commit == rig.origin.tip("main")


# #838-T14
def test_the_session_branch_checked_out_though_it_never_arrived(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of(("feature/y", three["feature/y"]), checkout=BRANCH))

    assert checked_out(workspace) == BRANCH
    assert head_of(workspace) == rig.origin.tip("main")


# #838-T15
def test_no_branches_starts_from_the_base_like_the_first_turn(rig: Rig) -> None:
    workspace = rig.prepared(resume=resume_of(checkout=None))

    assert checked_out(workspace) == BRANCH
    assert head_of(workspace) == rig.origin.tip("main")
    assert workspace.start_commit == rig.origin.tip("main")
    assert set(tips_of_the_repo(workspace)) == {"main", BRANCH}
    assert workspace.resume_moved == () and workspace.resume_missing == ()


# #838-T16
def test_the_start_commit_of_a_follow_up_is_the_tip_the_session_branch_has_on_the_provider(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout="feature/x"))

    assert workspace.start_commit == three[BRANCH]
    assert workspace.start_tips == {"main": rig.origin.tip("main"), **three}


# #838-T17
def test_the_commits_and_files_of_the_turn_are_counted_from_the_session_branchs_start(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout=BRANCH))
    mine = commit(workspace, "mine.txt")

    report = workspace.push_all(seconds=120.0)

    assert report.form_head == mine
    assert [entry.sha for entry in workspace.commits_since_start()] == [mine]
    assert [change.path for change in workspace.changed_files()] == ["mine.txt"]


# -- depth ---------------------------------------------------------------------------------------


# #838-T20
def test_the_session_branch_is_fetched_fifty_deep_and_the_others_and_the_base_one_deep(
    rig: Rig,
) -> None:
    tips = {
        BRANCH: rig.origin.many_commits_on(BRANCH, 60),
        "feature/x": rig.origin.many_commits_on("feature/x", 5),
    }

    workspace = rig.prepared(resume=resume_of(*tips.items(), checkout=BRANCH))

    def depth(ref: str) -> str:
        return raw("rev-list", "--count", ref, cwd=workspace.mirror, git=rig.git)

    assert depth(f"refs/heads/{BRANCH}") == "50"
    assert depth("refs/heads/feature/x") == "1"
    assert depth("refs/heads/main") == "1"
    # The agent has the same history: 50 commits to look back at, no more.
    assert raw("rev-list", "--count", BRANCH, cwd=workspace.repo, git=rig.git) == "50"


# #838-T20b
@pytest.mark.parametrize("session_first", [True, False])
def test_a_branch_that_is_an_ancestor_of_the_session_branch_does_not_cut_its_history(
    rig: Rig, session_first: bool
) -> None:
    ancestor = rig.origin.many_commits_on("feature/x", 60)
    raw("push", "-q", "origin", f"{ancestor}:refs/heads/{BRANCH}", cwd=rig.origin.seed, git=rig.git)
    session = rig.origin.many_commits_on(BRANCH, 10)
    listed = [(BRANCH, session), ("feature/x", ancestor)]
    if not session_first:
        listed.reverse()

    workspace = rig.prepared(resume=resume_of(*listed, checkout=BRANCH))

    # The session branch keeps the depth it is promised, whatever the order of `resume.branches`.
    assert raw("rev-list", "--count", BRANCH, cwd=workspace.mirror, git=rig.git) == "50"
    assert raw("rev-list", "--count", BRANCH, cwd=workspace.repo, git=rig.git) == "50"


# -- what moved, what is gone --------------------------------------------------------------------


# #838-T21
def test_a_branch_that_moved_on_the_provider_is_taken_at_its_new_tip_and_the_change_is_recorded(
    rig: Rig, three: dict[str, str]
) -> None:
    resume = resume_of_three(three, checkout="feature/x")
    moved = rig.origin.commit_on("feature/x", "someone-else.txt")

    workspace = rig.prepared(resume=resume)

    assert tips_of_the_repo(workspace)["feature/x"] == moved
    assert head_of(workspace) == moved
    assert (workspace.repo / "someone-else.txt").exists()
    assert workspace.resume_moved == (BranchMoved("feature/x", three["feature/x"], moved),)
    assert workspace.start_tips["feature/x"] == moved


# #838-T22
def test_the_session_branch_that_moved_is_the_start_of_the_turn(
    rig: Rig, three: dict[str, str]
) -> None:
    resume = resume_of_three(three, checkout=BRANCH)
    moved = rig.origin.commit_on(BRANCH, "someone-else.txt")

    workspace = rig.prepared(resume=resume)

    assert workspace.start_commit == moved
    assert workspace.resume_moved == (BranchMoved(BRANCH, three[BRANCH], moved),)


# #838-T23
def test_a_branch_that_is_gone_from_the_provider_is_left_out_and_recorded(
    rig: Rig, three: dict[str, str]
) -> None:
    tips = {**three, "feature/gone": "d" * 40}

    workspace = rig.prepared(resume=resume_of(*tips.items(), checkout="feature/x"))

    assert "feature/gone" not in tips_of_the_repo(workspace)
    assert "feature/gone" not in workspace.start_tips
    assert workspace.resume_missing == ("feature/gone",)
    assert checked_out(workspace) == "feature/x"


# #838-T24
def test_a_checkout_that_is_gone_falls_back_to_the_session_branch(
    rig: Rig, three: dict[str, str]
) -> None:
    tips = {**three, "feature/gone": "d" * 40}

    workspace = rig.prepared(resume=resume_of(*tips.items(), checkout="feature/gone"))

    assert checked_out(workspace) == BRANCH
    assert head_of(workspace) == three[BRANCH]
    assert workspace.resume_missing == ("feature/gone",)


# #838-T25
def test_a_session_branch_that_is_gone_ends_the_turn_before_the_agent_exists(
    rig: Rig, three: dict[str, str]
) -> None:
    raw("push", "-q", "origin", f":{BRANCH}", cwd=rig.origin.seed, git=rig.git)
    workspace = rig.workspace(resume=resume_of_three(three, checkout="feature/x"))

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.CLONE_FAILED
    assert "session branch" in refused.value.detail
    assert not workspace.repo.exists()


# #838-T26
def test_the_base_branch_may_be_a_branch_of_the_session_and_is_fetched_once(rig: Rig) -> None:
    old = rig.origin.tip("main")
    assert old is not None
    new = rig.origin.commit_on("main", "late.txt")
    # `commit_on` leaves the seed on main, so the push went to main itself.
    assert rig.origin.tip("main") == new
    workspace = rig.prepared(resume=resume_of(("main", old), checkout="main"))

    assert tips_of_the_repo(workspace)["main"] == new
    assert checked_out(workspace) == "main"
    assert workspace.resume_moved == (BranchMoved("main", old, new),)
    assert workspace.start_tips["main"] == new


# -- names ---------------------------------------------------------------------------------------


# #838-T30
@pytest.mark.parametrize(
    "name",
    [
        "a..b",
        "HEAD",
        "-delete",
        "has space",
        "feature/",
        "x.lock",
        "a b",
        "@{u}",
        "a\x00b",
        "a\x01b",
    ],
)
def test_a_name_git_does_not_accept_is_refused_before_anything_is_fetched(
    rig: Rig, name: str
) -> None:
    workspace = rig.workspace(resume=resume_of((name, GHOST), checkout=None))

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert not workspace.mirror.exists()


# #838-T31
def test_the_session_branch_and_the_base_branch_still_must_differ(rig: Rig) -> None:
    workspace = rig.workspace(branch="main", resume=resume_of(checkout=None))

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID


# -- one tip per branch --------------------------------------------------------------------------


# #838-T40
def test_a_branch_the_agent_did_not_touch_is_not_pushed_again(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout="feature/x"))
    mine = commit(workspace, "mine.txt")

    report = workspace.push_all(seconds=120.0)

    assert [entry.name for entry in report.branches] == ["feature/x"]
    assert report.branches[0].pushed and report.branches[0].head == mine
    assert rig.origin.tip("feature/x") == mine
    assert rig.origin.tip("feature/y") == three["feature/y"]
    assert rig.origin.tip(BRANCH) == three[BRANCH]
    assert rig.origin.tip("main") == workspace.start_tips["main"]


# #838-T41
def test_a_turn_that_changes_nothing_pushes_nothing(rig: Rig, three: dict[str, str]) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout="feature/x"))

    report = workspace.push_all(seconds=120.0)

    assert report.branches == ()
    assert report.form_head is None
    assert report.form_listed is True


# #838-T42
def test_the_form_branch_untouched_is_not_the_form_head_but_a_touched_one_is(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout=BRANCH))
    agent_git(workspace, "switch", "-q", "feature/y")
    other = commit(workspace, "on-y.txt")

    report = workspace.push_all(seconds=120.0)

    assert report.form_head is None, "the session branch has nothing on top of its start"
    assert [(entry.name, entry.head) for entry in report.branches] == [("feature/y", other)]


# #838-T43
def test_a_branch_that_moved_on_the_provider_and_the_agent_left_alone_is_not_pushed(
    rig: Rig, three: dict[str, str]
) -> None:
    resume = resume_of_three(three, checkout="feature/x")
    rig.origin.commit_on("feature/x", "someone-else.txt")
    workspace = rig.prepared(resume=resume)

    report = workspace.push_all(seconds=120.0)

    assert report.branches == ()


# #838-T44
def test_a_new_branch_the_agent_made_without_a_commit_is_not_pushed_but_one_with_a_commit_is(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout="feature/x"))
    agent_git(workspace, "branch", "empty-one")  # at feature/x's start tip
    agent_git(workspace, "branch", "empty-two", "feature/y")
    agent_git(workspace, "switch", "-q", "-c", "new-work")
    new = commit(workspace, "new.txt")

    report = workspace.push_all(seconds=120.0)

    assert [(entry.name, entry.pushed) for entry in report.branches] == [("new-work", True)]
    assert rig.origin.tip("new-work") == new
    assert rig.origin.tip("empty-one") is None and rig.origin.tip("empty-two") is None


# #838-T45
def test_a_branch_of_the_session_the_agent_rewound_is_judged_against_its_own_start(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout="feature/y"))
    # feature/y goes back to the base: that is not "unchanged", and the provider refuses it, as it
    # refuses any rewrite of pushed history (it is a non-fast-forward).
    agent_git(workspace, "reset", "-q", "--hard", "main")

    report = workspace.push_all(seconds=120.0)

    assert [(entry.name, entry.pushed) for entry in report.branches] == [("feature/y", False)]
    assert rig.origin.tip("feature/y") == three["feature/y"]


# #838-T46
def test_the_first_turn_keeps_its_one_start_tip(rig: Rig) -> None:
    workspace = rig.prepared()

    assert workspace.start_tips == {"main": rig.origin.tip("main"), BRANCH: rig.origin.tip("main")}
    assert workspace.resume_moved == () and workspace.resume_missing == ()
    assert pushed_names(workspace) == []


# -- after the environment's script --------------------------------------------------------------


# #838-T50
def test_what_a_script_did_to_the_branches_is_undone_branch_by_branch(
    rig: Rig, three: dict[str, str]
) -> None:
    workspace = rig.prepared(resume=resume_of_three(three, checkout="feature/x"))
    # The script commits on the checked-out branch, moves another branch, makes a branch and a tag
    # and changes a tracked file.
    commit(workspace, "script.txt")
    agent_git(workspace, "branch", "-f", "feature/y", "main")
    agent_git(workspace, "branch", "script-branch")
    agent_git(workspace, "tag", "script-tag")
    (workspace.repo / "x.txt").write_text("changed by the script\n")

    workspace.settle_after_setup()

    tips = tips_of_the_repo(workspace)
    assert tips == {"main": rig.origin.tip("main"), **three}
    assert checked_out(workspace) == "feature/x"
    assert head_of(workspace) == three["feature/x"]
    assert raw("tag", "--list", cwd=workspace.repo, git=rig.git) == ""
    assert (workspace.repo / "x.txt").read_text() == "x\n"
    assert workspace.script_commits >= 1 and workspace.dropped_refs == 2
    assert workspace.dirty() is False


# #838-T51
def test_after_the_script_the_first_turn_is_undone_as_before(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "script.txt")
    agent_git(workspace, "branch", "script-branch")

    workspace.settle_after_setup()

    assert tips_of_the_repo(workspace) == {
        "main": rig.origin.tip("main"),
        BRANCH: rig.origin.tip("main"),
    }
    assert checked_out(workspace) == BRANCH


# -- the token -----------------------------------------------------------------------------------


# #838-T60
def test_the_other_branches_are_fetched_with_the_token_in_the_environment_only(
    rig: Rig, three: dict[str, str]
) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(
            url=server.url,
            schemes=("http",),
            git=git,
            resume=resume_of_three(three, checkout="feature/x"),
        )

        workspace.prepare()

    assert checked_out(workspace) == "feature/x"
    assert files_mentioning(rig.base / "work", TOKEN) == []
    assert files_mentioning(rig.base / "work", "Authorization") == []
    config = (workspace.mirror / "config").read_text()
    assert "http://127.0.0.1" not in config
