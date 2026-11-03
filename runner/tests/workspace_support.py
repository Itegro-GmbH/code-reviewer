# SPDX-License-Identifier: LicenseRef-Proprietary

"""A prepared Implementer workspace over a file-system origin, for the git workspace tests (#762);
not a test file. The tests run as an ordinary user and there is no reader container: `LocalAccess`
runs git in the repository on the machine, the way the reader does in its container, so "the agent"
and "root" are the same user here."""

import subprocess
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path

from code_reviewer_runner.implementer.git_process import TRUSTED_PATH, GitProcess, Outcome
from code_reviewer_runner.implementer.git_workspace import (
    DiskSpace,
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
    disk_space,
)
from git_support import TOKEN, Origin, raw

IDENTITY = GitIdentity(name="Code Review Implementer", email="implementer@example.invalid")
BRANCH = "implementer/a1b2c3"


def agent_environment(home: Path, git: str) -> dict[str, str]:
    """The environment of the agent's git in these tests: the identity and git's config files out of
    play."""
    return {
        "PATH": ":".join(dict.fromkeys([str(Path(git).parent), *TRUSTED_PATH.split(":")])),
        "HOME": str(home),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_AUTHOR_NAME": IDENTITY.name,
        "GIT_AUTHOR_EMAIL": IDENTITY.email,
        "GIT_COMMITTER_NAME": IDENTITY.name,
        "GIT_COMMITTER_EMAIL": IDENTITY.email,
    }


class LocalAccess:
    """`RepoAccess` over a repository on this machine: git run in it as the current user."""

    def __init__(self, repo: Path, git: str, home: Path) -> None:
        self.repo = repo
        self.git = git
        self._env = agent_environment(home, git)
        self._process = GitProcess(git, self._env["PATH"], home, "unused-token")

    @property
    def repo_source(self) -> str:
        return str(self.repo)

    def upload_pack(self) -> str:
        return f"{self.git} upload-pack"

    def warm(self) -> bool:
        return True

    def reset(self, *, seconds: float) -> bool:
        return True

    def append_exclude(self, data: bytes, *, timeout: float) -> Outcome:
        exclude = self.repo / ".git" / "info" / "exclude"
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("ab") as handle:
            handle.write(data)
        return Outcome(0, "", "")

    def update_refs(
        self, options: Sequence[str], commands: Iterable[bytes], *, timeout: float
    ) -> Outcome:
        child = subprocess.Popen(
            [self.git, *options, "update-ref", "--stdin", "-z"],
            cwd=self.repo,
            env=self._env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert child.stdin is not None  # stdin=PIPE
        try:
            for part in commands:
                child.stdin.write(part)
            child.stdin.close()
        except BaseException:
            child.kill()
            child.wait()
            raise
        stdout, stderr = child.communicate(timeout=timeout)
        return Outcome(child.returncode, stdout.decode(), stderr.decode())

    def run(self, args: Sequence[str], *, timeout: float, write: bool = False) -> Outcome:
        return self._process.run(args, env=self._env, cwd=self.repo, timeout=timeout)

    def stream(
        self, args: Sequence[str], consume: Callable[[bytes], None], *, timeout: float
    ) -> Outcome:
        return self._process.stream(
            args, env=self._env, cwd=self.repo, consume=consume, timeout=timeout
        )


class Rig:
    """One test's directories and a way to build a workspace over them."""

    def __init__(self, base: Path, git: str, origin: Origin) -> None:
        self.base = base
        self.git = git
        self.origin = origin
        self.layout = WorkspaceLayout(work_dir=base / "work", run_dir=base / "run")
        self.home = base / "home"
        self.home.mkdir()

    def workspace(
        self,
        url: str | None = None,
        base_branch: str = "main",
        branch: str = BRANCH,
        schemes: tuple[str, ...] = ("file",),
        git: str | None = None,
        token: str = TOKEN,
        timeout: float = 600.0,
        space: Callable[[Path], DiskSpace] | None = None,
    ) -> GitWorkspace:
        spec = WorkspaceSpec(
            clone_url=url or self.origin.url, token=token, base_branch=base_branch, branch=branch
        )
        return GitWorkspace(
            spec,
            self.layout,
            IDENTITY,
            LocalAccess(self.layout.work_dir / "repo", git or self.git, self.home),
            git=git or self.git,
            schemes=schemes,
            timeout=timeout,
            space=space or disk_space,
        )

    def prepared(
        self,
        base_branch: str = "main",
        branch: str = BRANCH,
        space: Callable[[Path], DiskSpace] | None = None,
    ) -> GitWorkspace:
        workspace = self.workspace(base_branch=base_branch, branch=branch, space=space)
        workspace.prepare()
        return workspace


def agent_git(workspace: GitWorkspace, *args: str) -> subprocess.CompletedProcess[str]:
    """What the agent runs: git in its repository, in the environment the runner gives it."""
    return subprocess.run(
        [workspace.git, *args],
        cwd=workspace.repo,
        env=agent_environment(workspace.layout.run_dir.parent / "home", workspace.git),
        capture_output=True,
        text=True,
        check=False,
    )


def commit(workspace: GitWorkspace, name: str, content: str = "x\n") -> str:
    """A commit on the branch that is checked out in the agent's repository."""
    (workspace.repo / name).write_text(content)
    assert agent_git(workspace, "add", "-A").returncode == 0
    done = agent_git(workspace, "commit", "-qm", f"add {name}")
    assert done.returncode == 0, done.stderr
    return head_of(workspace)


def head_of(workspace: GitWorkspace, ref: str = "HEAD") -> str:
    return raw("rev-parse", ref, cwd=workspace.repo, git=workspace.git)
