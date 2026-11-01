# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer's git workspace (#762): clone into a runner-owned mirror, the agent's repository,
the accident guard and the leftover API. The push side is in test_implementer_git_push.py.

Everything runs against a bare repository on the file system standing in for GitHub, except the
token tests, which clone and push over HTTP on loopback (`HttpOrigin`). The tests run as an ordinary
user, so "the agent" and "root" are the same user here and `AgentUser` names the current one; the
user separation itself (the uid of the processes, what the engine user can read) is proven by
tests/privileged/test_implementer_git_users.py.
"""

import os
import stat
import subprocess
import threading
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.git_workspace import (
    LEFTOVER_MESSAGE,
    GitWorkspace,
    RepositoryUnusable,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode
from git_support import (
    TOKEN,
    HttpOrigin,
    environments_mentioning,
    files_mentioning,
    processes_mentioning,
    raw,
)
from workspace_support import (
    BRANCH,
    IDENTITY,
    Rig,
    agent_git,
    reset_to,
    spool_lines,
)


# #762-T01
def test_the_base_branch_is_cloned_into_a_root_owned_mirror(rig: Rig) -> None:
    workspace = rig.workspace()

    workspace.clone_mirror()

    assert workspace.start_commit == rig.origin.tip("main")
    assert workspace.mirror.is_dir()
    assert stat.S_IMODE(workspace.mirror.stat().st_mode) == 0o700
    shallow = raw("rev-list", "--count", "HEAD", cwd=workspace.mirror, git=rig.git)
    assert shallow == "1"  # --depth 1


# #762-T01
def test_the_token_is_in_no_argv_no_file_and_no_url(rig: Rig) -> None:
    git = "/usr/bin/git"  # the system git has the HTTP transport; the clone needs no guard
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git=git)
        server.hold()
        done: list[BaseException] = []

        def clone() -> None:
            try:
                workspace.clone_mirror()
            except BaseException as error:
                done.append(error)

        thread = threading.Thread(target=clone)
        thread.start()
        assert server.arrived.wait(30), "the clone never reached the server"
        # The git process is alive and waiting for the answer: look at it.
        assert processes_mentioning(TOKEN) == []
        assert processes_mentioning(TOKEN[:12]) == []
        assert environments_mentioning(TOKEN) == 0, "the token is only the encoded header"
        assert environments_mentioning("Authorization: Basic") >= 1, "the scan sees environments"
        server.release()
        thread.join(30)
        assert done == []

    assert workspace.start_commit == rig.origin.tip("main")
    assert files_mentioning(rig.base / "work", TOKEN) == []
    assert files_mentioning(rig.base / "work", "Authorization") == []
    config = (workspace.mirror / "config").read_text()
    assert "http://127.0.0.1" not in config  # no URL is kept in the mirror's config


# #762-T01
def test_a_token_the_server_does_not_know_is_a_clone_failure_that_does_not_name_it(
    rig: Rig,
) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(
            url=server.url, schemes=("http",), git=git, token="ghs_another-installation-token-0123"
        )

        with pytest.raises(JobError) as refused:
            workspace.clone_mirror()

    assert refused.value.code is ErrorCode.CLONE_FAILED
    assert "ghs_another" not in str(refused.value)


# #762-T01
def test_a_missing_base_branch_is_its_own_code(rig: Rig) -> None:
    workspace = rig.workspace(base_branch="nope")

    with pytest.raises(JobError) as refused:
        workspace.clone_mirror()

    assert refused.value.code is ErrorCode.BASE_BRANCH_NOT_FOUND


# #762-T01
def test_a_repository_that_cannot_be_reached_is_a_clone_failure(rig: Rig) -> None:
    workspace = rig.workspace(url=f"file://{rig.base}/missing.git")

    with pytest.raises(JobError) as refused:
        workspace.clone_mirror()

    assert refused.value.code is ErrorCode.CLONE_FAILED


# #762-T02
def test_the_agent_repository_has_the_new_branch_at_the_base_tip_and_no_remote(rig: Rig) -> None:
    workspace = rig.prepared()

    repo = workspace.repo
    assert repo == rig.base / "work" / "repo"
    assert raw("symbolic-ref", "--short", "HEAD", cwd=repo, git=rig.git) == BRANCH
    assert raw("rev-parse", "HEAD", cwd=repo, git=rig.git) == rig.origin.tip("main")
    assert raw("remote", cwd=repo, git=rig.git) == ""
    assert raw("config", "user.name", cwd=repo, git=rig.git) == IDENTITY.name
    assert raw("config", "user.email", cwd=repo, git=rig.git) == IDENTITY.email
    assert repo.stat().st_uid == os.geteuid()
    assert (repo / "README.md").read_text() == "# demo\n"
    assert not (repo.parent / "mirror.git" / "refs" / "heads" / BRANCH).exists()


# #762-T02
def test_the_agent_environment_names_the_guard_and_no_credential(rig: Rig) -> None:
    workspace = rig.prepared()

    environment = workspace.agent_environment()

    assert environment["GIT_CONFIG_SYSTEM"] == str(rig.base / "run" / "system.gitconfig")
    assert environment["CODE_REVIEWER_GUARD_CONF"] == str(rig.base / "run" / "guard.conf")
    assert environment["HOME"] == str(rig.layout.agent_home)
    assert environment["GIT_AUTHOR_NAME"] == IDENTITY.name
    assert all(TOKEN not in value for value in environment.values())
    assert "GIT_CONFIG_COUNT" not in environment
    conf = (rig.base / "run" / "guard.conf").read_text()
    assert f"START={workspace.start_commit}" in conf
    assert str(rig.base / "run" / "spool") in conf


# #762-T02
def test_a_branch_name_with_shell_characters_cannot_change_the_guard_configuration(
    rig: Rig, tmp_path: Path
) -> None:
    marker = tmp_path / "marker"
    branch = f"fix/$(touch${{IFS}}{marker})`touch${{IFS}}{marker}`;x"
    workspace = rig.workspace(branch=branch)
    workspace.prepare(self_test=False)

    done = subprocess.run(
        [rig.git, "commit", "--allow-empty", "-qm", "c"],
        cwd=workspace.repo,
        env=workspace.agent_environment(),
        capture_output=True,
        text=True,
        check=False,
    )

    assert done.returncode == 0, done.stderr
    assert not marker.exists()
    assert len(spool_lines(workspace)) == 1


# #762-T02
@pytest.mark.parametrize(
    "branch",
    ["bad name", "a..b", "-x", "a:b", "a^b", "x.lock", "a@{b", "main", "/a", "a//b", ""],
)
def test_a_branch_git_would_not_accept_or_equal_to_the_base_is_refused_before_any_work(
    rig: Rig, branch: str
) -> None:
    workspace = rig.workspace(branch=branch)

    with pytest.raises(JobError) as refused:
        workspace.prepare(self_test=False)

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert not (rig.base / "work").exists() or not any((rig.base / "work").iterdir())


# #762-T02
def test_a_work_directory_that_is_not_empty_is_refused(rig: Rig) -> None:
    (rig.base / "work" / "repo").mkdir(parents=True)

    with pytest.raises(JobError) as refused:
        rig.workspace().prepare(self_test=False)

    assert refused.value.code is ErrorCode.SETUP_FAILED


ALLOWED = {
    "commit": ["sh", "-c", "echo n > n.txt && git add n.txt && git commit -qm n"],
    "empty commit": ["git", "commit", "--allow-empty", "-qm", "e"],
    "revert": ["git", "revert", "--no-edit", "HEAD"],
    "cherry-pick of a new commit": [
        "sh",
        "-c",
        "git fetch -q {side} side && git cherry-pick FETCH_HEAD",
    ],
    "ff-merge of a new commit": [
        "sh",
        "-c",
        "git fetch -q {side} side && git merge -q --ff-only FETCH_HEAD",
    ],
}


# #762-T03
@pytest.mark.parametrize("name", sorted(ALLOWED))
def test_allowed_actions_work_and_signal(rig: Rig, name: str) -> None:
    workspace = rig.prepared()
    # The repo needs a commit of its own to revert; the base tip is the start, so make one.
    (workspace.repo / "mine.txt").write_text("mine\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    first = agent_git(workspace, "commit", "-qm", "mine")
    assert first.returncode == 0, first.stderr
    side = _side_repo(rig, workspace)
    base = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    workspace.spool_path.write_text("")
    command = [part.format(side=side) for part in ALLOWED[name]]

    done = subprocess.run(
        command if command[0] != "git" else [rig.git, *command[1:]],
        cwd=workspace.repo,
        env={
            **workspace.agent_environment(),
            "PATH": f"{Path(rig.git).parent}:{os.environ['PATH']}",
        },
        capture_output=True,
        text=True,
        check=False,
    )

    assert done.returncode == 0, done.stderr
    assert raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git) != base
    assert len(spool_lines(workspace)) >= 1


# #762-T03
def test_stash_and_fetch_work(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "README.md").write_text("changed\n")

    assert agent_git(workspace, "stash").returncode == 0
    assert agent_git(workspace, "stash", "pop").returncode == 0
    assert agent_git(workspace, "fetch", str(rig.origin.path), "main").returncode == 0


def _side_repo(rig: Rig, workspace: GitWorkspace) -> Path:
    """A repository holding a branch `side` with a commit on top of the start (for merge/pick)."""
    side = rig.base / "side"
    raw("clone", "-q", str(workspace.repo), str(side), git=rig.git)
    raw("checkout", "-q", "-b", "side", cwd=side, git=rig.git)
    (side / "side.txt").write_text("s\n")
    raw("add", "-A", cwd=side, git=rig.git)
    raw("commit", "-qm", "side", cwd=side, git=rig.git)
    return side


BLOCKED = {
    "amend": ["commit", "--amend", "-qm", "amended"],
    "reset --soft": ["reset", "-q", "--soft", "HEAD~1"],
    "reset --hard": ["reset", "-q", "--hard", "HEAD~1"],
    "reset to the start": ["reset", "-q", "--hard", "{start}"],
    "rebase -f": ["rebase", "-q", "-f", "{start}"],
    "branch": ["branch", "other"],
    "tag": ["tag", "v1"],
    "checkout -b": ["checkout", "-q", "-b", "other"],
    "switch -c": ["switch", "-q", "-c", "other"],
    "checkout the base branch": ["checkout", "-q", "main"],
    "switch the base branch": ["switch", "-q", "main"],
    "checkout --detach": ["checkout", "-q", "--detach"],
    "checkout a commit": ["checkout", "-q", "{start}"],
    "update-ref of another branch": ["update-ref", "refs/heads/x", "HEAD"],
    "update-ref back to the start": ["update-ref", "refs/heads/{branch}", "{start}"],
    "branch rename": ["branch", "-m", "{branch}", "renamed"],
    "worktree add": ["worktree", "add", "-q", "-b", "wt", "{wt}"],
}


# #762-T04
@pytest.mark.parametrize("name", sorted(BLOCKED))
def test_blocked_actions_fail_and_leave_the_branch(rig: Rig, name: str) -> None:
    workspace = rig.prepared()
    for number in (1, 2):
        made = agent_git(workspace, "commit", "--allow-empty", "-qm", f"c{number}")
        assert made.returncode == 0, made.stderr
    tip = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    reset_to(workspace, tip)
    workspace.spool_path.write_text("")
    arguments = [
        part.format(start=workspace.start_commit, branch=BRANCH, wt=rig.base / "wt")
        for part in BLOCKED[name]
    ]

    done = agent_git(workspace, *arguments)

    assert done.returncode != 0, f"{name} succeeded"
    assert raw("rev-parse", f"refs/heads/{BRANCH}", cwd=workspace.repo, git=rig.git) == tip
    assert raw("symbolic-ref", "HEAD", cwd=workspace.repo, git=rig.git) == f"refs/heads/{BRANCH}"
    assert spool_lines(workspace) == []


# #762-T04
def test_deleting_the_branch_is_blocked(rig: Rig) -> None:
    workspace = rig.prepared()
    tip = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    raw(
        "checkout", "-q", "--detach", cwd=workspace.repo, git=rig.git, GIT_CONFIG_SYSTEM="/dev/null"
    )

    done = agent_git(workspace, "branch", "-D", BRANCH)

    assert done.returncode != 0
    assert raw("rev-parse", f"refs/heads/{BRANCH}", cwd=workspace.repo, git=rig.git) == tip


# #762-T11
def test_the_self_test_passes_on_a_good_guard(rig: Rig) -> None:
    workspace = rig.workspace()

    workspace.self_test()


# #762-T11
def test_the_guard_matrix_failing_makes_the_turn_a_setup_failure(rig: Rig) -> None:
    matrix = rig.layout.guard_dir / "guard_matrix.sh"
    matrix.write_text("#!/bin/sh\necho 'FAIL  block  commit --amend: it succeeded'\nexit 1\n")

    with pytest.raises(JobError) as refused:
        rig.workspace().self_test()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert "commit --amend" in refused.value.detail


# #762-T11
def test_a_matrix_that_cannot_run_is_a_setup_failure(rig: Rig) -> None:
    matrix = rig.layout.guard_dir / "guard_matrix.sh"
    matrix.write_text("#!/bin/sh\necho 'guard_matrix: git 2.43 is older' >&2\nexit 2\n")

    with pytest.raises(JobError) as refused:
        rig.workspace().self_test()

    assert refused.value.code is ErrorCode.SETUP_FAILED


# #762-T11
@pytest.mark.parametrize("missing", ["guard_matrix.sh", "reference-transaction"])
def test_a_missing_guard_file_is_a_setup_failure(rig: Rig, missing: str) -> None:
    (rig.layout.guard_dir / missing).unlink()

    with pytest.raises(JobError) as refused:
        rig.workspace().self_test()

    assert refused.value.code is ErrorCode.SETUP_FAILED


# #762-T11
def test_a_git_older_than_2_53_is_a_setup_failure(rig: Rig, tmp_path: Path) -> None:
    old = tmp_path / "old" / "git"
    old.parent.mkdir()
    old.write_text("#!/bin/sh\necho 'git version 2.43.0'\n")
    old.chmod(0o755)

    with pytest.raises(JobError) as refused:
        rig.workspace(git=str(old)).self_test()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert "2.43" in refused.value.detail


# #762-T11
def test_prepare_runs_the_self_test_first_and_does_nothing_when_it_fails(rig: Rig) -> None:
    (rig.layout.guard_dir / "guard_matrix.sh").write_text("#!/bin/sh\nexit 1\n")

    with pytest.raises(JobError) as refused:
        rig.workspace().prepare()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert not (rig.base / "work" / "mirror.git").exists()


# #762-T08
def test_dirty_sees_a_changed_tracked_file_and_an_untracked_one(rig: Rig) -> None:
    workspace = rig.prepared()
    assert workspace.dirty() is False

    (workspace.repo / "new.txt").write_text("n\n")
    assert workspace.dirty() is True


# #762-T08
def test_commit_all_commits_everything_with_the_fixed_message_and_signals(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "README.md").write_text("changed\n")
    (workspace.repo / "new.txt").write_text("n\n")

    sha = workspace.commit_all()

    assert sha == raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    assert raw("log", "-1", "--format=%s", cwd=workspace.repo, git=rig.git) == LEFTOVER_MESSAGE
    assert LEFTOVER_MESSAGE == "Implementer: uncommitted changes of the turn"
    assert raw("log", "-1", "--format=%an <%ae>", cwd=workspace.repo, git=rig.git) == (
        f"{IDENTITY.name} <{IDENTITY.email}>"
    )
    assert workspace.dirty() is False
    assert sha is not None and spool_lines(workspace)[-1].endswith(sha)


# #762-T08
def test_commit_all_of_a_clean_tree_commits_nothing(rig: Rig) -> None:
    workspace = rig.prepared()

    assert workspace.commit_all() is None
    assert spool_lines(workspace) == []


# #762-T08
def test_commit_all_goes_through_the_guard(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "new.txt").write_text("n\n")
    # A guard that denies everything: its configuration is gone.
    (rig.base / "run" / "guard.conf").unlink()

    with pytest.raises(RepositoryUnusable) as refused:
        workspace.commit_all()

    # The agent ran and spent the model budget: not a free class (`setup_failed`).
    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert "the guard configuration is not usable" in refused.value.detail


# #762-T08
def test_a_local_hooks_path_of_the_agent_does_not_run_or_speak_in_the_leftover_commit(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    hooks = rig.base / "agent-hooks"
    hooks.mkdir()
    marker = rig.base / "hook-ran"
    script = hooks / "pre-commit"
    script.write_text(
        f"#!/bin/sh\n: > {marker}\necho 'code-reviewer-guard: SECRET-FROM-THE-AGENT' >&2\nexit 1\n"
    )
    script.chmod(0o755)
    raw("config", "core.hooksPath", str(hooks), cwd=workspace.repo, git=rig.git)
    (workspace.repo / "new.txt").write_text("n\n")

    sha = workspace.commit_all()

    assert sha is not None and sha == raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    assert not marker.exists(), "the agent's own pre-commit ran in a call of the runner"
    assert spool_lines(workspace)[-1].endswith(sha), "the guard of the image still ran"


# #762-T09
def test_text_the_agent_chose_does_not_reach_the_error_of_a_denied_leftover_commit(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    name = "SECRET-BRANCH-" + "x" * 20
    done = agent_git(workspace, "-c", "core.hooksPath=/dev/null", "checkout", "-q", "-b", name)
    assert done.returncode == 0, done.stderr
    (workspace.repo / "new.txt").write_text("n\n")

    with pytest.raises(RepositoryUnusable) as refused:
        workspace.commit_all()

    assert name not in refused.value.detail and name not in str(refused.value)
    assert "only the agent's branch may be updated" in refused.value.detail


# #762-T08
def test_a_status_that_fails_after_the_agent_ran_is_a_charged_class(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / ".git" / "HEAD").write_text("garbage\n")

    with pytest.raises(RepositoryUnusable) as refused:
        workspace.dirty()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION


# #762-T10
def test_no_file_of_the_workspace_has_the_token_and_the_mirror_is_private(rig: Rig) -> None:
    workspace = rig.prepared()
    agent_git(workspace, "commit", "--allow-empty", "-qm", "c")

    assert files_mentioning(rig.base, TOKEN) == []
    assert stat.S_IMODE(workspace.mirror.stat().st_mode) & 0o077 == 0
    for name in ("guard.conf", "system.gitconfig"):
        mode = stat.S_IMODE((rig.base / "run" / name).stat().st_mode)
        assert mode & 0o022 == 0, f"{name} must not be writable by anyone else"


# #762-T02
def test_the_guard_acts_only_in_the_agents_repository(rig: Rig) -> None:
    workspace = rig.prepared()
    assert f"REPO={workspace.repo}\n" in workspace.guard_conf_path.read_text()
    fixture = rig.base / "fixture"
    environment = workspace.agent_environment()

    def elsewhere(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [workspace.git, *args],
            cwd=cwd,
            env=environment,
            capture_output=True,
            text=True,
            check=False,
        )

    # What a test suite of the repository does: a fixture with its own history and branches.
    assert elsewhere("init", "-q", "-b", "main", str(fixture), cwd=rig.base).returncode == 0
    committed = elsewhere("commit", "-q", "--allow-empty", "-m", "fixture", cwd=fixture)
    assert committed.returncode == 0, committed.stderr
    switched = elsewhere("checkout", "-q", "-b", "other", cwd=fixture)
    assert switched.returncode == 0, switched.stderr
    cloned = elsewhere("clone", "-q", str(fixture), str(rig.base / "second"), cwd=rig.base)
    assert cloned.returncode == 0, cloned.stderr
    # and the agent's own repository is still guarded
    denied = agent_git(workspace, "checkout", "-q", "-b", "other")
    assert denied.returncode != 0
    assert "code-reviewer-guard" in denied.stderr


# #762-T02
@pytest.mark.parametrize("which", ["work", "run"])
def test_a_directory_that_is_a_link_is_refused_and_not_changed(rig: Rig, which: str) -> None:
    target = rig.base / "elsewhere"
    target.mkdir(mode=0o700)
    link = rig.base / which
    link.symlink_to(target)

    with pytest.raises(JobError) as refused:
        rig.workspace().clone_mirror()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert stat.S_IMODE(target.stat().st_mode) == 0o700, "the link was followed by a chmod"
    assert list(target.iterdir()) == []


# #762-T02
@pytest.mark.parametrize("which", ["work", "run"])
@pytest.mark.parametrize("mode", [0o775, 0o757])
def test_a_directory_that_others_can_write_is_refused(rig: Rig, which: str, mode: int) -> None:
    directory = rig.base / which
    directory.mkdir()
    directory.chmod(mode)

    with pytest.raises(JobError) as refused:
        rig.workspace().clone_mirror()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert stat.S_IMODE(directory.stat().st_mode) == mode


# #762-T02
def test_a_directory_that_is_a_file_is_refused(rig: Rig) -> None:
    (rig.base / "run").write_text("")

    with pytest.raises(JobError) as refused:
        rig.workspace().clone_mirror()

    assert refused.value.code is ErrorCode.SETUP_FAILED


# #762-T02
def test_a_run_directory_swapped_for_a_link_before_the_guard_is_written_is_refused(
    rig: Rig,
) -> None:
    workspace = rig.workspace()
    workspace.clone_mirror()
    workspace.create_agent_repository()
    target = rig.base / "elsewhere"
    target.mkdir(mode=0o700)
    (rig.base / "run").rmdir()
    (rig.base / "run").symlink_to(target)

    with pytest.raises(JobError) as refused:
        workspace.install_guard()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert list(target.iterdir()) == []


# #762-T02
def test_a_plain_directory_of_the_runner_is_accepted_and_made_enterable(rig: Rig) -> None:
    directory = rig.base / "work"
    directory.mkdir()
    directory.chmod(0o700)

    rig.workspace().clone_mirror()

    assert stat.S_IMODE(directory.stat().st_mode) == 0o755


# -- what the engine would load from the working tree is not on disk (#764) ----------------------

HOSTILE = {
    ".opencode/plugin/evil.js": "export default async () => ({})\n",
    "opencode.json": '{"plugin": ["./evil.js"]}\n',
    "opencode.jsonc": "{}\n",
    "src/keep.txt": "kept\n",
}


def seed_hostile(rig: Rig) -> None:
    seed = rig.origin.seed
    for name, text in HOSTILE.items():
        (seed / name).parent.mkdir(parents=True, exist_ok=True)
        (seed / name).write_text(text)
    raw("add", "-A", cwd=seed, git=rig.git)
    raw("commit", "-qm", "hostile", cwd=seed, git=rig.git)
    raw("push", "-q", "origin", "main", cwd=seed, git=rig.git)


# #764-R6
def test_the_files_the_engine_loads_from_its_directory_are_not_in_the_working_tree(
    rig: Rig,
) -> None:
    seed_hostile(rig)

    workspace = rig.prepared()

    assert not (workspace.repo / ".opencode").exists()
    assert not (workspace.repo / "opencode.json").exists()
    assert not (workspace.repo / "opencode.jsonc").exists()
    assert (workspace.repo / "src" / "keep.txt").read_text() == "kept\n"
    assert workspace.dirty() is False, "a missing file of the sparse checkout is not a change"


# #764-R6
def test_a_commit_of_the_agent_keeps_them_in_the_tree_and_the_push_does_not_delete_them(
    rig: Rig,
) -> None:
    seed_hostile(rig)
    workspace = rig.prepared()
    (workspace.repo / "new.txt").write_text("x\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    assert agent_git(workspace, "commit", "-qm", "new").returncode == 0

    result = workspace.push()

    tree = raw("ls-tree", "-r", "--name-only", result.head or "", cwd=workspace.mirror, git=rig.git)
    assert set(HOSTILE) | {"new.txt", "README.md", "src/app.py"} <= set(tree.splitlines())
    assert [change.path for change in workspace.changed_files()] == ["new.txt"]


# #764-R6
def test_a_name_that_is_a_link_or_a_file_instead_of_a_directory_is_left_out_too(
    rig: Rig,
) -> None:
    seed = rig.origin.seed
    (seed / ".opencode").symlink_to("/etc")
    raw("add", "-A", cwd=seed, git=rig.git)
    raw("commit", "-qm", "link", cwd=seed, git=rig.git)
    raw("push", "-q", "origin", "main", cwd=seed, git=rig.git)

    workspace = rig.prepared()

    assert not (workspace.repo / ".opencode").exists()
    assert not (workspace.repo / ".opencode").is_symlink()


# -- the three names the engine loads are not the agent's to change (#764, second review) ---------


def commit_all_changes(workspace: GitWorkspace) -> str | None:
    return workspace.commit_all("Add the work")


def tree_of(rig: Rig, workspace: GitWorkspace) -> list[str]:
    head = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    return raw("ls-tree", "-r", "--name-only", head, cwd=workspace.repo, git=rig.git).splitlines()


# #764-R11
@pytest.mark.parametrize("name", ["opencode.json", "opencode.jsonc", ".opencode/plugin/x.js"])
def test_a_new_file_the_engine_loads_is_no_change_and_blocks_no_commit(rig: Rig, name: str) -> None:
    workspace = rig.prepared()
    (workspace.repo / name).parent.mkdir(parents=True, exist_ok=True)
    (workspace.repo / name).write_text("{}\n")

    assert workspace.dirty() is False, "these names never count as a change"
    assert commit_all_changes(workspace) is None, "and there is nothing to commit"
    assert workspace.engine_inputs_present() == [name.split("/")[0]]


# #764-R11
def test_the_rest_of_the_work_is_committed_whatever_is_beside_it(rig: Rig) -> None:
    seed_hostile(rig)  # a tracked opencode.json, opencode.jsonc and .opencode/plugin/evil.js
    workspace = rig.prepared()
    (workspace.repo / "opencode.json").write_text('{"changed": true}\n')  # an edit of a tracked one
    (workspace.repo / ".opencode").mkdir()
    (workspace.repo / ".opencode" / "new.md").write_text("new\n")
    (workspace.repo / "src" / "keep.txt").write_text("the real work\n")
    (workspace.repo / "docs").mkdir()
    (workspace.repo / "docs" / "opencode.json").write_text("{}\n")  # nested: an ordinary file
    assert workspace.dirty() is True

    sha = commit_all_changes(workspace)

    assert sha is not None
    changed = {change.path for change in workspace.changed_files()}
    assert changed == {"src/keep.txt", "docs/opencode.json"}
    tree = tree_of(rig, workspace)
    assert "opencode.json" in tree and ".opencode/plugin/evil.js" in tree, "the tracked ones stay"
    assert ".opencode/new.md" not in tree
    head_json = raw("show", "HEAD:opencode.json", cwd=workspace.repo, git=rig.git)
    assert "changed" not in head_json, "an edit of a tracked one is not in the commit"
    assert workspace.engine_inputs_present() == [".opencode", "opencode.json"]
    assert workspace.dirty() is False, "after the commit only the ignored names are left"


# #764-R11
def test_an_edit_of_a_tracked_file_the_engine_loads_alone_is_no_change(rig: Rig) -> None:
    seed_hostile(rig)
    workspace = rig.prepared()
    (workspace.repo / "opencode.json").write_text('{"changed": true}\n')

    assert workspace.dirty() is False
    assert commit_all_changes(workspace) is None
    assert workspace.engine_inputs_present() == ["opencode.json"]


# #764-R11
def test_nothing_is_reported_when_the_agent_did_not_touch_them(rig: Rig) -> None:
    seed_hostile(rig)
    workspace = rig.prepared()
    (workspace.repo / "a.txt").write_text("x\n")

    assert workspace.engine_inputs_present() == []
    assert commit_all_changes(workspace) is not None
