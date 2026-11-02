# SPDX-License-Identifier: LicenseRef-Proprietary

"""A prepared Implementer workspace over a file-system origin, for the git workspace tests (#762);
not a test file. The tests run as an ordinary user, so "the agent" and "root" are the same user here
and `AgentUser` names the current one."""

import os
import subprocess
from pathlib import Path

from code_reviewer_runner.implementer.git_workspace import (
    AgentUser,
    GitIdentity,
    GitWorkspace,
    WorkspaceLayout,
    WorkspaceSpec,
)
from git_support import TOKEN, Origin, raw

IDENTITY = GitIdentity(name="Code Review Implementer", email="implementer@example.invalid")
BRANCH = "implementer/a1b2c3"


def _agent() -> AgentUser:
    return AgentUser(uid=os.geteuid(), gid=os.getegid())


class Rig:
    """One test's directories and a way to build a workspace over them."""

    def __init__(self, base: Path, git: str, origin: Origin) -> None:
        self.base = base
        self.git = git
        self.origin = origin
        self.layout = WorkspaceLayout(
            work_dir=base / "work",
            run_dir=base / "run",
            agent_home=base / "home",
        )
        self.layout.agent_home.mkdir()

    def workspace(
        self,
        url: str | None = None,
        base_branch: str = "main",
        branch: str = BRANCH,
        schemes: tuple[str, ...] = ("file",),
        git: str | None = None,
        token: str = TOKEN,
        timeout: float = 600.0,
    ) -> GitWorkspace:
        spec = WorkspaceSpec(
            clone_url=url or self.origin.url, token=token, base_branch=base_branch, branch=branch
        )
        return GitWorkspace(
            spec,
            self.layout,
            _agent(),
            IDENTITY,
            git=git or self.git,
            schemes=schemes,
            timeout=timeout,
        )

    def prepared(self, base_branch: str = "main", branch: str = BRANCH) -> GitWorkspace:
        workspace = self.workspace(base_branch=base_branch, branch=branch)
        workspace.prepare()
        return workspace


def agent_git(workspace: GitWorkspace, *args: str) -> subprocess.CompletedProcess[str]:
    """What the agent runs: git in its repository, in the environment the runner gives it."""
    return subprocess.run(
        [workspace.git, *args],
        cwd=workspace.repo,
        env=workspace.agent_environment(),
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
