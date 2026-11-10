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
 * The claim features this version of the contract defines (`features` in ClaimRequest). A reader ignores a feature name it does not know. `dynamic_capabilities` (#279): the runner reads `dynamic.capabilities`. `worker_credential` (#318): the caller is a Dispatcher and wants the split answer; the job input and its secrets reach only the Worker, with the per-job credential. `supersede` (#396): the runner understands `job.superseded` in a heartbeat answer and stops gracefully (it finishes the model requests in flight, sends no more, publishes nothing, reports its result and usage). The app supersedes a running job only when the claim named it. A Worker names it in the `features` of its details request. `dynamic_cost_policy` (#553): the runner reads `dynamic.cost` and enforces it (the price book of the managed key as the only price source, the token cap of an own key). A job that carries a cost policy goes only to a caller that named it; the app ends the job with `dynamic_engine_unavailable` otherwise, since a runner that did not read the policy would run without its bound. `vm_lifecycle` (#498): the caller is a Dispatcher that reports the VM it creates to the app (POST /api/runners/v1/jobs/{id}/vm, `KnownAppFeature` of the same name) so the app can measure billable minutes; the app records that it has seen a Dispatcher with and without it, and refuses to switch billing on while a Dispatcher without it has claimed recently. `cost_limit` (#666): the runner reads `llm.maxCostUsd` and enforces it next to the operator's own limit. The app sends it only to a caller that named it; a caller without it gets the job without the field and runs with the operator's own limit alone (a refused review is worse than a project limit that is not kept while a release rolls out), and the app logs that. A Worker names it in the `features` of its details request. `operator_cost_limit` (#689): the runner reads `llm.operatorMaxCostUsd`, the most one review may cost as the operator set it in the admin portal, and holds a review to the smaller of that and `llm.maxCostUsd`; it no longer reads `RUNNER_DYNAMIC_MAX_COST_USD` for a job that carries the field. The app sends it only to a caller that named it. A caller that names `cost_limit` alone gets the smaller of the two in `llm.maxCostUsd`; a caller that names neither gets neither field, and the app logs that. A Worker names it in the `features` of its details request. `implementer_environment` (#818): the runner reads `implementer.environment` of a turn and runs its setup script before the model. The app sends `environment` only to a caller that named it, and ends a turn whose environment has a script with `implementer_engine_unavailable` (free) for a caller that did not, since a turn that silently skipped its script would run on a base the person did not choose. A Worker names it in the `features` of its details request. `implementer_network` (#745, step 7): the runner reads `implementer.environment.network`, the environment's rule for the agent's network (`off`, an own list, `open`), and starts the network door for it. The app sends a `network` other than `off` only to a caller that named it and ends such a turn with `implementer_engine_unavailable` (free) for a caller that did not, since a runner that did not read the rule would give the agent a network the person did not choose, or none where one was asked for. A Worker names it in the `features` of its details request. `implementer_profile` (#843): the runner reads `implementer.profile`, the profile version a turn was started with, writes its `instructions` into the instruction file the agent gets and, when `canPush` is false, does not push anything when the turn ends. The app sends `profile` only to a caller that named it and ends a turn that has one with `implementer_engine_unavailable` (free) for a caller that did not, since a runner that did not read it would push the work of a profile that may not push, and would run an agent without the instructions the person chose. A Worker names it in the `features` of its details request. `implementer_result` (#843): the runner reads `implementer.resultSchema`, the result schema of a turn, gives the agent the finish tool made from it (the command `factory-submit` and the MCP tool `submit_result` in its container), checks what the agent handed in again after the container is gone, and reports it as `implementer.agentResult`. The app sends `resultSchema` only to a caller that named it and ends a turn that has one with `implementer_engine_unavailable` (free) for a caller that did not, since a runner that did not read it would run an agent that is never asked for its result. A Worker names it in the `features` of its details request. `implementer_resume` (#838): the runner reads `implementer.resume`, the branches a follow-up turn of an Implementer session starts from. The app sends `resume` only to a caller that named it and ends a follow-up turn with `implementer_engine_unavailable` (free) for a caller that did not, since a runner that did not read it would start from the base branch and push over the work of the earlier turns. A Worker names it in the `features` of its details request. `implementer_start_branch` (#909): the runner reads `implementer.startBranch` and starts the work from that branch instead of the base branch. The app sends `startBranch` only to a caller that named it and ends a turn that has one with `implementer_engine_unavailable` (free) for a caller that did not, since a runner that did not read it would start from the base branch and the person's start point would be lost silently. A Worker names it in the `features` of its details request. `implementer_ask` (#920): the runner reads `implementer.canAsk` and, for a turn that may ask, offers the agent the question next to the result (`factory-submit --ask`, `submit_result({ask: {...}})`) and reports a turn that ended with one as `implementer.agentAsk`. The app sends `canAsk` only to a caller that named it (to any other caller a turn runs as before: it ends with a result or fails, and there is no question to answer). A Worker names it in the `features` of its details request.
 */
export type KnownClaimFeature =
  | "dynamic_capabilities"
  | "worker_credential"
  | "supersede"
  | "dynamic_cost_policy"
  | "vm_lifecycle"
  | "cost_limit"
  | "operator_cost_limit"
  | "implementer_environment"
  | "implementer_network"
  | "implementer_profile"
  | "implementer_result"
  | "implementer_resume"
  | "implementer_start_branch"
  | "implementer_ask";
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
 * The error codes the runner reports in a result (ErrorCode in the runner, plus runner_shutdown from the job loop). #746 adds the codes of the Implementer: `branch_exists` (no longer produced: a branch the remote refuses is a rejected entry of `branches` and the turn ends `push_rejected`; the word stays for runs that carry it), `base_branch_not_found`, `clone_failed`, `setup_failed` (the repository's own set-up did not run), `agent_gave_up` (the agent ended without a result it stands behind), `no_result` (#843: the turn had a result schema and the agent ended without a result that fits it, also after the one reminder; the model was used), `push_rejected` (the remote refused the push), `branch_violation` (no longer produced: git is free in the workspace; the word stays for runs that carry it), `time_limit_reached` and the existing `cost_limit_reached` (the two limits of the turn), `git_write_not_granted` (the token cannot write contents of the repository), `implementer_engine_unavailable` (no engine of the runner runs the kind) and `implementer_config_invalid` (the turn's options cannot be used). A caller branches on the code, never on a message. The app accepts any code of the form below and stores an unknown one as 'unknown' (the original stays in the stored result), so a newer runner never loses a result.
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
  | "cancelled"
  | "branch_exists"
  | "base_branch_not_found"
  | "clone_failed"
  | "setup_failed"
  | "agent_gave_up"
  | "no_result"
  | "push_rejected"
  | "branch_violation"
  | "time_limit_reached"
  | "git_write_not_granted"
  | "implementer_engine_unavailable"
  | "implementer_config_invalid"
  | "sandbox_unproven"
  | "sandbox_size_unsupported"
  | "environment_setup_failed";
/**
 * Exactly the job the runner reads on stdin (see runner/src/code_reviewer_runner/job.py). Closed: the runner refuses unknown fields. Contains secrets (git.token, llm.apiKey): only the claim response carries it. #746: for `reviewKind: implementer` the job carries the `implementer` object instead of `prUrl`, `command`, `base` and `dynamic`; `git.token` is then a token that may write the contents of exactly the repository named in `implementer.repo` and nothing else. #856: `llm` is required for every job except a turn of the Implementer whose profile names the harness `claude-code` (a subscription turn): that turn runs on the login of the device of the runner, has no model door and no key of ours, and carries no `llm`, no `implementer.cost` and no `implementer.modelEntry`; the runner refuses a job that carries them with it, and every other job without `llm` (`invalid_job`).
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
  llm?: {
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
 * #746: what an implementer job asks for (`reviewKind: implementer`; the factory deployment only). A closed object: there is no command, permission, executable, endpoint or upstream URL here, so a job can never widen what the agent may do. The agent works in a full clone of `repo` (#909: every branch of the provider as a local branch, the whole history and the tags, no remote and no credential) on the new branch `branch` (it must not exist yet), which starts at the head of `startBranch` (the head of `baseBranch` when `startBranch` is absent); `baseBranch` is the branch the work is compared with and merged into. When the turn ends, every local branch the agent created or moved is pushed without force; a branch left as it was cloned is not. A `startBranch` the provider does not have ends the turn `clone_failed`. `instruction` is the user's task as literal data. `limits.timeLimitSeconds` is the wall clock the runner holds the turn to (the Dispatcher's own timeout for the kind is the backstop). `cost` and `modelEntry` are the `DynamicCostPolicy` and the `DynamicModelEntry` of the native Dynamic job, unchanged: the same passthrough proxy, price book and token cap, and a native job is the only way the Implementer runs a model. `capabilities` is optional, as for Dynamic. `resume` (#838) is present on a follow-up turn only: the branch then exists on the provider (an earlier turn pushed it) and the turn starts from the branches of `resume` instead of the base. #856: `cost` and `modelEntry` are required for every turn except one on the harness `claude-code` (the `harness` of the profile), which carries `subscription` instead and neither of them; the runner refuses a job that has both or neither.
 */
export type ImplementerJob = {
  [k: string]: unknown;
} & {
  repo: ImplementerRepo;
  baseBranch: ImplementerBranchName;
  /**
   * #746: the name of a branch as a job carries it: a non-empty text of at most 255 characters without whitespace and not starting with a dash (so it can never be read as an option). Whether it is a valid git ref name is decided by the app when the turn is submitted and again by the runner before it runs git; this is the floor both share.
   */
  startBranch?: string;
  branch: ImplementerBranchName;
  instruction: string;
  limits: {
    timeLimitSeconds: number;
  };
  cost?: DynamicCostPolicy;
  modelEntry?: DynamicModelEntry;
  subscription?: ImplementerSubscription;
  capabilities?: DynamicModelCapabilities;
  environment?: ImplementerEnvironment;
  profile?: ImplementerProfile;
  resultSchema?: ImplementerResultSchema;
  /**
   * #920: the turn may end with a question instead of a result: the finish tool offers `ask`. Sent only with `resultSchema` and only to a caller that named the claim feature `implementer_ask`; absent means false.
   */
  canAsk?: boolean;
  resume?: ImplementerResume;
};
/**
 * #746: the name of a branch as a job carries it: a non-empty text of at most 255 characters without whitespace and not starting with a dash (so it can never be read as an option). Whether it is a valid git ref name is decided by the app when the turn is submitted and again by the runner before it runs git; this is the floor both share.
 */
export type ImplementerBranchName = string;
/**
 * #818: the environment a turn was started with, as the turn copied it when it started: the setup script the runner runs once in the repository's folder after the clone and before the model is called, and (#745, step 7) the rule for the agent's network. Present only when the environment has a script or a network rule other than `off`, and the caller named the claim feature `implementer_environment` (and `implementer_network` for a rule); a turn with neither carries nothing (the size of the VM is the Dispatcher's business, it reaches the Worker as the VM it runs in). `setupScript`, when present, is literal text of at most 64 KB of UTF-8, written by a member of the workspace: it is data to run, never a command of the app, and it holds no secret by design (there is no field for one). `network`, when present, is the rule the network door enforces; absent means `off`. At least one of the two is present. `name` is for the run's log line only.
 */
export type ImplementerEnvironment = ImplementerEnvironment1 & {
  name: string;
  setupScript?: string;
  network?: ImplementerNetworkRule;
};
export type ImplementerEnvironment1 = {
  [k: string]: unknown;
};
/**
 * #840 (part of #745): how a follow-up turn got its earlier conversation, in `RunnerResult.implementer.resume`. Present on a follow-up turn (the job carried `resume`) that got as far as the engine's start; a first turn has none, and neither has a follow-up that ended before (the clone failed, the setup script failed). `mode` `imported` is the whole conversation of the earlier turns, read back into the engine, which continued in that session: the commands in it are the history the agent sees, not things that ran in the new sandbox. `summary_only` is a fresh engine session that was given a summary and a digest as data instead, for one of the stable `reason` words (always present with `summary_only`, never with `imported`): `no_snapshot` (the app had none, or the session was never saved), `download_failed` (the stored session could not be fetched), `snapshot_unreadable` (the file did not match its size or digest, was not gzip, or was not the engine's export), `import_failed` (the engine refused the import or the session was not there after it), `version_changed` (the same, and the engine version that wrote the snapshot is not the one that read it). Neither is a failure of the turn. A turn that imported a history so long that its first call alone is over the cost limit ends `cost_limit_reached` before any model call (the door refuses a call whose reserved cost is over the limit).
 */
export type ImplementerResumeResult = {
  mode: "imported" | "summary_only";
  reason?:
    | "no_snapshot"
    | "download_failed"
    | "snapshot_unreadable"
    | "import_failed"
    | "version_changed";
} & ImplementerResumeResult1;
export type ImplementerResumeResult1 =
  | {
      mode?: "imported";
      [k: string]: unknown;
    }
  | {
      mode?: "summary_only";
      [k: string]: unknown;
    };
/**
 * #746: what happened to a file between the base commit and the head commit.
 */
export type ImplementerFileStatus =
  "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
/**
 * #746: the names of the environment variables the Worker container of an implementer job gets, agreed here and used by later changes (the container profile and the runner). They hold no secret. `RUNNER_IMPLEMENTER_WORK_DIR`: the directory of the work volume, always `/work`. `RUNNER_IMPLEMENTER_MODEL_DOOR` (#745): `docker` when the container carries the VM's Docker socket, through which it starts the model door, the agent's container and the reader; unset, the container is not an Implementer's. `RUNNER_IMPLEMENTER_SANDBOX_PROOF` (#745, step 4): `proven` or `unproven`, the golden snapshot's Sysbox verdict (the fourth member of the snapshot pair; a deployment that was never told one passes `unproven`); anything but `proven` ends a turn `sandbox_unproven`, free. `RUNNER_IMPLEMENTER_AGENT_MEMORY_MB`: the memory limit of the agent's container in MB, computed from the VM's size; `0` ends a turn `sandbox_size_unsupported`, free. `RUNNER_IMPLEMENTER_NETWORK_SWITCH` (#745, step 7): a JSON document with the address of the Dispatcher's network call, the VM's name, the rule and the model provider's host the Dispatcher read in the claim answer, the time the token stops working, and a token signed over all of them; the Worker sends it back to narrow the VM's network policy after the setup. Absent (a deployment without the call), the policy is not changed and the report says so. It holds no secret that opens more than that one call for that one VM. The Dispatcher sets them, never the app and never a job.
 */
export type KnownImplementerEnvironmentName =
  | "RUNNER_IMPLEMENTER_WORK_DIR"
  | "RUNNER_IMPLEMENTER_MODEL_DOOR"
  | "RUNNER_IMPLEMENTER_SANDBOX_PROOF"
  | "RUNNER_IMPLEMENTER_AGENT_MEMORY_MB"
  | "RUNNER_IMPLEMENTER_NETWORK_SWITCH";
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
 * The features an app lists in VersionResponse.features. A reader ignores a name it does not know and refuses to run against an app that lacks one it needs. `worker_api`: /api/workers/v1 exists. `claim_by_job_id`: ClaimRequest.jobId is honoured. `pool_cap`: ClaimRequest.maxRunning is honoured. `release`: the release call exists. `vm_lifecycle` (#493): POST /api/runners/v1/jobs/{id}/vm exists (the Dispatcher reports the VM it created, for the billable minutes); a Dispatcher sends that call only to an app that lists the feature. `implementer_steps` (#745): POST /api/runners/v1/jobs/{id}/steps and POST /api/workers/v1/jobs/{id}/steps exist (the steps of a running turn of the Implementer, for the live view); a runner sends them only to an app that lists the feature. It is an app feature, not a claim feature: the call adds nothing to the job input, so there is nothing the app must withhold from a caller that does not know it. `implementer_snapshot` (#839): PUT /api/workers/v1/jobs/{id}/session exists (one part of the session snapshot of a turn of the Implementer, for the follow-up turns); a Worker puts it only to an app that lists the feature. An app feature too: the call adds nothing to the job input. `runner_session_snapshot` (#879): PUT /api/runners/v1/jobs/{id}/session and GET /api/runners/v1/jobs/{id}/resume-session exist (the same calls for a customer's runner, which holds a runner credential and no per-job credential: `RunnerLeaseTokenHeader`, `RunnerSessionPartQuery`, `RunnerResumeSessionQuery`); such a runner reads the list from GET /api/runners/v1/version with its own credential and uses the two calls only if the app lists the feature. `implementer_snapshot` does not say it: an app can have the Worker API's calls and not these.
 */
export type KnownAppFeature =
  | "worker_api"
  | "claim_by_job_id"
  | "pool_cap"
  | "release"
  | "vm_lifecycle"
  | "implementer_steps"
  | "implementer_snapshot"
  | "runner_session_snapshot";
/**
 * #745: the kinds of `StepRecord` the app stores. `reasoning`: a finished reasoning part, with the text the provider returned (often a summary). `text`: a finished assistant text part. `tool`: a tool call, with its name, status, title, the input as JSON text and the error text; the OUTPUT of a tool is never recorded, on either side. `step`: the end of one model call, with its tokens and cost. A record of another kind is left out and counted in `StepsResponse.dropped`: a newer runner may send more kinds.
 */
export type KnownStepKind = "reasoning" | "text" | "tool" | "step";
/**
 * #745: one record of the live view, for one part of the engine's messages. A part is sent again when it changes (a tool: running, then completed) with the same `partId` and a higher `seq`; the app keeps the record with the highest `seq` of each part, so a retry or a record that arrives behind a newer one changes nothing. `kind` is any lower case word, and the app stores the kinds of `KnownStepKind` only. A reader ignores fields it does not know. For a kind the app does not know only `kind`, `partId`, `seq`, `startedAt` and `endedAt` are checked and the other fields are dropped unread, whatever they hold: a newer runner may send kinds of any shape, and one of them must not make the app refuse the batch beside it. For a kind it knows, `KnownStepFields` bounds the other fields. `startedAt` and `endedAt` are epoch milliseconds of the sandbox's clock. The texts are cut by the runner (`text` at 16 KiB, `input` and `error` at 4 KiB, `title` at 512 bytes) and `bytes` is the true size of the cut text; the app cleans them again (control characters, secrets, and on the operator's key the model and provider names) and stores the cost of a model call only for a job on the workspace's own key. Per kind, `text` is required for `reasoning` and `text`, `tool` and `status` for `tool`, `tokens` for `step`.
 */
export type StepRecord = {
  kind: string;
  partId: string;
  seq: number;
  startedAt?: number;
  endedAt?: number;
  [k: string]: unknown;
};
/**
 * Every error of the API has one of these codes. 401 RUNNER_UNAUTHORIZED, 400 RUNNER_ID_INVALID / RUNNER_REQUEST_INVALID, 404 RUNNER_JOB_NOT_FOUND, 409 RUNNER_LEASE_LOST / RUNNER_RESULT_CONFLICT, 413 RUNNER_BODY_TOO_LARGE, 503 RUNNER_GIT_ACCESS_UNAVAILABLE (with Retry-After), 500 RUNNER_INTERNAL_ERROR. #318 adds 401 WORKER_CREDENTIAL_INVALID (a Worker route got a credential that is not the job's: wrong job, unknown, expired or from an earlier claim; also the fourth call of the details route in one claim, whose three calls are spent: the Worker has nothing left to fetch and stops, the claim itself is not lost) and 409 RUNNER_JOB_ENDED (the app ended the job, for example after a permanent access failure at fetch; the Worker stops). #854 adds 401 RUNNER_REGISTRATION_TOKEN_INVALID (the registration token of a customer's runner is unknown, used or expired: one answer for all three) and 426 RUNNER_UPDATE_NEEDED (a customer's runner whose base is older than the minimum the app requires gets no job; the error carries `minBaseVersion`). A customer's runner authenticates with its own credential (contracts/runner-registration.v1.json); a revoked credential is a plain 401 RUNNER_UNAUTHORIZED. #971 adds 422 RUNNER_LABEL_RESERVED (a customer's runner announced a label of the platform's reserved namespace `cr:` in `POST /api/runners/v1/register` or `PUT /api/runners/v1/self`; `fields` names each by position, `labels[1]`, with the field code `reserved`; nothing is stored. Only the platform identity, the Dispatcher's shared token, may carry such a label, and it is the identity that decides, never the text).
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
  | "RUNNER_JOB_ENDED"
  | "RUNNER_REGISTRATION_TOKEN_INVALID"
  | "RUNNER_UPDATE_NEEDED"
  | "RUNNER_LABEL_RESERVED";

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
   * #318: claim exactly this job (a Dispatcher woken by the dispatch webhook). Every rule of the claim applies to it unchanged, the labels included (#971). Absent (Runner v2, #971): the oldest due job this caller matches: it has every label the job requires (`cr:managed` and a size label for a hosted job, the labels of the environment for a turn of a runner environment), the job is of its workspace (a customer's runner) and of a kind and harness it runs. 204 when there is none. Naming the job stays for a Dispatcher that is still woken by id.
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
 * #746: the one repository a turn works on. `fullName` is `owner/name`; `cloneUrl` is the https address the runner clones from (the host of the git provider), with no credential in it: the token is in `git.token`.
 */
export interface ImplementerRepo {
  fullName: string;
  cloneUrl: string;
}
/**
 * #856: what a turn on the harness `claude-code` is run with instead of a model door: the own Claude login of the customer, which lives on the device of the runner and is never in a job, in the app or in a log. `model` is a model name or alias as Claude Code reads it (`sonnet`, `claude-sonnet-5-5`); left out, Claude Code uses its default. `maxBudgetUsd` is the most the turn may be worth at API prices, in US dollars as a decimal string: Claude Code stops the turn after the call that crosses it (`--max-budget-usd`); a turn of several messages gets the budget that is left of the earlier messages' estimates, and when an earlier message's worth is unknown the runner cannot tell what is left, so the turn may be worth up to twice this amount. It is the only brake besides the clock of the job, since there is no model door and no ledger. What a subscription turn is worth is an estimate (`usage.costBasis` is `subscription`) that is shown, never billed and never added to a total.
 */
export interface ImplementerSubscription {
  model?: string;
  maxBudgetUsd: string;
}
/**
 * #745, step 7: the rule for the agent's network, as the owner of the environment wrote it. `off`: the agent has no network and no network door is started. `list`: the agent reaches the host names in `hosts` through the network door and no others; an entry is a host name in its ASCII (punycode) lower-case form, either exact (`registry.npmjs.org`) or a suffix (`*.pythonhosted.org`, any name below `pythonhosted.org`, not the name itself), never an IP address, a port or a path; both have at least two labels (after the `*.` for a suffix) and a last label that starts with a letter, which no address does; at most 100 entries. `open`: the agent reaches any public name. A name of a package registry (npm and Yarn, PyPI and its file host, crates.io, RubyGems: the domains `npmjs.org`, `npmjs.com`, `yarnpkg.com`, `pypi.org`, `pythonhosted.org`, `crates.io`, `rubygems.org` and the names below them) that a `list` reaches is reached read-only (#784): the door ends the TLS connection with a certificate of its own authority for that name, forwards `GET` and `HEAD` to the registry it checked and refuses every other method, a `Host` that is not the name, a body, plain HTTP and port 80; so an install works and a publish or upload does not. In every mode the door refuses IP literals, names that resolve to a private, loopback, link-local, shared or metadata address, and ports other than 80 and 443. `hosts` is empty unless the mode is `list`, and not empty then.
 */
export interface ImplementerNetworkRule {
  mode: "off" | "list" | "open";
  /**
   * @maxItems 100
   */
  hosts: string[];
}
/**
 * #843: the profile version a turn was started with, as the turn copied it when it started. Present only for a turn started with a profile and a caller that named the claim feature `implementer_profile`; a turn without a profile carries nothing and runs with the platform's own defaults, exactly as every turn did before profiles. The model and the cost limit of the version are not here: they are the turn's own `modelEntry`, `cost` and `llm.maxCostUsd`, chosen from the version by the app. `instructions`, when present, is the system-level text the agent is given: the runner appends it to the instruction file it writes for the engine (after its own rules, so the text is the same for every turn of one version and the model provider's prompt cache hits), as literal data written by a member of the workspace; it is left out when the version has none. `canPush` says whether Control pushes the branches the agent made when the turn ends: when false the runner pushes nothing, lists no branch, reports no head commit and no commits, and the turn is a success without a push (a profile that only reads). The agent never has a remote or a credential, whatever `canPush` says. `name` and `version` are for the run's log line only. #856: `harness` (optional, `opencode` when left out) is the harness the agent runs with. `claude-code` is run only by a runner that announces it as ready, on the login of the device of that runner (`ImplementerJob.subscription`); a runner that cannot run it refuses the turn (`implementer_engine_unavailable`, reason `harness_not_ready`) and never falls back to OpenCode.
 */
export interface ImplementerProfile {
  name: string;
  version: number;
  instructions?: string;
  canPush: boolean;
  harness?: "opencode" | "claude-code";
}
/**
 * #843: the result schema of a turn, in the format of `result-schema.v1.json` (a subset of JSON Schema: strings with optional `enum` and `maxLength`, numbers, whole numbers, booleans, lists with `items` and `maxItems`, objects with `properties` and `required`, all closed, at most 4 levels and 100 fields). Present only for a turn that has one (the task's own, or the default of its profile) and a caller that named the claim feature `implementer_result`. The agent gets a finish tool made from it and decides itself when it is done; the runner checks what it handed in against the schema, with the rules of the app's `checkResultValue`. The app holds the result to the bounds of a result and does not check it against the schema again: the workflow engine does, before it routes the value anywhere. This definition states the root only: the format, its limits and the answer to a schema that breaks them are those of `result-schema.v1.json` and of the validators on both sides (`contracts/result-check-vectors.json` holds them to the same answers).
 */
export interface ImplementerResultSchema {
  type: "object";
  properties: {
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #838 (part of #745): what a follow-up turn of an Implementer session is told about the branches the earlier turns left on the provider. Present only on a follow-up, and only for a caller that named the claim feature `implementer_resume`; a first turn has none. Without it the turn starts from `startBranch` (else `baseBranch`) as the contract says above; with it the runner takes the whole repository exactly as a first turn does (#909: every branch of the provider as a local branch and its tags, the whole history, no depth), so `branches` no longer decides what is cloned: it decides what is told to the agent when a branch moved or is gone since the earlier turn, makes the session branch at the start tip when the provider does not have it, and checks out `checkout`. `turn` is the number of this turn (the first is 1, so a follow-up has 2 or more). `branches` are the branches the last turn pushed with the tip it pushed, the session branch first when it is among them, at most 20, no name twice (a rule JSON Schema cannot state; the runner refuses a repeat). The `head` is only what the earlier turn knew: the runner takes the tip the provider has now, and a branch that moved is reported to the agent, not refused. A branch the provider no longer has is left out; a session branch that is gone ends the turn (`clone_failed`, free). `checkout` is the branch the agent was on when the last turn ended: one of `branches` or the session branch (which a turn that pushed nothing still has), or null for the session branch; any other name is refused by the runner (`invalid_job`). `branches` empty means the earlier turns pushed nothing: the turn starts from the base branch like a first turn. The agent still has no remote and Control still pushes every local branch that has a commit of its own when the turn ends, without force: a branch the agent did not touch is not pushed again. The app still holds the agent's earlier conversation (#840): `snapshot` (optional, default false) says that a stored session exists for this session; the Worker then fetches it from the app (`GET /api/workers/v1/jobs/{id}/resume-session`, `worker-api.v1.json`) and has the engine import it before it starts, and the turn continues in that session (`ImplementerResumeResult.mode` `imported`). When there is none, when it cannot be fetched or read, or the engine cannot import it (`ImplementerResumeResult.reason`), the turn starts a fresh session and is given `previousSummary` (the summary the last turn ended with, at most 8 KiB UTF-8) and `digest` (the app's record of the earlier turns: instructions, summaries, commit subjects, changed files; at most 16 KiB UTF-8) as DATA in a part of the first message of their own, never as instructions and never in the preface the runner writes (`mode` `summary_only`). Both are text that came from the agent and from members of the workspace; the maximum is in bytes, which JSON Schema cannot state, so `maxLength` counts characters and the runner counts bytes.
 */
export interface ImplementerResume {
  turn: number;
  /**
   * @maxItems 20
   */
  branches:
    | []
    | [ImplementerResumeBranch]
    | [ImplementerResumeBranch, ImplementerResumeBranch]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ]
    | [
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
        ImplementerResumeBranch,
      ];
  checkout: ImplementerBranchName | null;
  snapshot?: boolean;
  previousSummary?: string | null;
  digest?: string | null;
}
/**
 * #838: a branch of the session the last turn pushed: its name and the full commit id of the tip it pushed.
 */
export interface ImplementerResumeBranch {
  name: ImplementerBranchName;
  head: string;
}
/**
 * #745, step 7: what the network door did in a turn, in `ImplementerResult.network`; present for every turn that got as far as the network, whatever its rule (so for the rule `off` too; `door` is false then), also when the second wall is not in place (`vmPolicy` says so), so that a missing wall is never left out of the report. `connections` are the connections the door saw, one entry for each distinct host, port and outcome, with their count and the bytes each way (the bytes the door relayed, both directions, counted at the end of a connection; nothing of their content is kept), at most 100 (`dropped` counts the entries that did not fit); `reason` is a word of the door for a refusal (`not_listed`, `ip_literal`, `private_address`, `port_not_allowed`, `unresolvable`, `bad_request`, `too_many_connections`, `upstream_failed`, and for a package registry (#784) `method_not_allowed`, `host_mismatch`, `registry_read_only`, `tls_failed`) and null for an allowed connection. `vmPolicy` says what the second wall did: `narrowed` (the VM's network policy was cut to GitHub, the model provider, the app and the rule), `unchanged` (the rule is `open`, so the policy was left as it was), `not_configured` (this runner was started without a way to change the policy, for example because the Dispatcher has no public address or the App named no provider host: the first wall alone held, and the turn's notes say so).
 */
export interface ImplementerNetworkReport {
  mode: "off" | "list" | "open";
  door: boolean;
  vmPolicy: "narrowed" | "unchanged" | "not_configured";
  allowed: number;
  refused: number;
  bytesIn: number;
  bytesOut: number;
  dropped: number;
  /**
   * @maxItems 100
   */
  connections: {
    host: string;
    port: number;
    outcome: "allowed" | "refused";
    reason: string | null;
    count: number;
    bytesIn: number;
    bytesOut: number;
  }[];
}
/**
 * #818: what the setup script of a turn did, in `ImplementerResult.setup`; present when a script ran, absent otherwise. `ok` is whether it ended with exit status 0 within its time limit. `exitCode` is its exit status, null when it did not end by itself (the time limit, `timedOut`, or a signal). `output` is the end of what it wrote to stdout and stderr together, at most 8192 characters, with every secret known to the runner removed like every log line. A failed script ends the turn with the error code `environment_setup_failed` before the model is called.
 */
export interface ImplementerSetupResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationSeconds: number;
  output: string;
}
/**
 * #843: the result the agent handed in through the finish tool, in `ImplementerResult.agentResult`. Present only for a turn that carried `resultSchema` and only when the agent's result fits it: the runner reads the file the tool wrote once the agent's container is gone, holds it to at most 256 KiB, 8 levels and 20,000 values before it parses it, and checks it against the schema. Data of an untrusted writer: the app holds it to the same bounds, takes the secrets out of every text and key in it, shows it as plain text and hands it to a workflow only as data, never as a command; it does not check it against the schema (the workflow engine does, before it routes the value anywhere). A turn that ended without a valid result has no `agentResult` and ends `no_result`. A result the app finds over the bounds (also after the secrets are taken out) is left out and the turn is recorded `no_result` as well; the rest of the report is kept, so a result is never a reason to refuse a completion.
 */
export interface ImplementerAgentResult {
  [k: string]: unknown;
}
/**
 * #920: the question the agent ended the turn with instead of a result, in `ImplementerResult.agentAsk`. Present only for a turn that carried `canAsk` and handed in no result: the runner reads the file the finish tool wrote once the agent's container is gone, holds it to its bounds and takes the secrets out of every text. A turn with a question succeeds (`ok` true, no `errorCode`) and has no `agentResult`; the workflow engine puts the step into `waiting` and shows the question to people, and the answer starts the next turn of the same session. Data of an untrusted writer: shown as plain text, never a command. `options` is left out when there are none.
 */
export interface ImplementerAgentAsk {
  question: string;
  /**
   * @minItems 1
   * @maxItems 10
   */
  options?:
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
      ];
  context?: string;
}
/**
 * #746: what a turn of the Implementer did, in `RunnerResult.implementer`. A closed object; later fields (checks, open questions, an export of the work) are additive in a later change. It is facts the runner measured in the repository, never text from the agent except `summary`, which is shown as plain text. `baseCommit` is the head of the base branch the work started from; on a follow-up turn (the job carries `resume`) it is the tip the session branch started the turn at, which `commits` and `filesChanged` count from. `headCommit` is the last commit of the branch, or null when the turn made none. `pushed` says that the branch with `headCommit` is on the remote, and is never true without a `headCommit`. The branch is the one the form named. The agent may create other branches, and the runner pushes all local branches of the agent's repository when the turn ends, each without force: `branches` has one entry for every branch the runner dealt with (at most 50, the task's branch first and then alphabetical), `pushed` or `rejected` with a reason word of the runner (`non_fast_forward`, `remote_rejected`, `workflows_not_allowed`, `provider_refused`, `provider_error`, `provider_unavailable`, `timed_out`, `unreadable`, `not_a_commit`, `out_of_time`, `excluded`, `login_secret`, `unchecked`; a caller treats an unknown word as a rejection without a reason). A branch with nothing new on the base commit is not listed. `branchesDropped` counts the local branches that are in no entry: `invalid` those whose name cannot be pushed, `overflow` the valid ones beyond the limit of 50 (an unreadable list of branches, or one too long to read, has no entries and the turn ends `push_rejected`). A result without `branches` comes from an older runner and means none. `commits` are the commits of the form's branch after the base commit, oldest first, at most 200 (more are cut off, the head commit is always the last); `filesChanged` are the files that differ between the base commit and the head commit, at most 500. `opencode` names the saved agent session a later turn continues, null when none was saved. `checkedOut` (#837, optional) is the local branch the agent's HEAD was on when the runner read the repository after the turn, once a detached HEAD with work on no branch was saved on a branch (`<task branch>-leftover-<id>`): a name as those of `branches` are, null when HEAD was detached and on no branch, or was not read; a follow-up turn starts on it. It names a branch of the agent's repository, which may not have arrived: `branches` says which did. A result without `checkedOut` comes from an older runner. `resume` (#840, optional) says how a follow-up turn got its earlier conversation (`ImplementerResumeResult`); a result without it is a first turn, a turn that ended before the engine started, or comes from an older runner. A failed turn carries the block too, whenever the runner got as far as the repository.
 */
export interface ImplementerResult {
  baseCommit: string;
  headCommit: string | null;
  pushed: boolean;
  branchesDropped?: {
    invalid: number;
    overflow: number;
  };
  /**
   * @maxItems 50
   */
  branches?: {
    name: string;
    head: string | null;
    result: "pushed" | "rejected";
    reason: string | null;
  }[];
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
  setup?: ImplementerSetupResult;
  network?: ImplementerNetworkReport;
  checkedOut?: string | null;
  resume?: ImplementerResumeResult;
  agentResult?: ImplementerAgentResult;
  agentAsk?: ImplementerAgentAsk;
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
    /**
     * #891: true while a member has asked for this run to stop (a turn of the Implementer); absent means nobody did. The lease is extended as usual. The runner ends the agent, pushes what is committed, takes the snapshot, reports its result with errorCode `cancelled` and the usage it measured, and exits. A runner of an earlier release ignores the field; the app ends the job `cancelled` itself once the grace for the stop (4 minutes) is over, and the claim is then lost.
     */
    cancelRequested?: boolean;
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
  /**
   * #856: present only on a turn that ran on the harness `claude-code` (a login of the customer's device): `subscription`. Such a turn is not billed through us, so `costUsd` is null; `estimatedCostUsd` is what Claude Code says the turn is worth at API prices, an estimate that is shown as such (for example as 'about 1.20 USD through a subscription') and never billed and never added to a total. A reader that does not know the field ignores it, and a turn without it is billed as before.
   */
  costBasis?: "subscription";
  /**
   * #856: see `costBasis`. Null when Claude Code did not price every model of the turn from its list (unknown).
   */
  estimatedCostUsd?: number | null;
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
  branchesDropped?: {
    invalid: number;
    overflow: number;
  };
  /**
   * @maxItems 50
   */
  branches?: {
    name: string;
    head: string | null;
    result: "pushed" | "rejected";
    reason: string | null;
  }[];
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
  setup?: ImplementerSetupResult;
  network?: ImplementerNetworkReport;
  checkedOut?: string | null;
  resume?: ImplementerResumeResult;
  agentResult?: ImplementerAgentResult;
  agentAsk?: ImplementerAgentAsk;
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
     * succeeded or failed: the job is finished. queued: the runner reported runner_shutdown, the job was given back and waits for another runner (it fails instead if that was the last allowed attempt). superseded (#397): the run was replaced by a newer push; its report is stored once and the job stays superseded. cancelled (#891): the runner reported errorCode `cancelled` after it stopped a turn a member asked it to stop; the report is stored and the job is cancelled.
     */
    status: "succeeded" | "failed" | "queued" | "superseded" | "cancelled";
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
    /**
     * #971: the size label the job requires, `cr:size-<vCPUs>` of a size of `contracts/environment-sizes.v1.json` (the sizes of the platform: 1, 2, 4, 6, 8). The Dispatcher checks it: a label that names a size it does not launch is given back unlaunched. The size of the VM stays what it was: `vcpus` of the answer when the turn's environment names one, else the Dispatcher's own configuration for the kind (so a hosted turn without an environment gets the size the operator configured, whatever `cr:size-2` says). Every job this answer is for is a hosted one and has one: reviews run on `cr:size-1`, a turn of the Implementer on the size of its environment (`cr:size-2` without one). Optional only so that a Dispatcher can read the answer of an app of the previous release, which does not send it; the Dispatcher's own configuration applies then. It comes from the app's authenticated answer only. The namespace `cr:` is reserved for the platform identity (`contracts/runner-registration.v1.json`).
     */
    sizeLabel?: string;
    /**
     * #818: the VM size in vCPUs that the turn's environment asks for. Present only for a job of the kind `implementer` that was started with an environment; absent otherwise, and then the Dispatcher's configuration and default apply. It comes from the app's authenticated answer only. The Dispatcher launches only the sizes of the platform (`contracts/environment-sizes.v1.json`) and fails the launch with its own code for any other, and it ignores the field for every other kind, so a review can never name a size.
     */
    vcpus?: number;
    network?: ImplementerNetworkRule1;
    /**
     * #745, step 7: the host name of the model provider of a job of the kind `implementer` (the host of the upstream address of its model entry, a plain lower-case ASCII host name, never an address or a wildcard), for the Dispatcher that narrows the VM's network policy. The Dispatcher signs it, with the rule and an expiry, into the token of the switch call, so the VM cannot name another host there. Absent for every other kind, and for a provider whose address has no plain host name; the Dispatcher then gives the VM no switch.
     */
    modelHost?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #745, step 7: the rule for the agent's network, as the owner of the environment wrote it. `off`: the agent has no network and no network door is started. `list`: the agent reaches the host names in `hosts` through the network door and no others; an entry is a host name in its ASCII (punycode) lower-case form, either exact (`registry.npmjs.org`) or a suffix (`*.pythonhosted.org`, any name below `pythonhosted.org`, not the name itself), never an IP address, a port or a path; both have at least two labels (after the `*.` for a suffix) and a last label that starts with a letter, which no address does; at most 100 entries. `open`: the agent reaches any public name. A name of a package registry (npm and Yarn, PyPI and its file host, crates.io, RubyGems: the domains `npmjs.org`, `npmjs.com`, `yarnpkg.com`, `pypi.org`, `pythonhosted.org`, `crates.io`, `rubygems.org` and the names below them) that a `list` reaches is reached read-only (#784): the door ends the TLS connection with a certificate of its own authority for that name, forwards `GET` and `HEAD` to the registry it checked and refuses every other method, a `Host` that is not the name, a body, plain HTTP and port 80; so an install works and a publish or upload does not. In every mode the door refuses IP literals, names that resolve to a private, loopback, link-local, shared or metadata address, and ports other than 80 and 443. `hosts` is empty unless the mode is `list`, and not empty then.
 */
export interface ImplementerNetworkRule1 {
  mode: "off" | "list" | "open";
  /**
   * @maxItems 100
   */
  hosts: string[];
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
  /**
   * #818: the size of the VM in vCPUs, reported for a job of the kind `implementer` only (an app of the release before refuses an unknown field of this closed body, and a report that is refused costs only the measuring of the minutes), so that minutes can be priced by size.
   */
  vcpus?: number;
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
 * #745: the tokens of one model call, as the runner counts them.
 */
export interface StepTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  [k: string]: unknown;
}
/**
 * #745: the fields of a `StepRecord` of a kind of `KnownStepKind` beyond the ones every record has, and their bounds. The lengths are in characters.
 */
export interface KnownStepFields {
  text?: string;
  bytes?: number;
  tool?: string;
  status?: string;
  title?: string;
  input?: string;
  error?: string;
  reason?: string;
  tokens?: StepTokens;
  cost?: number;
  [k: string]: unknown;
}
/**
 * #745: POST /api/runners/v1/jobs/{id}/steps, with the runner token in Authorization and the lease token of the claim in the body, like the heartbeat. A batch of the records of a running turn of the Implementer: at most 50, in a body of at most 48 KiB (the app reads up to 64 KiB, RUNNER_MAX_BODY_BYTES, so the lease token and the escaping of the sender's JSON have room; 413 above). The call proves the claim and nothing more: it does NOT extend the lease, only the heartbeat does. 409 RUNNER_LEASE_LOST for a lost or stale claim (stop sending steps); 400 RUNNER_REQUEST_INVALID for a job that is not a turn of the Implementer or a record that does not fit the schema (the whole batch is refused: `fields` names the first wrong ones, as `records[2].text`); 404 RUNNER_JOB_NOT_FOUND. The sender is best effort: it drops what the app refuses and never lets this call delay the turn. The app also bounds a turn on its own (16,000 parts, 6 MiB of payload): what is past a bound is counted in `StepsResponse.dropped`.
 */
export interface StepsRequest {
  leaseToken: LeaseToken;
  /**
   * @minItems 1
   * @maxItems 50
   */
  records: [StepRecord, ...StepRecord[]];
  [k: string]: unknown;
}
/**
 * #745: 200 from the steps call. Counts of the records of the batch: `stored` made or changed a row, `stale` did not because the part holds a record with an equal or higher `seq` (a retry, or an older record that came late), `dropped` were left out (a kind the app does not know, or past a bound of the turn). Repeating a batch answers 200 with `stored` 0.
 */
export interface StepsResponse {
  version: 1;
  stored: number;
  stale: number;
  dropped: number;
  [k: string]: unknown;
}
/**
 * #879: the request headers of the two runner calls whose body is raw bytes (`PUT .../session`, `GET .../resume-session`), as an object of lower-case header names. The lease token of the claim, which the calls with a JSON body (heartbeat, complete, steps) carry in the body, travels in `X-Lease-Token` here, next to the runner credential in `Authorization: Bearer crc_...` (contracts/runner-registration.v1.json). Secret: never log it. The shared `RUNNER_TOKEN` of a Dispatcher is not accepted by these two calls (401 RUNNER_UNAUTHORIZED): a Dispatcher's Worker has the Worker API's calls of the same names.
 */
export interface RunnerLeaseTokenHeader {
  "x-lease-token": LeaseToken;
  [k: string]: unknown;
}
/**
 * #879: the query string of PUT /api/runners/v1/jobs/{id}/session, as an object of its parameters (every value is decimal digits or text in the URL): one part of the session snapshot of the running turn of the Implementer a customer's runner holds (follow-up turns). It is the call of the Worker API (`SessionPartQuery` in contracts/worker-api.v1.json: the same parts of exactly 3 MiB, at most 3, the same description of the whole file in every part, the same checks, the same replacement of the session's old snapshot once the last part is in) for a runner that holds no per-job credential: the runner credential is in `Authorization`, the lease token in `X-Lease-Token` (`RunnerLeaseTokenHeader`), the bytes of the part are the body (`application/octet-stream`, up to 3 MiB: 413 RUNNER_BODY_TOO_LARGE above, 400 RUNNER_REQUEST_INVALID with `fields` naming `body` unless exactly as long as `bytes` says for that part). The call proves the claim and nothing more: it does NOT extend the lease. 401 RUNNER_UNAUTHORIZED for a credential the app does not know, a revoked runner's included (and for the shared token); 404 RUNNER_JOB_NOT_FOUND for a job of another workspace, one another runner holds, or a hosted one (a Dispatcher holds it); 409 RUNNER_LEASE_LOST for a lease that ran out, a claim that ended or a token that is not the claim's (stop sending); 400 for a job that is not a turn of the Implementer, a missing or malformed `X-Lease-Token` (`fields`: `x-lease-token`) or a query or body that does not fit. The sender is best effort: a snapshot that is not stored means the next turn starts from a summary. The app lists the feature `runner_session_snapshot` in `KnownAppFeature`; a runner sends the call only to an app that lists it.
 */
export interface RunnerSessionPartQuery {
  part: string;
  parts: string;
  bytes: string;
  rawBytes: string;
  sha256: string;
  opencodeVersion: string;
  [k: string]: unknown;
}
/**
 * #879: 200 from PUT /api/runners/v1/jobs/{id}/session. `part` and `parts` repeat the request's; `complete` is true once the whole snapshot is stored, also for a part sent again after that. Repeating a part answers 200.
 */
export interface RunnerSessionPartResponse {
  version: 1;
  part: number;
  parts: number;
  complete: boolean;
  [k: string]: unknown;
}
/**
 * #879: the query string of GET /api/runners/v1/jobs/{id}/resume-session, as an object of its parameters: one part of the session snapshot the earlier turns stored, read by the customer's runner that holds a follow-up turn of the Implementer. It is the call of the Worker API (`ResumeSessionQuery` in contracts/worker-api.v1.json: the same parts of exactly 3 MiB, `part` from 0 and 0 when absent, the same answer of 200 with the bytes of the part, 204 when the session has no stored snapshot, a snapshot of the job's own session and of an earlier turn only) with the runner credential in `Authorization` and the lease token in `X-Lease-Token` (`RunnerLeaseTokenHeader`). The description of the whole file is in the headers of every part (`RunnerResumeSessionHeaders`). It proves the claim and nothing more: it does NOT extend the lease. The refusals are those of `RunnerSessionPartQuery`: 401 RUNNER_UNAUTHORIZED, 404 RUNNER_JOB_NOT_FOUND, 409 RUNNER_LEASE_LOST, and 400 RUNNER_REQUEST_INVALID (`fields`: `part` for a part that is not a number or beyond the last, `x-lease-token` for a missing or malformed token) also for a job that is not a turn of the Implementer. The runner checks the size and the sha256 of the whole file; a file it cannot fetch or read means the turn continues from a summary, never a failed turn.
 */
export interface RunnerResumeSessionQuery {
  part?: string;
  [k: string]: unknown;
}
/**
 * #879: the response headers of a 200 from GET /api/runners/v1/jobs/{id}/resume-session, as an object of lower-case header names (every value is text in the header). They are those of `ResumeSessionHeaders` in contracts/worker-api.v1.json and describe the WHOLE file, not the part: `x-snapshot-parts` (how many parts, 1 to 3, which is what `x-snapshot-bytes` makes), `x-snapshot-bytes` (the size of the gzip file), `x-snapshot-raw-bytes` (the size of the JSON inside it), `x-snapshot-sha256` (the lower case hex digest of the gzip file) and `x-snapshot-opencode-version` (the engine that wrote it). `Content-Length` is the size of this part. `Cache-Control` is `no-store`.
 */
export interface RunnerResumeSessionHeaders {
  "x-snapshot-parts": string;
  "x-snapshot-bytes": string;
  "x-snapshot-raw-bytes": string;
  "x-snapshot-sha256": string;
  "x-snapshot-opencode-version": string;
  [k: string]: unknown;
}
/**
 * #879: a customer's runner may also send its own credential (`Authorization: Bearer crc_...`; a revoked or unknown one is 401), to read the features before it uses a call the app of an earlier release does not have. The answer holds no job data; authenticating with a runner credential also marks the runner seen, as every call of the runner does. #318: 200 from GET /api/runners/v1/version (dispatcher credential; #322: a Worker may also send its per-job credential with ?jobId=<its job>, which must be the running claim of that job). Lets a Dispatcher or a Worker detect an app that is too old before it claims anything. An app of a previous release has no such route (404), which means it is too old. `version` is the runner API version; `appVersion` is the build of the app, for logs.
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
     * For RUNNER_REQUEST_INVALID and RUNNER_LABEL_RESERVED (field code `reserved`): which fields were refused and why (never their values).
     */
    fields?: {
      field: string;
      code: "required" | "invalid" | "too_long" | "reserved";
      [k: string]: unknown;
    }[];
    retryAfterSeconds?: number;
    /**
     * #854: for RUNNER_UPDATE_NEEDED, the oldest version of the base the app accepts (1.4.0).
     */
    minBaseVersion?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
