# SPDX-License-Identifier: LicenseRef-Proprietary

"""The result of one job: the stable error codes and the JSON the runner prints on stdout."""

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

# The finer name (`errorReason`) of a failure of a job process that held the job and left no usable
# result (#273): the model may have been used and nobody can say how much, so the app counts the run
# with an unknown cost instead of voiding it.
NO_RESULT_REASON = "no_result_from_process"
# The finer name of a failure of a job that a customer's runner ended because it passed the runner's
# disk budget (#855, `factory_runner/disk_budget.py`), next to the code `runner_error`.
DISK_BUDGET_REASON = "disk_budget_exceeded"


# #856: the basis of the cost of a turn that ran on a login of the customer's device.
COST_BASIS_SUBSCRIPTION = "subscription"


class ErrorCode(StrEnum):
    """Stable codes a caller may branch on. Never put free text where a code is expected."""

    # The job itself was refused before PR-Agent was loaded.
    INVALID_JOB = "invalid_job"
    INVALID_COMMAND = "invalid_command"
    # The installed PR-Agent no longer matches what the runner was written and tested against.
    PR_AGENT_VERSION_MISMATCH = "pr_agent_version_mismatch"
    IDENTITY_PATCH_FAILED = "identity_patch_failed"
    # A failure inside the runner itself (a bug, not a property of the job).
    RUNNER_ERROR = "runner_error"
    # PR-Agent ran but reported a failure it handled itself (failure comment, failed flag).
    COMMAND_FAILED = "command_failed"
    LLM_AUTH = "llm_auth"
    LLM_RATE_LIMIT = "llm_rate_limit"
    LLM_TIMEOUT = "llm_timeout"
    LLM_UNAVAILABLE = "llm_unavailable"
    LLM_BAD_REQUEST = "llm_bad_request"
    LLM_QUOTA = "llm_quota"
    LLM_CONTEXT_LENGTH_EXCEEDED = "llm_context_length_exceeded"
    MODEL_UNKNOWN = "model_unknown"
    # The provider has no endpoint that takes every parameter of the request (#477): the model
    # exists, but not for this request. A Diff job asks for required parameters (#270).
    LLM_PARAMETERS_UNSUPPORTED = "llm_parameters_unsupported"
    GIT_AUTH = "git_auth"
    GIT_FORBIDDEN = "git_forbidden"
    GIT_RATE_LIMIT = "git_rate_limit"
    GIT_UNPROCESSABLE = "git_unprocessable"
    GIT_UNAVAILABLE = "git_unavailable"
    GIT_PROVIDER_INIT = "git_provider_init"
    PR_NOT_FOUND = "pr_not_found"
    # The command did not finish within RUNNER_JOB_TIMEOUT_SECONDS.
    TIMEOUT = "timeout"
    # The model answered, but its answer could not be turned into a review.
    LLM_OUTPUT_INVALID = "llm_output_invalid"
    # handle_request returned normally, yet no review comment was recorded (for example because
    # the identity patch no longer matches what GitHub reports).
    REVIEW_NOT_PUBLISHED = "review_not_published"
    # The review comment reached GitHub's size limit and the hidden record of earlier findings no
    # longer fits: the record is not advanced any more, so findings are lost. The review (cut, or a
    # standalone copy) may be on the pull request, and `commentUrl` says where when it can be found.
    REVIEW_STATE_TRUNCATED = "review_state_truncated"
    # The review comment reached GitHub's size limit and part of the visible review was cut off,
    # the record of findings still fits.
    REVIEW_TEXT_TRUNCATED = "review_text_truncated"
    # Dynamic Review (#195). Stable codes a caller branches on; there is never a fallback to Diff.
    DYNAMIC_ENGINE_UNAVAILABLE = "dynamic_engine_unavailable"
    DYNAMIC_ISOLATION_SELF_CHECK_FAILED = "dynamic_isolation_self_check_failed"
    DYNAMIC_CONFIG_INVALID = "dynamic_config_invalid"
    CHECKOUT_INCOMPLETE = "checkout_incomplete"
    DYNAMIC_POLICY_VIOLATION = "dynamic_policy_violation"
    DYNAMIC_BUDGET_EXCEEDED = "dynamic_budget_exceeded"
    DYNAMIC_ACCOUNTING_FAILED = "dynamic_accounting_failed"
    # A Diff run stopped at the cost limit of its project (#666): the cost so far reached it, so no
    # further model request was sent. What the calls cost is reported and billed as usual.
    COST_LIMIT_REACHED = "cost_limit_reached"
    DYNAMIC_MODEL_FEATURES_UNSUPPORTED = "dynamic_model_features_unsupported"
    # The job is not ours any more (its lease was lost, or it was cancelled), or that could not be
    # confirmed right before the summary would have been written (#260). Nothing was written.
    LEASE_LOST = "lease_lost"
    # A newer push replaced this run while it was running (#396). It stopped sending model requests,
    # published nothing and reports what it used. Not a failure of the job.
    SUPERSEDED = "superseded"
    # A member asked for this run to stop (#891). The turn was ended, what was committed was pushed
    # and the usage is reported. Not a failure of the job.
    CANCELLED = "cancelled"
    # The Implementer (#746). Stable codes a caller branches on; a turn that fails is never run
    # again silently. `COST_LIMIT_REACHED` above is the cost limit of a turn as well.
    # `BRANCH_EXISTS` and `BRANCH_VIOLATION` are no longer produced since git is free in the
    # workspace and the final push reports each branch by itself; they stay for the runs that carry
    # them and for older runners (contracts/runner-api.v1.json).
    BRANCH_EXISTS = "branch_exists"
    BASE_BRANCH_NOT_FOUND = "base_branch_not_found"
    CLONE_FAILED = "clone_failed"
    SETUP_FAILED = "setup_failed"
    AGENT_GAVE_UP = "agent_gave_up"
    # #843: the turn had a result schema, and the agent ended without a result that fits it, also
    # after the one reminder. The model was used, so it is charged like `agent_gave_up`.
    NO_RESULT = "no_result"
    PUSH_REJECTED = "push_rejected"
    BRANCH_VIOLATION = "branch_violation"
    TIME_LIMIT_REACHED = "time_limit_reached"
    GIT_WRITE_NOT_GRANTED = "git_write_not_granted"
    IMPLEMENTER_ENGINE_UNAVAILABLE = "implementer_engine_unavailable"
    IMPLEMENTER_CONFIG_INVALID = "implementer_config_invalid"
    # The golden snapshot's Sysbox is not proven (the build's proof did not pass or was not read),
    # so the agent's container does not start; the VM is too small for it (#745, step 4). Free: the
    # model was never used.
    SANDBOX_UNPROVEN = "sandbox_unproven"
    SANDBOX_SIZE_UNSUPPORTED = "sandbox_size_unsupported"
    # #818: the setup script of the environment failed (a non-zero exit, its time limit, the disk)
    # or
    # its result could not be saved as the agent's image. Before the model: free.
    ENVIRONMENT_SETUP_FAILED = "environment_setup_failed"
    # The runner was told to stop (SIGTERM, #765): what is committed was pushed, and the job host
    # gives the job back to the queue under this code.
    RUNNER_SHUTDOWN = "runner_shutdown"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Usage:
    """What the run consumed, as PR-Agent reports it. Cost is None when no call could be priced."""

    model: str | None
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    ai_calls: int
    fallback_used: bool
    cost_usd: float | None
    # Why a Dynamic Review was wrapped up before it was done (`cost_limit`, `time_limit`, #293).
    stopped_early: str | None = None
    # By how much the settled cost passed the operator's cost limit, in USD (#540); None when it did
    # not. The cost guard bounds the excess (see "The bound" in `dynamic_review/budget.py`).
    limit_exceeded_by: float | None = None
    # The per-call trace of a Dynamic Review without content (#541): `usage.callTrace` of the runner
    # API, built by `dynamic_review/call_trace.py`. None for any other run.
    call_trace: dict[str, Any] | None = None
    # #856: a turn on the harness claude-code (a login of the customer's device) is not billed
    # through us: `cost_usd` stays None and `cost_basis` says `subscription`; what Claude Code says
    # the turn is worth at API prices is `estimated_cost_usd` (None: it did not say).
    cost_basis: str | None = None
    estimated_cost_usd: float | None = None

    @property
    def used_the_model(self) -> bool:
        """True when at least one model call was made. A failed result reports usage only then."""
        return self.ai_calls > 0 or self.total_tokens > 0

    def to_json(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "model": self.model,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "totalTokens": self.total_tokens,
            "aiCalls": self.ai_calls,
            "fallbackUsed": self.fallback_used,
            "costUsd": self.cost_usd,
        }
        if self.stopped_early is not None:
            document["stoppedEarly"] = self.stopped_early
        if self.limit_exceeded_by is not None:
            document["limitExceededBy"] = self.limit_exceeded_by
        if self.call_trace is not None:
            document["callTrace"] = self.call_trace
        if self.cost_basis is not None:
            document["costBasis"] = self.cost_basis
            document["estimatedCostUsd"] = self.estimated_cost_usd
        return document


@dataclass(frozen=True)
class ReviewFindings:
    """The findings left open on the pull request after a successful review (#405).

    The app decides the review verdict from this, so it counts what is *open*, not what the run
    found: a Dynamic run carries earlier findings over. `by_severity` is the count per priority
    (`P0` to `P3`) of a Dynamic review and None for a review that has no severities (Diff);
    `open` may be larger than their sum when the summary left lower priority findings out.
    """

    open: int
    by_severity: dict[str, int] | None
    # The review did not cover everything it was asked to (a finding the validation dropped, a chunk
    # that failed, files left out for the token budget): `open` may miss a blocker, so the app never
    # approves on it. Left out of the JSON when False.
    incomplete: bool = False

    def to_json(self) -> dict[str, Any]:
        document: dict[str, Any] = {"open": self.open, "bySeverity": self.by_severity}
        if self.incomplete:
            document["incomplete"] = True
        return document


@dataclass(frozen=True)
class JobResult:
    ok: bool
    duration_ms: int
    comment_url: str | None
    error_code: ErrorCode | None
    log_tail: str
    # True when the log held more than `log_tail` shows (older lines or characters were cut).
    log_truncated: bool = False
    usage: Usage | None = None
    # A finer, stable name for the failure next to `error_code` (for a Dynamic checkout failure
    # the `CheckoutReason`). Never free text; None where a failure has no finer name.
    error_reason: str | None = None
    # The findings left open by a successful review, for the verdict the app submits (#405). None
    # where the runner cannot say (and on every failure): the app then submits no verdict.
    findings: ReviewFindings | None = None
    # What a turn of the Implementer did (`ImplementerResult`, built by `implementer/report.py`).
    # None for every other job, and for a turn that never had a repository: the key is then left
    # out, never sent as null (the app refuses null).
    implementer: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "ok": self.ok,
            "durationMs": self.duration_ms,
            "commentUrl": self.comment_url,
            "errorCode": self.error_code.value if self.error_code else None,
            "logTail": self.log_tail,
            "logTruncated": self.log_truncated,
            "usage": self.usage.to_json() if self.usage else None,
        }
        if self.error_reason is not None:
            document["errorReason"] = self.error_reason
        if self.findings is not None:
            document["findings"] = self.findings.to_json()
        if self.implementer is not None:
            document["implementer"] = self.implementer
        return document

    def to_line(self) -> str:
        """One line of JSON, ASCII only, so nothing in a log can break the framing."""
        return json.dumps(self.to_json(), ensure_ascii=True, separators=(",", ":"))

    @property
    def exit_code(self) -> int:
        return 0 if self.ok else 1
