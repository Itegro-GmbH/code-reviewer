# SPDX-License-Identifier: LicenseRef-Proprietary

"""The final push of the Implementer's git workspace: git is free inside the workspace, and when
the turn ends the runner takes every local branch of the agent's repository into its own mirror and
pushes each to the provider without force, one refspec and one command per branch, so one refusal
does not stop the others. Real git, a bare repository for the provider, a plain HTTP server for the
token tests."""

import http.server
import os
import secrets
import subprocess
import threading
import tracemalloc
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer import git_workspace, push_policy
from code_reviewer_runner.implementer.git_process import Outcome
from code_reviewer_runner.implementer.git_workspace import (
    REASON_NOT_A_COMMIT,
    REASON_NOT_FAST_FORWARD,
    REASON_OUT_OF_SPACE,
    REASON_OUT_OF_TIME,
    REASON_PROVIDER_ERROR,
    REASON_PROVIDER_REFUSED,
    REASON_PROVIDER_UNAVAILABLE,
    REASON_REMOTE_REJECTED,
    REASON_TIMED_OUT,
    REASON_UNREADABLE,
    REASON_WORKFLOWS,
    DiskSpace,
    GitWorkspace,
    LeaseNotConfirmed,
    PushReport,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, HttpOrigin, raw, still_running
from workspace_support import (
    BRANCH,
    IDENTITY,
    LocalAccess,
    Rig,
    agent_environment,
    agent_git,
    commit,
    head_of,
)

SECONDS = 120.0


def push(workspace: GitWorkspace, **options: Any) -> PushReport:
    return workspace.push_all(seconds=options.pop("seconds", SECONDS), **options)


def branch(report: PushReport, name: str) -> Any:
    found = [entry for entry in report.branches if entry.name == name]
    assert len(found) == 1, [entry.name for entry in report.branches]
    return found[0]


def names(report: PushReport) -> list[str]:
    return [entry.name for entry in report.branches]


def make_branch(workspace: GitWorkspace, name: str, file: str, start: str | None = None) -> str:
    """A new local branch with one commit on it, the way the agent makes one; the branch it was on
    stays checked out afterwards."""
    here = agent_git(workspace, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    assert (
        agent_git(workspace, "checkout", "-q", "-b", name, *([start] if start else [])).returncode
        == 0
    )
    tip = commit(workspace, file)
    assert agent_git(workspace, "checkout", "-q", here).returncode == 0
    return tip


# -- the mirror has a place of its own and the fetch looks for room first -------------------------


def test_the_mirror_lives_on_the_reserve_directory_the_agent_never_sees(rig: Rig) -> None:
    workspace = rig.prepared()

    assert workspace.mirror == rig.layout.work_dir / "reserve" / "mirror.git"
    assert workspace.mirror.is_dir() and not (workspace.repo / "reserve").exists()


def test_a_mirror_without_room_takes_nothing_over_and_every_branch_says_so(rig: Rig) -> None:
    space: list[DiskSpace] = [DiskSpace(free_bytes=10 * 1024**3, free_inodes=10**6)]
    workspace = rig.prepared(space=lambda path: space[0])
    commit(workspace, "a.txt")
    make_branch(workspace, "experiment/two", "b.txt", start=workspace.start_commit)
    space[0] = DiskSpace(free_bytes=1024, free_inodes=10**6)  # the disk filled up meanwhile

    report = push(workspace)

    assert report.listed and not report.pushed_any
    assert {(entry.name, entry.reason) for entry in report.branches} == {
        (BRANCH, REASON_OUT_OF_SPACE),
        ("experiment/two", REASON_OUT_OF_SPACE),
    }
    assert rig.origin.tip(BRANCH) is None, "nothing reached the provider"
    assert not (workspace.mirror / "refs" / "runner").exists(), "nothing was taken over"


def test_inodes_count_as_room_too(rig: Rig) -> None:
    workspace = rig.prepared(space=lambda path: DiskSpace(free_bytes=10 * 1024**3, free_inodes=5))
    commit(workspace, "a.txt")

    report = push(workspace)

    assert branch(report, BRANCH).reason == REASON_OUT_OF_SPACE


def test_a_fetch_that_fails_with_the_disk_gone_is_out_of_space_and_not_unreadable(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    free = [10 * 1024**3]
    workspace = rig.prepared(space=lambda path: DiskSpace(free_bytes=free[0], free_inodes=10**6))
    commit(workspace, "a.txt")
    real = GitWorkspace._mirror  # pyright: ignore[reportPrivateUsage]

    def mirror(self: GitWorkspace, args: list[str], **options: Any) -> Outcome:
        done = real(self, args, **options)
        if "fetch" in args:
            free[0] = 1024  # the disk filled while the fetch ran
            return Outcome(128, "", "fatal: write error: No space left on device")
        return done

    monkeypatch.setattr(GitWorkspace, "_mirror", mirror)

    report = push(workspace)

    assert branch(report, BRANCH).reason == REASON_OUT_OF_SPACE


def test_with_room_the_check_changes_nothing(rig: Rig) -> None:
    workspace = rig.prepared(
        space=lambda path: DiskSpace(free_bytes=10 * 1024**3, free_inodes=10**6)
    )
    tip = commit(workspace, "a.txt")

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == tip and branch(report, BRANCH).pushed


# -- every local branch is pushed, git is free ----------------------------------------------------


def test_the_form_branch_is_pushed_and_reported(rig: Rig) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == tip
    assert report.pushed_any and report.form_head == tip and report.listed
    entry = branch(report, BRANCH)
    assert (entry.head, entry.pushed, entry.reason) == (tip, True, None)


def test_amend_reset_and_rebase_of_the_agents_own_branch_all_arrive(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    commit(workspace, "b.txt")
    first = head_of(workspace, "HEAD~1")
    assert agent_git(workspace, "commit", "--amend", "-qm", "amended").returncode == 0
    assert agent_git(workspace, "reset", "-q", "--soft", "HEAD~1").returncode == 0
    assert agent_git(workspace, "commit", "-qm", "squashed").returncode == 0
    rebased = agent_git(workspace, "rebase", "-q", "--onto", workspace.start_commit, first)
    assert rebased.returncode == 0, rebased.stderr
    tip = head_of(workspace)
    assert tip != first

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == tip
    assert branch(report, BRANCH).pushed


def test_a_branch_the_agent_created_arrives_with_the_form_branch(rig: Rig) -> None:
    workspace = rig.prepared()
    form = commit(workspace, "a.txt")
    other = make_branch(workspace, "experiment/two", "b.txt", start=workspace.start_commit)

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == form
    assert rig.origin.tip("experiment/two") == other
    assert names(report) == [BRANCH, "experiment/two"]
    assert all(entry.pushed for entry in report.branches)


def test_a_turn_that_worked_only_on_another_branch_still_pushes_it(rig: Rig) -> None:
    workspace = rig.prepared()
    other = make_branch(workspace, "elsewhere", "b.txt", start=workspace.start_commit)

    report = push(workspace)

    assert rig.origin.tip("elsewhere") == other
    assert rig.origin.tip(BRANCH) is None
    assert names(report) == ["elsewhere"]
    assert report.form_head is None


def test_the_base_branch_moved_forward_by_the_agent_is_pushed_too(rig: Rig) -> None:
    # The risk the owner accepted: no rule about which branch, so the default branch moves.
    workspace = rig.prepared()
    assert agent_git(workspace, "checkout", "-q", "main").returncode == 0
    tip = commit(workspace, "on-main.txt")

    report = push(workspace)

    assert rig.origin.tip("main") == tip
    assert branch(report, "main").pushed


def test_a_hook_the_agent_wrote_and_a_bypass_of_hooks_change_nothing(
    rig: Rig, tmp_path: Path
) -> None:
    workspace = rig.prepared()
    hooks = workspace.repo / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    (hooks / "reference-transaction").write_text("#!/bin/sh\nexit 1\n")
    (hooks / "reference-transaction").chmod(0o755)
    (workspace.repo / "a.txt").write_text("a\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    done = agent_git(workspace, "-c", "core.hooksPath=/dev/null", "commit", "-qm", "x")
    assert done.returncode == 0, done.stderr
    tip = head_of(workspace)

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == tip and branch(report, BRANCH).pushed


def test_a_branch_with_nothing_new_is_not_pushed_and_not_reported(rig: Rig) -> None:
    workspace = rig.prepared()
    assert agent_git(workspace, "branch", "same-as-start").returncode == 0

    report = push(workspace)

    assert report.branches == () and not report.pushed_any and report.listed
    assert rig.origin.tip(BRANCH) is None and rig.origin.tip("same-as-start") is None
    assert rig.origin.branches() == ["refs/heads/main"]


def test_tags_and_notes_are_never_pushed(rig: Rig) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    assert agent_git(workspace, "tag", "-a", "-m", "t", "v1", tip).returncode == 0
    assert agent_git(workspace, "tag", "light").returncode == 0
    assert agent_git(workspace, "notes", "add", "-m", "note").returncode == 0

    push(workspace)

    assert rig.origin.branches() == [f"refs/heads/{BRANCH}", "refs/heads/main"]


def test_nothing_is_ever_deleted_on_the_provider(rig: Rig) -> None:
    rig.origin.commit_on("keep", "kept.txt")
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    assert agent_git(workspace, "branch", "-q", "doomed", workspace.start_commit).returncode == 0
    assert agent_git(workspace, "branch", "-q", "-D", "doomed").returncode == 0

    push(workspace)

    assert "refs/heads/keep" in rig.origin.branches()
    assert "refs/heads/main" in rig.origin.branches()


def test_every_push_names_one_ref_without_a_plus_and_without_force_or_mirror_flags(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    make_branch(workspace, "two", "b.txt", start=workspace.start_commit)
    seen: list[list[str]] = []
    real = workspace._mirror  # pyright: ignore[reportPrivateUsage]

    def mirror(args: list[str], **options: Any) -> Outcome:
        seen.append(list(args))
        return real(args, **options)

    monkeypatch.setattr(workspace, "_mirror", mirror)

    push(workspace)

    pushes = [args for args in seen if "push" in args]
    assert len(pushes) == 2
    for args in pushes:
        words = args[args.index("push") :]
        assert words[:2] == ["push", "--porcelain"]
        assert len(words) == 4, "push, --porcelain, the url, one refspec"
        refspec = words[3]
        assert refspec.startswith("refs/runner/in/") and ":refs/heads/" in refspec
        assert not any(word.startswith("+") for word in words[2:])
        for flag in ("--force", "-f", "--mirror", "--all", "--tags", "--delete", "--prune"):
            assert flag not in words
    for args in seen:
        assert not any(word.startswith("+refs/heads") and "push" in args for word in args)


# -- a rewrite of what is already on the provider is rejected, per branch --------------------------


def test_a_rewritten_branch_that_is_already_on_the_provider_is_rejected_and_the_others_arrive(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    form = commit(workspace, "a.txt")
    # `main` is on the provider at the start commit; the agent replaces it with unrelated history.
    assert agent_git(workspace, "checkout", "-q", "--orphan", "rewritten").returncode == 0
    assert agent_git(workspace, "rm", "-rfq", "--cached", ".").returncode == 0
    commit(workspace, "fresh.txt")
    assert agent_git(workspace, "branch", "-q", "-M", "main").returncode == 0
    before = rig.origin.tip("main")

    report = push(workspace)

    assert rig.origin.tip("main") == before, "no force: the provider's branch did not move"
    main = branch(report, "main")
    assert (main.pushed, main.reason) == (False, REASON_NOT_FAST_FORWARD)
    assert rig.origin.tip(BRANCH) == form and branch(report, BRANCH).pushed


def test_a_form_branch_that_exists_on_the_provider_with_other_history_is_rejected(rig: Rig) -> None:
    rig.origin.commit_on(BRANCH, "someone-else.txt")
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    other = make_branch(workspace, "second", "b.txt", start=workspace.start_commit)
    taken = rig.origin.tip(BRANCH)

    report = push(workspace)

    entry = branch(report, BRANCH)
    assert (entry.pushed, entry.reason) == (False, REASON_NOT_FAST_FORWARD)
    assert rig.origin.tip(BRANCH) == taken
    assert rig.origin.tip("second") == other and report.form_head is not None


def test_a_refusal_of_one_branch_does_not_stop_the_others(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    make_branch(workspace, "wf", "w.txt", start=workspace.start_commit)
    make_branch(workspace, "zz", "z.txt", start=workspace.start_commit)
    rig.origin.reject_ref_with_hook(
        "refs/heads/wf",
        "refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml`",
    )

    report = push(workspace)

    assert (branch(report, "wf").pushed, branch(report, "wf").reason) == (False, REASON_WORKFLOWS)
    assert branch(report, BRANCH).pushed and branch(report, "zz").pushed
    assert rig.origin.tip("wf") is None and rig.origin.tip("zz") is not None


def test_a_refusal_with_another_reason_is_remote_rejected(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    rig.origin.reject_with_hook("protected branch hook declined")

    report = push(workspace)

    assert (branch(report, BRANCH).pushed, branch(report, BRANCH).reason) == (
        False,
        REASON_REMOTE_REJECTED,
    )
    assert not report.pushed_any


# -- the names are the agent's: nothing a name holds becomes an option, a refspec or a command -----


@pytest.mark.parametrize(
    "name",
    [
        "a;touch${IFS}pwned",
        "$(touch${IFS}pwned)",
        "`touch${IFS}pwned`",
        "x'y",
        'q"q',
        "a&b",
        "a|b",
        "a>b",
        "a$IFS",
    ],
)
def test_a_branch_name_with_shell_characters_is_pushed_as_a_name_and_runs_nothing(
    rig: Rig, tmp_path: Path, name: str
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    done = agent_git(workspace, "branch", name, workspace.start_commit)
    assert done.returncode == 0, done.stderr
    assert agent_git(workspace, "checkout", "-q", name).returncode == 0
    tip = commit(workspace, "b.txt")
    assert agent_git(workspace, "checkout", "-q", BRANCH).returncode == 0
    marker = rig.base / "pwned"

    report = push(workspace)

    assert rig.origin.tip(name) == tip and branch(report, name).pushed
    assert not marker.exists() and not (Path.cwd() / "pwned").exists()
    assert not (tmp_path / "pwned").exists()


HOSTILE_REFS = ["--force", "--delete", "+x", "-x", "HEAD"]


@pytest.mark.parametrize("ref", HOSTILE_REFS)
def test_a_ref_name_that_is_no_branch_name_is_counted_and_never_given_to_git(
    rig: Rig, ref: str
) -> None:
    workspace = rig.prepared()
    form = commit(workspace, "a.txt")
    # Written by hand: `git branch` itself would refuse most of these.
    (workspace.repo / ".git" / "refs" / "heads" / ref).write_text(form + "\n")

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == form
    assert rig.origin.branches() == [f"refs/heads/{BRANCH}", "refs/heads/main"]
    assert report.invalid == 1
    assert [entry.name for entry in report.branches if entry.name.startswith(("-", "+"))] == []


def test_a_ref_file_whose_name_holds_a_line_break_makes_no_branch(rig: Rig) -> None:
    workspace = rig.prepared()
    form = commit(workspace, "a.txt")
    heads = workspace.repo / ".git" / "refs" / "heads"
    (heads / f"evil\n{form}\trefs-heads-forged").write_text(form + "\n")
    (heads / "evil\u2028name").write_text(form + "\n")

    report = push(workspace)

    assert rig.origin.branches() == [f"refs/heads/{BRANCH}", "refs/heads/main"]
    assert branch(report, BRANCH).pushed
    assert not [entry for entry in report.branches if "\n" in entry.name or "\u2028" in entry.name]


# -- the runner never runs what the agent's repository configures --------------------------------


def test_the_runner_never_executes_the_config_hooks_or_filters_of_the_agent_repository(
    rig: Rig, tmp_path: Path
) -> None:
    workspace = rig.prepared()
    marker = tmp_path / "marker"
    script = tmp_path / "trap.sh"
    script.write_text(f"#!/bin/sh\ntouch {marker}\nexit 0\n")
    script.chmod(0o755)
    config = workspace.repo / ".git" / "config"
    config.write_text(
        config.read_text()
        + f"[core]\n\tfsmonitor = {script}\n\tsshCommand = {script}\n\tpager = {script}\n"
        + f"\teditor = {script}\n\thooksPath = {tmp_path}\n"
        + f"[alias]\n\tstatus = !{script}\n\tfetch = !{script}\n\tpush = !{script}\n"
        + f"[uploadpack]\n\tpackObjectsHook = {script}\n"
        + f'[filter "trap"]\n\tclean = {script}\n\tsmudge = {script}\n'
        + f"[diff]\n\texternal = {script}\n"
        + f"[credential]\n\thelper = {script}\n"
        + "[gc]\n\tauto = 1\n[receive]\n\tfsckObjects = true\n"
        + "[safe]\n\tdirectory = *\n"
    )
    hooks = workspace.repo / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    for hook in (
        "pre-push",
        "post-checkout",
        "reference-transaction",
        "pre-auto-gc",
        "post-commit",
    ):
        (hooks / hook).write_bytes(script.read_bytes())
        (hooks / hook).chmod(0o755)
    (workspace.repo / ".gitattributes").write_text("* filter=trap\n")
    (workspace.repo / "a.txt").write_text("a\n")
    environment = agent_environment(rig.home, rig.git)
    for arguments in (["add", "-A"], ["commit", "-qm", "x", "--no-verify"]):
        subprocess.run(
            [
                rig.git,
                "-c",
                "core.fsmonitor=false",
                "-c",
                "filter.trap.clean=cat",
                "-c",
                "filter.trap.smudge=cat",
                "-c",
                "core.hooksPath=/dev/null",
                *arguments,
            ],
            cwd=workspace.repo,
            env=environment,
            check=True,
            capture_output=True,
        )
    tip = head_of(workspace)
    marker.unlink(missing_ok=True)

    report = push(workspace)

    assert branch(report, BRANCH).head == tip and rig.origin.tip(BRANCH) == tip
    assert not marker.exists(), "a root operation ran something the agent configured"


def test_root_never_gets_the_agents_repository_as_its_directory_or_git_dir(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    make_branch(workspace, "two", "b.txt", start=workspace.start_commit)
    calls: list[tuple[list[str], str, dict[str, Any]]] = []
    real = git_workspace.GitProcess.run

    def run(
        self: Any, args: Any, *, env: Any, cwd: Any = "/", spawn: Any = None, **rest: Any
    ) -> Any:
        calls.append((list(args), str(cwd), dict(spawn or {})))
        return real(self, args, env=env, cwd=cwd, spawn=spawn, **rest)

    monkeypatch.setattr(git_workspace.GitProcess, "run", run)

    push(workspace)

    repo = str(workspace.repo)
    assert calls
    for args, cwd, _ in calls:
        assert not cwd.startswith(repo), f"git ran with the agent's repository as directory: {args}"
        assert "--git-dir" not in args or args[args.index("--git-dir") + 1] == str(workspace.mirror)
        assert "-C" not in args
        if repo in args:
            # The repository is only a remote, read by an upload-pack named on the command line.
            assert args[0] in ("ls-remote", "-c", "--git-dir")
            assert any(word.startswith("--upload-pack=") for word in args)
            assert not any(word.startswith("safe.directory") for word in args)


def test_a_fetch_from_a_tip_with_objects_that_fail_the_fsck_is_refused_per_branch(
    rig: Rig, tmp_path: Path
) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    blob_file = tmp_path / "blob"
    blob_file.write_text("x\n")
    blob = raw("hash-object", "-w", str(blob_file), cwd=workspace.repo, git=rig.git)
    tree_file = tmp_path / "tree"
    tree_file.write_bytes((b"100644 dup\0" + bytes.fromhex(blob)) * 2)  # two entries, one name
    tree = raw(
        "hash-object", "-w", "--literally", "-t", "tree", str(tree_file),
        cwd=workspace.repo, git=rig.git,
    )  # fmt: skip
    person = {
        "GIT_AUTHOR_NAME": IDENTITY.name,
        "GIT_AUTHOR_EMAIL": IDENTITY.email,
        "GIT_COMMITTER_NAME": IDENTITY.name,
        "GIT_COMMITTER_EMAIL": IDENTITY.email,
    }
    bad = raw(
        "commit-tree", tree, "-p", good, "-m", "bad", cwd=workspace.repo, git=rig.git, **person
    )
    assert agent_git(workspace, "update-ref", "refs/heads/broken", bad).returncode == 0

    report = push(workspace)

    assert (branch(report, "broken").pushed, branch(report, "broken").reason) == (
        False,
        REASON_UNREADABLE,
    )
    assert rig.origin.tip("broken") is None and rig.origin.tip(BRANCH) == good


def test_a_branch_that_points_at_a_tree_or_an_annotated_tag_is_not_pushed(rig: Rig) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    tree = raw("rev-parse", "HEAD^{tree}", cwd=workspace.repo, git=rig.git)
    assert agent_git(workspace, "tag", "-a", "-m", "t", "tagged", good).returncode == 0
    tag = raw("rev-parse", "refs/tags/tagged", cwd=workspace.repo, git=rig.git)
    (workspace.repo / ".git" / "refs" / "heads" / "on-tree").write_text(tree + "\n")
    (workspace.repo / ".git" / "refs" / "heads" / "on-tag").write_text(tag + "\n")

    report = push(workspace)

    for name in ("on-tree", "on-tag"):
        assert (branch(report, name).pushed, branch(report, name).reason) == (
            False,
            REASON_NOT_A_COMMIT,
        )
        assert rig.origin.tip(name) is None
    assert rig.origin.tip(BRANCH) == good


# -- the provider, the token and the clock ------------------------------------------------------


def test_a_failed_push_never_names_the_token(rig: Rig) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git=git)
        workspace.clone_mirror()
        server.token = "ghs_something-else-token-0123456789"  # the credential stops working
        workspace.create_agent_repository()
        commit(workspace, "a.txt")

        report = push(workspace)

    entry = branch(report, BRANCH)
    assert (entry.pushed, entry.reason) == (False, REASON_PROVIDER_REFUSED)
    assert TOKEN not in repr(report)


def test_a_push_over_http_authenticates_with_the_token_and_not_in_argv(rig: Rig) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git=git)
        workspace.clone_mirror()
        workspace.create_agent_repository()
        tip = commit(workspace, "a.txt")

        push(workspace)

    assert rig.origin.tip(BRANCH) == tip
    assert all(header is not None for _, header in server.requests)


def test_a_redirect_of_the_provider_is_not_followed_and_the_token_does_not_go_with_it(
    rig: Rig,
) -> None:
    seen: list[str | None] = []

    class Sink(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

        def do_GET(self) -> None:
            seen.append(self.headers.get("Authorization"))
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    sink = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink)
    target = (
        f"http://127.0.0.1:{sink.server_address[1]}/elsewhere.git/info/refs?service=git-upload-pack"
    )

    class Redirect(http.server.BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:
            return

        def do_GET(self) -> None:
            self.send_response(302)
            self.send_header("Location", target)
            self.send_header("Content-Length", "0")
            self.end_headers()

    redirector = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
    threads = [
        threading.Thread(target=server.serve_forever, daemon=True) for server in (sink, redirector)
    ]
    for thread in threads:
        thread.start()
    try:
        workspace = rig.workspace(
            url=f"http://127.0.0.1:{redirector.server_address[1]}/origin.git",
            schemes=("http",),
            git="/usr/bin/git",
        )
        with pytest.raises(JobError) as failed:
            workspace.clone_mirror()
    finally:
        for server in (sink, redirector):
            server.shutdown()
            server.server_close()

    assert failed.value.code is ErrorCode.CLONE_FAILED
    assert seen == [], "git followed the redirect and sent its request, with the token, elsewhere"
    assert TOKEN not in str(failed.value)


def fail_pushes(
    workspace: GitWorkspace,
    monkeypatch: pytest.MonkeyPatch,
    text: str,
    times: int = 1,
    *,
    stdout: str = "",
    unanswered: bool = False,
) -> list[int]:
    """The next `times` pushes of the mirror to the provider fail with this report of git (`text`
    on standard error, `stdout` the porcelain lines of the refs)."""
    real = workspace._mirror  # pyright: ignore[reportPrivateUsage]
    failed: list[int] = []

    def mirror(args: list[str], **options: Any) -> Outcome:
        if "push" in args and len(failed) < times:
            failed.append(1)
            return Outcome(255 if unanswered else 1 if stdout else 128, stdout, text, unanswered)
        return real(args, **options)

    monkeypatch.setattr(workspace, "_mirror", mirror)
    return failed


@pytest.fixture
def quick(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(git_workspace, "TRANSIENT_PAUSE_SECONDS", 0.0)


TRANSIENT_TEXTS = [
    "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 502",
    "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 503",
    "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 429",
    "fatal: unable to access 'https://x/r.git/': Recv failure: Connection reset by peer",
    "fatal: unable to access 'https://x/r.git/': Could not resolve host: x",
    "send-pack: unexpected disconnect while reading sideband packet",
    "error: cannot open '/work/mirror.git/FETCH_HEAD': Permission denied",
]


@pytest.mark.usefixtures("quick")
@pytest.mark.parametrize("text", TRANSIENT_TEXTS)
def test_a_push_the_provider_could_not_take_is_tried_once_more_and_then_works(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, text: str
) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    failed = fail_pushes(workspace, monkeypatch, text)

    report = push(workspace)

    assert failed == [1]
    assert rig.origin.tip(BRANCH) == tip and branch(report, BRANCH).pushed


@pytest.mark.usefixtures("quick")
def test_a_provider_that_never_takes_the_push_is_provider_unavailable_for_that_branch(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, TRANSIENT_TEXTS[1], times=5)

    report = push(workspace)

    entry = branch(report, BRANCH)
    assert (entry.pushed, entry.reason) == (False, REASON_PROVIDER_UNAVAILABLE)
    assert rig.origin.tip(BRANCH) is None


@pytest.mark.parametrize(
    "text",
    [
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 403",
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 401",
        "remote: Repository not found.\nfatal: ... The requested URL returned error: 404",
        "remote: Permission to acme/widgets.git denied to bot.\n"
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 403",
    ],
)
def test_a_client_error_of_the_provider_is_a_refusal_and_is_not_tried_again(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, text: str
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    failed = fail_pushes(workspace, monkeypatch, text, times=5)

    report = push(workspace)

    assert failed == [1]
    assert branch(report, BRANCH).reason == REASON_PROVIDER_REFUSED


@pytest.mark.usefixtures("quick")
@pytest.mark.parametrize("reason", ["internal error", "failed to update ref", "Internal Error"])
def test_a_remote_rejection_that_says_the_provider_failed_is_tried_again(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    line = f"!\trefs/runner/in/0:refs/heads/{BRANCH}\t[remote rejected] ({reason})\nDone\n"
    fail_pushes(workspace, monkeypatch, "error: failed to push some refs", stdout=line)

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == tip and branch(report, BRANCH).pushed


@pytest.mark.parametrize(
    "reason",
    ["pre-receive hook declined", "protected branch hook declined", "cannot lock ref"],
)
def test_a_remote_rejection_with_a_real_reason_is_not_tried_again(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    line = f"!\trefs/runner/in/0:refs/heads/{BRANCH}\t[remote rejected] ({reason})\nDone\n"
    failed = fail_pushes(workspace, monkeypatch, "error: failed to push", stdout=line, times=5)

    report = push(workspace)

    assert failed == [1] and branch(report, BRANCH).reason == REASON_REMOTE_REJECTED


def test_one_hard_line_among_hiccups_is_a_refusal(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    lines = (
        f"!\trefs/runner/in/0:refs/heads/{BRANCH}\t[remote rejected] (internal error)\n"
        f"!\trefs/runner/in/0:refs/heads/{BRANCH}\t[remote rejected] (pre-receive hook declined)\n"
    )
    fail_pushes(workspace, monkeypatch, "error: failed to push", stdout=lines, times=5)

    assert branch(push(workspace), BRANCH).reason == REASON_REMOTE_REJECTED


# -- the clock and the lease ----------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


def with_gate(
    rig: Rig, answers: list[str], clock: Clock | None = None
) -> tuple[GitWorkspace, list[str]]:
    """A workspace whose lease gate gives these answers in turn ("held", "lost", "unconfirmed"; the
    last one repeats), and the list of the answers it was asked for."""
    asked: list[str] = []
    clock = clock or Clock()

    def gate() -> None:
        answer = answers[min(len(asked), len(answers) - 1)]
        asked.append(answer)
        if answer == "lost":
            raise JobError(ErrorCode.LEASE_LOST, "the job is no longer held by this runner")
        if answer == "unconfirmed":
            raise LeaseNotConfirmed

    workspace = GitWorkspace(
        git_workspace.WorkspaceSpec(rig.origin.url, TOKEN, "main", BRANCH),
        rig.layout,
        IDENTITY,
        LocalAccess(rig.layout.work_dir / "repo", rig.git, rig.home),
        git=rig.git,
        schemes=("file",),
        before_push=gate,
        clock=clock,
        sleep=clock.sleep,
    )
    workspace.prepare()
    return workspace, asked


def test_the_lease_is_asked_before_the_listing_and_before_every_push(rig: Rig) -> None:
    workspace, asked = with_gate(rig, ["held"])
    commit(workspace, "a.txt")
    make_branch(workspace, "two", "b.txt", start=workspace.start_commit)

    push(workspace)

    assert asked == ["held", "held", "held"]


def test_a_lost_lease_pushes_nothing_and_reads_nothing(rig: Rig) -> None:
    workspace, asked = with_gate(rig, ["lost"])
    commit(workspace, "a.txt")

    with pytest.raises(JobError) as ended:
        push(workspace)

    assert ended.value.code is ErrorCode.LEASE_LOST and asked == ["lost"]
    assert rig.origin.tip(BRANCH) is None
    assert workspace.push_report().branches == ()


def test_a_lease_lost_between_two_branches_keeps_the_first_and_stops_before_the_second(
    rig: Rig,
) -> None:
    workspace, _ = with_gate(rig, ["held", "held", "lost"])
    form = commit(workspace, "a.txt")
    make_branch(workspace, "two", "b.txt", start=workspace.start_commit)

    with pytest.raises(JobError) as ended:
        push(workspace)

    assert ended.value.code is ErrorCode.LEASE_LOST
    assert rig.origin.tip(BRANCH) == form and rig.origin.tip("two") is None
    assert names(workspace.push_report()) == [BRANCH]


def test_an_unconfirmed_lease_is_asked_again_and_the_push_goes_when_it_is_confirmed(
    rig: Rig,
) -> None:
    clock = Clock()
    workspace, asked = with_gate(rig, ["unconfirmed", "unconfirmed", "held"], clock)
    tip = commit(workspace, "a.txt")

    report = push(workspace, confirm_seconds=30.0, confirm_pause=2.0)

    assert asked[:3] == ["unconfirmed", "unconfirmed", "held"]
    assert clock.slept[:2] == [2.0, 2.0]
    assert rig.origin.tip(BRANCH) == tip and branch(report, BRANCH).pushed


def test_a_lease_that_stays_unconfirmed_ends_the_turn_lease_lost_after_its_window(rig: Rig) -> None:
    clock = Clock()
    workspace, asked = with_gate(rig, ["unconfirmed"], clock)
    commit(workspace, "a.txt")

    with pytest.raises(JobError) as ended:
        push(workspace, confirm_seconds=10.0, confirm_pause=2.0)

    assert ended.value.code is ErrorCode.LEASE_LOST
    assert 10.0 <= sum(clock.slept) <= 12.0 and len(asked) >= 5
    assert rig.origin.tip(BRANCH) is None


def test_branches_after_the_time_is_up_are_rejected_out_of_time_and_nothing_is_pushed_late(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    make_branch(workspace, "two", "b.txt", start=workspace.start_commit)

    report = push(workspace, seconds=0.0)

    assert [(entry.name, entry.reason) for entry in report.branches] == [
        (BRANCH, REASON_OUT_OF_TIME),
        ("two", REASON_OUT_OF_TIME),
    ], "the base branch, still at the start commit, is not among them"
    assert rig.origin.branches() == ["refs/heads/main"]


# -- the rule that may come later is in one place -------------------------------------------------


def test_an_excluded_branch_is_not_pushed_and_is_reported_as_rejected(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(push_policy, "PUSH_EXCLUDED_BRANCHES", frozenset({"secret-branch"}))
    workspace = rig.prepared()
    form = commit(workspace, "a.txt")
    make_branch(workspace, "secret-branch", "s.txt", start=workspace.start_commit)

    report = push(workspace)

    entry = branch(report, "secret-branch")
    assert (entry.pushed, entry.reason) == (False, push_policy.REASON_EXCLUDED)
    assert rig.origin.tip("secret-branch") is None and rig.origin.tip(BRANCH) == form


def test_more_branches_than_the_limit_are_cut_and_counted(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(push_policy, "MAX_PUSHED_BRANCHES", 2)
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    for number in range(3):
        make_branch(workspace, f"b{number}", f"f{number}.txt", start=workspace.start_commit)

    report = push(workspace)

    assert names(report) == [BRANCH, "b0"] and report.overflow == 2


# -- the mirror ---------------------------------------------------------------------------------


def hanging_git(tmp_path: Path, real: str, mirror: Path, flag: Path, marker: str) -> str:
    """A `git` that, while `flag` exists, takes a lock in the mirror when it fetches and then hangs
    in a child of its own (a killed fetch leaves exactly this behind). Returns its path."""
    lock = mirror / "refs" / "runner" / "in" / "0.lock"
    directory = tmp_path / "wrapper"
    directory.mkdir()
    script = directory / "git"
    script.write_text(
        "#!/bin/sh\n"
        f'if [ -e "{flag}" ]; then\n'
        '  case " $* " in *" fetch "*)\n'
        f'    mkdir -p "{lock.parent}" && : > "{lock}"\n'
        f"    sleep {marker} &\n"
        "    wait ;;\n"
        "  esac\n"
        "fi\n"
        f'exec "{real}" "$@"\n'
    )
    script.chmod(0o755)
    return str(script)


def test_a_fetch_killed_at_the_timeout_rejects_that_branch_and_leaves_no_lock_or_child(
    rig: Rig, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(git_workspace, "FETCH_TIMEOUT", 2.0)
    flag = tmp_path / "hang"
    marker = f"{secrets.randbelow(9000) + 1000}.{secrets.randbelow(900) + 100}"
    mirror = rig.base / "work" / "reserve" / "mirror.git"
    wrapper = hanging_git(tmp_path, rig.git, mirror, flag, marker)
    workspace = rig.workspace(git=wrapper, timeout=3)
    workspace.prepare()
    tip = commit(workspace, "a.txt")
    flag.touch()

    report = push(workspace)

    assert (branch(report, BRANCH).pushed, branch(report, BRANCH).reason) == (
        False,
        REASON_TIMED_OUT,
    )
    lock = mirror / "refs" / "runner" / "in" / "0.lock"
    assert lock.exists(), "the killed fetch left its lock (the test's premise)"
    assert still_running(f"sleep {marker}") == [], "the timeout left a child behind"
    flag.unlink()

    report = push(workspace)

    assert rig.origin.tip(BRANCH) == tip and branch(report, BRANCH).pushed
    assert not lock.exists()


def test_a_repository_the_agent_made_unreadable_ends_quickly_and_leaves_nothing_running(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(git_workspace, "LIST_TIMEOUT", 2.0)
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    head = workspace.repo / ".git" / "HEAD"
    saved = head.read_text()
    head.unlink()
    os.mkfifo(head)

    report = push(workspace)

    assert report.listed is False and report.branches == ()
    assert rig.origin.tip(BRANCH) is None
    assert still_running("upload-pack", str(workspace.repo)) == []
    head.unlink()
    head.write_text(saved)
    assert push(workspace).listed and rig.origin.tip(BRANCH) == tip


def test_a_stale_lock_in_the_mirror_does_not_stop_the_push(rig: Rig) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    lock = workspace.mirror / "refs" / "runner" / "in" / "0.lock"
    lock.parent.mkdir(parents=True)
    lock.write_text("")
    (workspace.mirror / "shallow.lock").write_text("")

    push(workspace)

    assert rig.origin.tip(BRANCH) == tip


def test_binary_and_large_commits_are_pushed_and_the_shallow_mirror_takes_them(rig: Rig) -> None:
    workspace = rig.prepared()
    blob = secrets.token_bytes(6 * 1024 * 1024)
    (workspace.repo / "data.bin").write_bytes(blob)
    (workspace.repo / "big.txt").write_text("line of text\n" * 200_000)
    assert agent_git(workspace, "add", "-A").returncode == 0
    assert agent_git(workspace, "commit", "-qm", "big").returncode == 0
    tip = head_of(workspace)

    report = push(workspace)

    assert branch(report, BRANCH).pushed and rig.origin.tip(BRANCH) == tip
    size = raw(
        "cat-file", "-s", f"{tip}:data.bin",
        cwd=rig.origin.seed, git=rig.git, GIT_DIR=str(rig.origin.path),
    )  # fmt: skip
    assert int(size) == len(blob)
    assert (Path(workspace.mirror) / "shallow").exists(), "the mirror is a depth 1 clone"


def test_no_background_gc_or_maintenance_is_started_in_the_mirror(rig: Rig) -> None:
    workspace = rig.prepared()
    for number in range(6):
        commit(workspace, f"c{number}.txt")

    push(workspace)

    assert still_running("gc --auto", "maintenance run --auto") == []
    for path in ("gc.pid", "gc.log"):
        assert not (workspace.mirror / path).exists()


# -- the work on a detached HEAD is not lost -----------------------------------------------------


def test_committed_work_on_a_detached_head_is_saved_on_a_branch_and_pushed(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    assert agent_git(workspace, "checkout", "-q", "--detach").returncode == 0
    detached = commit(workspace, "only-here.txt")

    saved = workspace.rescue_detached_head()

    assert saved is not None and saved.startswith(f"{BRANCH}-leftover-")
    assert workspace.checked_out == saved
    assert head_of(workspace, f"refs/heads/{saved}") == detached
    report = push(workspace)
    assert rig.origin.tip(saved) == detached and branch(report, saved).pushed


def test_a_detached_head_that_a_branch_contains_needs_no_rescue(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    assert agent_git(workspace, "checkout", "-q", "--detach").returncode == 0

    assert workspace.rescue_detached_head() is None
    assert agent_git(workspace, "branch", "--list", "*leftover*").stdout.strip() == ""
    # HEAD is on no branch: a follow-up turn has none to start on (#837).
    assert workspace.checked_out is None


def test_a_head_on_a_branch_needs_no_rescue(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")

    assert workspace.rescue_detached_head() is None
    assert workspace.checked_out == BRANCH


# #837
def test_the_branch_the_agent_switched_to_is_the_one_checked_out(rig: Rig) -> None:
    workspace = rig.prepared()
    assert agent_git(workspace, "checkout", "-q", "-b", "feature/x").returncode == 0
    commit(workspace, "a.txt")

    assert workspace.checked_out is None, "nothing was read yet"
    assert workspace.rescue_detached_head() is None
    assert workspace.checked_out == "feature/x"


def test_a_branch_name_the_runner_would_not_push_is_not_named_as_checked_out(rig: Rig) -> None:
    workspace = rig.prepared()
    # Git takes a no-break space in a name; the runner's policy does not (`push_policy`).
    assert agent_git(workspace, "checkout", "-q", "-b", "a\u00a0b").returncode == 0
    commit(workspace, "a.txt")

    assert workspace.rescue_detached_head() is None
    assert workspace.checked_out is None


# -- the agent's list of branches is read as the agent's user and with a bound ----------------


def test_a_list_of_branches_over_the_cap_is_not_read_and_says_why(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(git_workspace, "LIST_MAX_BYTES", 20_000)
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    tip = head_of(workspace)
    lines = "".join(f"{tip} refs/heads/pad/{number:06d}\n" for number in range(2_000))
    (workspace.repo / ".git" / "packed-refs").write_text(
        "# pack-refs with: peeled fully-peeled sorted \n" + lines
    )

    report = push(workspace)

    assert report.listed is False and report.list_problem == git_workspace.LIST_TOO_LARGE
    assert report.branches == () and rig.origin.tip(BRANCH) is None


def test_a_huge_list_of_branches_costs_the_runner_no_memory_beyond_the_cap(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    tip = head_of(workspace)
    with (workspace.repo / ".git" / "packed-refs").open("w") as handle:
        handle.write("# pack-refs with: peeled fully-peeled sorted \n")
        for number in range(1_200_000):  # about 70 MB
            handle.write(f"{tip} refs/heads/pad/{number:08d}\n")

    tracemalloc.start()
    try:
        report = workspace.push_all(seconds=SECONDS)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert report.list_problem == git_workspace.LIST_TOO_LARGE
    assert peak < 16 * 1024 * 1024, f"the runner held {peak} bytes of the list"
    assert still_running("for-each-ref", str(workspace.repo)) == []


def test_the_cap_does_not_touch_a_normal_list(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    for number in range(30):
        make_branch(workspace, f"extra/{number}", f"e{number}.txt", start=workspace.start_commit)

    report = push(workspace)

    assert report.listed and report.list_problem is None and len(report.branches) == 31


# -- the reason words say what happened ---------------------------------------------------------


def rejected_line(name: str, reason: str) -> str:
    return f"!\trefs/runner/in/0:refs/heads/{name}\t[remote rejected] ({reason})\nDone\n"


# #745: only git's own `[rejected]` means other history
@pytest.mark.parametrize(
    ("status", "expected"),
    [
        ("[rejected] (fetch first)", REASON_NOT_FAST_FORWARD),
        ("[rejected] (non-fast-forward)", REASON_NOT_FAST_FORWARD),
        ("[remote failure] (remote failed to report status)", REASON_REMOTE_REJECTED),
    ],
)
def test_a_refused_line_says_other_history_only_when_git_says_so(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, status: str, expected: str
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    line = f"!\trefs/runner/in/0:refs/heads/{BRANCH}\t{status}\nDone\n"
    fail_pushes(workspace, monkeypatch, "error: failed to push", stdout=line, times=5)

    assert branch(push(workspace), BRANCH).reason == expected


def test_a_branch_called_workflow_that_is_refused_for_another_reason_is_remote_rejected(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    name = "my-workflow-notes"
    workspace = rig.prepared()
    make_branch(workspace, name, "n.txt", start=workspace.start_commit)
    status = rejected_line(name, "protected branch hook declined")
    fail_pushes(
        workspace,
        monkeypatch,
        "remote: error: GH013 for refs/heads/" + name,
        stdout=status,
        times=3,
    )

    report = push(workspace)

    assert branch(report, name).reason == REASON_REMOTE_REJECTED


def test_githubs_words_for_a_workflow_file_are_found_in_the_reason_of_the_status_line(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    status = rejected_line(
        BRANCH,
        "refusing to allow a GitHub App to create or update workflow "
        "`.github/workflows/x.yml` without `workflows` permission",
    )
    fail_pushes(workspace, monkeypatch, "error: failed to push", stdout=status, times=3)

    assert branch(push(workspace), BRANCH).reason == REASON_WORKFLOWS


def test_a_server_that_says_it_on_a_remote_line_is_believed_only_at_the_start_of_the_line(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    status = rejected_line(BRANCH, "pre-receive hook declined")
    words = "refusing to allow a GitHub App to create or update workflow `x`"
    fail_pushes(workspace, monkeypatch, f"remote: {words}\n", stdout=status, times=3)
    assert branch(push(workspace), BRANCH).reason == REASON_WORKFLOWS


def test_a_workflow_sentence_inside_a_longer_remote_line_is_no_reason(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    status = rejected_line(BRANCH, "pre-receive hook declined")
    text = "remote: error: GH013: x refusing to allow a GitHub App to create or update workflow \n"
    fail_pushes(workspace, monkeypatch, text, stdout=status, times=3)

    assert branch(push(workspace), BRANCH).reason == REASON_REMOTE_REJECTED


def test_a_push_killed_at_its_time_limit_is_timed_out_not_unavailable(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    failed = fail_pushes(workspace, monkeypatch, "git push timed out", times=5, unanswered=True)

    report = push(workspace)

    assert failed == [1], "a push that was killed is not tried again"
    assert branch(report, BRANCH).reason == REASON_TIMED_OUT


def test_an_error_of_the_provider_that_is_no_refusal_of_the_access_is_provider_error(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    text = "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 413"
    failed = fail_pushes(workspace, monkeypatch, text, times=5)

    report = push(workspace)

    assert failed == [1]
    assert branch(report, BRANCH).reason == REASON_PROVIDER_ERROR


def test_the_report_says_whether_the_task_branch_is_among_the_local_branches(rig: Rig) -> None:
    workspace = rig.prepared()
    make_branch(workspace, "elsewhere", "e.txt", start=workspace.start_commit)
    assert push(workspace).form_listed is True

    assert agent_git(workspace, "checkout", "-q", "elsewhere").returncode == 0
    assert agent_git(workspace, "branch", "-D", BRANCH).returncode == 0
    report = push(workspace)

    assert report.form_listed is False and names(report) == ["elsewhere"]
