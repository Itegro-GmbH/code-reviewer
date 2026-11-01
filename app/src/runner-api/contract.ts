// SPDX-License-Identifier: LicenseRef-Proprietary

// The TypeScript side of contracts/runner-api.v1.json. The JSON file is the source of the format;
// these types and sets are written by hand and kept in line with it by
// integration-tests/compatibility/runner-api-contract.integration.test.ts (the sets are compared
// with the file, and real answers and the request checks are validated against it).
import type { ReviewCommand } from "../integrations/types.ts";
import type { JobStatus } from "../db/job-status.ts";
import type { CostPolicyJson } from "../native-cost/policy.ts";
import type { JobModelEntry } from "../models-dev/job-entry.ts";
import {
  PROJECT_REVIEW_KINDS,
  type ProjectReviewKind,
} from "../job-kind/job-kind.ts";
import {
  RUNNER_ENGINES,
  type RunnerEngine,
} from "../jobs/runner-capabilities.ts";

export const RUNNER_API_VERSION = 1 as const;

/** The engines a runner may advertise in a claim (`Engine` in the contract). */
export const CLAIM_ENGINES = RUNNER_ENGINES;
export type ClaimEngine = RunnerEngine;

/**
 * What else a runner may say it understands in a claim (`features` in `ClaimRequest`, #279).
 * `dynamic_capabilities`: it reads `dynamic.capabilities` of a Dynamic job. A job field a previous-release
 * runner would refuse (its job input is closed) is only sent to a runner that names the feature.
 */
export const CLAIM_FEATURES = [
  "dynamic_capabilities",
  // #320: the caller is a Dispatcher and gets the split answer (`SplitClaimResponse`): a per-job
  // credential and no job input, no git token and no model key.
  "worker_credential",
  // #396: the runner stops gracefully when a heartbeat answers `job.superseded`. A running job is superseded by a
  // newer push only when its holder named it (#397); a Worker names it in its job details request.
  "supersede",
  // #553: the runner reads `dynamic.cost` and enforces it (the price book of the managed key, the token cap of an own key).
  // A job that carries a cost policy goes only to a caller that named it.
  "dynamic_cost_policy",
  // #498: the caller is a Dispatcher that reports the VM it creates (`vm_lifecycle`, the App feature of the same name). The
  // App records that it has seen a Dispatcher with and without it: billing is not switched on while one without it claims.
  "vm_lifecycle",
  // #666: the runner reads `llm.maxCostUsd` and enforces it next to the operator's own cost limit. A project cost limit goes
  // only to a caller that named it; any other caller runs the job without it.
  "cost_limit",
  // #689: the runner reads `llm.operatorMaxCostUsd`, the most one review may cost as the operator set it in the admin portal, and
  // holds a review to the smaller of that and `llm.maxCostUsd`. Sent only to a caller that named it; a caller with `cost_limit`
  // alone gets the smaller of the two in `llm.maxCostUsd`, one with neither gets neither (`job-cost-limit.ts`).
  "operator_cost_limit",
] as const;
export type ClaimFeature = (typeof CLAIM_FEATURES)[number];

/**
 * The request body of a claim: which engines the runner can run (absent/empty means `pr-agent`) and which
 * features it understands (absent means none).
 */
export type ClaimRequest = {
  engines?: ClaimEngine[];
  features?: ClaimFeature[];
  /**
   * #424: the LLM providers the runner can run (slugs of its registry). Absent means
   * `DEFAULT_LLM_PROVIDERS`, which is all a previous-release runner can run. Slugs this app has no
   * adapter for are kept: a newer runner may know more than this app.
   */
  llmProviders?: string[];
  /** #322: claim exactly this job (a Dispatcher woken by the dispatch webhook). */
  jobId?: string;
  /** #322: the pool cap: 204 while this many jobs of the caller's `X-Runner-Id` are running. */
  maxRunning?: number;
};

/**
 * #424: the form of an LLM provider slug (`LlmProviderId` in the contract): `llm.provider` of a job
 * and the items of `llmProviders`. Whether a slug is usable is the registry's decision
 * (`src/llm/providers`), not the contract's.
 */
export const LLM_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
/** #424: what a caller that advertised no providers can run: the only provider before the registry. */
export const DEFAULT_LLM_PROVIDERS = ["openrouter"] as const;
/** #424: the bound of `llmProviders` (and of the Worker's list). */
export const MAX_LLM_PROVIDERS = 16;

/** #322: the range of `ClaimRequest.maxRunning`. */
export const MAX_RUNNING_RANGE = { min: 1, max: 1000 } as const;

/**
 * #322: what this app lists in `VersionResponse.features` (`KnownAppFeature` in the contract). A
 * Dispatcher reads the list before it claims, so an app that lacks one of them (a previous release,
 * which would ignore `jobId` and `maxRunning`) is never asked.
 */
export const APP_FEATURES = [
  "worker_api",
  "claim_by_job_id",
  "pool_cap",
  "release",
  "vm_lifecycle",
] as const;
export type AppFeature = (typeof APP_FEATURES)[number];

/** #322: 200 from `GET /api/runners/v1/version` (`VersionResponse`). */
export type VersionResponse = {
  version: typeof RUNNER_API_VERSION;
  appVersion: string;
  features: AppFeature[];
};

/**
 * #322: the body of `POST /api/runners/v1/jobs/{id}/release` (`ReleaseRequest`): the per-job credential of
 * the claim, why the job is given back and, optionally, how long it must not be offered again.
 */
export type ReleaseRequest = {
  credential: string;
  reason: string;
  retryAfterSeconds?: number;
};

/** #322: the range of `ReleaseRequest.retryAfterSeconds`. */
export const RELEASE_RETRY_AFTER_RANGE = { min: 1, max: 86_400 } as const;

/** #322: 200 from the release (`ReleaseResponse`). */
export type ReleaseResponse = {
  version: typeof RUNNER_API_VERSION;
  job: { id: string; status: "queued" | "failed" };
};

/**
 * #493: the body of `POST /api/runners/v1/jobs/{id}/vm` (`VmStartRequest`): the Dispatcher says that it created the VM of
 * the claim. Closed. The per-job credential proves the claim; `startedAt` is the Dispatcher's clock (the App keeps it
 * between the claim and its own clock); `timeoutSeconds` is the VM's own timeout, the platform's backstop.
 */
export type VmStartRequest = {
  credential: string;
  vmName: string;
  startedAt: string;
  timeoutSeconds: number;
};

/** #493: the name of a VM (`VmName`): the platform's, as the Dispatcher stops it. */
export const VM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** #493: `startedAt` is ISO 8601 in UTC with the `Z`, milliseconds optional (`VmStartRequest.startedAt`). */
export const VM_STARTED_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/** #493: the range of `VmStartRequest.timeoutSeconds`. */
export const VM_TIMEOUT_SECONDS_RANGE = { min: 60, max: 86_400 } as const;

/** #493: 200 from the report (`VmStartResponse`). `replayed`: the VM was known; nothing changed. */
export type VmStartResponse = {
  version: typeof RUNNER_API_VERSION;
  status: "recorded" | "replayed";
};

/**
 * #364: 200 from `GET /api/runners/v1/jobs/{id}` (`JobStateResponse`): the status of a job and nothing else, for a
 * Dispatcher that decides whether the VM of a job is a leftover.
 */
export type JobStateResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    status: JobStatus;
    /** #397: a superseded job whose claim is still valid (its Worker drains). Left out otherwise. */
    draining?: true;
  };
};

/** The path prefix of this version; the version is part of the URL. */
export const RUNNER_API_PATH = "/api/runners/v1" as const;

/** #320: the path prefix of the Worker API, which a per-job credential (not the runner token) opens. */
export const WORKER_API_PATH = "/api/workers/v1" as const;

/** #320: how many times the Worker of one claim may fetch the job details (each mints a fresh token). */
export const MAX_WORKER_FETCHES = 3;

/** Every request body is read up to this size; a larger one is refused with 413. */
export const RUNNER_MAX_BODY_BYTES = 64 * 1024;

/** How often a runner should send a heartbeat (the lease is four times as long). */
export const HEARTBEAT_INTERVAL_SECONDS = 30;

/**
 * The environment variables a job may carry: the options of the PR-Agent tools, one option name per
 * key (a second `__` would address a nested value). The app only ever sends the review tool's family
 * (`toRunnerSettings`); the removed tools' families are accepted for v1 compatibility with a
 * previous-release app and ignored by the runner. The same pattern as `propertyNames` of `JobEnv` in
 * the contract and as the runner's `_ENV_KEY` (a test compares it with the contract).
 */
export const RUNNER_ENV_KEY_PATTERN =
  /^(PR_REVIEWER|PR_DESCRIPTION|PR_CODE_SUGGESTIONS|PR_QUESTIONS)__[A-Z0-9]+(_[A-Z0-9]+)*$/;

/** Error codes the runner reports in a result (`KnownRunnerErrorCode` in the contract). */
export const RUNNER_ERROR_CODES = [
  "invalid_job",
  "invalid_command",
  "pr_agent_version_mismatch",
  "identity_patch_failed",
  "runner_error",
  "command_failed",
  "review_not_published",
  "review_state_truncated",
  "review_text_truncated",
  "pr_not_found",
  "git_auth",
  "git_forbidden",
  "git_rate_limit",
  "git_unavailable",
  "git_unprocessable",
  "git_provider_init",
  "llm_auth",
  "llm_quota",
  "llm_rate_limit",
  "llm_timeout",
  "llm_unavailable",
  "llm_bad_request",
  "llm_context_length_exceeded",
  "llm_output_invalid",
  "model_unknown",
  "llm_parameters_unsupported",
  "timeout",
  "runner_shutdown",
  "unknown",
  // Dynamic Review (#195). Stable codes a caller may branch on; never a fallback to Diff.
  "dynamic_engine_unavailable",
  "dynamic_isolation_self_check_failed",
  "dynamic_config_invalid",
  "checkout_incomplete",
  "dynamic_policy_violation",
  "dynamic_budget_exceeded",
  "dynamic_accounting_failed",
  "dynamic_model_features_unsupported",
  // #666: a Diff Review that sent no further model request because its cost had reached the cost limit of the project.
  "cost_limit_reached",
  "lease_lost",
  // #396: the run was replaced by a newer push; it stopped gracefully and reports what it used.
  "superseded",
  // #746: the Implementer (the factory deployment only). Stable codes a caller branches on; a turn that fails is never
  // run again silently. `cost_limit_reached` above is the cost limit of a turn as well.
  "branch_exists",
  "base_branch_not_found",
  "clone_failed",
  "setup_failed",
  "agent_gave_up",
  "push_rejected",
  "branch_violation",
  "time_limit_reached",
  "git_write_not_granted",
  "implementer_engine_unavailable",
  "implementer_config_invalid",
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

/**
 * Why a Dynamic Review checkout failed (`KnownCheckoutReason` in the contract), reported next to the
 * code `checkout_incomplete`. A reader accepts any name of the right form and shows an unknown one
 * with a general sentence.
 */
export const RUNNER_CHECKOUT_REASONS = [
  "invalid_request",
  "ref_moved",
  "ref_missing",
  "protocol",
  "pack_invalid",
  "object_missing",
  "tree_invalid",
  "entries",
  "path_invalid",
  "budget_transfer",
  "budget_preparation",
  "budget_exposed",
  "diff_too_large",
  "input_too_large",
  "cancelled",
  "timeout",
  "transport",
  "isolation",
  "context",
] as const;
export type RunnerCheckoutReason = (typeof RUNNER_CHECKOUT_REASONS)[number];

/** The codes the API answers with (`ApiErrorCode` in the contract). */
export const RUNNER_API_ERROR_CODES = [
  "RUNNER_UNAUTHORIZED",
  "RUNNER_ID_INVALID",
  "RUNNER_REQUEST_INVALID",
  "RUNNER_JOB_NOT_FOUND",
  "RUNNER_LEASE_LOST",
  "RUNNER_RESULT_CONFLICT",
  "RUNNER_BODY_TOO_LARGE",
  "RUNNER_GIT_ACCESS_UNAVAILABLE",
  "RUNNER_INTERNAL_ERROR",
  // The Worker API (#318, served from #320): a credential that is not the job's, and a job the app ended.
  "WORKER_CREDENTIAL_INVALID",
  "RUNNER_JOB_ENDED",
] as const;
export type RunnerApiErrorCode = (typeof RUNNER_API_ERROR_CODES)[number];

export type FieldErrorCode = "required" | "invalid" | "too_long";
export type FieldError = { field: string; code: FieldErrorCode };

export type ErrorResponse = {
  error: {
    code: RunnerApiErrorCode;
    message: string;
    fields?: FieldError[];
    retryAfterSeconds?: number;
  };
};

/**
 * The kinds of job on the wire (`ReviewKind` in the contract): the kinds a project can select and, since #746, the
 * Implementer's `implementer`. A project never selects the last one (`PROJECT_REVIEW_KINDS` stays `diff` and `dynamic`).
 */
export const RUNNER_REVIEW_KINDS = [
  ...PROJECT_REVIEW_KINDS,
  "implementer",
] as const;
export type ReviewKind = (typeof RUNNER_REVIEW_KINDS)[number];

/**
 * #746: the names of the environment variables the Worker container of an implementer job gets
 * (`KnownImplementerEnvironmentName` in the contract). The Dispatcher sets them; they hold no secret.
 */
export const IMPLEMENTER_ENVIRONMENT_NAMES = [
  "RUNNER_IMPLEMENTER_WORK_DIR",
  "RUNNER_IMPLEMENTER_EGRESS_PORT",
  "RUNNER_IMPLEMENTER_NETWORK",
] as const;
export type ImplementerEnvironmentName =
  (typeof IMPLEMENTER_ENVIRONMENT_NAMES)[number];

/** #746: what the Worker of an implementer job can reach besides the model proxy and its repository (`ImplementerNetworkMode`). */
export const IMPLEMENTER_NETWORK_MODES = ["registries", "none"] as const;
export type ImplementerNetworkMode = (typeof IMPLEMENTER_NETWORK_MODES)[number];

/** #746: the directory of the work volume (`RUNNER_IMPLEMENTER_WORK_DIR`). */
export const IMPLEMENTER_WORK_DIR = "/work";

/**
 * The Dynamic options of a tagged job (#195). Only model/skill/limits: the fixed core, the tools, the
 * permissions, the endpoints and the executable command are runner-owned and never arrive here. The
 * skill is literal data.
 */
export type DynamicReviewOptions = {
  model: string;
  skill: string;
  limits: { maxFindings: number };
  /**
   * #279: what the provider's model metadata says the model can do. Optional and sent only to a runner
   * that advertised the `dynamic_capabilities` feature; a previous-release runner has a closed job
   * contract and would refuse the key.
   */
  capabilities?: DynamicModelCapabilities;
  /**
   * #553: whose key pays and what bounds the cost of a native job (`DynamicCostPolicy` in the contract): the confirmed price
   * book of the managed key, the token cap of an own key. Optional and sent only to a runner that advertised the
   * `dynamic_cost_policy` feature; a job without it is a job of today.
   */
  cost?: CostPolicyJson;
  /**
   * #578: the provider and the one model of a native job (`JobModelEntry`, contracts/job-model-entry.v1.json): the entry the
   * runner turns into the provider block of the engine's configuration. No key. Sent exactly when `cost` is.
   */
  modelEntry?: JobModelEntry;
};

/** `DynamicModelCapabilities` in the contract. Prices are exact decimal text, US dollars per million tokens. */
export type DynamicModelCapabilities = {
  toolChoiceRequired: boolean;
  structuredOutput: boolean;
  maxOutputTokens: number;
  contextWindowTokens: number;
  inputUsdPerMtok?: string;
  outputUsdPerMtok?: string;
};

/**
 * The checkout facts a Dynamic job carries (#195/#196), all pinned when the job was queued or claimed.
 * `comparison` is the declared comparison mode; it is a hint for preparation, never proof that the
 * comparison is complete — the runner's checkout verifies that before it trusts it.
 */
export type ClaimBase = {
  repository: string;
  baseRef: string;
  headSha: string;
  previousReviewedSha: string | null;
  /** #255: heads of earlier jobs of the pull request that did not succeed, newest first; absent when none. */
  attemptedShas?: string[];
  /**
   * #257: true when more heads were attempted than `attemptedShas` holds; absent means false. Only
   * `true` or absent on purpose: the app is stricter than the contract (the schema and the runner
   * accept a boolean), and a runner from before #257 rejects the key, so `false` is never sent.
   */
  attemptedShasTruncated?: true;
  comparison: "full" | "incremental";
};

/** The job as the runner reads it on stdin. Contains secrets: only the claim response has it. */
export type RunnerJobInput = {
  prUrl: string;
  command: ReviewCommand;
  /**
   * #195: absent means Diff, the legacy shape. `dynamic` is only sent to a runner that advertised
   * `opencode`; a previous-release runner never receives it.
   */
  reviewKind?: ProjectReviewKind;
  /** Present exactly when `reviewKind` is `dynamic`. */
  dynamic?: DynamicReviewOptions;
  /** Checkout facts; present with `dynamic`. */
  base?: ClaimBase;
  git: {
    provider: "github";
    baseUrl: string;
    token: string;
    botLogin: string;
  };
  llm: {
    /** A slug of the registry (`LlmProviderId`); the claim sends `openrouter` for now. */
    provider: string;
    model: string;
    apiKey: string;
    /** The token budget of the review (#689: decided by the app from the model's context window, `model-catalog/token-budget.ts`; no setting). */
    maxTokens?: number;
    /**
     * #666: the cost limit of the project in US dollars (whole cents), left out when none is set. Sent only to a caller that
     * advertised the `cost_limit` feature; a previous-release runner has a closed job contract and would refuse the key.
     */
    maxCostUsd?: number;
    /**
     * #689: the most one review may cost as the operator set it in the admin portal, in US dollars (whole cents). Sent only to a
     * caller that advertised `operator_cost_limit`; the runner holds a review to the smaller of this and `maxCostUsd`.
     */
    operatorMaxCostUsd?: number;
    /** Not sent by the app in the MVP (no fallback chain). The runner accepts it. */
    fallbackModels?: string[];
  };
  env: Record<string, string>;
};

/** #746: `ImplementerJob` in the contract: what a turn of the Implementer asks for. A closed object. */
export type ImplementerJobOptions = {
  repo: { fullName: string; cloneUrl: string };
  baseBranch: string;
  branch: string;
  /** The task as the user wrote it, at most 20 000 characters; literal data. */
  instruction: string;
  limits: { timeLimitSeconds: number };
  /** The cost policy and the model entry of the native Dynamic job, unchanged. */
  cost: CostPolicyJson;
  modelEntry: JobModelEntry;
  capabilities?: DynamicModelCapabilities;
};

/**
 * #746: the job an implementer runner reads on stdin. It has no pull request: `prUrl`, `command`, `base` and `dynamic` are
 * absent, and `git.token` may write the contents of exactly `implementer.repo`. The claim builds it (#753).
 */
export type ImplementerJobInput = Omit<
  RunnerJobInput,
  "prUrl" | "command" | "reviewKind" | "dynamic" | "base" | "args"
> & {
  reviewKind: "implementer";
  implementer: ImplementerJobOptions;
  // Absent, and said so, so that code that handles either input can read these without narrowing first (#753).
  prUrl?: undefined;
  command?: undefined;
  dynamic?: undefined;
  base?: undefined;
};

/** #753: the input of a job as a claim or a Worker's fetch hands it out: a review's, or a turn's. */
export type AnyJobInput = RunnerJobInput | ImplementerJobInput;

export type ClaimResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    leaseToken: string;
    leaseExpiresAt: string;
    heartbeatIntervalSeconds: number;
    tokenExpiresAt: string | null;
    input: AnyJobInput;
  };
};

/**
 * #320: the answer of a claim that names the feature `worker_credential` (`SplitClaimResponse`). The
 * Dispatcher gets the per-job credential and no job input: the git token and the model key reach only
 * the Worker, which fetches them with the credential (`WorkerJobDetailsResponse`).
 */
export type SplitClaimResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    credential: string;
    reviewKind: ReviewKind;
    leaseExpiresAt: string;
    heartbeatIntervalSeconds: number;
  };
};

/** #320: 200 from `GET /api/workers/v1/jobs/{id}` (`WorkerJobDetailsResponse`). */
export type WorkerJobDetailsResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    leaseExpiresAt: string;
    heartbeatIntervalSeconds: number;
    tokenExpiresAt: string | null;
    input: AnyJobInput;
  };
};

/** #320: the body of `POST /api/workers/v1/jobs/{id}/result` (`WorkerResultRequest`). */
export type WorkerResultRequest = { result: RunnerResult };

export type HeartbeatRequest = { leaseToken: string };

export type HeartbeatResponse = {
  version: typeof RUNNER_API_VERSION;
  job: {
    id: string;
    heartbeatAt: string;
    leaseExpiresAt: string;
    /** #396: a newer push replaced this run (only for a claim that named the feature `supersede`). */
    superseded?: boolean;
  };
};

export type RunnerUsage = {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aiCalls: number;
  fallbackUsed: boolean;
  costUsd: number | null;
  /** Why a Dynamic Review was wrapped up before it was done (#293); null for a complete run. */
  stoppedEarly: StoppedEarly | null;
  /** #540: by how much, in US dollars, the cost passed the operator's cost limit; absent when it did not. */
  limitExceededBy?: number;
  /** What each call was, without content (#541). Absent for a runner that sends none and for a Diff Review. */
  callTrace?: RunnerCallTrace;
};

/** The engine's tools as the trace names them; every other tool a model called is `other` (#541). */
export const TRACE_TOOL_NAMES = [
  "read",
  "grep",
  "glob",
  "StructuredOutput",
  "other",
] as const;
export type TraceToolName = (typeof TRACE_TOOL_NAMES)[number];
/** Why a model call ended, as the trace names it; null when the provider said nothing. */
export const TRACE_FINISH_REASONS = [
  "stop",
  "tool_calls",
  "length",
  "content_filter",
  "other",
] as const;
export type TraceFinishReason = (typeof TRACE_FINISH_REASONS)[number];
/** At most this many model calls and this many tool calls are kept in a trace (the first ones). */
export const MAX_TRACE_ENTRIES = 100;

/** One model call of the trace (#541). A count is null when the provider reported none. */
export type RunnerModelCallTrace = {
  index: number;
  /** Milliseconds from the start of the run to the start of the call. */
  tMs: number;
  promptTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  finishReason: TraceFinishReason | null;
  /** The call the run was wrapped up with. */
  final: boolean;
  tools: { name: TraceToolName; count: number }[];
};

/** One tool call of the trace (#541). The arguments are never sent. */
export type RunnerToolCallTrace = {
  index: number;
  name: TraceToolName;
  /** The size of the result the model was shown; null when it never was. */
  resultBytes: number | null;
  /** The same tool with the same normalised arguments already ran in this job. */
  isRepeat: boolean;
};

/** #541: what each call of a Dynamic Review was, as numbers and stable names; no path, argument or content. */
export type RunnerCallTrace = {
  truncated: boolean;
  modelCalls: RunnerModelCallTrace[];
  toolCalls: RunnerToolCallTrace[];
};

/** The reasons a Dynamic Review stops early: its cost limit or its time limit. */
export const STOPPED_EARLY_REASONS = [
  "cost_limit",
  // #666: the cost limit of the project, when it is the smaller of the two.
  "project_cost_limit",
  "time_limit",
  // #553: an own key whose price is not known is bound by tokens.
  "token_limit",
] as const;
export type StoppedEarly = (typeof STOPPED_EARLY_REASONS)[number];

/** The priorities of a Dynamic Review's findings, highest first (#195); `P0` is the one that blocks (#405). */
export const FINDING_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export type FindingPriority = (typeof FINDING_PRIORITIES)[number];

/**
 * #405: what a successful review left open on the pull request. `open` counts the findings open AFTER the run;
 * `bySeverity` is the count per priority of the findings a Dynamic summary lists (so it may add up to less than
 * `open`), and null for a Diff Review, whose findings have no severity.
 */
export type ReviewFindings = {
  open: number;
  bySeverity: Record<FindingPriority, number> | null;
  /** True when the review did not cover everything (a dropped finding, a failed chunk): `open` may miss a blocker. */
  incomplete?: true;
};

/** The largest count a runner may report; the same bound as the schema. */
export const MAX_FINDING_COUNT = 100_000;

/** The result of a job as the runner reports it, after the checks and with every field filled. */
export type RunnerResult = {
  ok: boolean;
  durationMs: number;
  commentUrl: string | null;
  /** null if and only if `ok`. Any code of the right form is accepted; see `RUNNER_ERROR_CODES`. */
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * The stable finer name of a failure (a `RUNNER_CHECKOUT_REASONS` entry for a checkout failure);
   * absent when the runner gave none. Any name of the right form is accepted.
   */
  errorReason?: string;
  logTail: string;
  logTruncated: boolean;
  usage: RunnerUsage | null;
  /** #405: the findings left open by a successful review; absent where the runner could not say. */
  findings?: ReviewFindings;
  /** #746: what a turn of the Implementer did; only a result of an implementer job carries it. */
  implementer?: ImplementerResult;
};

/** What happened to a file between the base commit and the head commit (`ImplementerFileStatus`). */
export const IMPLEMENTER_FILE_STATUSES = [
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "typechange",
] as const;
export type ImplementerFileStatus = (typeof IMPLEMENTER_FILE_STATUSES)[number];

/** The bounds of `ImplementerResult`, the same as the schema. */
export const IMPLEMENTER_RESULT_LIMITS = {
  commits: 200,
  filesChanged: 500,
  summaryChars: 8192,
} as const;

/**
 * The most a complete or result body of a turn of the Implementer can be and still be within `IMPLEMENTER_RESULT_LIMITS` (#754).
 * The runner writes JSON with every non-ASCII character escaped (`ensure_ascii`), which makes a code point outside the Basic
 * Multilingual Plane 12 bytes (two escapes), so every counted character is taken as 12 bytes: the commits (a sha and a subject of
 * 500), the files (a path of 4096), the summary, and the log tail and error message of any result (8192 and 2000, the limits of
 * `requests.ts`). The structure around them is counted generously, and the usage with its call trace keeps the 64 KiB every kind
 * has. Only the app's reading of this kind changes: the limit for Diff and Dynamic is `RUNNER_MAX_BODY_BYTES` as before. A
 * platform may limit a request body below this before the app sees it.
 */
export const IMPLEMENTER_MAX_BODY_BYTES =
  RUNNER_MAX_BODY_BYTES +
  12 *
    (IMPLEMENTER_RESULT_LIMITS.commits * (500 + 48) +
      IMPLEMENTER_RESULT_LIMITS.filesChanged * (4096 + 32) +
      IMPLEMENTER_RESULT_LIMITS.summaryChars +
      (8192 + 2000));

/** #746: `ImplementerResult` in the contract: facts the runner measured in the repository, and a plain-text summary. */
export type ImplementerResult = {
  baseCommit: string;
  headCommit: string | null;
  pushed: boolean;
  commits: { sha: string; subject: string }[];
  filesChanged: { path: string; status: ImplementerFileStatus }[];
  summary: string;
  opencode: { sessionId: string; version: string } | null;
};

export type CompleteRequest = { leaseToken: string; result: RunnerResult };

export type CompleteResponse = {
  version: typeof RUNNER_API_VERSION;
  /**
   * `queued`: the runner reported `runner_shutdown`, the job was given back and waits again (it fails
   * instead when that was the last allowed attempt).
   */
  job: {
    id: string;
    status: "succeeded" | "failed" | "queued" | "superseded";
  };
  alreadyCompleted: boolean;
};
