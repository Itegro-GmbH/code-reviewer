# SPDX-License-Identifier: LicenseRef-Proprietary

"""The agent's repository is a full clone (#909): every branch of the provider as a local branch,
the whole history and the tags, on a first turn and on a follow-up alike; a job may name a start
branch other than the base; and what the agent did not touch is neither pushed nor reported nor
counted.

Real git against a bare repository on the file system standing in for GitHub (`Origin`).
"""

from pathlib import Path

import pytest

from code_reviewer_runner.implementer import git_workspace as workspace_module
from code_reviewer_runner.implementer import push_policy
from code_reviewer_runner.implementer.git_workspace import DiskSpace, GitWorkspace
from code_reviewer_runner.job import ImplementerResume, JobError, ResumeBranch
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, HttpOrigin, files_mentioning, raw
from workspace_support import BRANCH, Rig, agent_git, commit, head_of


def local_branches(workspace: GitWorkspace) -> dict[str, str]:
    listed = raw(
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        "refs/heads/",
        cwd=workspace.repo,
        git=workspace.git,
    )
    return {line.split()[0]: line.split()[1] for line in listed.splitlines()}


def origin_branches(rig: Rig) -> dict[str, str]:
    listed = raw(
        "--git-dir",
        str(rig.origin.path),
        "for-each-ref",
        "--format=%(refname:short) %(objectname)",
        "refs/heads/",
        git=rig.git,
    )
    return {line.split()[0]: line.split()[1] for line in listed.splitlines()}


def count_all(rig: Rig, where: Path, *args: str) -> int:
    return int(raw("rev-list", "--count", *(args or ("--all",)), cwd=where, git=rig.git))


def tag_names(rig: Rig, where: Path) -> set[str]:
    return set(raw("tag", "--list", cwd=where, git=rig.git).split())


def push_names(workspace: GitWorkspace) -> list[str]:
    report = workspace.push_all(seconds=120.0)
    return [entry.name for entry in report.branches if entry.pushed]


@pytest.fixture
def busy(rig: Rig) -> dict[str, str]:
    """A provider with a long history on two branches and one more branch, plus tags."""
    tips = {
        "main": rig.origin.many_commits_on("main", 80),
        "feature/x": rig.origin.many_commits_on("feature/x", 70),
        "feature/y": rig.origin.commit_on("feature/y", "y.txt"),
    }
    raw("tag", "v1", tips["main"], cwd=rig.origin.seed, git=rig.git)
    raw("tag", "-a", "v2", "-m", "second", tips["feature/x"], cwd=rig.origin.seed, git=rig.git)
    raw("push", "-q", "origin", "v1", "v2", cwd=rig.origin.seed, git=rig.git)
    return tips


def resume_of(rig: Rig, *names: str, checkout: str | None) -> ImplementerResume:
    return ImplementerResume(
        turn=2,
        branches=tuple(ResumeBranch(name, rig.origin.tip(name) or "c" * 40) for name in names),
        checkout=checkout,
    )


# #909-T01
def test_a_first_turn_has_every_branch_of_the_provider_the_whole_history_and_the_tags(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.prepared()

    repo = workspace.repo
    expected = origin_branches(rig)
    tips = local_branches(workspace)
    assert {name: tip for name, tip in tips.items() if name != BRANCH} == expected
    assert tips[BRANCH] == expected["main"]
    assert raw("rev-parse", "--is-shallow-repository", cwd=repo, git=rig.git) == "false"
    for name in expected:
        assert count_all(rig, repo, name) == count_all(
            rig, rig.origin.path, f"refs/heads/{name}"
        ), name
    assert count_all(rig, repo) == count_all(rig, rig.origin.path)
    assert tag_names(rig, repo) == {"v1", "v2"}
    assert raw("rev-parse", "v2^{commit}", cwd=repo, git=rig.git) == busy["feature/x"]
    assert raw("symbolic-ref", "--short", "HEAD", cwd=repo, git=rig.git) == BRANCH
    assert head_of(workspace) == expected["main"]


# #909-T01
def test_the_mirror_is_a_full_clone_too(rig: Rig, busy: dict[str, str]) -> None:
    workspace = rig.workspace()

    workspace.clone_mirror()

    assert raw("rev-parse", "--is-shallow-repository", cwd=workspace.mirror, git=rig.git) == "false"
    assert count_all(rig, workspace.mirror, "refs/heads/main") == count_all(
        rig, rig.origin.path, "refs/heads/main"
    )
    assert workspace.start_commit == busy["main"]


# #909-T01
def test_a_session_branch_the_provider_already_has_on_a_first_turn_still_starts_at_the_start(
    rig: Rig,
) -> None:
    rig.origin.commit_on(BRANCH, "someone-else.txt")

    workspace = rig.prepared()

    assert head_of(workspace) == rig.origin.tip("main")
    assert local_branches(workspace)[BRANCH] == rig.origin.tip("main")


# #909-T02
@pytest.mark.parametrize("checkout", [BRANCH, "feature/x"])
def test_a_follow_up_has_every_branch_the_whole_history_the_tags_and_the_branch_it_ended_on(
    rig: Rig, busy: dict[str, str], checkout: str
) -> None:
    rig.origin.commit_on(BRANCH, "session.txt")
    resume = resume_of(rig, BRANCH, "feature/x", checkout=checkout)

    workspace = rig.prepared(resume=resume)

    repo = workspace.repo
    expected = origin_branches(rig)
    assert local_branches(workspace) == expected
    assert raw("rev-parse", "--is-shallow-repository", cwd=repo, git=rig.git) == "false"
    assert count_all(rig, repo) == count_all(rig, rig.origin.path)
    assert tag_names(rig, repo) == {"v1", "v2"}
    assert raw("symbolic-ref", "--short", "HEAD", cwd=repo, git=rig.git) == checkout
    assert head_of(workspace) == expected[checkout]


# #909-T02
def test_a_follow_up_does_not_need_to_know_which_branches_the_earlier_turns_pushed(
    rig: Rig, busy: dict[str, str]
) -> None:
    rig.origin.commit_on(BRANCH, "session.txt")

    workspace = rig.prepared(resume=resume_of(rig, BRANCH, checkout=BRANCH))

    assert set(local_branches(workspace)) == set(origin_branches(rig))
    assert workspace.resume_missing == ()


# #909-T03
def test_a_start_branch_is_where_the_session_branch_starts_and_the_diff_to_the_base_works(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.prepared(start_branch="feature/x")

    repo = workspace.repo
    assert raw("symbolic-ref", "--short", "HEAD", cwd=repo, git=rig.git) == BRANCH
    assert head_of(workspace) == busy["feature/x"]
    assert workspace.start_commit == busy["feature/x"]
    done = agent_git(workspace, "diff", "--stat", "main...HEAD")
    assert done.returncode == 0, done.stderr
    assert "history.txt" in done.stdout
    assert agent_git(workspace, "merge-base", "main", "HEAD").stdout.strip()
    # The base is the base and the start branch is itself, both at the tip the provider has.
    tips = local_branches(workspace)
    assert tips["main"] == busy["main"]
    assert tips["feature/x"] == busy["feature/x"]
    assert (repo / "history.txt").read_text() == "69\n"


# #909-T03
def test_the_commits_of_the_turn_are_counted_from_the_start_branch_not_from_the_base(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.prepared(start_branch="feature/x")

    own = commit(workspace, "mine.txt")
    workspace.push_all(seconds=120.0)

    assert [entry.sha for entry in workspace.commits_since_start()] == [own]
    assert [change.path for change in workspace.changed_files()] == ["mine.txt"]


# #909-T03
def test_a_start_branch_that_is_the_base_is_the_base(rig: Rig, busy: dict[str, str]) -> None:
    workspace = rig.prepared(start_branch="main")

    assert head_of(workspace) == busy["main"]
    assert workspace.start_commit == busy["main"]


# #909-T04
def test_a_start_branch_the_provider_does_not_have_ends_the_turn_clone_failed(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.workspace(start_branch="not/there")

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.CLONE_FAILED
    assert not workspace.repo.exists()


# #909-T04
def test_a_missing_base_branch_is_still_its_own_code_beside_a_start_branch(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.workspace(base_branch="nope", start_branch="feature/x")

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.BASE_BRANCH_NOT_FOUND


# #909-T04
@pytest.mark.parametrize("name", ["-x", "a..b", "HEAD", BRANCH])
def test_a_start_branch_that_cannot_be_a_branch_is_refused_before_anything_is_fetched(
    rig: Rig, name: str
) -> None:
    workspace = rig.workspace(start_branch=name)

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert not workspace.mirror.exists()


# #909-T05
def test_untouched_branches_are_not_pushed_not_reported_and_not_counted(rig: Rig) -> None:
    for number in range(push_policy.MAX_PUSHED_BRANCHES + 20):
        rig.origin.commit_on(f"topic/{number:03d}", f"t{number}.txt")
    before = origin_branches(rig)
    workspace = rig.prepared()
    commit(workspace, "mine.txt")
    mine = head_of(workspace)

    report = workspace.push_all(seconds=120.0)

    assert [entry.name for entry in report.branches] == [BRANCH]
    assert report.branches[0].pushed and report.overflow == 0 and report.invalid == 0
    assert origin_branches(rig) == {**before, BRANCH: mine}


# #909-T05
def test_a_branch_the_agent_moved_is_pushed_without_force_and_the_rest_is_left_alone(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.prepared()
    agent_git(workspace, "checkout", "-q", "feature/y")
    moved = commit(workspace, "more-y.txt")
    agent_git(workspace, "checkout", "-q", "-b", "brand-new", "main")
    new = commit(workspace, "new.txt")
    before = origin_branches(rig)

    report = workspace.push_all(seconds=120.0)

    assert sorted(entry.name for entry in report.branches) == ["brand-new", "feature/y"]
    assert all(entry.pushed for entry in report.branches)
    assert origin_branches(rig) == {**before, "feature/y": moved, "brand-new": new}


# #909-T05
def test_a_branch_the_agent_rewrote_is_refused_by_the_provider_not_forced(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.prepared()
    agent_git(workspace, "checkout", "-q", "feature/y")
    agent_git(workspace, "reset", "-q", "--hard", "main")
    commit(workspace, "rewritten.txt")
    before = origin_branches(rig)

    report = workspace.push_all(seconds=120.0)

    assert [(entry.name, entry.pushed) for entry in report.branches] == [("feature/y", False)]
    assert origin_branches(rig) == before


# #909-T05
def test_untouched_branches_of_a_follow_up_are_not_pushed_either(
    rig: Rig, busy: dict[str, str]
) -> None:
    rig.origin.commit_on(BRANCH, "session.txt")
    workspace = rig.prepared(resume=resume_of(rig, BRANCH, checkout=BRANCH))

    assert push_names(workspace) == []
    assert workspace.push_report().branches == ()


# #909-T08
def test_the_agent_repository_has_no_remote_no_remote_branch_and_no_credential(
    rig: Rig, busy: dict[str, str]
) -> None:
    with HttpOrigin(rig.origin, TOKEN, "/usr/bin/git") as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git="/usr/bin/git")
        workspace.prepare()

    repo = workspace.repo
    assert raw("remote", cwd=repo, git=rig.git) == ""
    assert raw("for-each-ref", "refs/remotes/", cwd=repo, git=rig.git) == ""
    config = (repo / ".git" / "config").read_text()
    assert "url" not in config and "http" not in config
    assert files_mentioning(repo, TOKEN) == []
    assert files_mentioning(rig.base / "work", TOKEN) == []
    assert files_mentioning(rig.base / "work", "Authorization") == []
    assert "http://127.0.0.1" not in (workspace.mirror / "config").read_text()


# #909-T01
def test_after_a_setup_script_every_branch_and_tag_of_the_provider_is_as_it_was(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.prepared()
    agent_git(workspace, "checkout", "-q", "feature/y")
    agent_git(workspace, "commit", "-q", "--allow-empty", "-m", "script commit on a branch")
    agent_git(workspace, "branch", "-f", "feature/x", "main")
    agent_git(workspace, "tag", "-f", "v1", "feature/y")
    agent_git(workspace, "tag", "-d", "v2")
    agent_git(workspace, "tag", "script-tag")
    agent_git(workspace, "branch", "script-branch")

    workspace.settle_after_setup()

    assert raw("symbolic-ref", "--short", "HEAD", cwd=workspace.repo, git=rig.git) == BRANCH
    assert local_branches(workspace) == {**origin_branches(rig), BRANCH: busy["main"]}
    assert tag_names(rig, workspace.repo) == {"v1", "v2"}
    assert raw("rev-parse", "v1^{commit}", cwd=workspace.repo, git=rig.git) == busy["main"]
    assert raw("rev-parse", "v2^{commit}", cwd=workspace.repo, git=rig.git) == busy["feature/x"]
    assert workspace.dropped_refs == 2  # script-tag, script-branch
    assert workspace.script_commits == 1
    assert push_names(workspace) == []


# #909-T04
def test_a_follow_up_does_not_end_because_its_start_branch_is_gone(
    rig: Rig, busy: dict[str, str]
) -> None:
    rig.origin.commit_on(BRANCH, "session.txt")
    workspace = rig.workspace(
        start_branch="gone/branch", resume=resume_of(rig, BRANCH, checkout=BRANCH)
    )

    workspace.prepare()

    assert head_of(workspace) == rig.origin.tip(BRANCH)


# #909-T10
def test_a_clone_that_leaves_too_little_room_ends_the_turn_clone_failed(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.workspace(space=lambda path: DiskSpace(free_bytes=1024, free_inodes=10**6))

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.CLONE_FAILED
    assert "room" in refused.value.detail
    assert not workspace.repo.exists()


# #909-T10
def test_a_clone_that_leaves_too_few_inodes_ends_the_turn_clone_failed(
    rig: Rig, busy: dict[str, str]
) -> None:
    workspace = rig.workspace(space=lambda path: DiskSpace(free_bytes=10 * 1024**3, free_inodes=5))

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.CLONE_FAILED


# #909-T10
def test_an_agent_clone_that_fills_the_disk_ends_the_turn_clone_failed(
    rig: Rig, busy: dict[str, str]
) -> None:
    holder: list[GitWorkspace] = []

    def space(path: Path) -> DiskSpace:
        # Room while only the mirror exists; gone once the agent's repository has been cloned.
        room = 10 * 1024**3 if not holder[0].repo.exists() else 1024
        return DiskSpace(free_bytes=room, free_inodes=10**6)

    workspace = rig.workspace(space=space)
    holder.append(workspace)

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.CLONE_FAILED
    assert "room" in refused.value.detail


# #909-T10
def test_a_clone_with_room_left_is_not_refused(rig: Rig, busy: dict[str, str]) -> None:
    workspace = rig.workspace(
        space=lambda path: DiskSpace(free_bytes=10 * 1024**3, free_inodes=10**6)
    )

    workspace.prepare()

    assert head_of(workspace) == busy["main"]


# #909-T05
def test_branches_the_agent_did_not_touch_do_not_count_against_the_cap_of_the_list(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    for number in range(300):
        rig.origin.commit_on(f"topic/{number:03d}", f"t{number}.txt")
    monkeypatch.setattr(workspace_module, "LIST_MAX_BYTES", 4_000)
    workspace = rig.prepared()
    commit(workspace, "a.txt")

    report = workspace.push_all(seconds=120.0)

    assert report.listed and report.list_problem is None
    assert [entry.name for entry in report.branches if entry.pushed] == [BRANCH]
