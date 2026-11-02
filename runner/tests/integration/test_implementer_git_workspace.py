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
    assert not (repo.parent / "mirror.git" / "refs" / "heads" / BRANCH).exists()


# #762-T02
def test_the_agent_environment_has_the_identity_and_no_credential_and_no_guard(rig: Rig) -> None:
    workspace = rig.prepared()

    environment = workspace.agent_environment()

    assert environment["HOME"] == str(rig.layout.agent_home)
    assert environment["GIT_AUTHOR_NAME"] == IDENTITY.name
    assert environment["GIT_COMMITTER_EMAIL"] == IDENTITY.email
    assert all(TOKEN not in value for value in environment.values())
    assert "GIT_CONFIG_COUNT" not in environment
    assert not any("GUARD" in name or name == "GIT_CONFIG_SYSTEM" for name in environment)
    assert not (rig.base / "run" / "guard.conf").exists()
    assert not (rig.base / "run" / "system.gitconfig").exists()
    assert not (rig.base / "run" / "spool").exists()


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
    assert all(TOKEN not in value for value in workspace.agent_environment().values())


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

    report = workspace.push_all(seconds=120.0)

    tree = raw(
        "ls-tree", "-r", "--name-only", report.form_head or "", cwd=workspace.mirror, git=rig.git
    )
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
    workspace.push_all(seconds=120.0)
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
