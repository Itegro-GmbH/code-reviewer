# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Implementer's git workspace (#762): clone into a runner-owned mirror, the agent's repository
(where git is free: nothing is installed in it) and the leftover API. The final push is in
test_implementer_git_push.py.

Everything runs against a bare repository on the file system standing in for GitHub, except the
token tests, which clone and push over HTTP on loopback (`HttpOrigin`). The tests run as an ordinary
user, so "the agent" and "root" are the same user here and `AgentUser` names the current one; the
user separation itself (the uid of the processes, what the engine user can read) is proven by
tests/privileged/test_implementer_git_users.py.
"""

import os
import stat
import threading
from pathlib import Path

import pytest

from code_reviewer_runner.implementer.git_workspace import LEFTOVER_MESSAGE, GitWorkspace
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
from workspace_support import BRANCH, IDENTITY, Rig, agent_git, commit, head_of


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
    assert not (repo.parent / "reserve" / "mirror.git" / "refs" / "heads" / BRANCH).exists()


def test_nothing_is_installed_in_the_agents_repository(rig: Rig) -> None:
    workspace = rig.prepared()

    hooks = workspace.repo / ".git" / "hooks"
    assert not hooks.exists() or list(hooks.iterdir()) == []
    config = (workspace.repo / ".git" / "config").read_text()
    assert "hooksPath" not in config and "[remote" not in config


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
        workspace.prepare()

    assert refused.value.code is ErrorCode.IMPLEMENTER_CONFIG_INVALID
    assert not (rig.base / "work").exists() or not any((rig.base / "work").iterdir())


# #762-T02
def test_a_work_directory_that_is_not_empty_is_refused(rig: Rig) -> None:
    (rig.base / "work" / "repo").mkdir(parents=True)

    with pytest.raises(JobError) as refused:
        rig.workspace().prepare()

    assert refused.value.code is ErrorCode.SETUP_FAILED


def _side_repo(rig: Rig, workspace: GitWorkspace) -> Path:
    """A repository holding a branch `side` with a commit on top of the start (for merge/pick)."""
    side = rig.base / "side"
    raw("clone", "-q", str(workspace.repo), str(side), git=rig.git)
    raw("checkout", "-q", "-b", "side", cwd=side, git=rig.git)
    (side / "side.txt").write_text("s\n")
    raw("add", "-A", cwd=side, git=rig.git)
    raw("commit", "-qm", "side", cwd=side, git=rig.git)
    return side


# What the guard used to refuse is the agent's to do now.
FREE = {
    "amend": ["commit", "--amend", "-qm", "amended"],
    "reset --soft": ["reset", "-q", "--soft", "HEAD~1"],
    "reset --hard": ["reset", "-q", "--hard", "HEAD~1"],
    "reset to the start": ["reset", "-q", "--hard", "{start}"],
    "rebase -f": ["rebase", "-q", "-f", "{start}"],
    "branch": ["branch", "other"],
    "tag": ["tag", "v1"],
    "annotated tag": ["tag", "-a", "-m", "t", "v2"],
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
    "delete another branch": ["branch", "-D", "main"],
    "notes": ["notes", "add", "-m", "n"],
    "stash": ["stash", "list"],
    "config": ["config", "user.name", "Somebody Else"],
    "hooks off": ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-qm", "h"],
    "empty commit": ["commit", "--allow-empty", "-qm", "e"],
    "revert": ["revert", "--no-edit", "HEAD"],
    "merge a new commit": ["merge", "-q", "--no-edit", "--allow-unrelated-histories", "side"],
}


# The owner's decision: inside its workspace the agent may do anything with git.
@pytest.mark.parametrize("name", sorted(FREE))
def test_git_is_free_inside_the_workspace(rig: Rig, name: str) -> None:
    workspace = rig.prepared()
    commit(workspace, "c1.txt")
    commit(workspace, "c2.txt")
    side = _side_repo(rig, workspace)
    assert agent_git(workspace, "fetch", "-q", str(side), "side:side").returncode == 0
    arguments = [
        part.format(start=workspace.start_commit, branch=BRANCH, wt=rig.base / "wt")
        for part in FREE[name]
    ]

    done = agent_git(workspace, *arguments)

    assert done.returncode == 0, f"{name}: {done.stderr}"


def test_stash_and_fetch_work(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / "README.md").write_text("changed\n")

    assert agent_git(workspace, "stash").returncode == 0
    assert agent_git(workspace, "stash", "pop").returncode == 0
    assert agent_git(workspace, "fetch", str(rig.origin.path), "main").returncode == 0


def test_the_agent_has_no_way_to_push(rig: Rig) -> None:
    workspace = rig.prepared()
    commit_here = agent_git(workspace, "commit", "--allow-empty", "-qm", "c")
    assert commit_here.returncode == 0

    plain = agent_git(workspace, "push")
    named = agent_git(workspace, "push", "origin", BRANCH)

    assert plain.returncode != 0 and named.returncode != 0
    assert rig.origin.tip(BRANCH) is None


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


# #762-T08
def test_commit_all_of_a_clean_tree_commits_nothing(rig: Rig) -> None:
    workspace = rig.prepared()

    assert workspace.commit_all() is None


# #762-T08
def test_a_local_hooks_path_of_the_agent_does_not_run_in_the_leftover_commit(rig: Rig) -> None:
    workspace = rig.prepared()
    hooks = rig.base / "agent-hooks"
    hooks.mkdir()
    marker = rig.base / "hook-ran"
    script = hooks / "pre-commit"
    script.write_text(f"#!/bin/sh\n: > {marker}\necho 'SECRET-FROM-THE-AGENT' >&2\nexit 1\n")
    script.chmod(0o755)
    raw("config", "core.hooksPath", str(hooks), cwd=workspace.repo, git=rig.git)
    (workspace.repo / "new.txt").write_text("n\n")

    sha = workspace.commit_all()

    assert sha is not None and sha == head_of(workspace)
    assert not marker.exists(), "the agent's own pre-commit ran in a call of the runner"


def test_a_leftover_commit_on_a_detached_head_gets_a_branch_of_its_own(rig: Rig) -> None:
    workspace = rig.prepared()
    assert agent_git(workspace, "checkout", "-q", "--detach").returncode == 0
    (workspace.repo / "new.txt").write_text("n\n")

    sha = workspace.commit_all()

    assert sha == head_of(workspace)
    branch = agent_git(workspace, "symbolic-ref", "--short", "HEAD")
    assert branch.returncode == 0 and branch.stdout.startswith(f"{BRANCH}-leftover-")


def test_a_leftover_commit_goes_to_the_branch_the_agent_is_on(rig: Rig) -> None:
    workspace = rig.prepared()
    assert agent_git(workspace, "checkout", "-q", "-b", "elsewhere").returncode == 0
    (workspace.repo / "new.txt").write_text("n\n")

    sha = workspace.commit_all()

    assert raw("rev-parse", "refs/heads/elsewhere", cwd=workspace.repo, git=rig.git) == sha
    assert raw("rev-parse", f"refs/heads/{BRANCH}", cwd=workspace.repo, git=rig.git) == (
        workspace.start_commit
    )


def test_a_leftover_commit_that_git_refuses_is_setup_failed_and_names_nothing_of_the_agent(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    (workspace.repo / "new.txt").write_text("n\n")
    (workspace.repo / ".git" / "index.lock").write_text("SECRET-LINE-OF-THE-AGENT")

    with pytest.raises(JobError) as refused:
        workspace.commit_all()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert "SECRET-LINE-OF-THE-AGENT" not in refused.value.detail


def test_a_status_that_fails_says_clean_and_the_leftover_is_not_tried(rig: Rig) -> None:
    workspace = rig.prepared()
    (workspace.repo / ".git" / "HEAD").write_text("garbage\n")

    assert workspace.dirty() is False


# #762-T10
def test_no_file_of_the_workspace_has_the_token_and_the_mirror_is_private(rig: Rig) -> None:
    workspace = rig.prepared()
    agent_git(workspace, "commit", "--allow-empty", "-qm", "c")

    assert files_mentioning(rig.base, TOKEN) == []
    assert stat.S_IMODE(workspace.mirror.stat().st_mode) & 0o077 == 0


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
def test_a_plain_directory_of_the_runner_is_accepted_and_made_enterable(rig: Rig) -> None:
    directory = rig.base / "work"
    directory.mkdir()
    directory.chmod(0o700)

    rig.workspace().clone_mirror()

    assert stat.S_IMODE(directory.stat().st_mode) == 0o755


# -- the repository after an environment's setup script (#818) ----------------------------------


def after_a_script(rig: Rig):
    """A prepared workspace whose repository a script has worked in: a tracked file changed, a
    file added that git does not ignore, one it does, and a folder."""
    workspace = rig.prepared()
    repo = workspace.repo
    (repo / ".gitignore").write_text("node_modules/\n")
    raw("add", ".gitignore", cwd=repo, git=rig.git)
    raw("commit", "-qm", "ignore", cwd=repo, git=rig.git)
    (repo / "README.md").write_text("changed by the script\n")
    (repo / "generated.txt").write_text("made by the script\n")
    (repo / "venv").mkdir()
    (repo / "venv" / "bin.txt").write_text("x\n")
    (repo / "node_modules").mkdir()
    (repo / "node_modules" / "pkg.js").write_text("x\n")
    return workspace


# #818-T60
def test_the_tracked_files_a_script_changed_are_put_back(rig: Rig) -> None:
    workspace = after_a_script(rig)

    restored = workspace.settle_after_setup()

    assert restored == ["README.md"] and workspace.restored_count == 1
    assert (workspace.repo / "README.md").read_text() == "# demo\n"
    assert raw("diff", "--stat", "HEAD", cwd=workspace.repo, git=rig.git) == ""


# #818-T61
def test_what_the_script_added_stays_in_the_tree_and_is_no_change_of_the_agent(rig: Rig) -> None:
    workspace = after_a_script(rig)

    workspace.settle_after_setup()

    repo = workspace.repo
    assert (repo / "generated.txt").read_text() == "made by the script\n"
    assert (repo / "venv" / "bin.txt").exists() and (repo / "node_modules" / "pkg.js").exists()
    assert workspace.dirty() is False, "the agent has changed nothing"
    assert raw("status", "--porcelain", cwd=repo, git=rig.git) == ""
    assert workspace.commit_all() is None, "the system's commit takes none of it"
    assert workspace.excluded_count == 2  # generated.txt and venv/ (node_modules/ is ignored)


# #818-T62
def test_the_agents_own_new_file_is_a_change_and_a_script_file_can_be_added_by_name(
    rig: Rig,
) -> None:
    workspace = after_a_script(rig)
    workspace.settle_after_setup()
    repo = workspace.repo

    (repo / "mine.txt").write_text("the agent's\n")
    assert workspace.dirty() is True
    sha = workspace.commit_all()
    committed = raw("show", "--name-only", "--format=", sha or "", cwd=repo, git=rig.git)
    assert committed.split() == ["mine.txt"]
    # The agent can still choose to commit a file the script made, by name.
    raw("add", "-f", "generated.txt", cwd=repo, git=rig.git)
    assert raw("diff", "--cached", "--name-only", cwd=repo, git=rig.git) == "generated.txt"


# #818-T63
def test_names_git_reads_in_a_pattern_are_kept_out_all_the_same(rig: Rig) -> None:
    workspace = rig.prepared()
    repo = workspace.repo
    odd = ["#hash.txt", "!bang.txt", "star*.txt", "q?.txt", "[br].txt", "back\\slash.txt", "tail "]
    for name in odd:
        (repo / name).write_text("x\n")

    workspace.settle_after_setup()

    assert workspace.dirty() is False
    assert workspace.commit_all() is None
    assert workspace.excluded_count == len(odd)


# #818-T64
def test_a_clean_repository_is_left_alone_and_nothing_is_written(rig: Rig) -> None:
    workspace = rig.prepared()

    assert workspace.settle_after_setup() == []

    assert workspace.restored_count == 0 and workspace.excluded_count == 0
    exclude = workspace.repo / ".git" / "info" / "exclude"
    assert "generated" not in (exclude.read_text() if exclude.exists() else "")


# #818-T65
def test_a_repository_the_script_broke_ends_the_step_with_setup_failed(rig: Rig) -> None:
    import shutil

    workspace = rig.prepared()
    shutil.rmtree(workspace.repo / ".git")

    with pytest.raises(JobError) as refused:
        workspace.settle_after_setup()
    assert refused.value.code is ErrorCode.SETUP_FAILED


# #818-T66
def test_the_patterns_are_anchored_escaped_and_leave_out_a_name_with_a_line_end() -> None:
    from code_reviewer_runner.implementer.git_workspace import exclude_patterns

    listing = b"a.txt\0dir/\0we*ird[1]\0two\nlines\0trail \0\0"

    assert exclude_patterns(listing) == [b"/a.txt", b"/dir/", b"/we\\*ird\\[1\\]", b"/trail\\ "]
