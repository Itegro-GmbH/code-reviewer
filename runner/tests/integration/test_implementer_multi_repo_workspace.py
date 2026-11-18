# SPDX-License-Identifier: LicenseRef-Proprietary

"""The workspaces of a multi-repository turn (#1093, epic #1090, ADR 0006).

Everything runs against bare repositories on the file system standing in for GitHub (`Origin`), one
per repository, with git run as an ordinary user (`LocalAccess`), as the other tests of the git
workspace do. What is proven here: the three ways a repository starts (direct work on the base, a
new branch made from it, an existing branch continued), the failures that end the turn before the
agent starts and name the repository, the push of every repository with its own token, the facts of
each repository, and that one rejected repository does not keep the others from being pushed.
"""

from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any, cast

import pytest

from code_reviewer_runner.implementer import git_workspace
from code_reviewer_runner.implementer.git_workspace import (
    REASON_LOGIN_SECRET,
    REASON_UNCHECKED,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.implementer.multi_result import outcomes_of, push_error
from code_reviewer_runner.implementer.multi_workspace import MultiWorkspace
from code_reviewer_runner.implementer.report import valid_block
from code_reviewer_runner.job import ImplementerResume, JobError, ResumeBranch, ResumeRepo
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, HttpOrigin, Origin, raw, system_git
from workspace_support import IDENTITY, LocalAccess, agent_git, commit

OTHER_TOKEN = "ghs_other-installation-token-0123456789"


class Repo:
    """One repository of the turn: its origin and how the job names it."""

    def __init__(
        self,
        base: Path,
        git: str,
        name: str,
        *,
        branch: str,
        exists: bool = False,
        token: str = TOKEN,
        url: str | None = None,
        origin: Origin | None = None,
    ) -> None:
        self.name = name
        self.origin = origin or Origin(base, git, name)
        self.branch = branch
        self.exists = exists
        self.token = token
        self.url = url or self.origin.url


class MultiRig:
    def __init__(self, base: Path) -> None:
        self.base = base
        self.git = system_git()
        self.layout = WorkspaceLayout(work_dir=base / "work", run_dir=base / "run")
        self.home = base / "home"
        self.home.mkdir()

    def repo(self, name: str, **kwargs: object) -> Repo:
        return Repo(self.base, self.git, name, **kwargs)  # type: ignore[arg-type]

    def workspace(
        self,
        repos: Sequence[Repo],
        *,
        resume: ImplementerResume | None = None,
        schemes: tuple[str, ...] = ("file",),
        before_push: Callable[[], None] | None = None,
        guard_secrets: Sequence[str] = (),
    ) -> MultiWorkspace:
        members: list[GitWorkspace] = []
        for repo in repos:
            spec = WorkspaceSpec(
                clone_url=repo.url,
                token=repo.token,
                base_branch="main",
                branch=repo.branch,
                resume=None if resume is None else resume.for_repo(repo.name),
                name=repo.name,
                full_name=f"acme/{repo.name}",
                direct=repo.branch == "main",
                branch_exists=repo.exists,
                max_branches=25,
            )
            members.append(
                GitWorkspace(
                    spec,
                    self.layout,
                    IDENTITY,
                    LocalAccess(self.layout.work_dir / repo.name, self.git, self.home),
                    git=self.git,
                    schemes=schemes,
                    before_push=before_push,
                    guard_secrets=guard_secrets,
                )
            )
        return MultiWorkspace(tuple(members))


@pytest.fixture
def rig(tmp_path: Path) -> MultiRig:
    return MultiRig(tmp_path)


def agent(member: GitWorkspace, *args: str) -> str:
    done = agent_git(member, *args)
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


def checked_out(member: GitWorkspace) -> str:
    return agent(member, "symbolic-ref", "--short", "HEAD")


def three(rig: MultiRig) -> list[Repo]:
    """A new branch (`feature/x` from `main`), direct work on `main`, and a branch that exists."""
    existing = rig.repo("lib", branch="feature/x", exists=True)
    existing.origin.commit_on("feature/x", "earlier.txt")
    return [
        rig.repo("app", branch="feature/x"),
        rig.repo("shared", branch="main"),
        existing,
    ]


# #1093-T01
def test_each_repository_starts_the_way_its_entry_says(rig: MultiRig) -> None:
    repos = three(rig)
    workspace = rig.workspace(repos)

    workspace.prepare()

    app, shared, lib = workspace.members
    assert checked_out(app) == "feature/x" and app.branch_created is True
    assert agent(app, "rev-parse", "HEAD") == repos[0].origin.tip("main")
    assert checked_out(shared) == "main" and shared.branch_created is False
    assert checked_out(lib) == "feature/x" and lib.branch_created is False
    assert agent(lib, "rev-parse", "HEAD") == repos[2].origin.tip("feature/x")
    # One mirror per repository under the reserve disk, one directory per repository on the volume.
    for repo in repos:
        assert (rig.layout.work_dir / "reserve" / "mirror" / f"{repo.name}.git").is_dir()
        assert (rig.layout.work_dir / repo.name / ".git").exists()
    assert not (rig.layout.work_dir / "repo").exists()


# #1093-T02
def test_an_existing_branch_that_is_gone_ends_the_turn_naming_the_repository(rig: MultiRig) -> None:
    repos = [rig.repo("app", branch="main"), rig.repo("lib", branch="feature/gone", exists=True)]

    with pytest.raises(JobError) as refused:
        rig.workspace(repos).prepare()

    assert refused.value.code is ErrorCode.CLONE_FAILED
    assert "lib" in refused.value.detail


# #1093-T03
def test_a_branch_that_is_there_after_all_is_never_overwritten_or_continued(rig: MultiRig) -> None:
    repos = [rig.repo("app", branch="main"), rig.repo("lib", branch="feature/x", exists=False)]
    tip = repos[1].origin.commit_on("feature/x", "someone.txt")

    with pytest.raises(JobError) as refused:
        rig.workspace(repos).prepare()

    assert refused.value.code is ErrorCode.BRANCH_EXISTS
    assert "lib" in refused.value.detail
    assert repos[1].origin.tip("feature/x") == tip


# #1093-T04
def test_a_base_branch_the_provider_does_not_have_names_the_repository(rig: MultiRig) -> None:
    repo = rig.repo("lib", branch="feature/x")
    workspace = rig.workspace([rig.repo("app", branch="main"), repo])
    raw("branch", "-m", "main", "trunk", cwd=repo.origin.path, git=rig.git)

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.BASE_BRANCH_NOT_FOUND
    assert "lib" in refused.value.detail


# #1093-T05
def test_a_failed_set_up_has_no_start_commit(rig: MultiRig) -> None:
    workspace = rig.workspace(
        [rig.repo("app", branch="main"), rig.repo("lib", branch="x", exists=True)]
    )

    with pytest.raises(JobError):
        workspace.prepare()

    with pytest.raises(JobError):
        _ = workspace.start_commit


# #1093-T06
def test_every_changed_branch_of_every_repository_is_pushed_and_reported(rig: MultiRig) -> None:
    repos = three(rig)
    workspace = rig.workspace(repos)
    workspace.prepare()
    app, shared, lib = workspace.members
    app_tip = commit(app, "feature.txt")
    shared_tip = commit(shared, "direct.txt")
    lib_tip = commit(lib, "round2.txt")

    workspace.push_all(seconds=120.0)

    assert repos[0].origin.tip("feature/x") == app_tip
    assert repos[1].origin.tip("main") == shared_tip
    assert repos[2].origin.tip("feature/x") == lib_tip
    assert push_error(workspace, handed_in_something=False) is None
    entries = {entry.name: entry for entry in outcomes_of(workspace, can_push=True)}
    assert entries["app"].created is True and entries["app"].pushed is True
    assert entries["app"].base_commit == repos[0].origin.tip("main") != app_tip
    assert entries["app"].head_commit == app_tip
    assert [c.sha for c in entries["app"].commits] == [app_tip]
    assert entries["shared"].created is False and entries["shared"].branch == "main"
    assert entries["shared"].head_commit == shared_tip and entries["shared"].pushed is True
    # A continued branch counts from its own tip, not from the base.
    assert entries["lib"].base_commit != entries["lib"].head_commit == lib_tip
    assert [c.sha for c in entries["lib"].commits] == [lib_tip]


# #1093-T07
def test_a_continued_branch_that_got_no_commit_has_none_and_is_on_the_remote(rig: MultiRig) -> None:
    repos = three(rig)
    workspace = rig.workspace(repos)
    workspace.prepare()
    commit(workspace.members[0], "feature.txt")

    workspace.push_all(seconds=120.0)

    lib = {entry.name: entry for entry in outcomes_of(workspace, can_push=True)}["lib"]
    tip = repos[2].origin.tip("feature/x")
    assert lib.base_commit == lib.head_commit == tip
    assert lib.commits == () and lib.files_changed == ()
    assert lib.pushed is True and lib.created is False
    assert lib.branches == ()


# #1093-T08
def test_a_new_branch_with_no_commit_is_not_pushed_and_is_verifiably_empty(rig: MultiRig) -> None:
    repos = [rig.repo("app", branch="feature/x"), rig.repo("lib", branch="feature/y")]
    workspace = rig.workspace(repos)
    workspace.prepare()
    commit(workspace.members[0], "feature.txt")

    workspace.push_all(seconds=120.0)

    assert repos[1].origin.tip("feature/y") is None
    lib = {entry.name: entry for entry in outcomes_of(workspace, can_push=True)}["lib"]
    assert lib.created is True and lib.pushed is False
    assert lib.head_commit == lib.base_commit
    # Verifiably empty is no failure: the turn is judged by the repositories that have work.
    assert push_error(workspace, handed_in_something=False) is None


# #1093-T09
def test_a_turn_with_no_commit_in_any_repository_gave_up(rig: MultiRig) -> None:
    workspace = rig.workspace(three(rig))
    workspace.prepare()

    workspace.push_all(seconds=120.0)

    assert push_error(workspace, handed_in_something=False) == (
        ErrorCode.AGENT_GAVE_UP,
        "the agent ended without a commit",
    )
    assert push_error(workspace, handed_in_something=True) is None


# #1093-T10
def test_a_repository_that_rejects_the_push_does_not_keep_the_others_from_arriving(
    rig: MultiRig,
) -> None:
    repos = three(rig)
    repos[1].origin.reject_ref_with_hook("refs/heads/main", "protected branch")
    workspace = rig.workspace(repos)
    workspace.prepare()
    app, shared, _ = workspace.members
    app_tip = commit(app, "feature.txt")
    commit(shared, "direct.txt")

    workspace.push_all(seconds=120.0)

    assert repos[0].origin.tip("feature/x") == app_tip
    error = push_error(workspace, handed_in_something=False)
    assert error is not None and error[0] is ErrorCode.PUSH_REJECTED
    assert "shared" in error[1]
    entries = {entry.name: entry for entry in outcomes_of(workspace, can_push=True)}
    assert entries["shared"].pushed is False
    assert entries["shared"].branches is not None
    assert [(b.name, b.reason) for b in entries["shared"].branches] == [("main", "remote_rejected")]
    assert entries["app"].pushed is True


# #1093-T11
def test_the_base_branch_is_pushed_too_when_the_entry_names_a_working_branch(
    rig: MultiRig,
) -> None:
    repos = [rig.repo("app", branch="feature/x")]
    workspace = rig.workspace(repos)
    workspace.prepare()
    (app,) = workspace.members
    branch_tip = commit(app, "feature.txt")
    agent(app, "checkout", "-q", "main")
    main_tip = commit(app, "on-main.txt")

    workspace.push_all(seconds=120.0)

    assert repos[0].origin.tip("feature/x") == branch_tip
    assert repos[0].origin.tip("main") == main_tip


# #1093-T12
def test_nothing_is_forced_a_rewritten_branch_is_refused(rig: MultiRig) -> None:
    repos = three(rig)
    workspace = rig.workspace(repos)
    workspace.prepare()
    lib = workspace.members[2]
    agent(lib, "reset", "-q", "--hard", "main")
    commit(lib, "rewritten.txt")
    before = repos[2].origin.tip("feature/x")

    workspace.push_all(seconds=120.0)

    assert repos[2].origin.tip("feature/x") == before
    error = push_error(workspace, handed_in_something=False)
    assert error is not None and error[0] is ErrorCode.PUSH_REJECTED and "lib" in error[1]


# #1093-T13
def test_the_block_of_the_report_is_one_the_app_reads(rig: MultiRig) -> None:
    from code_reviewer_runner.implementer.turn_result import TurnResult
    from code_reviewer_runner.result import Usage

    repos = three(rig)
    workspace = rig.workspace(repos)
    workspace.prepare()
    for member in workspace.members[:2]:
        commit(member, "w.txt")
    workspace.push_all(seconds=120.0)
    outcomes = outcomes_of(workspace, can_push=True)
    first = outcomes[0]
    turn = TurnResult(
        error_code=None,
        error_detail=None,
        base_commit=first.base_commit,
        head_commit=first.head_commit,
        pushed=first.pushed,
        branches=() if first.branches is None else first.branches,
        branches_dropped=first.branches_dropped,
        commits=first.commits,
        files_changed=first.files_changed,
        summary="done",
        opencode_session_id=None,
        opencode_version="1",
        usage=Usage(None, 0, 0, 0, 0, False, None),
        repos=outcomes,
    )

    block = valid_block(turn.implementer_block())

    assert block is not None
    assert [entry["name"] for entry in block["repos"]] == ["app", "shared", "lib"]
    assert block["baseCommit"] == block["repos"][0]["baseCommit"]
    assert block["commits"] == block["repos"][0]["commits"]


# #1093-T14
def test_a_follow_up_checks_out_the_branch_each_repository_ended_on(rig: MultiRig) -> None:
    repos = [rig.repo("app", branch="feature/x", exists=True), rig.repo("lib", branch="main")]
    first = repos[0].origin.commit_on("feature/x", "round1.txt")
    other = repos[0].origin.commit_on("feature/other", "o.txt")
    resume = ImplementerResume(
        turn=2,
        repos=(
            ResumeRepo(
                "app",
                (ResumeBranch("feature/x", first), ResumeBranch("feature/other", other)),
                "feature/other",
            ),
            ResumeRepo("lib", (), None),
        ),
    )
    workspace = rig.workspace(repos, resume=resume)

    workspace.prepare()

    app, lib = workspace.members
    assert checked_out(app) == "feature/other"
    assert checked_out(lib) == "main"
    assert app.branch_created is False


# #1093-T15
def test_every_repository_is_pushed_with_the_token_of_its_own_installation(rig: MultiRig) -> None:
    git = rig.git
    app = rig.repo("app", branch="feature/x")
    lib = rig.repo("lib", branch="feature/y", token=OTHER_TOKEN)
    with (
        HttpOrigin(app.origin, TOKEN, git) as first,
        HttpOrigin(lib.origin, OTHER_TOKEN, git) as second,
    ):
        app.url, lib.url = first.url, second.url
        workspace = rig.workspace([app, lib], schemes=("http",))
        workspace.prepare()
        app_tip = commit(workspace.members[0], "a.txt")
        lib_tip = commit(workspace.members[1], "b.txt")

        workspace.push_all(seconds=120.0)

    assert app.origin.tip("feature/x") == app_tip
    assert lib.origin.tip("feature/y") == lib_tip
    # Neither server was ever shown the other's token.
    assert all(header is not None for _, header in first.requests)
    assert {header for _, header in first.requests} != {header for _, header in second.requests}


# #1093-T16
def test_a_turn_that_fails_after_the_set_up_reports_every_repository(rig: MultiRig) -> None:
    from code_reviewer_runner.implementer.job_run import _early_block  # pyright: ignore[reportPrivateUsage]

    repos = three(rig)
    workspace = rig.workspace(repos)
    assert _early_block(workspace) is None, "nothing is reported before every repository is cloned"
    workspace.prepare()

    block = _early_block(workspace)

    assert block is not None
    listed = cast("list[dict[str, Any]]", block["repos"])
    entries = {entry["name"]: entry for entry in listed}
    assert entries["app"]["created"] is True and entries["app"]["pushed"] is False
    assert entries["lib"]["created"] is False and entries["lib"]["pushed"] is True
    assert entries["lib"]["baseCommit"] == repos[2].origin.tip("feature/x")
    assert valid_block(block) is not None


# #1093-T17
def test_the_directories_of_a_multi_repository_turn_are_found_by_their_mirrors(
    rig: MultiRig,
) -> None:
    from code_reviewer_runner.factory_runner.housekeeping import clear_work, work_subdirectories

    workspace = rig.workspace(three(rig))
    workspace.prepare()
    work = rig.layout.work_dir

    names = work_subdirectories(work)

    assert {"app", "shared", "lib"} <= set(names)
    assert clear_work(work) == []
    assert sorted(entry.name for entry in work.iterdir()) == []


LOGIN = "sk-" + "ant-" + "oat01-Zq9Lm3XvTn8Rk5Wc2-multirepotestmultirepotest"


def gate_with(answers: list[str]) -> tuple[Callable[[], None], list[str]]:
    """One lease gate for the whole turn (the job's host answers one question for every repository):
    "held" or "lost" in turn, the last one repeating; and the list of what it was asked."""
    asked: list[str] = []

    def gate() -> None:
        answer = answers[min(len(asked), len(answers) - 1)]
        asked.append(answer)
        if answer == "lost":
            raise JobError(ErrorCode.LEASE_LOST, "the job is no longer held by this runner")

    return gate, asked


# #1093-T60
def test_a_lease_lost_in_the_second_repository_stops_the_push_before_the_third(
    rig: MultiRig,
) -> None:
    repos = three(rig)
    # app: asked at the start and before its push (held, held); shared: asked at its start (lost).
    gate, asked = gate_with(["held", "held", "lost"])
    workspace = rig.workspace(repos, before_push=gate)
    workspace.prepare()
    app, shared, lib = workspace.members
    app_tip = commit(app, "feature.txt")
    commit(shared, "direct.txt")
    commit(lib, "round2.txt")
    lib_remote = repos[2].origin.tip("feature/x")

    with pytest.raises(JobError) as ended:
        workspace.push_all(seconds=120.0)

    assert ended.value.code is ErrorCode.LEASE_LOST
    assert asked == ["held", "held", "lost"], "nothing is asked or pushed after the loss"
    assert repos[0].origin.tip("feature/x") == app_tip
    assert repos[1].origin.tip("main") == workspace.members[1].start_commit
    assert repos[2].origin.tip("feature/x") == lib_remote
    reached = {fact.workspace.spec.name: fact.reached for fact in workspace.facts()}
    assert reached == {"app": True, "shared": True, "lib": False}
    # The report: what arrived is said; the repository the push did not get to says `pushed` false
    # and no `branches` (not attempted, its remote state was not looked at).
    entries = {entry.name: entry for entry in outcomes_of(workspace, can_push=True)}
    assert entries["app"].pushed is True and entries["app"].branches is not None
    assert entries["lib"].pushed is False and entries["lib"].branches is None
    assert entries["lib"].head_commit is not None


# #1093-T61
def test_the_login_in_one_repository_stops_that_branch_only_and_names_the_repository(
    rig: MultiRig,
) -> None:
    repos = three(rig)
    workspace = rig.workspace(repos, guard_secrets=(LOGIN,))
    workspace.prepare()
    app, shared, lib = workspace.members
    app_tip = commit(app, "feature.txt")
    commit(shared, "notes.txt", f"token={LOGIN}\n")
    lib_tip = commit(lib, "round2.txt")

    workspace.push_all(seconds=120.0)

    assert repos[0].origin.tip("feature/x") == app_tip
    assert repos[2].origin.tip("feature/x") == lib_tip
    assert repos[1].origin.tip("main") == workspace.members[1].start_commit
    error = push_error(workspace, handed_in_something=False)
    assert error is not None and error[0] is ErrorCode.PUSH_REJECTED
    assert "login_secret" in error[1] and "(repository shared)" in error[1]
    assert LOGIN not in error[1]
    entries = {entry.name: entry for entry in outcomes_of(workspace, can_push=True)}
    assert entries["shared"].pushed is False and entries["shared"].branches is not None
    assert [(b.name, b.reason) for b in entries["shared"].branches] == [
        ("main", REASON_LOGIN_SECRET)
    ]
    assert entries["app"].pushed is True and entries["lib"].pushed is True


# #1093-T62
def test_a_branch_the_guard_cannot_read_to_its_end_is_unchecked_in_its_repository_only(
    rig: MultiRig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(git_workspace, "GUARD_READ_MAX_BYTES", 2048)
    repos = three(rig)
    workspace = rig.workspace(repos, guard_secrets=(LOGIN,))
    workspace.prepare()
    app, shared, _ = workspace.members
    app_tip = commit(app, "feature.txt")
    commit(shared, "big.txt", "x" * 8192)

    workspace.push_all(seconds=120.0)

    assert repos[0].origin.tip("feature/x") == app_tip
    assert repos[1].origin.tip("main") == workspace.members[1].start_commit
    error = push_error(workspace, handed_in_something=False)
    assert error is not None and error[0] is ErrorCode.PUSH_REJECTED
    assert "unchecked" in error[1] and "(repository shared)" in error[1]
    entries = {entry.name: entry for entry in outcomes_of(workspace, can_push=True)}
    assert [(b.name, b.reason) for b in entries["shared"].branches or ()] == [
        ("main", REASON_UNCHECKED)
    ]
    assert entries["app"].pushed is True


# #1093-T63
def test_a_follow_up_whose_branch_is_gone_in_one_repository_names_it_and_pushes_nothing(
    rig: MultiRig,
) -> None:
    repos = [
        rig.repo("app", branch="feature/x", exists=True),
        rig.repo("lib", branch="feature/x", exists=True),
    ]
    first = repos[0].origin.commit_on("feature/x", "round1.txt")
    # `lib` never had the branch the follow-up resumes (deleted on the provider since).
    resume = ImplementerResume(
        turn=2,
        repos=(
            ResumeRepo("app", (ResumeBranch("feature/x", first),), "feature/x"),
            ResumeRepo("lib", (ResumeBranch("feature/x", "1" * 40),), "feature/x"),
        ),
    )

    with pytest.raises(JobError) as refused:
        rig.workspace(repos, resume=resume).prepare()

    assert refused.value.code is ErrorCode.CLONE_FAILED
    assert "lib" in refused.value.detail and "app" not in refused.value.detail
    assert repos[0].origin.tip("feature/x") == first


# #1093-T64
def test_a_follow_up_that_only_continues_direct_work_on_the_base_is_resumed(rig: MultiRig) -> None:
    repos = [rig.repo("app", branch="main"), rig.repo("lib", branch="main")]
    tip = repos[0].origin.tip("main")
    assert tip is not None
    resume = ImplementerResume(
        turn=2,
        repos=(
            ResumeRepo("app", (ResumeBranch("main", tip),), "main"),
            ResumeRepo("lib", (), None),
        ),
    )
    workspace = rig.workspace(repos, resume=resume)

    workspace.prepare()

    app, lib = workspace.members
    assert checked_out(app) == "main" and checked_out(lib) == "main"
    assert app.branch_created is False and lib.branch_created is False
    new = commit(app, "again.txt")
    workspace.push_all(seconds=120.0)
    assert repos[0].origin.tip("main") == new
    assert push_error(workspace, handed_in_something=False) is None


# #1093-T65
def test_a_profile_that_may_not_push_reports_every_repository_without_facts_through_the_session(
    rig: MultiRig,
) -> None:
    from types import SimpleNamespace

    from code_reviewer_runner.implementer.session import ImplementerSession
    from code_reviewer_runner.implementer.turn_result import TurnResult
    from code_reviewer_runner.result import Usage

    repos = three(rig)
    workspace = rig.workspace(repos)
    workspace.prepare()
    commit(workspace.members[0], "feature.txt")
    # Nothing is pushed: `canPush` false never reaches `push_all`.

    def turn_result(
        error: Any, head: Any, pushed: Any, branches: Any, dropped: Any, commits: Any, files: Any
    ) -> TurnResult:
        return TurnResult(
            error_code=None if error is None else error[0],
            error_detail=None if error is None else error[1],
            base_commit=workspace.start_commit,
            head_commit=head,
            pushed=pushed,
            branches=branches,
            branches_dropped=dropped,
            commits=commits,
            files_changed=files,
            summary="done",
            opencode_session_id=None,
            opencode_version="1",
            usage=Usage(None, 0, 0, 0, 0, False, None),
        )

    # `_multi_result` reads five attributes of the session and calls `_turn_result`.
    stub = SimpleNamespace(
        _can_push=False,
        _error=None,
        _agent_ask=None,
        _agent_result=None,
        _turn_result=turn_result,
    )

    result = ImplementerSession._multi_result(stub, workspace)  # type: ignore[arg-type]  # pyright: ignore[reportPrivateUsage]

    assert result.error_code is None, "a turn that may not push is no failed push"
    assert result.repos is not None and [entry.name for entry in result.repos] == [
        "app",
        "shared",
        "lib",
    ]
    for entry in result.repos:
        assert entry.head_commit is None and entry.pushed is False
        assert entry.commits == () and entry.files_changed == () and entry.branches is None
    assert result.head_commit is None and result.pushed is False and result.commits == ()
    block = valid_block(result.implementer_block())
    assert block is not None
    assert [(e["name"], e["headCommit"], e["pushed"]) for e in block["repos"]] == [
        ("app", None, False),
        ("shared", None, False),
        ("lib", None, False),
    ]
    assert block["headCommit"] is None and block["commits"] == []
    assert repos[0].origin.tip("feature/x") is None


# #1093-T66
def test_a_ref_collision_in_one_repository_names_it(rig: MultiRig) -> None:
    # The provider has `feature`, the new branch is `feature/x`: git cannot hold both as refs.
    colliding = rig.repo("lib", branch="feature/x")
    colliding.origin.commit_on("feature", "f.txt")
    workspace = rig.workspace([rig.repo("app", branch="feature/y"), colliding])

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert "(repository lib)" in refused.value.detail


# #1093-T67
def test_a_branch_name_git_does_not_accept_names_its_repository(rig: MultiRig) -> None:
    workspace = rig.workspace([rig.repo("app", branch="feature/y"), rig.repo("lib", branch="a..b")])

    with pytest.raises(JobError) as refused:
        workspace.prepare()

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert "(repository lib)" in refused.value.detail
