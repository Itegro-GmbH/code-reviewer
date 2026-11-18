# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a multi-repository turn did in each repository (#1093, epic #1090, ADR 0006).

The facts are the single repository's, repository by repository (`RepoOutcome`), and the verdict of
the turn is the sum of them:

* it **succeeds** when, in every repository, the working branch arrived or is verifiably empty (at
  its start tip) and nothing of it was rejected;
* it ends **`push_rejected`** when in any repository the working branch was not taken (rejected for
  any reason, or gone) or no branch arrived although some had commits; the message names the
  repository by its mount. What was pushed in the others stays pushed and is in the report;
* it ends **`agent_gave_up`** when no repository has a commit of this turn, unless the agent handed
  in a result or a question.

Nothing here reads a repository; the workspaces measured the facts.
"""

from ..result import ErrorCode
from .git_workspace import (
    LIST_TOO_LARGE,
    REASON_LOGIN_SECRET,
    REASON_UNCHECKED,
    BranchPush,
)
from .multi_workspace import MemberFacts, MultiWorkspace
from .report import MAX_REPO_COMMITS
from .turn_result import RepoOutcome


def _form_of(fact: MemberFacts) -> BranchPush | None:
    """The report's entry of the working branch (none when it was unchanged or not looked at)."""
    return next((b for b in fact.report.branches if b.name == fact.workspace.spec.branch), None)


def push_failure(name: str, form: BranchPush | None) -> str:
    """The sentence for a working branch that did not arrive, naming the repository."""
    if form is not None and form.reason == REASON_LOGIN_SECRET:
        what = "the work holds the login of this device (login_secret) and was not pushed"
    elif form is not None and form.reason == REASON_UNCHECKED:
        what = (
            "the work could not be checked for the login of this device (unchecked), "
            "so it was not pushed"
        )
    else:
        what = "the work could not be pushed"
    return f"{what} (repository {name})"


def push_error(
    workspace: MultiWorkspace, *, handed_in_something: bool
) -> tuple[ErrorCode, str] | None:
    """The error the push makes of the turn, or None. Judged after the push, for a turn nothing
    else ended. `handed_in_something` is a result or a question of the agent (a turn may rightly
    change nothing then)."""
    facts = workspace.facts()
    for fact in facts:
        name = fact.workspace.spec.name or ""
        if not fact.report.listed:
            too_long = (
                ": its list of branches is too long"
                if fact.report.list_problem == (LIST_TOO_LARGE)
                else ""
            )
            return (
                ErrorCode.PUSH_REJECTED,
                f"the repository {name} of the agent could not be read{too_long}, "
                "so nothing was pushed there",
            )
    if not any(fact.report.branches for fact in facts):
        if handed_in_something:
            return None
        return ErrorCode.AGENT_GAVE_UP, "the agent ended without a commit"
    for fact in facts:
        report, form = fact.report, _form_of(fact)
        arrived_none = bool(report.branches) and not report.pushed_any
        if (
            arrived_none
            or (form is not None and not form.pushed)
            or (form is None and not report.form_listed)
        ):
            return ErrorCode.PUSH_REJECTED, push_failure(fact.workspace.spec.name or "", form)
    return None


def outcomes_of(workspace: MultiWorkspace, *, can_push: bool) -> tuple[RepoOutcome, ...]:
    """The entry of every repository, in the order of the job."""
    return tuple(_outcome(fact, can_push=can_push) for fact in workspace.facts())


def _outcome(fact: MemberFacts, *, can_push: bool) -> RepoOutcome:
    member = fact.workspace
    spec = member.spec
    if not can_push:
        # Nothing leaves the container, so nothing is read or reported of the repository.
        return RepoOutcome(
            name=spec.name or "",
            full_name=spec.full_name or "",
            base=spec.base_branch,
            branch=spec.branch,
            created=member.branch_created,
            base_commit=member.start_commit,
            head_commit=None,
            pushed=False,
        )
    report, form = fact.report, _form_of(fact)
    # The tip the branch was taken over at when it had work on it; the start tip when it did not.
    head = report.form_head or member.start_commit
    on_the_remote_already = (
        fact.reached and report.listed and report.form_listed and not member.branch_created
    )
    # A repository the push did not get to (a lost lease ended it first) says `pushed` false and has
    # no `branches` (`branches=None` below): not attempted, its remote state was not looked at. The
    # contract keeps this ("pushed" in docs/implementer.md); `branches` absent is the flag.
    pushed = form.pushed if form is not None else on_the_remote_already
    commits, commits_cut = member.newest_commits_since_start(MAX_REPO_COMMITS)
    return RepoOutcome(
        name=spec.name or "",
        full_name=spec.full_name or "",
        base=spec.base_branch,
        branch=spec.branch,
        created=member.branch_created,
        base_commit=member.start_commit,
        head_commit=head,
        pushed=pushed,
        commits=tuple(commits),
        files_changed=tuple(member.changed_files()),
        branches=tuple(report.branches) if fact.reached else None,
        branches_dropped=(report.invalid, report.overflow),
        checked_out=member.checked_out,
        commits_truncated=commits_cut,
    )
