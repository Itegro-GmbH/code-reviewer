// SPDX-License-Identifier: LicenseRef-Proprietary

// Generated from contracts/runner-api.v1.json. Do not edit: change the schema and run `make generate-contracts`.
// `make verify` fails while this file differs from what the schema generates.

/**
 * ISO 8601, UTC.
 */
export type Timestamp = string;
/**
 * The id of a job (a UUID).
 */
export type JobId = string;
/**
 * Proof that the caller holds the job. New for every claim; required by heartbeat and complete. Secret: never log it.
 */
export type LeaseToken = string;
/**
 * The commands the product executes. Since the removal of /ask, /improve and /describe only /review exists (a historical run keeps its original command in the database, never on the wire).
 */
export type Command = "review";
/**
 * An engine a runner can run and may advertise in a claim (#195). pr-agent runs Diff Review, opencode runs Dynamic Review. #746: implementer runs the Implementer (reviewKind implementer, a session that changes a branch of a repository); a runner advertises it only when its start-up self-check proved the Implementer prerequisites. An empty legacy claim means pr-agent only; a runner only advertises an engine its fail-closed startup self-check proved.
 */
export type Engine = "pr-agent" | "opencode" | "implementer";
/**
 * The review kind a job was queued for (#195), pinned at enqueue time. Absent on a legacy Diff payload means diff. A runner is only handed a job whose kind one of its engines can run, and a Dynamic job is never silently run by PR-Agent. #746: `implementer` is a turn of the Implementer (the factory deployment only): its input has no pull request (`prUrl`, `command`, `base` and `dynamic` are absent) and carries the closed `implementer` object; only a runner that advertised the engine `implementer` is handed one, and a job of this kind is never run by another engine.
 */
export type ReviewKind = "diff" | "dynamic" | "implementer";
/**
 * #424: the slug of an LLM provider, as in the registries of the app and of the runner. The form only: whether a slug is usable is decided by the registry of the side that reads it.
 */
export type LlmProviderId = string;
/**
 * #424: the providers this release of the contract knows. The registry of the runner (llm_providers.py) and the one of the app (app/src/llm/providers) each list exactly these, and tests compare the three. A provider is added here with the change that adds its adapter.
 */
export type KnownLlmProvider = "openrouter" | "anthropic";
/**
 * The claim features this version of the contract defines (`features` in ClaimRequest). A reader ignores a feature name it does not know. `dynamic_capabilities` (#279): the runner reads `dynamic.capabilities`. `worker_credential` (#318): the caller is a Dispatcher and wants the split answer; the job input and its secrets reach only the Worker, with the per-job credential. `supersede` (#396): the runner understands `job.superseded` in a heartbeat answer and stops gracefully (it finishes the model requests in flight, sends no more, publishes nothing, reports its result and usage). The app supersedes a running job only when the claim named it. A Worker names it in the `features` of its details request. `dynamic_cost_policy` (#553): the runner reads `dynamic.cost` and enforces it (the price book of the managed key as the only price source, the token cap of an own key). A job that carries a cost policy goes only to a caller that named it; the app ends the job with `dynamic_engine_unavailable` otherwise, since a runner that did not read the policy would run without its bound. `vm_lifecycle` (#498): the caller is a Dispatcher that reports the VM it creates to the app (POST /api/runners/v1/jobs/{id}/vm, `KnownAppFeature` of the same name) so the app can measure billable minutes; the app records that it has seen a Dispatcher with and without it, and refuses to switch billing on while a Dispatcher without it has claimed recently. `cost_limit` (#666): the runner reads `llm.maxCostUsd` and enforces it next to the operator's own limit. The app sends it only to a caller that named it; a caller without it gets the job without the field and runs with the operator's own limit alone (a refused review is worse than a project limit that is not kept while a release rolls out), and the app logs that. A Worker names it in the `features` of its details request. `operator_cost_limit` (#689): the runner reads `llm.operatorMaxCostUsd`, the most one review may cost as the operator set it in the admin portal, and holds a review to the smaller of that and `llm.maxCostUsd`; it no longer reads `RUNNER_DYNAMIC_MAX_COST_USD` for a job that carries the field. The app sends it only to a caller that named it. A caller that names `cost_limit` alone gets the smaller of the two in `llm.maxCostUsd`; a caller that names neither gets neither field, and the app logs that. A Worker names it in the `features` of its details request.
 */
export type KnownClaimFeature =
  | "dynamic_capabilities"
  | "worker_credential"
  | "supersede"
  | "dynamic_cost_policy"
  | "vm_lifecycle"
  | "cost_limit"
  | "operator_cost_limit";
/**
 * #318: the per-job credential. 256 random bits, base64url without padding, behind the prefix `crj_`. The app mints it at claim; it is valid only for that job and only while the claim holds, and it is the one thing a Worker holds (Authorization: Bearer). Secret: never log it, never put it in an argument, an environment variable or a file; the Dispatcher passes it to the Worker on stdin.
 */
export type WorkerCredential = string;
/**
 * US dollars per million tokens as an exact decimal text (no exponent, no sign), for example "0.02016". Zero is a free model.
 */
export type UnitPrice = string;
/**
 * #553: whose key pays for a native job (a job that runs through the passthrough proxy) and what bounds its cost. Optional, additive, and sent only to a caller that named the claim feature `dynamic_cost_policy`; a job without it is a job of today. A closed object. `managed` (the instance operator's key, which we pay): `priceBook` is the confirmed price of the model (the app's price confirmation, #549) and is the runner's **only** price source, never the engine's own cost and never models.dev; an unknown cost ends the run with `dynamic_accounting_failed`, which billing treats as our fault; there is no token cap. `own` (the workspace's key, the user pays the provider): `priceBook` is the catalog's price when it states one, else null; an unknown cost does not end the run, it is bound by `maxTotalTokens` (prompt, cache and completion tokens in all) and the clock, and the result reports `costUsd: null`, which billing charges as minutes only. A call that stated no usage at all still fails the run.
 */
export type DynamicCostPolicy =
  | {
      keyMode: "managed";
      priceBook: DynamicPriceBook;
      maxTotalTokens: null;
    }
  | {
      keyMode: "own";
      priceBook: DynamicPriceBook | null;
      maxTotalTokens: number;
    };
/**
 * #553: a price in whole micro-USD per million tokens as digits only (2.50 USD is "2500000"); at most 100000 USD per million tokens.
 */
export type MicroUsdPerMtok = string;
/**
 * Why a Dynamic Review checkout failed (CheckoutReason in the runner), reported as errorReason next to the code checkout_incomplete. A caller branches on the reason, never on a message. The app accepts any reason of the form below and shows an unknown one with a general sentence.
 */
export type KnownCheckoutReason =
  | "invalid_request"
  | "ref_moved"
  | "ref_missing"
  | "protocol"
  | "pack_invalid"
  | "object_missing"
  | "tree_invalid"
  | "entries"
  | "path_invalid"
  | "budget_transfer"
  | "budget_preparation"
  | "budget_exposed"
  | "diff_too_large"
  | "input_too_large"
  | "cancelled"
  | "timeout"
  | "transport"
  | "isolation"
  | "context";
/**
 * The error codes the runner reports in a result (ErrorCode in the runner, plus runner_shutdown from the job loop). #746 adds the codes of the Implementer: `branch_exists` (the branch to create is already on the remote), `base_branch_not_found`, `clone_failed`, `setup_failed` (the repository's own set-up did not run), `agent_gave_up` (the agent ended without a result it stands behind), `push_rejected` (the remote refused the push), `branch_violation` (the work left the branch it was given), `time_limit_reached` and the existing `cost_limit_reached` (the two limits of the turn), `git_write_not_granted` (the token cannot write contents of the repository), `implementer_engine_unavailable` (no engine of the runner runs the kind) and `implementer_config_invalid` (the turn's options cannot be used). A caller branches on the code, never on a message. The app accepts any code of the form below and stores an unknown one as 'unknown' (the original stays in the stored result), so a newer runner never loses a result.
 */
export type KnownRunnerErrorCode =
  | "invalid_job"
  | "invalid_command"
  | "pr_agent_version_mismatch"
  | "identity_patch_failed"
  | "runner_error"
  | "command_failed"
  | "review_not_published"
  | "review_state_truncated"
  | "review_text_truncated"
  | "pr_not_found"
  | "git_auth"
  | "git_forbidden"
  | "git_rate_limit"
  | "git_unavailable"
  | "git_unprocessable"
  | "git_provider_init"
  | "llm_auth"
  | "llm_quota"
  | "llm_rate_limit"
  | "llm_timeout"
  | "llm_unavailable"
  | "llm_bad_request"
  | "llm_context_length_exceeded"
  | "llm_output_invalid"
  | "model_unknown"
  | "llm_parameters_unsupported"
  | "timeout"
  | "runner_shutdown"
  | "unknown"
  | "dynamic_engine_unavailable"
  | "dynamic_isolation_self_check_failed"
  | "dynamic_config_invalid"
  | "checkout_incomplete"
  | "dynamic_policy_violation"
  | "dynamic_budget_exceeded"
  | "dynamic_accounting_failed"
  | "dynamic_model_features_unsupported"
  | "cost_limit_reached"
  | "lease_lost"
  | "superseded"
  | "branch_exists"
  | "base_branch_not_found"
  | "clone_failed"
  | "setup_failed"
  | "agent_gave_up"
  | "push_rejected"
  | "branch_violation"
  | "time_limit_reached"
  | "git_write_not_granted"
  | "implementer_engine_unavailable"
  | "implementer_config_invalid";
/**
 * Exactly the job the runner reads on stdin (see runner/src/code_reviewer_runner/job.py). Closed: the runner refuses unknown fields. Contains secrets (git.token, llm.apiKey): only the claim response carries it. #746: for `reviewKind: implementer` the job carries the `implementer` object instead of `prUrl`, `command`, `base` and `dynamic`; `git.token` is then a token that may write the contents of exactly the repository named in `implementer.repo` and nothing else.
 */
export type RunnerJobInput = {
  [k: string]: unknown;
} & {
  prUrl?: string;
  command?: Command;
  reviewKind?: ReviewKind;
  dynamic?: DynamicReview;
  base?: ClaimBase;
  implementer?: ImplementerJob;
  /**
   * Legacy field of the removed /ask command. A previous release may send it; the runner accepts and ignores it and never hands it to PR-Agent. This app sends no args.
   *
   * @maxItems 1
   */
  args?: [] | [string];
  git: {
    provider: "github";
    baseUrl: string;
    token: string;
    botLogin: string;
  };
  llm: {
    /**
     * #424: the slug of an LLM provider, as in the registries of the app and of the runner. The form only: whether a slug is usable is decided by the registry of the side that reads it.
     */
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    /**
     * The token budget of a review (it also bounds the fallback models, so it must fit the smallest window of the chain). #689: it is no setting of a workspace or a project any more; the app decides it for every job from the context window of the model (100000, or the window when that is smaller). The field and its bounds are unchanged, so a runner of either release reads a job of either.
     */
    maxTokens?: number;
    /**
     * #666: the cost limit the customer set for a review of the project (the project's setting over the workspace default), in US dollars: a number above 0 and at most 100, in whole cents. Optional and additive, and sent only to a caller that named the claim feature `cost_limit`; a job without it is a job of today. A Dynamic Review is held to the smaller of this and the operator's own limit (`RUNNER_DYNAMIC_MAX_COST_USD`): it is wrapped up and delivers its review, and names `project_cost_limit` in `usage.stoppedEarly` when this limit is the one that stopped it. A Diff Review sends no further model request once what it has cost reaches this (one call is never cut short) and ends with `cost_limit_reached`. Both report and bill what the calls really cost.
     */
    maxCostUsd?: number;
    /**
     * #689: the most one review may cost as the operator set it in the admin portal ("Maximum cost per review"), in US dollars: a number above 0 and at most 100, in whole cents. It applies to both review kinds and is the customer's maximum: the review is held to the smaller of this and `maxCostUsd`. Optional and additive, and sent only to a caller that named the claim feature `operator_cost_limit`. A job that carries it ignores `RUNNER_DYNAMIC_MAX_COST_USD`, which stays the runner's fallback for a job from an app that does not send it (and a Diff Review then has no operator limit).
     */
    operatorMaxCostUsd?: number;
    /**
     * Models to try, in order, when the main model fails. Optional; the app does not send it in the MVP (no fallback chain is decided), the runner accepts it.
     *
     * @maxItems 5
     */
    fallbackModels?:
      | []
      | [string]
      | [string, string]
      | [string, string, string]
      | [string, string, string, string]
      | [string, string, string, string, string];
  };
  env: JobEnv;
};
/**
 * #746: the name of a branch as a job carries it: a non-empty text of at most 255 characters without whitespace and not starting with a dash (so it can never be read as an option). Whether it is a valid git ref name is decided by the app when the turn is submitted and again by the runner before it runs git; this is the floor both share.
 */
export type ImplementerBranchName = string;
/**
 * #746: what happened to a file between the base commit and the head commit.
 */
export type ImplementerFileStatus =
  "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
/**
 * #746: the names of the environment variables the Worker container of an implementer job gets, agreed here and used by later changes (the container profile and the runner). They hold no secret. `RUNNER_IMPLEMENTER_WORK_DIR`: the directory of the work volume, always `/work`. `RUNNER_IMPLEMENTER_EGRESS_PORT`: the loopback port of the registries proxy, a decimal port number; present when the network is `registries`. `RUNNER_IMPLEMENTER_NETWORK`: one of ImplementerNetworkMode. The Dispatcher sets them, never the app and never a job; the runner trusts these and nothing a job says about its own network.
 */
export type KnownImplementerEnvironmentName =
  | "RUNNER_IMPLEMENTER_WORK_DIR"
  | "RUNNER_IMPLEMENTER_EGRESS_PORT"
  | "RUNNER_IMPLEMENTER_NETWORK";
/**
 * #746: what the Worker of an implementer job can reach besides the model proxy and the git remote of its repository. `registries`: the package registries named by the deployment, through the loopback proxy of `RUNNER_IMPLEMENTER_EGRESS_PORT` (a default-deny proxy that allows only those hosts). `none`: nothing else.
 */
export type ImplementerNetworkMode = "registries" | "none";
/**
 * The engine's tools; every other name a model called is `other`.
 */
export type RunnerTraceToolName =
  "read" | "grep" | "glob" | "StructuredOutput" | "other";
/**
 * What the runner prints when a job ends (the output of code-reviewer-run-job), plus an optional errorMessage. The runner has redacted secrets from logTail; the app removes anything that still looks like one before it stores the result.
 */
export type RunnerResult = {
  ok: boolean;
  durationMs: number;
  /**
   * Link to the comment PR-Agent wrote; null when it could not be found (the run is still ok). A failed result may carry it too: review_state_truncated and review_text_truncated report a review that was posted but shortened.
   */
  commentUrl?: string | null;
  /**
   * null if and only if ok is true. See KnownRunnerErrorCode.
   */
  errorCode: string | null;
  /**
   * Optional stable finer name of a failure, never free text. For a Dynamic Review checkout failure it is one of KnownCheckoutReason. Absent when the runner gave none; the app stores only a name of the form below.
   */
  errorReason?: string | null;
  /**
   * Optional human readable detail for a failure; never contains secrets.
   */
  errorMessage?: string | null;
  logTail: string;
  logTruncated?: boolean;
  /**
   * #405: the findings left open on the pull request by a successful review, which the app turns into the review verdict it submits. Absent (or null) where the runner cannot say, and on every failure: the app then submits no verdict. Additive: a runner that does not send it, or an app that does not read it, keeps working.
   */
  findings?: ReviewFindings | null;
  implementer?: ImplementerResult1;
  /**
   * What the run used. A failed result carries it too, whenever the run made at least one model call before it failed (a timeout at the end, an answer the validator refuses, a publish error): the app counts such a run exactly like a successful one. A run that failed before its first model call reports null. The cost follows the same rule as for a successful run: exact, or null when any call is unpriced; the token counters are reported either way.
   */
  usage?: RunnerUsage | null;
  [k: string]: unknown;
};
/**
 * Why a Dispatcher gives a claimed job back. `launch_failed`: the Worker could not be started. `worker_exited`: the Worker was started and its container ended with a non-zero exit code before it reported a result (#375); the call is a no-op (409 RUNNER_JOB_ENDED, or 401 for a claim that is gone) when the job already has its result or another claim holds it. Either way the app counts a lost attempt (three attempts, then the job fails, with the reason as its error code). A reader accepts any reason of the right form (ReleaseRequest) and treats an unknown one like launch_failed, so an app that does not know `worker_exited` still gives the job back.
 */
export type KnownReleaseReason = "launch_failed" | "worker_exited";
/**
 * #493: the name of a Sandbox VM, as the platform and the Dispatcher know it (unique per launch: `cr-<kind>-<job id>-<random>`). Free text of the Dispatcher's own naming; the app uses it only as a key and never as a command.
 */
export type VmName = string;
/**
 * The features an app lists in VersionResponse.features. A reader ignores a name it does not know and refuses to run against an app that lacks one it needs. `worker_api`: /api/workers/v1 exists. `claim_by_job_id`: ClaimRequest.jobId is honoured. `pool_cap`: ClaimRequest.maxRunning is honoured. `release`: the release call exists. `vm_lifecycle` (#493): POST /api/runners/v1/jobs/{id}/vm exists (the Dispatcher reports the VM it created, for the billable minutes); a Dispatcher sends that call only to an app that lists the feature.
 */
export type KnownAppFeature =
  "worker_api" | "claim_by_job_id" | "pool_cap" | "release" | "vm_lifecycle";
/**
 * Every error of the API has one of these codes. 401 RUNNER_UNAUTHORIZED, 400 RUNNER_ID_INVALID / RUNNER_REQUEST_INVALID, 404 RUNNER_JOB_NOT_FOUND, 409 RUNNER_LEASE_LOST / RUNNER_RESULT_CONFLICT, 413 RUNNER_BODY_TOO_LARGE, 503 RUNNER_GIT_ACCESS_UNAVAILABLE (with Retry-After), 500 RUNNER_INTERNAL_ERROR. #318 adds 401 WORKER_CREDENTIAL_INVALID (a Worker route got a credential that is not the job's: wrong job, unknown, expired or from an earlier claim; also the fourth call of the details route in one claim, whose three calls are spent: the Worker has nothing left to fetch and stops, the claim itself is not lost) and 409 RUNNER_JOB_ENDED (the app ended the job, for example after a permanent access failure at fetch; the Worker stops).
 */
export type ApiErrorCode =
  | "RUNNER_UNAUTHORIZED"
  | "RUNNER_ID_INVALID"
  | "RUNNER_REQUEST_INVALID"
  | "RUNNER_JOB_NOT_FOUND"
  | "RUNNER_LEASE_LOST"
  | "RUNNER_RESULT_CONFLICT"
  | "RUNNER_BODY_TOO_LARGE"
  | "RUNNER_GIT_ACCESS_UNAVAILABLE"
  | "RUNNER_INTERNAL_ERROR"
  | "WORKER_CREDENTIAL_INVALID"
  | "RUNNER_JOB_ENDED";

/**
 * The optional body of POST /api/runners/v1/claim (#195): the engines the calling runner can run. Absent or empty means ['pr-agent'] (a previous-release runner). Unknown or duplicated engine names are refused with 400 RUNNER_REQUEST_INVALID before any job is claimed. #279 adds the optional `features`: what else this runner understands. The app sends a job optional fields a previous-release runner would reject (the job input is closed) only to a runner that names the matching feature, so `dynamic_capabilities` means the runner reads `dynamic.capabilities`. Unknown feature names are ignored, so a newer runner can name features an older app does not know. Unknown fields are ignored, as everywhere in v1. #318 adds the Dispatcher's fields: `jobId` claims exactly that job (anything else, such as a job that is not due, already running, finished, cancelled or of a kind the advertised engines cannot run, is 204), `maxRunning` is the pool cap (the claim is 204 while that many jobs of the same X-Runner-Id are running), and the feature `worker_credential` selects the split answer (SplitClaimResponse: a per-job credential and no job input). Without that feature the answer is the legacy ClaimResponse, unchanged. #424 adds the optional `llmProviders`: the providers the runner can run; absent means ['openrouter'].
 */
export interface ClaimRequest {
  /**
   * @minItems 1
   * @maxItems 3
   */
  engines?: [Engine] | [Engine, Engine] | [Engine, Engine, Engine];
  /**
   * @maxItems 16
   */
  features?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  /**
   * #424: the LLM providers this runner can run (the slugs of its registry). Absent means ['openrouter'], which is what a previous-release runner can run. An app sends a job for a provider only to a caller that listed it, so a newer app never hands an old runner a job it cannot read. The app only parses and validates the list today and does not use it yet (the claim issue of epic #420 will); it still always sends 'openrouter'. A previous-release app ignores the key.
   *
   * @minItems 1
   * @maxItems 16
   */
  llmProviders?:
    | [LlmProviderId]
    | [LlmProviderId, LlmProviderId]
    | [LlmProviderId, LlmProviderId, LlmProviderId]
    | [LlmProviderId, LlmProviderId, LlmProviderId, LlmProviderId]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ]
    | [
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
        LlmProviderId,
      ];
  /**
   * #318: claim exactly this job (a Dispatcher woken by the dispatch webhook). Absent: the next due job, as before.
   */
  jobId?: string;
  /**
   * #318: the pool cap. The app counts the running jobs whose X-Runner-Id equals this request's and answers 204 at or above the cap, inside the claim transaction.
   */
  maxRunning?: number;
  [k: string]: unknown;
}
/**
 * #195: the Dynamic options of a tagged job. Model, skill and the output limit only. A closed object: there is no fixed core, permission, executable command, endpoint or upstream URL here, so a job can never widen what the read-only agent may do. The skill is literal data.
 */
export interface DynamicReview {
  model: string;
  skill: string;
  limits: {
    maxFindings: number;
  };
  capabilities?: DynamicModelCapabilities;
  cost?: DynamicCostPolicy;
  modelEntry?: DynamicModelEntry;
}
/**
 * #279: what the app read from the provider's public metadata about the job's Dynamic model, so any tool-capable model runs without the operator describing it. Optional, and sent only to a runner that advertised the `dynamic_capabilities` feature in its claim. It comes from the app, never from the repository or the model. The runner can only narrow with it: it is intersected with the operator's RUNNER_DYNAMIC_CAPABILITIES (both booleans must hold, the smaller number wins for the limits, the higher unit price wins) and never widens what that allows. `maxOutputTokens` is the output allowance of one call, chosen by the app within the model's stated limit. The two unit prices come together or not at all; a model without them (outside the runner's built-in default) is refused by the runner with dynamic_config_invalid. A closed object.
 */
export interface DynamicModelCapabilities {
  toolChoiceRequired: boolean;
  structuredOutput: boolean;
  maxOutputTokens: number;
  contextWindowTokens: number;
  inputUsdPerMtok?: UnitPrice;
  outputUsdPerMtok?: UnitPrice;
}
/**
 * #553: a price book in the JSON form of the app (`priceBookToJson`; `fakes/fixtures/price-books.json` is read by the app's and the runner's readers): the base level, models.dev's older `contextOver200k` level and up to 64 tiers, each for a prompt above `contextOver` tokens, from the smallest up. The runner reads it strictly and, for the book of a claim, does not price a cache read as input when the level has no read price (the call is then unpriced).
 */
export interface DynamicPriceBook {
  input: MicroUsdPerMtok;
  output: MicroUsdPerMtok;
  cacheRead?: MicroUsdPerMtok | null;
  cacheWrite5m?: MicroUsdPerMtok | null;
  cacheWrite1h?: MicroUsdPerMtok | null;
  reasoning?: MicroUsdPerMtok | null;
  inputAudio?: MicroUsdPerMtok | null;
  outputAudio?: MicroUsdPerMtok | null;
  contextOver200k?: DynamicPriceLevel | null;
  /**
   * @maxItems 64
   */
  tiers?: {
    contextOver: number;
    input: MicroUsdPerMtok;
    output: MicroUsdPerMtok;
    cacheRead?: MicroUsdPerMtok | null;
    cacheWrite5m?: MicroUsdPerMtok | null;
    cacheWrite1h?: MicroUsdPerMtok | null;
    reasoning?: MicroUsdPerMtok | null;
    inputAudio?: MicroUsdPerMtok | null;
    outputAudio?: MicroUsdPerMtok | null;
  }[];
}
/**
 * #553: the prices of one level of a price book. `input` and `output` are required, every other price may be null or left out and then means "not priced", never zero. The audio prices are read and not used: a call with audio tokens is unknown.
 */
export interface DynamicPriceLevel {
  input: MicroUsdPerMtok;
  output: MicroUsdPerMtok;
  cacheRead?: MicroUsdPerMtok | null;
  cacheWrite5m?: MicroUsdPerMtok | null;
  cacheWrite1h?: MicroUsdPerMtok | null;
  reasoning?: MicroUsdPerMtok | null;
  inputAudio?: MicroUsdPerMtok | null;
  outputAudio?: MicroUsdPerMtok | null;
}
/**
 * #578: the provider and the one model of a native job, the `JobModelEntry` of job-model-entry.v1.json (the closed object the runner reads strictly; this file does not repeat it, and both suites check every example against that file). Optional and additive: sent exactly when `cost` is, so only to a caller that named the claim feature `dynamic_cost_policy`; a job without it is a job of today. It holds no key. `upstreamBaseUrl` is the address the runner's supervisor connects to; the engine is never told it. Its `modelId` is `dynamic.model` and `llm.model`, and its `providerId` is the provider of `llm.provider` (the underscore of a slug is the hyphen of the id).
 */
export interface DynamicModelEntry {
  [k: string]: unknown;
}
/**
 * #195: the checkout facts a Dynamic job carries, pinned when the job was queued or claimed and bounded. `headSha` is the exact queued head; `baseRef` is the branch the pull request merges into (the exact base SHA is resolved during checkout, #196). `previousReviewedSha` is the head of the last successful review of the same kind (#199), or null. `attemptedShas` (#255, optional: absent means none, and the app leaves it out when empty) are the heads of the earlier jobs of the pull request that ran and did not succeed, newest first; the publisher accepts such a head as the state of the summary comment, because a run may have written it and then ended without success. `attemptedShasTruncated` (#257, optional: absent means false, and the app leaves it out unless it is true) says that more heads qualified than the list holds; only then does the publisher rewrite a bot-owned summary whose state head it cannot account for, with a full review, instead of refusing it. `comparison` is the *declared* mode: a hint for preparation, never proof that the comparison is complete — the checkout verifies that before it trusts it.
 */
export interface ClaimBase {
  repository: string;
  baseRef: string;
  headSha: string;
  previousReviewedSha: string | null;
  /**
   * @maxItems 20
   */
  attemptedShas?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  attemptedShasTruncated?: boolean;
  comparison: "full" | "incremental";
}
/**
 * Extra options of the PR-Agent tools, as strings. The review tool's options (PR_REVIEWER__*) are used; a previous release's option families for the removed tools (PR_DESCRIPTION__*, PR_CODE_SUGGESTIONS__*, PR_QUESTIONS__*) are accepted for v1 compatibility and ignored. Nothing else is allowed here (credentials, endpoints and the model have their own fields).
 */
export interface JobEnv {
  [k: string]: string;
}
/**
 * #746: what an implementer job asks for (`reviewKind: implementer`; the factory deployment only). A closed object: there is no command, permission, executable, endpoint or upstream URL here, so a job can never widen what the agent may do. The agent works in a clone of `repo` that starts at the head of `baseBranch`, on the new branch `branch` (it must not exist yet) and only there, and pushes it. `instruction` is the user's task as literal data. `limits.timeLimitSeconds` is the wall clock the runner holds the turn to (the Dispatcher's own timeout for the kind is the backstop). `cost` and `modelEntry` are the `DynamicCostPolicy` and the `DynamicModelEntry` of the native Dynamic job, unchanged: the same passthrough proxy, price book and token cap, and a native job is the only way the Implementer runs a model. `capabilities` is optional, as for Dynamic.
 */
export interface ImplementerJob {
  repo: ImplementerRepo;
  baseBranch: ImplementerBranchName;
  branch: ImplementerBranchName;
  instruction: string;
  limits: {
    timeLimitSeconds: number;
  };
  cost: DynamicCostPolicy;
  modelEntry: DynamicModelEntry;
  capabilities?: DynamicModelCapabilities;
}
/**
 * #746: the one repository a turn works on. `fullName` is `owner/name`; `cloneUrl` is the https address the runner clones from (the host of the git provider), with no credential in it: the token is in `git.token`.
 */
export interface ImplementerRepo {
  fullName: string;
  cloneUrl: string;
}
/**
 * #746: what a turn of the Implementer did, in `RunnerResult.implementer`. A closed object; later fields (checks, open questions, an export of the work) are additive in a later change. It is facts the runner measured in the repository, never text from the agent except `summary`, which is shown as plain text. `baseCommit` is the head of the base branch the work started from. `headCommit` is the last commit of the branch, or null when the turn made none. `pushed` says that the branch with `headCommit` is on the remote, and is never true without a `headCommit`. `commits` are the commits of the branch after the base commit, oldest first, at most 200 (more are cut off, the head commit is always the last); `filesChanged` are the files that differ between the base commit and the head commit, at most 500. `opencode` names the saved agent session a later turn continues, null when none was saved. A failed turn carries the block too, whenever the runner got as far as the repository.
 */
export interface ImplementerResult {
  baseCommit: string;
  headCommit: string | null;
  pushed: boolean;
  /**
   * @maxItems 200
   */
  commits: {
    sha: string;
    subject: string;
  }[];
  /**
   * @maxItems 500
   */
  filesChanged: {
    path: string;
    status: ImplementerFileStatus;
  }[];
  summary: string;
  opencode: {
    sessionId: string;
    version: string;
  } | null;
}
/**
 * 200 from POST /api/runners/v1/claim. 204 without a body means there is nothing to do. Cache-Control is always no-store.
 */
export interface ClaimResponse {
  version: 1;
  job: {
    id: JobId;
    leaseToken: LeaseToken;
    leaseExpiresAt: Timestamp;
    /**
     * How often to send a heartbeat; the lease is several times longer.
     */
    heartbeatIntervalSeconds: number;
    /**
     * When the git token stops working; null if it does not expire.
     */
    tokenExpiresAt: Timestamp | null;
    input: RunnerJobInput;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/*
 */
export interface HeartbeatRequest {
  leaseToken: LeaseToken;
  [k: string]: unknown;
}
/**
 * #397, #396: the numbers behind the supersede of a running run, stated once for both sides; a test on each side compares its own constants with these. They are not part of any request or answer. The Worker learns of the push at its next heartbeat (at most 'maxHeartbeatIntervalSeconds'), tells its process at once, and lets the model requests in flight finish: each takes at most 'longestModelRequestSeconds', so the Worker drains for at most 'workerDrainSeconds' (the same number) and ends its process 'killMarginSeconds' before the lease named in the heartbeat answer, whichever comes first. The app keeps the claim for 'claimSeconds' from the push (heartbeats answer 'superseded', the report is taken), which is the heartbeat interval, the longest request and a margin of 60 seconds. It takes a report for 'reportGraceSeconds' more, the time before which it does not settle the usage record with an unknown cost. A report after that is refused with 409, like a heartbeat. A Worker takes the end of its drain from the 'leaseExpiresAt' of the heartbeat answer that said 'superseded': the app sets the lease of a superseded run once, at the push, to 'claimSeconds' after it, and heartbeats do not extend it.
 */
export interface SupersedeTiming {
  maxHeartbeatIntervalSeconds?: 60;
  longestModelRequestSeconds?: 120;
  workerDrainSeconds?: 120;
  killMarginSeconds?: 20;
  claimSeconds?: 240;
  reportGraceSeconds?: 60;
  [k: string]: unknown;
}
/*
 */
export interface HeartbeatResponse {
  version: 1;
  job: {
    id: JobId;
    heartbeatAt: Timestamp;
    leaseExpiresAt: Timestamp;
    /**
     * #396: true when a newer push replaced this run. Sent only to a claim that named the feature `supersede`; absent means not superseded. The runner finishes the model requests in flight, sends no more, publishes nothing, reports its result (errorCode `superseded`, with usage) and exits.
     */
    superseded?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/*
 */
export interface RunnerUsage {
  model: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  aiCalls: number;
  fallbackUsed: boolean;
  /**
   * The cost in US dollars, or null when it is not known. A Dynamic Review and a Diff Review report the exact sum of the charges their model provider stated for every call, and null when any call has no stated charge or ended without an answer that could have been billed; neither estimates one from tokens or a price table. #553: a native Dynamic Review reports null when its model is not priced or any call could not be priced; on the managed key such a run ends with `dynamic_accounting_failed` instead of succeeding, and the app refuses a managed success with a null cost.
   */
  costUsd: number | null;
  /**
   * Why a Dynamic Review was wrapped up before it was done: the model was asked for its answer right away because the run reached its cost limit (`cost_limit`, the operator's), the cost limit of its project (`project_cost_limit`, #666: `llm.maxCostUsd`, when that is the smaller one), its time limit or (#553, an own key whose price is not known) its token limit. Absent or null for a complete run; the review a Dynamic Review produced is published and says it may be incomplete. A Diff Review is never wrapped up: when it sends no further model request because what it has cost reached the operator's cost limit (`cost_limit`) or the project's (`project_cost_limit`), it ends with `cost_limit_reached`, posts no review, and reports the limit that stopped it here on its failed result.
   */
  stoppedEarly?:
    "cost_limit" | "project_cost_limit" | "time_limit" | "token_limit" | null;
  /**
   * #540: by how much, in US dollars, the cost of a Dynamic Review passed its cost limit (the operator's, or the project's when that is the smaller one, #666). The review is delivered nevertheless: the last normal call may cost more than expected and the final call that carries the answer is always made (the documented bound: the limit plus the excess of the last normal call plus the final call). Absent when the cost stayed within the limit or is not known.
   */
  limitExceededBy?: number;
  callTrace?: RunnerCallTrace;
  [k: string]: unknown;
}
/**
 * #541: what each model call and each tool call of a Dynamic Review was, as numbers and stable names (RunnerCallTrace). Optional and additive: a runner of an earlier release sends none, and an app of an earlier release ignores it. Observability only; nothing in the run reads it.
 */
export interface RunnerCallTrace {
  truncated: boolean;
  /**
   * @maxItems 100
   */
  modelCalls: RunnerModelCallTrace[];
  /**
   * @maxItems 100
   */
  toolCalls: RunnerToolCallTrace[];
}
/**
 * One model call. A count is null when the provider reported none (a refused call, a provider without cache tokens); it is never a guess. tMs is the time since the run started when the call began.
 */
export interface RunnerModelCallTrace {
  index: number;
  tMs: number;
  promptTokens: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  finishReason:
    "stop" | "tool_calls" | "length" | "content_filter" | "other" | null;
  /**
   * True for the call the run was wrapped up with (the wrap-up or the recovery).
   */
  final: boolean;
  /**
   * The tools the answer asked for, each name once with its count.
   *
   * @maxItems 5
   */
  tools:
    | []
    | [
        {
          name: RunnerTraceToolName;
          count: number;
        },
      ]
    | [
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
      ]
    | [
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
      ]
    | [
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
      ]
    | [
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
        {
          name: RunnerTraceToolName;
          count: number;
        },
      ];
}
/**
 * One tool call. isRepeat is true when the same tool with the same normalised arguments already ran in this job; the arguments themselves are never sent. resultBytes is the size of the result the model was shown, null when it never was.
 */
export interface RunnerToolCallTrace {
  index: number;
  name: RunnerTraceToolName;
  resultBytes: number | null;
  isRepeat: boolean;
}
/**
 * #541: the per-call trace of a Dynamic Review, without content. Sizes, counts, times, the cost and stable names only: no path, no argument, no tool result and no model text is ever in it. At most 100 model calls and 100 tool calls are kept (the first ones); truncated says that more happened. Tool names are the engine's own; any other name is `other`.
 */
export interface RunnerCallTrace1 {
  truncated: boolean;
  /**
   * @maxItems 100
   */
  modelCalls: RunnerModelCallTrace[];
  /**
   * @maxItems 100
   */
  toolCalls: RunnerToolCallTrace[];
}
/**
 * #405: what a successful review left open on the pull request. `open` counts the findings that are open AFTER the run (a Dynamic Review carries the findings of earlier runs over, PR-Agent keeps a record of active ones), not the ones the run found. `bySeverity` is the count per priority of a Dynamic Review, of the findings its summary lists (so `open` may exceed the sum when lower priority findings did not fit); null for a Diff Review, whose findings have no severity.
 */
export interface ReviewFindings {
  open: number;
  /**
   * True when the review did not cover everything it was asked to: a finding its validation dropped, a chunk that failed, files left out for the token budget. `open` may then miss a blocker, so the app never approves on it. Absent means complete.
   */
  incomplete?: boolean;
  bySeverity: {
    P0: number;
    P1: number;
    P2: number;
    P3: number;
  } | null;
}
/**
 * #746: what a turn of the Implementer did (ImplementerResult). Only a result of an implementer job carries it; absent for every other kind. Optional and additive: an app of the release before ignores it.
 */
export interface ImplementerResult1 {
  baseCommit: string;
  headCommit: string | null;
  pushed: boolean;
  /**
   * @maxItems 200
   */
  commits: {
    sha: string;
    subject: string;
  }[];
  /**
   * @maxItems 500
   */
  filesChanged: {
    path: string;
    status: ImplementerFileStatus;
  }[];
  summary: string;
  opencode: {
    sessionId: string;
    version: string;
  } | null;
}
/**
 * The whole request body must not exceed 65536 bytes (413 otherwise).
 */
export interface CompleteRequest {
  leaseToken: LeaseToken;
  result: RunnerResult;
  [k: string]: unknown;
}
/**
 * 200 for a completion and for the repetition of the same completion (alreadyCompleted: true); a different result for a completed job is 409. A result with errorCode runner_shutdown is not stored: the job is given back (status queued) and a repetition is 409, because the runner no longer holds the job.
 */
export interface CompleteResponse {
  version: 1;
  job: {
    id: JobId;
    /**
     * succeeded or failed: the job is finished. queued: the runner reported runner_shutdown, the job was given back and waits for another runner (it fails instead if that was the last allowed attempt). superseded (#397): the run was replaced by a newer push; its report is stored once and the job stays superseded.
     */
    status: "succeeded" | "failed" | "queued" | "superseded";
    [k: string]: unknown;
  };
  alreadyCompleted: boolean;
  [k: string]: unknown;
}
/**
 * #318: 200 from POST /api/runners/v1/claim when the request names the feature `worker_credential`. The job's input, the git token and the model key are not in it: the Worker fetches them with the credential (GET /api/workers/v1/jobs/{id}), so the answer to the Dispatcher carries none of them. The credential itself opens the details call, so whoever holds it can fetch them: the Dispatcher is trusted to hand it to the Worker on stdin and to use it for nothing else (the app does not bind a credential to a process). 204 without a body means there is nothing to do. Cache-Control is always no-store. The credential is a secret.
 */
export interface SplitClaimResponse {
  version: 1;
  job: {
    id: JobId;
    credential: WorkerCredential;
    reviewKind: ReviewKind;
    leaseExpiresAt: Timestamp;
    /**
     * How often the lease must be extended; the Dispatcher heartbeats with the credential until the Worker takes over.
     */
    heartbeatIntervalSeconds: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #318: POST /api/runners/v1/jobs/{id}/release, with the dispatcher credential (RUNNER_TOKEN) in Authorization and the job credential in the body. Gives the job back to the queue (or fails it on the last attempt).
 */
export interface ReleaseRequest {
  credential: WorkerCredential;
  reason: string;
  /**
   * Do not offer the job again before this many seconds have passed.
   */
  retryAfterSeconds?: number;
  [k: string]: unknown;
}
/**
 * #318: 200 from the release. `queued`: the job waits for another claim; `failed`: that was the last allowed attempt.
 */
export interface ReleaseResponse {
  version: 1;
  job: {
    id: JobId;
    status: "queued" | "failed";
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #493: POST /api/runners/v1/jobs/{id}/vm, with the dispatcher credential (RUNNER_TOKEN) in Authorization and the job credential in the body, like the release. The Dispatcher says that it created the VM of the claim, right after `Sandbox.create` returned. Closed: an unknown field is refused. The first report of a VM wins and a repeat changes nothing. `startedAt` is the Dispatcher's clock; the app keeps it between the claim and its own clock. `timeoutSeconds` is the VM's own timeout, the platform's backstop for a VM that nobody stops. Only a job whose running claim the credential holds is accepted: a report after the claim ended is 409 RUNNER_JOB_ENDED, a credential that is not the claim's is 401. It only measures; it sets no price and never has to succeed for a launch to go on.
 */
export interface VmStartRequest {
  credential: WorkerCredential;
  vmName: VmName;
  /**
   * ISO 8601 in UTC with the `Z`; milliseconds optional.
   */
  startedAt: string;
  timeoutSeconds: number;
}
/**
 * #493: 200 from the report. `recorded`: the VM is stored. `replayed`: the VM was known; nothing changed.
 */
export interface VmStartResponse {
  version: 1;
  status: "recorded" | "replayed";
  [k: string]: unknown;
}
/**
 * #364: 200 from GET /api/runners/v1/jobs/{id} (the dispatcher credential only; a per-job credential is refused). What a Dispatcher asks to decide whether the VM of a job is a leftover: the job's status and nothing else, no job input, lease, repository or credential. `running`: the app holds the job under a lease. Any other status: it does not (`queued` also covers a lease that lapsed and a job that was given back). A reader that meets a status it does not know treats the job as running. An unknown id is 404 RUNNER_JOB_NOT_FOUND. An app of a previous release has no such route (a 404 without an ErrorResponse body); it is not a required feature, so a reader goes on without it.
 */
export interface JobStateResponse {
  version: 1;
  job: {
    id: JobId;
    status:
      | "queued"
      | "running"
      | "succeeded"
      | "failed"
      | "superseded"
      | "cancelled";
    /**
     * #397: true for a superseded job whose claim is still valid: its Worker is finishing the model requests in flight and reporting what they cost. A Dispatcher keeps the VM of a draining job until the claim ends (the reaper). Absent means not draining; a reader that does not know the field sees a superseded job as ended.
     */
    draining?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #318: 200 from GET /api/runners/v1/version (dispatcher credential; #322: a Worker may also send its per-job credential with ?jobId=<its job>, which must be the running claim of that job). Lets a Dispatcher or a Worker detect an app that is too old before it claims anything. An app of a previous release has no such route (404), which means it is too old. `version` is the runner API version; `appVersion` is the build of the app, for logs.
 */
export interface VersionResponse {
  version: 1;
  appVersion: string;
  /**
   * @maxItems 64
   */
  features: string[];
  [k: string]: unknown;
}
/*
 */
export interface ErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    /**
     * For RUNNER_REQUEST_INVALID: which fields were refused and why (never their values).
     */
    fields?: {
      field: string;
      code: "required" | "invalid" | "too_long";
      [k: string]: unknown;
    }[];
    retryAfterSeconds?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
