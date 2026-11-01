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


@dataclass(frozen=True)
class TurnResult:
    """The outcome of a turn. `error_code` is None for a success; a failed turn carries the block
    too, whenever the runner got as far as the repository (the contract says so)."""

    error_code: ErrorCode | None
    # A sentence of ours only; names no value from the repository, the agent or the model.
    error_detail: str | None
    base_commit: str
    head_commit: str | None
    pushed: bool
    commits: tuple[CommitInfo, ...]
    files_changed: tuple[FileChange, ...]
    summary: str
    opencode_session_id: str | None
    opencode_version: str
    usage: Usage
    # Facts for the job log (counts and stable words), in order.
    notes: tuple[str, ...] = field(default_factory=tuple)

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
        return {
            "baseCommit": self.base_commit,
            "headCommit": self.head_commit,
            "pushed": self.pushed,
            "commits": [{"sha": c.sha, "subject": c.subject} for c in self.commits],
            "filesChanged": [{"path": f.path, "status": f.kind.value} for f in self.files_changed],
            "summary": self.summary,
            "opencode": opencode,
        }
