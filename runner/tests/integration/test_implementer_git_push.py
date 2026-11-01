# SPDX-License-Identifier: LicenseRef-Proprietary

"""The push side of the Implementer's git workspace (#762): the runner-owned mirror fetches the
agent's branch without force, checks that it still contains the start commit and pushes from the
mirror. The check is the guarantee; the guard hook is only the fast path (the tests that go around
the hook show it)."""

import http.server
import itertools
import os
import secrets
import subprocess
import threading
import tracemalloc
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer import git_workspace
from code_reviewer_runner.implementer.git_process import Outcome
from code_reviewer_runner.implementer.git_workspace import (
    GitWorkspace,
    PushLoop,
    PushOutcome,
    PushTransient,
    PushUnverified,
    RepositoryUnusable,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode
from git_support import TOKEN, HttpOrigin, raw, still_running
from workspace_support import (
    BRANCH,
    IDENTITY,
    Rig,
    agent_git,
)

NO_HOOKS = ("-c", "core.hooksPath=/dev/null")


def commit(workspace: GitWorkspace, name: str, content: str = "x\n") -> str:
    """A commit made the way the agent does (guard active, signals the spool)."""
    (workspace.repo / name).write_text(content)
    assert agent_git(workspace, "add", "-A").returncode == 0
    done = agent_git(workspace, "commit", "-qm", f"add {name}")
    assert done.returncode == 0, done.stderr
    return raw("rev-parse", "HEAD", cwd=workspace.repo, git=workspace.git)


def bypass(workspace: GitWorkspace, *args: str) -> None:
    """What a hostile agent can do: `-c core.hooksPath=/dev/null` takes the guard away."""
    done = agent_git(workspace, *NO_HOOKS, *args)
    assert done.returncode == 0, done.stderr


def write_ref(workspace: GitWorkspace, sha: str) -> None:
    """A hand-written ref file: `update-ref` refuses a non-commit on a branch, a file does not."""
    (workspace.repo / ".git" / "refs" / "heads" / BRANCH).write_text(sha + "\n")


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


# #762-T05
def test_a_commit_is_fetched_checked_and_pushed_and_a_second_one_follows(rig: Rig) -> None:
    workspace = rig.prepared()
    first = commit(workspace, "a.txt")

    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert result.head == first
    assert rig.origin.tip(BRANCH) == first
    assert rig.origin.tip("main") == workspace.start_commit
    second = commit(workspace, "b.txt")

    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert rig.origin.tip(BRANCH) == second
    assert workspace.pushed_tip == second


# #762-T05
def test_a_push_with_nothing_new_is_up_to_date(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    workspace.push()

    assert workspace.push().outcome is PushOutcome.UP_TO_DATE


# #762-T05
def test_pushes_are_batched_by_the_injected_interval(rig: Rig) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=120.0, clock=clock)
    assert loop.tick() is None  # nothing signalled yet

    first = commit(workspace, "a.txt")
    result = loop.tick()  # the first push is not held back
    assert result is not None and result.head == first
    second = commit(workspace, "b.txt")
    clock.now += 30
    assert loop.tick() is None, "batched: the interval has not passed"
    assert rig.origin.tip(BRANCH) == first
    clock.now += 100
    result = loop.tick()
    assert result is not None and result.head == second
    assert rig.origin.tip(BRANCH) == second
    assert loop.tick() is None


# #762-T05
def test_the_final_push_is_not_held_back_by_the_interval(rig: Rig) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=120.0, clock=clock)
    commit(workspace, "a.txt")
    assert loop.tick() is not None
    last = commit(workspace, "b.txt")

    result = loop.finish()

    assert result.outcome is PushOutcome.PUSHED
    assert rig.origin.tip(BRANCH) == last


# #762-T05
def test_a_move_of_the_branch_without_a_spool_line_is_found_by_the_poll(rig: Rig) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())
    tip = commit(workspace, "a.txt")
    workspace.spool_path.write_text("")  # the hook's hint is gone; the ref is still polled

    result = loop.tick()

    assert result is not None and result.head == tip


# #762-T06
def test_a_rewrite_of_a_pushed_commit_ends_the_turn_and_origin_keeps_the_last_good_tip(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    bypass(workspace, "commit", "--amend", "-qm", "rewritten")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) == good
    assert workspace.pushed_tip == good


# #762-T06
def test_after_a_violation_nothing_is_pushed_any_more_even_if_the_branch_looks_fine_again(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    bypass(workspace, "reset", "-q", "--hard", workspace.start_commit)
    with pytest.raises(JobError):
        workspace.push()
    bypass(workspace, "reset", "-q", "--hard", good)
    commit(workspace, "c.txt")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) == good


# #762-T06
def test_a_branch_that_no_longer_contains_the_start_is_a_violation_and_nothing_is_pushed(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    empty_tree = raw("hash-object", "-t", "tree", "/dev/null", cwd=workspace.repo, git=rig.git)
    unrelated = raw(
        "commit-tree",
        empty_tree,
        "-m",
        "unrelated",
        cwd=workspace.repo,
        git=rig.git,
        GIT_AUTHOR_NAME=IDENTITY.name,
        GIT_AUTHOR_EMAIL=IDENTITY.email,
        GIT_COMMITTER_NAME=IDENTITY.name,
        GIT_COMMITTER_EMAIL=IDENTITY.email,
    )
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", unrelated)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) is None
    assert (
        subprocess.run(
            [
                rig.git,
                "--git-dir",
                str(workspace.mirror),
                "rev-parse",
                "-q",
                "--verify",
                f"refs/heads/{BRANCH}",
            ],
            capture_output=True,
            check=False,
        ).returncode
        != 0
    ), "the mirror does not keep the rejected tip"


# #762-T06
def test_a_deleted_branch_is_a_violation(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    workspace.push()
    bypass(workspace, "checkout", "-q", "--detach")
    bypass(workspace, "branch", "-D", BRANCH)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION


# #762-T07
def test_a_branch_that_exists_on_origin_with_other_history_is_branch_exists(rig: Rig) -> None:
    workspace = rig.prepared()
    theirs = rig.origin.commit_on(BRANCH, "theirs.txt")
    commit(workspace, "a.txt")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_EXISTS
    assert rig.origin.tip(BRANCH) == theirs


# #762-T07
def test_origin_moving_on_after_our_first_push_is_a_rejected_push(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    workspace.push()
    theirs = rig.origin.commit_on(BRANCH, "theirs.txt")
    commit(workspace, "b.txt")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert rig.origin.tip(BRANCH) == theirs


# #762-T07
def test_origin_refusing_a_workflow_file_is_a_rejected_push(rig: Rig) -> None:
    workspace = rig.prepared()
    rig.origin.reject_with_hook("refusing to allow a GitHub App to create or update workflow")
    (workspace.repo / ".github" / "workflows").mkdir(parents=True)
    commit(workspace, ".github/workflows/ci.yml", "on: push\n")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert "workflow" in refused.value.detail
    assert rig.origin.tip(BRANCH) is None


# #762-T07
def test_a_failed_push_never_names_the_token(rig: Rig) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git=git)
        workspace.clone_mirror()
        server.token = "ghs_something-else-token-0123456789"  # the credential stops working
        workspace.create_agent_repository()
        workspace.install_guard()
        commit(workspace, "a.txt")

        with pytest.raises(JobError) as refused:
            workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert TOKEN not in str(refused.value)


# #762-T07
def test_a_push_over_http_authenticates_with_the_token_and_not_in_argv(rig: Rig) -> None:
    git = "/usr/bin/git"
    with HttpOrigin(rig.origin, TOKEN, git) as server:
        workspace = rig.workspace(url=server.url, schemes=("http",), git=git)
        workspace.clone_mirror()
        workspace.create_agent_repository()
        workspace.install_guard()
        tip = commit(workspace, "a.txt")

        workspace.push()

    assert rig.origin.tip(BRANCH) == tip
    assert all(header is not None for _, header in server.requests)


# #762-T12
def test_a_forged_spool_line_costs_one_verified_attempt_and_changes_no_ref(rig: Rig) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock)
    tip = commit(workspace, "a.txt")
    assert loop.tick() is not None
    before = workspace.verifications
    refs = raw("for-each-ref", cwd=workspace.mirror, git=rig.git)
    with workspace.spool_path.open("a") as spool:
        spool.write("1.0 " + "f" * 40 + "\n")
        spool.write("garbage that is not a line\n")
        spool.write("\x00\x01" * 100 + "\n")

    result = loop.tick()

    assert result is not None and result.outcome is PushOutcome.UP_TO_DATE
    assert workspace.verifications == before + 1
    assert raw("for-each-ref", cwd=workspace.mirror, git=rig.git) == refs
    assert rig.origin.tip(BRANCH) == tip
    assert loop.tick() is None, "the forged lines were read once"


# #762-T12
def test_a_spool_that_grows_without_bound_is_cut_by_the_runner(rig: Rig) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())
    with workspace.spool_path.open("a") as spool:
        spool.write(("1.0 " + "a" * 40 + "\n") * 40_000)  # about 1.6 MB

    loop.tick()

    assert workspace.spool_path.stat().st_size < 1_000_000


# #762-T13
def test_no_commits_and_a_clean_tree_is_nothing_to_push_and_no_ref_on_origin(rig: Rig) -> None:
    workspace = rig.prepared()

    result = workspace.push()

    assert result.outcome is PushOutcome.NOTHING_TO_PUSH
    assert result.head is None
    assert rig.origin.tip(BRANCH) is None


# #762-T13
def test_the_final_push_of_a_turn_without_commits_creates_nothing(rig: Rig) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())

    assert loop.finish().outcome is PushOutcome.NOTHING_TO_PUSH
    assert rig.origin.tip(BRANCH) is None


# #762-T14
def test_binary_and_large_commits_are_pushed_and_the_shallow_mirror_passes_the_check(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    blob = secrets.token_bytes(6 * 1024 * 1024)
    (workspace.repo / "data.bin").write_bytes(blob)
    (workspace.repo / "big.txt").write_text("line of text\n" * 200_000)
    assert agent_git(workspace, "add", "-A").returncode == 0
    assert agent_git(workspace, "commit", "-qm", "big").returncode == 0
    tip = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)

    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert rig.origin.tip(BRANCH) == tip
    size = raw(
        "cat-file",
        "-s",
        f"{tip}:data.bin",
        cwd=rig.origin.seed,
        git=rig.git,
        GIT_DIR=str(rig.origin.path),
    )
    assert int(size) == len(blob)
    assert (Path(workspace.mirror) / "shallow").exists(), "the mirror is a depth 1 clone"
    assert os.environ.get("GIT_DIR") is None


# #762-T09
def test_the_runner_never_executes_the_config_of_the_agent_repository(
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
        + f"[core]\n\tfsmonitor = {script}\n\tsshCommand = {script}\n"
        + f"[alias]\n\tstatus = !{script}\n"
        + f"[uploadpack]\n\tpackObjectsHook = {script}\n"
    )
    hooks = workspace.repo / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    for name in ("pre-push", "post-checkout", "reference-transaction", "pre-auto-gc"):
        (hooks / name).write_bytes(script.read_bytes())
        (hooks / name).chmod(0o755)
    commit_ref = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    (workspace.repo / "a.txt").write_text("a\n")
    agent_env = workspace.agent_environment()
    subprocess.run(
        [rig.git, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "add", "-A"],
        cwd=workspace.repo,
        env=agent_env,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        [
            rig.git,
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
            "commit",
            "-qm",
            "x",
        ],
        cwd=workspace.repo,
        env=agent_env,
        check=True,
        capture_output=True,
    )
    assert commit_ref != raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    marker.unlink(missing_ok=True)

    workspace.agent_tip()
    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert not marker.exists(), "a root operation ran something the agent configured"


def as_agent(workspace: GitWorkspace, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    """What the agent runs, with a change of its environment (what a hostile agent can do)."""
    return subprocess.run(
        [workspace.git, *args],
        cwd=workspace.repo,
        env={**workspace.agent_environment(), **env},
        capture_output=True,
        text=True,
        check=False,
    )


def mirror_has(workspace: GitWorkspace, ref: str) -> bool:
    return (
        subprocess.run(
            [workspace.git, "--git-dir", str(workspace.mirror), "rev-parse", "-q", "--verify", ref],
            capture_output=True,
            check=False,
        ).returncode
        == 0
    )


# -- one push at a time ----------------------------------------------------------------------


# #762-T15
def test_pushes_from_several_threads_do_not_fail_each_other_or_poison_the_turn(rig: Rig) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())
    failures: list[BaseException] = []

    def push_once(call: str) -> None:
        try:
            if call == "tick":
                loop.tick()
            elif call == "finish":
                loop.finish()
            else:
                workspace.push()
        except BaseException as error:
            failures.append(error)

    tip = ""
    for number in range(4):
        tip = commit(workspace, f"c{number}.txt")
        start = threading.Barrier(6)

        def run(call: str, start: threading.Barrier = start) -> None:
            start.wait()
            push_once(call)

        threads = [
            threading.Thread(target=run, args=(call,))
            for call in ("push", "tick", "push", "finish", "tick", "push")
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(60)
        assert failures == [], [str(error) for error in failures]
        assert rig.origin.tip(BRANCH) == tip

    assert workspace.push().outcome is PushOutcome.UP_TO_DATE


# -- a failed look is not a violation ------------------------------------------------------


def hanging_git(tmp_path: Path, real: str, mirror: Path, flag: Path, marker: str) -> str:
    """A `git` that, while `flag` exists, takes the lock a fetch of the branch takes and then hangs
    in a child of its own (a killed fetch leaves exactly this behind). Returns its path."""
    lock = mirror / "refs" / "heads" / "implementer" / "a1b2c3.lock"
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


# #762-T15
def test_a_fetch_killed_at_the_timeout_is_not_a_violation_and_its_lock_does_not_stay(
    rig: Rig, tmp_path: Path
) -> None:
    flag = tmp_path / "hang"
    marker = (
        f"{secrets.randbelow(9000) + 1000}.{secrets.randbelow(900) + 100}"  # no other run's sleep
    )
    mirror = rig.base / "work" / "mirror.git"
    wrapper = hanging_git(tmp_path, rig.git, mirror, flag, marker)
    workspace = rig.workspace(git=wrapper, timeout=3)
    workspace.prepare(self_test=False)
    tip = commit(workspace, "a.txt")
    flag.touch()

    with pytest.raises(PushUnverified) as failed:
        workspace.push()

    assert failed.value.code is ErrorCode.RUNNER_ERROR
    lock = mirror / "refs" / "heads" / "implementer" / "a1b2c3.lock"
    assert lock.exists(), "the killed fetch left its lock (the test's premise)"
    assert still_running(f"sleep {marker}") == [], "the timeout left a child behind"
    flag.unlink()

    result = workspace.push()

    assert result.outcome is PushOutcome.PUSHED
    assert rig.origin.tip(BRANCH) == tip
    assert not lock.exists()


# #762-T15
def test_a_stale_lock_in_the_mirror_does_not_stop_the_push(rig: Rig) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    lock = workspace.mirror / "refs" / "heads" / "implementer" / "a1b2c3.lock"
    lock.parent.mkdir(parents=True)
    lock.write_text("")
    (workspace.mirror / "shallow.lock").write_text("")

    assert workspace.push().head == tip
    assert rig.origin.tip(BRANCH) == tip


# #762-T15
def test_a_repository_the_agent_made_unreadable_is_not_a_violation_until_it_is_repaired(
    rig: Rig,
) -> None:
    workspace = rig.workspace(timeout=3)
    workspace.prepare(self_test=False)
    tip = commit(workspace, "a.txt")
    head = workspace.repo / ".git" / "HEAD"
    saved = head.read_text()
    head.unlink()
    os.mkfifo(head)

    with pytest.raises(PushUnverified):
        workspace.push()

    head.unlink()
    head.write_text(saved)
    assert workspace.push().head == tip
    assert still_running("upload-pack", str(workspace.repo)) == []


# #762-T15
def test_the_loop_tries_again_after_a_look_that_failed_and_the_final_push_says_so(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(git_workspace, "TIP_TIMEOUT", 2.0)
    workspace = rig.workspace(timeout=3)
    workspace.prepare(self_test=False)
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock)
    tip = commit(workspace, "a.txt")
    head = workspace.repo / ".git" / "HEAD"
    saved = head.read_text()
    head.unlink()
    os.mkfifo(head)

    assert loop.tick() is None
    with pytest.raises(RepositoryUnusable) as ended:
        loop.finish()
    assert ended.value.code is ErrorCode.BRANCH_VIOLATION, "a charged class, not runner_error"

    head.unlink()
    head.write_text(saved)
    clock.now += 1000.0  # the back-off is over
    result = loop.tick()
    assert result is not None and result.head == tip
    assert rig.origin.tip(BRANCH) == tip


# #762-T15
def test_reading_the_tip_of_a_repository_with_a_fifo_as_head_ends_quickly_and_leaves_nothing(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    head = workspace.repo / ".git" / "HEAD"
    head.unlink()
    os.mkfifo(head)
    assert git_workspace.TIP_TIMEOUT <= 30, "the tick must not wait for the 600 s of a push"
    monkeypatch.setattr(git_workspace, "TIP_TIMEOUT", 2.0)

    assert workspace.agent_tip() is None

    assert still_running("upload-pack", str(workspace.repo)) == []


# #762-T15
def test_the_loop_waits_longer_each_time_a_look_fails_and_starts_over_after_a_good_one(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock)
    commit(workspace, "a.txt")
    real_push = workspace.push
    calls: list[float] = []
    failing = [True]

    def push() -> object:
        calls.append(clock.now)
        if failing[0]:
            raise PushUnverified("the agent's branch could not be fetched")
        return real_push()

    monkeypatch.setattr(workspace, "push", push)

    assert loop.tick() is None
    assert loop.tick() is None, "no second look in the same moment"
    assert len(calls) == 1
    first_wait = None
    for step in range(1, 600):
        clock.now = 1000.0 + step
        loop.tick()
        if len(calls) == 2:
            first_wait = float(step)
            break
    assert first_wait is not None and first_wait >= 5.0, "a failed look is not repeated at once"
    second_start = clock.now
    second_wait = None
    for step in range(1, 1200):
        clock.now = second_start + step
        loop.tick()
        if len(calls) == 3:
            second_wait = float(step)
            break
    assert second_wait is not None and second_wait > first_wait, "the wait grows"
    failing[0] = False
    clock.now += 100000
    result = loop.tick()
    assert result is not None and result.outcome is PushOutcome.PUSHED
    assert len(calls) == 4


# #762-T15
def test_the_wait_between_failed_looks_has_a_ceiling(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock, retry_backoff=10.0, max_backoff=60.0)
    commit(workspace, "a.txt")
    calls: list[float] = []

    def push() -> object:
        calls.append(clock.now)
        raise PushUnverified("the agent's branch could not be fetched")

    monkeypatch.setattr(workspace, "push", push)

    for _ in range(8):
        loop.tick()
        clock.now += 61.0

    assert len(calls) == 8, "after the ceiling, a look is made every 60 s at most"
    assert [b - a for a, b in itertools.pairwise(calls)][-1] == 61.0


# #762-T15
def test_the_final_push_ignores_the_wait_and_unverified_ends_the_turn_as_a_charged_class(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock)
    commit(workspace, "a.txt")
    calls: list[int] = []

    def push() -> object:
        calls.append(1)
        raise PushUnverified("the agent's branch could not be fetched")

    monkeypatch.setattr(workspace, "push", push)
    assert loop.tick() is None  # a wait starts

    with pytest.raises(RepositoryUnusable) as ended:
        loop.finish()

    assert len(calls) == 2, "the final push looks at once, whatever the wait"
    assert ended.value.code is ErrorCode.BRANCH_VIOLATION
    assert not isinstance(ended.value, PushUnverified)


# -- what the agent can make git print ---------------------------------------------------------


# #762-T09
def test_what_the_agent_makes_git_print_is_not_in_the_error(rig: Rig, tmp_path: Path) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    secret = tmp_path / "secret"
    line = "SECRET-LINE-" + secrets.token_hex(8)
    secret.write_text(line + "\n")
    packed = workspace.repo / ".git" / "packed-refs"
    packed.unlink(missing_ok=True)
    packed.symlink_to(secret)

    with pytest.raises(JobError) as failed:
        workspace.push()

    assert line not in str(failed.value) and line not in failed.value.detail
    assert workspace.agent_tip() is None


# -- who the commits are by --------------------------------------------------------------------

VICTIM = "Victim Human"
VICTIM_EMAIL = "victim@example.com"
# Only the committer is checked (a cherry-pick, `git am` and a merge keep the foreign author), so
# the forgeries that count are the ones that change the committer.
FORGERIES: dict[str, tuple[tuple[str, ...], dict[str, str]]] = {
    "committer in the environment": (("commit",), {"GIT_COMMITTER_EMAIL": VICTIM_EMAIL}),
    "committer name in the environment": (("commit",), {"GIT_COMMITTER_NAME": VICTIM}),
    "committer and author in the environment": (
        ("commit",),
        {"GIT_COMMITTER_EMAIL": VICTIM_EMAIL, "GIT_AUTHOR_EMAIL": VICTIM_EMAIL},
    ),
}


# #762-T16
@pytest.mark.parametrize("name", sorted(FORGERIES))
def test_a_commit_by_someone_else_is_a_violation_and_is_not_pushed(rig: Rig, name: str) -> None:
    arguments, environment = FORGERIES[name]
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    (workspace.repo / "b.txt").write_text("b\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    made = as_agent(workspace, *arguments, "-qm", "forged", **environment)
    assert made.returncode == 0, made.stderr
    commit(workspace, "c.txt")  # an honest commit on top does not hide it

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert VICTIM_EMAIL not in str(refused.value) and VICTIM not in str(refused.value)
    assert rig.origin.tip(BRANCH) == good
    assert workspace.pushed_tip == good
    with pytest.raises(JobError):
        workspace.push()


# #762-T16
def test_a_forged_commit_is_taken_out_of_the_mirror_again(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    made = as_agent(
        workspace, "commit", "--allow-empty", "-qm", "forged", GIT_COMMITTER_EMAIL=VICTIM_EMAIL
    )
    assert made.returncode == 0

    with pytest.raises(JobError):
        workspace.push()

    assert not mirror_has(workspace, f"refs/heads/{BRANCH}")
    assert rig.origin.tip(BRANCH) is None


# #762-T16
def test_an_identity_set_with_dash_c_does_not_beat_the_one_in_the_agent_environment(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    (workspace.repo / "a.txt").write_text("a\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    made = agent_git(
        workspace,
        "-c",
        f"user.email={VICTIM_EMAIL}",
        "-c",
        f"user.name={VICTIM}",
        "commit",
        "-qm",
        "x",
    )
    assert made.returncode == 0, made.stderr
    tip = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    author = raw("log", "-1", "--format=%an <%ae> %cn <%ce>", cwd=workspace.repo, git=rig.git)
    assert author == f"{IDENTITY.name} <{IDENTITY.email}> {IDENTITY.name} <{IDENTITY.email}>"

    assert workspace.push().head == tip


# #762-T16
def test_dash_c_forges_a_commit_when_the_environment_has_no_identity_and_is_caught(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    (workspace.repo / "a.txt").write_text("a\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    environment = {
        key: value
        for key, value in workspace.agent_environment().items()
        if not key.startswith(("GIT_AUTHOR", "GIT_COMMITTER"))
    }
    made = subprocess.run(
        [workspace.git, "-c", f"user.email={VICTIM_EMAIL}", "commit", "-qm", "x"],
        cwd=workspace.repo,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert made.returncode == 0, made.stderr

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) is None


# #762-T16
def test_known_limit_a_cherry_picked_commit_of_someone_else_is_pushed(rig: Rig) -> None:
    """The guard allows `git fetch` and `git cherry-pick` (T03). The commit keeps its foreign
    author, the committer is the system (the agent's environment), and only the committer is
    checked: a legitimate turn is not aborted. A forged author stays possible; it is visible,
    because the committer of the same commit shows the system."""
    workspace = rig.prepared()
    rig.origin.commit_on("side", "theirs.txt")
    fetched = agent_git(workspace, "fetch", "-q", rig.origin.url, "side")
    assert fetched.returncode == 0, fetched.stderr
    picked = agent_git(workspace, "cherry-pick", "FETCH_HEAD")
    assert picked.returncode == 0, picked.stderr
    tip = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    people = raw("log", "-1", "--format=%ae|%ce", cwd=workspace.repo, git=rig.git)
    author_email, committer_email = people.split("|")
    assert author_email != IDENTITY.email
    assert committer_email == IDENTITY.email

    assert workspace.push().head == tip
    assert rig.origin.tip(BRANCH) == tip


# #762-T16
def test_known_limit_a_forged_author_is_pushed_and_shows_the_system_as_committer(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    (workspace.repo / "a.txt").write_text("a\n")
    assert agent_git(workspace, "add", "-A").returncode == 0
    made = as_agent(workspace, "commit", "-qm", "x", GIT_AUTHOR_EMAIL=VICTIM_EMAIL)
    assert made.returncode == 0, made.stderr
    tip = raw("rev-parse", "HEAD", cwd=workspace.repo, git=rig.git)
    people = raw("log", "-1", "--format=%ae|%ce", cwd=workspace.repo, git=rig.git)
    assert people == f"{VICTIM_EMAIL}|{IDENTITY.email}"

    assert workspace.push().head == tip


# -- what the fetch checks ---------------------------------------------------------------------


# #762-T17
def test_a_tip_with_objects_that_fail_the_fsck_is_refused(rig: Rig, tmp_path: Path) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    blob_file = tmp_path / "blob"
    blob_file.write_text("x\n")
    blob = raw("hash-object", "-w", str(blob_file), cwd=workspace.repo, git=rig.git)
    entry = b"100644 dup\0" + bytes.fromhex(blob)
    tree_file = tmp_path / "tree"
    tree_file.write_bytes(entry * 2)  # two entries with one name: git fsck calls it an error
    tree = raw(
        "hash-object",
        "-w",
        "--literally",
        "-t",
        "tree",
        str(tree_file),
        cwd=workspace.repo,
        git=rig.git,
    )
    person = {
        "GIT_AUTHOR_NAME": IDENTITY.name,
        "GIT_AUTHOR_EMAIL": IDENTITY.email,
        "GIT_COMMITTER_NAME": IDENTITY.name,
        "GIT_COMMITTER_EMAIL": IDENTITY.email,
    }
    bad = raw(
        "commit-tree", tree, "-p", good, "-m", "bad", cwd=workspace.repo, git=rig.git, **person
    )
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", bad)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) == good


# #762-T07
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


# -- the headers of a commit, read as they are stored ----------------------------------------


def raw_commit(workspace: GitWorkspace, headers: list[str], message: str = "forged\n") -> str:
    """A commit object with exactly these `author`/`committer` header lines (a hand-built object,
    what `git hash-object` takes from a hostile agent), on top of the current tip."""
    parent = raw("rev-parse", "HEAD", cwd=workspace.repo, git=workspace.git)
    tree = raw("rev-parse", "HEAD^{tree}", cwd=workspace.repo, git=workspace.git)
    body = f"tree {tree}\nparent {parent}\n" + "".join(f"{line}\n" for line in headers)
    done = subprocess.run(
        [workspace.git, "hash-object", "--literally", "-t", "commit", "-w", "--stdin"],
        cwd=workspace.repo,
        input=body + "\n" + message,
        env={"PATH": os.environ["PATH"], "HOME": str(workspace.repo), "GIT_CONFIG_NOSYSTEM": "1"},
        capture_output=True,
        text=True,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


SYSTEM = f"{IDENTITY.name} <{IDENTITY.email}> 1700000000 +0000"
ALICE = "Alice Human <alice@example.com> 1700000000 +0000"
DUPLICATES: dict[str, list[str]] = {
    "a second committer after the system one": [
        f"author {SYSTEM}",
        f"committer {ALICE}",
        f"committer {SYSTEM}",
    ],
    "a second committer before the system one": [
        f"author {SYSTEM}",
        f"committer {SYSTEM}",
        f"committer {ALICE}",
    ],
    "a second author": [f"author {ALICE}", f"author {SYSTEM}", f"committer {SYSTEM}"],
    "no committer": [f"author {SYSTEM}"],
    "a committer line that is not a plain identity": [
        f"author {SYSTEM}",
        f"committer {IDENTITY.name} <{IDENTITY.email}> <{ALICE}",
    ],
}


# #762-T16
@pytest.mark.parametrize("name", sorted(DUPLICATES))
def test_a_commit_without_exactly_one_author_and_one_committer_is_refused(
    rig: Rig, name: str
) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    forged = raw_commit(workspace, DUPLICATES[name])
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", forged)
    commit(workspace, "c.txt")  # an honest commit on top does not hide it

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert "alice" not in str(refused.value).lower()
    assert rig.origin.tip(BRANCH) == good
    assert workspace.pushed_tip == good


# #762-T16
def test_a_commit_with_one_author_and_one_committer_of_the_system_passes_the_header_check(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    plain = raw_commit(workspace, [f"author {SYSTEM}", f"committer {SYSTEM}"])
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", plain)

    assert workspace.push().head == plain
    assert rig.origin.tip(BRANCH) == plain


# #762-T16
def test_lines_of_the_message_that_look_like_headers_do_not_count(rig: Rig) -> None:
    workspace = rig.prepared()
    plain = raw_commit(
        workspace,
        [f"author {SYSTEM}", f"committer {SYSTEM}"],
        message=f"committer {ALICE}\nauthor {ALICE}\n",
    )
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", plain)

    assert workspace.push().head == plain


# -- a refusal is decided by git's own result, not by what its output says ------------------

FAKE_REFUSALS = (
    "(non-fast-forward)",
    "non-commit object",
    "fsck error",
    "couldn't find remote ref",
)


# #762-T09
@pytest.mark.parametrize("text", FAKE_REFUSALS)
def test_a_line_in_packed_refs_that_imitates_a_refusal_does_not_end_the_turn(
    rig: Rig, text: str
) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    packed = workspace.repo / ".git" / "packed-refs"
    packed.write_text(f"# pack-refs with: peeled\nnot a ref line {text}\n")

    with pytest.raises(PushUnverified) as unverified:
        workspace.push()

    assert unverified.value.code is ErrorCode.RUNNER_ERROR
    assert text not in str(unverified.value)
    packed.unlink()
    assert workspace.push().head == tip, "the turn went on: nothing was refused"
    assert rig.origin.tip(BRANCH) == tip


# #762-T06
def test_a_branch_pointing_at_a_tree_is_refused_by_what_it_points_at(rig: Rig) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    tree = raw("rev-parse", "HEAD^{tree}", cwd=workspace.repo, git=rig.git)
    write_ref(workspace, tree)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) == good
    assert mirror_has(workspace, f"refs/heads/{BRANCH}")
    assert raw("rev-parse", f"refs/heads/{BRANCH}", cwd=workspace.mirror, git=rig.git) == good


# #762-T06
def test_a_branch_pointing_at_an_annotated_tag_is_refused(rig: Rig) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    done = as_agent(
        workspace, "-c", "core.hooksPath=/dev/null", "tag", "-a", "-m", "t", "tagged", good
    )
    assert done.returncode == 0, done.stderr
    tag = raw("rev-parse", "refs/tags/tagged", cwd=workspace.repo, git=rig.git)
    write_ref(workspace, tag)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert rig.origin.tip(BRANCH) == good


# #762-T06
def test_a_rewrite_leaves_the_tip_of_the_mirror_where_it_was(
    rig: Rig,
) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    bypass(workspace, "commit", "--amend", "-qm", "rewritten")

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert raw("rev-parse", f"refs/heads/{BRANCH}", cwd=workspace.mirror, git=rig.git) == good


# -- the mirror never collects garbage in the background ----------------------------------------


# #762-T15
def test_no_background_gc_or_maintenance_is_started_in_the_mirror(rig: Rig) -> None:
    workspace = rig.prepared()
    marker = rig.base / "gc-ran"
    hook = workspace.mirror / "hooks" / "pre-auto-gc"
    hook.parent.mkdir(exist_ok=True)
    hook.write_text(f"#!/bin/sh\n: > {marker}\nexit 1\n")
    hook.chmod(0o755)
    for key, value in (
        ("gc.auto", "1"),
        ("gc.autoPackLimit", "1"),
        ("fetch.unpackLimit", "1"),
        ("maintenance.auto", "true"),
    ):
        raw("config", key, value, cwd=workspace.mirror, git=rig.git)
    for number in range(3):
        commit(workspace, f"f{number}.txt")
        workspace.push()

    assert not marker.exists(), "a push started git gc --auto in the mirror"


# -- the back-off is measured from the end of the failed look (#764, review of #782) ---------


# #764-F1
def test_a_look_that_takes_long_and_fails_waits_from_its_end_not_from_its_start(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock, retry_backoff=10.0, max_backoff=120.0)
    commit(workspace, "a.txt")
    calls: list[float] = []

    def push() -> object:
        calls.append(clock.now)
        clock.now += 40.0  # a fetch that hangs for 40 s and then fails
        raise PushUnverified("the agent's branch could not be fetched")

    monkeypatch.setattr(workspace, "push", push)

    assert loop.tick() is None
    assert loop.tick() is None, "the failed look took 40 s, the wait of 10 s starts after it"
    assert len(calls) == 1
    clock.now += 9.0
    assert loop.tick() is None
    assert len(calls) == 1, "9 s after the end of the look is still inside the wait"
    clock.now += 2.0
    loop.tick()
    assert len(calls) == 2, "the wait is over 11 s after the end of the look"


# #764-F1
def test_a_slow_good_push_spaces_the_next_one_from_its_end(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=120.0, clock=clock)
    commit(workspace, "a.txt")
    real_push = workspace.push

    def push() -> object:
        clock.now += 100.0
        return real_push()

    monkeypatch.setattr(workspace, "push", push)
    assert loop.tick() is not None
    commit(workspace, "b.txt")

    clock.now += 60.0
    assert loop.tick() is None, "the interval counts from the end of the push that took 100 s"


# -- a commit message is not read as a whole (#764, review of #782) ---------------------------


HUGE_MESSAGE_BYTES = 24 * 1024 * 1024


# #764-F2
def test_a_huge_commit_message_does_not_fill_the_memory_of_the_check(rig: Rig) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    huge = raw_commit(
        workspace,
        [f"author {SYSTEM}", f"committer {SYSTEM}"],
        message=("x" * 99 + "\n") * (HUGE_MESSAGE_BYTES // 100),
    )
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", huge)

    tracemalloc.start()
    try:
        result = workspace.push()
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert result.head == huge, "a long message is not a violation"
    assert peak < HUGE_MESSAGE_BYTES // 4, f"the check held {peak} bytes of a message"


# #764-F2
def test_a_huge_message_does_not_hide_a_forged_committer_after_it(rig: Rig) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    bypass(
        workspace,
        "update-ref",
        f"refs/heads/{BRANCH}",
        raw_commit(
            workspace,
            [f"author {SYSTEM}", f"committer {SYSTEM}"],
            message=("y" * 99 + "\n") * 20_000,
        ),
    )
    forged = raw_commit(workspace, [f"author {SYSTEM}", f"committer {ALICE}"], message="fake\n")
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", forged)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert raw("rev-parse", f"refs/heads/{BRANCH}", cwd=workspace.mirror, git=rig.git) == good


# #764-F2
def test_a_header_block_that_is_absurdly_large_is_refused(rig: Rig) -> None:
    workspace = rig.prepared()
    good = commit(workspace, "a.txt")
    workspace.push()
    padding = [f"extra {'z' * 900}"] * 1_500  # about 1.3 MB of header lines
    bloated = raw_commit(workspace, [f"author {SYSTEM}", f"committer {SYSTEM}", *padding])
    bypass(workspace, "update-ref", f"refs/heads/{BRANCH}", bloated)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.BRANCH_VIOLATION
    assert raw("rev-parse", f"refs/heads/{BRANCH}", cwd=workspace.mirror, git=rig.git) == good


# -- a push the provider cannot take for now is not a refusal (#764) ----------------------------

TRANSIENT_TEXTS = {
    "a 502": "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 502",
    "a 503": "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 503",
    "a 429": "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 429",
    "a reset": "fatal: unable to access 'https://x/r.git/': Recv failure: Connection reset by peer",
    "no route": "fatal: unable to access 'https://x/r.git/': Could not resolve host: x",
    "a hang up": "send-pack: unexpected disconnect while reading sideband packet",
}


def fail_pushes(
    workspace: GitWorkspace,
    monkeypatch: pytest.MonkeyPatch,
    text: str,
    times: int = 1,
    *,
    stdout: str = "",
) -> list[int]:
    """The next `times` pushes of the mirror to the provider fail with this report of git (`text`
    on standard error, `stdout` the porcelain lines of the refs)."""
    real = workspace._mirror  # pyright: ignore[reportPrivateUsage]
    failed: list[int] = []

    def mirror(args: list[str], **options: Any) -> Outcome:
        if "push" in args and len(failed) < times:
            failed.append(1)
            return Outcome(1 if stdout else 128, stdout, text)
        return real(args, **options)

    monkeypatch.setattr(workspace, "_mirror", mirror)
    return failed


# #764-R4
@pytest.mark.parametrize("name", sorted(TRANSIENT_TEXTS))
def test_a_push_that_failed_without_a_refusal_is_tried_again_and_then_works(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, TRANSIENT_TEXTS[name])

    with pytest.raises(PushTransient) as failed:
        workspace.push()

    assert isinstance(failed.value, PushUnverified), "the loop backs off on it"
    assert failed.value.code is ErrorCode.RUNNER_ERROR, "not a refusal, not charged as one"
    assert rig.origin.tip(BRANCH) is None
    assert workspace.push().head == tip
    assert rig.origin.tip(BRANCH) == tip


# #764-R4
@pytest.mark.parametrize(
    "text",
    [
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 403",
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 401",
        "remote: Repository not found.\nfatal: ... The requested URL returned error: 404",
    ],
)
def test_a_client_error_of_the_provider_is_a_refusal(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, text: str
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, text)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert not isinstance(refused.value, PushUnverified)


# #764-R4
def test_the_loop_backs_off_on_a_transient_failure_and_pushes_when_it_is_over(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    clock = Clock()
    loop = PushLoop(workspace, interval=0.0, clock=clock, retry_backoff=10.0)
    tip = commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, TRANSIENT_TEXTS["a 503"])

    assert loop.tick() is None
    assert rig.origin.tip(BRANCH) is None
    clock.now += 5
    assert loop.tick() is None, "inside the wait"
    clock.now += 6
    result = loop.tick()

    assert result is not None and result.head == tip and rig.origin.tip(BRANCH) == tip


# #764-R4
def test_the_final_push_after_a_transient_failure_takes_what_the_loop_could_not(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())
    commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, TRANSIENT_TEXTS["a 502"])
    assert loop.tick() is None
    second = commit(workspace, "b.txt")

    result = loop.finish()

    assert result.head == second and rig.origin.tip(BRANCH) == second


# #764-R4
def test_a_final_push_the_provider_never_takes_is_push_rejected_not_a_branch_violation(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    loop = PushLoop(workspace, interval=0.0, clock=Clock())
    commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, TRANSIENT_TEXTS["a 503"], times=5)

    with pytest.raises(JobError) as ended:
        loop.finish()

    assert ended.value.code is ErrorCode.PUSH_REJECTED
    assert not isinstance(ended.value, RepositoryUnusable)


# -- the status of the tree is not read as a whole (#764) ---------------------------------------


# #764-R9
def test_dirty_stops_at_the_first_line_of_a_status_that_would_be_large(rig: Rig) -> None:
    workspace = rig.prepared()
    for number in range(20_000):
        (workspace.repo / f"u{number}-{'x' * 150}").write_bytes(b"")

    tracemalloc.start()
    try:
        answer = workspace.dirty()
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()

    assert answer is True
    assert peak < 512 * 1024, f"dirty() held {peak} bytes of the status"


# #764-R9
def test_dirty_is_false_for_a_clean_tree_and_true_for_one_change(rig: Rig) -> None:
    workspace = rig.prepared()
    assert workspace.dirty() is False

    (workspace.repo / "new.txt").write_text("x\n")

    assert workspace.dirty() is True


# #764-R13
@pytest.mark.parametrize(
    "text",
    [
        "error: cannot open '/work/mirror.git/FETCH_HEAD': Permission denied",
        "fatal: could not create work tree dir '/work/x': Permission denied",
    ],
)
def test_a_local_permission_error_is_not_a_refusal_of_the_provider(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, text: str
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, text)

    with pytest.raises(PushTransient):
        workspace.push()


# #764-R13
def test_what_the_remote_says_about_permissions_is_still_a_refusal(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    fail_pushes(
        workspace,
        monkeypatch,
        "remote: Permission to acme/widgets.git denied to bot.\n"
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 403",
    )

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED and not isinstance(
        refused.value, PushUnverified
    )


REF = "refs/heads/implementer/a1b2c3"


def rejected(reason: str, *, kind: str = "remote rejected") -> str:
    return f"!\t{REF}:{REF}\t[{kind}] ({reason})\nDone\n"


# #764-R13
@pytest.mark.parametrize("reason", ["internal error", "failed to update ref", "Internal Error"])
def test_a_remote_rejection_that_says_the_provider_failed_is_tried_again(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    workspace = rig.prepared()
    tip = commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, "error: failed to push some refs", stdout=rejected(reason))

    with pytest.raises(PushTransient):
        workspace.push()

    assert workspace.push().head == tip, "the next try goes through"


# #764-R13
@pytest.mark.parametrize(
    "reason",
    [
        "pre-receive hook declined",
        "protected branch hook declined",
        "refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml`",
        "cannot lock ref",
    ],
)
def test_a_remote_rejection_with_a_real_reason_is_a_refusal(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, reason: str
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    fail_pushes(workspace, monkeypatch, "error: failed to push some refs", stdout=rejected(reason))

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
    assert not isinstance(refused.value, PushUnverified)


# #764-R13
def test_one_hard_line_among_hiccups_makes_the_push_a_refusal(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = rig.prepared()
    commit(workspace, "a.txt")
    both = rejected("internal error") + rejected("pre-receive hook declined")
    fail_pushes(workspace, monkeypatch, "error: failed to push some refs", stdout=both)

    with pytest.raises(JobError) as refused:
        workspace.push()

    assert refused.value.code is ErrorCode.PUSH_REJECTED
