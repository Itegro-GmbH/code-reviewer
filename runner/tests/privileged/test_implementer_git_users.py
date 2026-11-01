# SPDX-License-Identifier: LicenseRef-Proprietary

"""Who runs what in the Implementer's git workspace (#762), with the real engine user.

The workspace tests in tests/integration run as one ordinary user, so "the agent" and "root" are the
same there. This file proves the separation: the agent's git commands run as the engine user, the
config of the agent's repository is never executed with root's rights, and the engine user can read
neither the token nor the mirror. Needs git 2.53 or newer with the HTTP transport (CI's)."""

import os
import secrets
import shutil
import stat
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest
from privileged_support import ENGINE_GID, ENGINE_UID, exec_directory, run_as

from code_reviewer_runner.implementer.git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    PushOutcome,
    WorkspaceLayout,
    WorkspaceSpec,
)
from code_reviewer_runner.job import JobError
from code_reviewer_runner.result import ErrorCode
from git_support import (
    TOKEN,
    HttpOrigin,
    Origin,
    files_mentioning,
    guard_directory,
    guard_git,
)

BRANCH = "implementer/a1b2c3"
IDENTITY = GitIdentity(name="Code Review Implementer", email="implementer@example.invalid")


@pytest.fixture
def base() -> Iterator[Path]:
    """A directory where programs may run (the hook and the scripts), enterable by everybody."""
    directory = exec_directory("cr-implementer-git-")
    yield directory
    shutil.rmtree(directory, ignore_errors=True)


def _workspace(base: Path, url: str, schemes: tuple[str, ...], git: str) -> GitWorkspace:
    home = base / "home"
    home.mkdir()
    os.chown(home, ENGINE_UID, ENGINE_GID)
    layout = WorkspaceLayout(
        work_dir=base / "work",
        run_dir=base / "run",
        guard_dir=guard_directory(base / "guard"),
        agent_home=home,
    )
    layout.guard_dir.chmod(0o755)
    spec = WorkspaceSpec(clone_url=url, token=TOKEN, base_branch="main", branch=BRANCH)
    return GitWorkspace(
        spec, layout, AgentUser(ENGINE_UID, ENGINE_GID), IDENTITY, git=git, schemes=schemes
    )


def _root_pids_with(needle: str) -> list[int]:
    """The processes of root whose command line has the needle (the held git of the runner)."""
    found: list[int] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            command = (entry / "cmdline").read_bytes()
            status = (entry / "status").read_text()
        except OSError:
            continue
        if needle.encode() in command and status.split("Uid:")[1].split()[0] == "0":
            found.append(int(entry.name))
    return found


def _can_read(path: Path) -> bool:
    done = run_as(ENGINE_UID, ENGINE_GID, "import sys; open(sys.argv[1], 'rb').read()", str(path))
    return done.returncode == 0


def _can_list(path: Path) -> bool:
    done = run_as(ENGINE_UID, ENGINE_GID, "import os, sys; os.listdir(sys.argv[1])", str(path))
    return done.returncode == 0


# #762-T08
def test_the_leftover_calls_and_the_self_test_run_as_the_engine_user(base: Path) -> None:
    git = guard_git()
    workspace = _workspace(base, Origin(base, git).url, ("file",), git)
    workspace.prepare()  # the matrix runs as the engine user too
    marker = base / "marker"
    marker.write_text("")
    marker.chmod(0o666)
    script = base / "who.sh"
    script.write_text(f"#!/bin/sh\nid -u >> {marker}\nexit 0\n")
    script.chmod(0o755)
    config = workspace.repo / ".git" / "config"
    config.write_text(config.read_text() + f"[core]\n\tfsmonitor = {script}\n")
    (workspace.repo / "new.txt").write_text("n\n")

    assert workspace.dirty() is True
    sha = workspace.commit_all()

    assert sha is not None
    assert workspace.repo.stat().st_uid == ENGINE_UID
    assert (workspace.repo / ".git" / "HEAD").stat().st_uid == ENGINE_UID
    ran_as = set(marker.read_text().split())
    assert ran_as == {str(ENGINE_UID)}, "git status ran the agent's config, as the engine user"
    assert workspace.spool_path.read_text().strip().endswith(sha)


# #762-T09
def test_no_root_operation_runs_what_the_agent_repository_configures(base: Path) -> None:
    git = guard_git()
    workspace = _workspace(base, Origin(base, git).url, ("file",), git)
    workspace.prepare(self_test=False)
    marker = base / "marker"
    marker.write_text("")
    marker.chmod(0o666)
    script = base / "trap.sh"
    script.write_text(f"#!/bin/sh\nid -u >> {marker}\nexit 0\n")
    script.chmod(0o755)
    config = workspace.repo / ".git" / "config"
    config.write_text(
        config.read_text()
        + f"[core]\n\tfsmonitor = {script}\n\tsshCommand = {script}\n"
        + f"\talternateRefsCommand = {script}\n"
        + f"[uploadpack]\n\tpackObjectsHook = {script}\n"
    )
    objects = workspace.repo / ".git" / "objects" / "info"
    objects.mkdir(exist_ok=True)
    alternate = base / "alternate-objects"
    alternate.mkdir(mode=0o755)
    (objects / "alternates").write_text(f"{alternate}\n")
    hooks = workspace.repo / ".git" / "hooks"
    hooks.mkdir(exist_ok=True)
    for name in (
        "pre-push",
        "post-checkout",
        "reference-transaction",
        "pre-auto-gc",
        "post-commit",
    ):
        (hooks / name).write_text(script.read_text())
        (hooks / name).chmod(0o755)
    for path in [workspace.repo, *workspace.repo.rglob("*")]:
        os.lchown(path, ENGINE_UID, ENGINE_GID)
    env = workspace.agent_environment()
    for step in (["add", "-A"], ["commit", "-q", "--allow-empty", "-m", "x"]):
        done = run_as_git(workspace, ["-c", "core.hooksPath=/dev/null", *step], env)
        assert done == 0

    workspace.agent_tip()
    workspace.push()

    lines = marker.read_text().split()
    assert "0" not in lines, "a root operation ran something the agent configured"


def run_as_git(workspace: GitWorkspace, args: list[str], env: dict[str, str]) -> int:
    return subprocess.run(
        [workspace.git, *args],
        cwd=workspace.repo,
        env=env,
        user=ENGINE_UID,
        group=ENGINE_GID,
        extra_groups=[],
        capture_output=True,
        check=False,
    ).returncode


# #762-T10
def test_the_engine_user_can_read_neither_the_token_nor_the_mirror(base: Path) -> None:
    git = "/usr/bin/git"  # the HTTP transport
    origin = Origin(base, git)
    with HttpOrigin(origin, TOKEN, git) as server:
        workspace = _workspace(base, server.url, ("http",), git)
        server.hold()
        errors: list[BaseException] = []

        def clone() -> None:
            try:
                workspace.clone_mirror()
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=clone)
        thread.start()
        assert server.arrived.wait(30)
        # The runner's git process is alive and holds the token in its environment.
        pids = [pid for pid in _root_pids_with("--depth=1")]
        assert pids, "the held git process was not found"
        for pid in pids:
            assert not _can_read(Path(f"/proc/{pid}/environ"))
            assert (
                not _can_read(Path(f"/proc/{pid}/cmdline"))
                or TOKEN not in Path(f"/proc/{pid}/cmdline").read_text()
            )
        server.release()
        thread.join(30)
        assert errors == []

    workspace.create_agent_repository()
    workspace.install_guard()
    assert not _can_list(workspace.mirror)
    assert not _can_read(workspace.mirror / "config")
    assert not _can_read(workspace.mirror / "HEAD")
    assert stat.S_IMODE(workspace.mirror.stat().st_mode) == 0o700
    assert workspace.mirror.stat().st_uid == 0
    assert files_mentioning(base / "work", TOKEN) == []
    # What the engine user can write is the spool and its own tree, not the guard.
    for name in ("guard.conf", "system.gitconfig"):
        done = run_as(
            ENGINE_UID,
            ENGINE_GID,
            "import sys; open(sys.argv[1], 'a').write('x')",
            str(base / "run" / name),
        )
        assert done.returncode != 0, f"the engine user can change {name}"
    appended = run_as(
        ENGINE_UID,
        ENGINE_GID,
        "import sys; open(sys.argv[1], 'a').write('1.0 ' + 'a' * 40 + '\\n')",
        str(workspace.spool_path),
    )
    assert appended.returncode == 0, appended.stderr


# #762-T09
def test_the_upload_pack_of_the_runner_runs_as_the_engine_user_and_reads_nothing_of_roots(
    base: Path,
) -> None:
    real = guard_git()
    uids = base / "uids"
    uids.write_text("")
    uids.chmod(0o666)
    programs = base / "bin"
    programs.mkdir(mode=0o755)
    wrapper = programs / "git"
    wrapper.write_text(
        f'#!/bin/sh\nif [ "$1" = upload-pack ]; then id -u >> {uids}; fi\nexec {real} "$@"\n'
    )
    wrapper.chmod(0o755)
    workspace = _workspace(base, Origin(base, real).url, ("file",), str(wrapper))
    workspace.prepare(self_test=False)
    # What the agent can point git at: a file only root can read, as its repository's `packed-refs`.
    line = "SECRET-LINE-" + secrets.token_hex(8)
    secret = base / "root-only"
    secret.write_text(line + "\n")
    secret.chmod(0o600)
    packed = workspace.repo / ".git" / "packed-refs"
    packed.unlink(missing_ok=True)
    packed.symlink_to(secret)
    # The trap works: an upload-pack of root's tells what is in the file.
    control = subprocess.run(
        [real, "-c", f"safe.directory={workspace.repo}", "upload-pack", "--advertise-refs", "."],
        cwd=workspace.repo,
        capture_output=True,
        text=True,
        check=False,
        env={"PATH": os.environ["PATH"], "HOME": "/", "GIT_CONFIG_NOSYSTEM": "1"},
    )
    assert line in control.stderr, "a root upload-pack should show the line (the premise)"
    uids.write_text("")

    assert workspace.agent_tip() is None
    with pytest.raises(JobError) as failed:
        workspace.push()

    assert line not in str(failed.value) and line not in failed.value.detail
    assert set(uids.read_text().split()) == {str(ENGINE_UID)}, "an upload-pack ran as someone else"
    # and an honest turn is read by the same user
    packed.unlink()
    (workspace.repo / "new.txt").write_text("n\n")
    assert workspace.commit_all() is not None
    uids.write_text("")

    assert workspace.agent_tip() is not None
    assert workspace.push().outcome is PushOutcome.PUSHED
    assert set(uids.read_text().split()) == {str(ENGINE_UID)}


# #762-T02
def test_a_work_directory_that_belongs_to_the_engine_user_is_refused(base: Path) -> None:
    git = guard_git()
    workspace = _workspace(base, Origin(base, git).url, ("file",), git)
    (base / "work").mkdir()
    os.chown(base / "work", ENGINE_UID, ENGINE_GID)

    with pytest.raises(JobError) as refused:
        workspace.clone_mirror()

    assert refused.value.code is ErrorCode.SETUP_FAILED
    assert not (base / "work" / "mirror.git").exists()
