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
from git_support import TOKEN, Origin, guard_directory, raw

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
            guard_dir=guard_directory(base / "guard"),
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
        workspace.prepare(self_test=False)
        return workspace


def agent_git(workspace: GitWorkspace, *args: str) -> subprocess.CompletedProcess[str]:
    """What the agent runs: git in its repository with the guard active."""
    return subprocess.run(
        [workspace.git, *args],
        cwd=workspace.repo,
        env=workspace.agent_environment(),
        capture_output=True,
        text=True,
        check=False,
    )


def reset_to(workspace: GitWorkspace, sha: str) -> None:
    """Back to a known state between actions, without the guard (a test's own set-up)."""
    raw(
        "checkout",
        "-qf",
        BRANCH,
        cwd=workspace.repo,
        git=workspace.git,
        GIT_CONFIG_SYSTEM="/dev/null",
    )
    raw(
        "update-ref",
        f"refs/heads/{BRANCH}",
        sha,
        cwd=workspace.repo,
        git=workspace.git,
        GIT_CONFIG_SYSTEM="/dev/null",
    )
    raw(
        "reset",
        "-q",
        "--hard",
        sha,
        cwd=workspace.repo,
        git=workspace.git,
        GIT_CONFIG_SYSTEM="/dev/null",
    )
    raw("clean", "-qfd", cwd=workspace.repo, git=workspace.git, GIT_CONFIG_SYSTEM="/dev/null")


def spool_lines(workspace: GitWorkspace) -> list[str]:
    return workspace.spool_path.read_text().splitlines()
