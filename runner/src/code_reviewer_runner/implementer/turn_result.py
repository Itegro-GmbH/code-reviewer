# SPDX-License-Identifier: LicenseRef-Proprietary

"""What one turn of the Implementer's agent produced (#764), in the shape of the contract's
`ImplementerResult` (`contracts/runner-api.v1.json`).

It is facts the runner measured in the repository, never text from the agent except `summary`,
which is shown as plain text: redacted of the job's secrets and cut at the contract's bound. The
job glue (#765) turns this into the runner's `JobResult`; nothing here prints or logs.
"""

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from ..redaction import Redactor
from ..result import ErrorCode, Usage
from .git_workspace import BranchPush
from .history import CommitInfo, FileChange

MAX_SUMMARY_CHARS = 8192
_CUT_MARK = "\n[...]"


def clip_summary(text: str, secrets: Iterable[str], *, tail: str = "") -> str:
    """The agent's closing text as the summary: the job's secrets are gone first (a secret cut in
    half would no longer match), then the text is cut so that it and `tail` fit `MAX_SUMMARY_CHARS`.
    `tail` is the runner's own note (what of the agent's work was not kept); it is never cut and
    follows the text after a blank line."""
    clean = Redactor(secrets).redact(text).strip()
    suffix = f"\n\n{tail}" if tail and clean else tail
    room = MAX_SUMMARY_CHARS - len(suffix)
    if len(clean) > room:
        clean = clean[: room - len(_CUT_MARK)] + _CUT_MARK
    return clean + suffix


# The bounds of one repository's entry in `ImplementerResult.repos` (#1091): up to ten repositories
# share one report, so its lists are shorter than the single form's.
MAX_REPO_COMMITS = 100
MAX_REPO_FILES = 250


@dataclass(frozen=True)
class RepoOutcome:
    """What a multi-repository turn did in one repository (#1093, `ImplementerRepoResult`): the
    facts of the single form, per repository. `branches` is None for a profile that may not push
    (nothing was listed, so the entry has none)."""

    name: str
    full_name: str
    base: str
    branch: str
    # This turn made the working branch (it was not in the clone).
    created: bool
    # The tip of the working branch when the turn started; the tip when it ended (the same when
    # the turn made no commit there; None only for a profile that may not push).
    base_commit: str
    head_commit: str | None
    # The branch at `head_commit` is on the remote at the end: pushed by this turn or there already.
    pushed: bool
    commits: tuple[CommitInfo, ...] = ()
    files_changed: tuple[FileChange, ...] = ()
    branches: tuple[BranchPush, ...] | None = None
    branches_dropped: tuple[int, int] = (0, 0)
    checked_out: str | None = None
    commits_truncated: int = 0
    files_truncated: int = 0

    def block(self) -> dict[str, Any]:
        """The entry of `implementer.repos`. The lists are cut to the bounds of the entry (the
        newest commits stay, the head last), and what was left out is counted."""
        commits = list(self.commits)
        files = list(self.files_changed)
        commits_cut = self.commits_truncated + max(len(commits) - MAX_REPO_COMMITS, 0)
        files_cut = self.files_truncated + max(len(files) - MAX_REPO_FILES, 0)
        commits = commits[-MAX_REPO_COMMITS:]
        files = files[:MAX_REPO_FILES]
        entry: dict[str, Any] = {
            "name": self.name,
            "fullName": self.full_name,
            "base": self.base,
            "branch": self.branch,
            "created": self.created,
            "baseCommit": self.base_commit,
            "headCommit": self.head_commit,
            "pushed": self.pushed,
        }
        if self.branches is not None:
            entry["branches"] = [
                {
                    "name": branch.name,
                    "head": branch.head,
                    "result": "pushed" if branch.pushed else "rejected",
                    "reason": branch.reason,
                }
                for branch in self.branches
            ]
            entry["branchesDropped"] = {
                "invalid": self.branches_dropped[0],
                "overflow": self.branches_dropped[1],
            }
        entry["commits"] = [{"sha": c.sha, "subject": c.subject} for c in commits]
        entry["filesChanged"] = [{"path": f.path, "status": f.kind.value} for f in files]
        entry["checkedOut"] = self.checked_out
        if commits_cut:
            entry["commitsTruncated"] = commits_cut
        if files_cut:
            entry["filesTruncated"] = files_cut
        return entry


@dataclass(frozen=True)
class TurnResult:
    """The outcome of a turn. `error_code` is None for a success; a failed turn carries the block
    too, whenever the runner got as far as the repository (the contract says so)."""

    error_code: ErrorCode | None
    # A sentence of ours only; names no value from the repository, the agent or the model.
    error_detail: str | None
    base_commit: str
    head_commit: str | None
    # The form's branch: its tip when it has work on top of the base commit, and whether it arrived.
    # A follow-up turn that added nothing names the tip the earlier turns left it at (#965).
    pushed: bool
    # Every local branch of the agent's repository the final push dealt with, pushed or rejected.
    branches: tuple[BranchPush, ...]
    # How many local branches were left out: (names that cannot be pushed, valid names beyond
    # the limit).
    branches_dropped: tuple[int, int]
    commits: tuple[CommitInfo, ...]
    files_changed: tuple[FileChange, ...]
    summary: str
    opencode_session_id: str | None
    opencode_version: str
    usage: Usage
    # Facts for the job log (counts and stable words), in order.
    notes: tuple[str, ...] = field(default_factory=tuple)
    # #818: what the environment's setup script did (`ImplementerSetupResult`); None: no script ran.
    setup: dict[str, Any] | None = None
    # #745, step 7: what the network door did (`ImplementerNetworkReport`); None: no rule but `off`.
    network: dict[str, Any] | None = None
    # #837: the local branch HEAD was on when the agent's work was read, after the rescue of a
    # detached HEAD (`GitWorkspace.checked_out`); None: detached and on no branch, or not read.
    checked_out: str | None = None
    # #840: how a follow-up turn got its earlier conversation (`ImplementerResumeResult`):
    # `{"mode": "imported"}` or `{"mode": "summary_only", "reason": <word>}`. None: a first turn, or
    # a turn that ended before the engine started.
    resume: dict[str, Any] | None = None
    # #843: the result the agent handed in through the finish tool, checked by Control against the
    # turn's result schema once the agent's container was gone; None: the turn has no result schema,
    # or the agent handed in none that fits. Data of an untrusted writer, never a command.
    agent_result: dict[str, Any] | None = None
    # #920: the question the agent ended the turn with (`question`, `options`, `context`), checked
    # by
    # Control like the result; None: the turn ended with a result, or with neither. Never a command.
    agent_ask: dict[str, Any] | None = None
    # #1093: one entry per repository of a multi-repository turn, in the order of the job; None for
    # the turn of one repository. The fields above are then copies of the first entry.
    repos: tuple[RepoOutcome, ...] | None = None

    @property
    def ok(self) -> bool:
        return self.error_code is None

    def implementer_block(self) -> dict[str, Any]:
        """The `implementer` object of the runner's result (`ImplementerResult`)."""
        opencode: dict[str, str] | None = (
            None
            if self.opencode_session_id is None
            else {"sessionId": self.opencode_session_id, "version": self.opencode_version}
        )
        block: dict[str, Any] = {
            "baseCommit": self.base_commit,
            "headCommit": self.head_commit,
            "pushed": self.pushed,
            "branches": [
                {
                    "name": branch.name,
                    "head": branch.head,
                    "result": "pushed" if branch.pushed else "rejected",
                    "reason": branch.reason,
                }
                for branch in self.branches
            ],
            "branchesDropped": {
                "invalid": self.branches_dropped[0],
                "overflow": self.branches_dropped[1],
            },
            "commits": [{"sha": c.sha, "subject": c.subject} for c in self.commits],
            "filesChanged": [{"path": f.path, "status": f.kind.value} for f in self.files_changed],
            "summary": self.summary,
            "opencode": opencode,
            **({} if self.checked_out is None else {"checkedOut": self.checked_out}),
            **({} if self.resume is None else {"resume": self.resume}),
            **({} if self.agent_result is None else {"agentResult": self.agent_result}),
            **({} if self.agent_ask is None else {"agentAsk": self.agent_ask}),
            **({} if self.setup is None else {"setup": self.setup}),
            **({} if self.network is None else {"network": self.network}),
        }
        if self.repos is not None:
            block.update(self._repos_block())
        return block

    def _repos_block(self) -> dict[str, Any]:
        """`repos`, and the old fields as copies of the first entry (so they stay equal when a list
        is cut): a reader that does not know `repos` sees the first repository as it always saw
        the only one."""
        assert self.repos is not None
        entries = [repo.block() for repo in self.repos]
        first = entries[0]
        copies: dict[str, Any] = {
            "baseCommit": first["baseCommit"],
            "headCommit": first["headCommit"],
            "pushed": first["pushed"],
            "branches": first.get("branches", []),
            "branchesDropped": first.get("branchesDropped", {"invalid": 0, "overflow": 0}),
            "commits": first["commits"],
            "filesChanged": first["filesChanged"],
        }
        if first["checkedOut"] is not None:
            copies["checkedOut"] = first["checkedOut"]
        return {**copies, "repos": entries}
