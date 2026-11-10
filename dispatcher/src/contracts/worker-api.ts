// SPDX-License-Identifier: LicenseRef-Proprietary

// Generated from contracts/worker-api.v1.json. Do not edit: change the schema and run `make generate-contracts`.
// `make verify` fails while this file differs from what the schema generates.

/**
 * Exactly the job the runner reads on stdin (see runner/src/code_reviewer_runner/job.py). Closed: the runner refuses unknown fields. Contains secrets (git.token, llm.apiKey): only the claim response carries it. #746: for `reviewKind: implementer` the job carries the `implementer` object instead of `prUrl`, `command`, `base` and `dynamic`; `git.token` is then a token that may write the contents of exactly the repository named in `implementer.repo` and nothing else. #856: `llm` is required for every job except a turn of the Implementer whose profile names the harness `claude-code` (a subscription turn): that turn runs on the login of the device of the runner, has no model door and no key of ours, and carries no `llm`, no `implementer.cost` and no `implementer.modelEntry`; the runner refuses a job that carries them with it, and every other job without `llm` (`invalid_job`).
 */
export type RunnerJobInput = {
  [k: string]: unknown;
} & {
  prUrl?: string;
  /**
   * The commands the product executes. Since the removal of /ask, /improve and /describe only /review exists (a historical run keeps its original command in the database, never on the wire).
   */
  command?: "review";
  /**
   * The review kind a job was queued for (#195), pinned at enqueue time. Absent on a legacy Diff payload means diff. A runner is only handed a job whose kind one of its engines can run, and a Dynamic job is never silently run by PR-Agent. #746: `implementer` is a turn of the Implementer (the factory deployment only): its input has no pull request (`prUrl`, `command`, `base` and `dynamic` are absent) and carries the closed `implementer` object; only a runner that advertised the engine `implementer` is handed one, and a job of this kind is never run by another engine.
   */
  reviewKind?: "diff" | "dynamic" | "implementer";
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
     * #424: the slug of an LLM provider, checked against the registry of the runner (`runner/src/code_reviewer_runner/llm_providers.py`), which refuses one it has none for with invalid_job. The app sends a provider only to a caller that advertised it in `llmProviders`; this release knows KnownLlmProvider. #555: the one exception is a native job (`dynamic.modelEntry` present): its provider may be a provider of the models.dev catalog outside the registry, named by its slug (the hyphen of the catalog id is an underscore); its key goes only to the address of the entry, which the runner accepts only as a plain public https address in exactly one spelling (`contracts/key-destination-vectors.json`), and the job then carries no `llm.baseUrl`, `llm.requireParameters` or `llm.fallbackModels`.
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
  /**
   * #746: the name of a branch as a job carries it: a non-empty text of at most 255 characters without whitespace and not starting with a dash (so it can never be read as an option). Whether it is a valid git ref name is decided by the app when the turn is submitted and again by the runner before it runs git; this is the floor both share.
   */
  baseBranch: string;
  /**
   * #746: the name of a branch as a job carries it: a non-empty text of at most 255 characters without whitespace and not starting with a dash (so it can never be read as an option). Whether it is a valid git ref name is decided by the app when the turn is submitted and again by the runner before it runs git; this is the floor both share.
   */
  startBranch?: string;
  /**
   * #746: the name of a branch as a job carries it: a non-empty text of at most 255 characters without whitespace and not starting with a dash (so it can never be read as an option). Whether it is a valid git ref name is decided by the app when the turn is submitted and again by the runner before it runs git; this is the floor both share.
   */
  branch: string;
  instruction: string;
  limits: {
    timeLimitSeconds: number;
  };
  /**
   * #553: whose key pays for a native job (a job that runs through the passthrough proxy) and what bounds its cost. Optional, additive, and sent only to a caller that named the claim feature `dynamic_cost_policy`; a job without it is a job of today. A closed object. `managed` (the instance operator's key, which we pay): `priceBook` is the confirmed price of the model (the app's price confirmation, #549) and is the runner's **only** price source, never the engine's own cost and never models.dev; an unknown cost ends the run with `dynamic_accounting_failed`, which billing treats as our fault; there is no token cap. `own` (the workspace's key, the user pays the provider): `priceBook` is the catalog's price when it states one, else null; an unknown cost does not end the run, it is bound by `maxTotalTokens` (prompt, cache and completion tokens in all) and the clock, and the result reports `costUsd: null`, which billing charges as minutes only. A call that stated no usage at all still fails the run.
   */
  cost?:
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
 * #818: the environment a turn was started with, as the turn copied it when it started: the setup script the runner runs once in the repository's folder after the clone and before the model is called, and (#745, step 7) the rule for the agent's network. Present only when the environment has a script or a network rule other than `off`, and the caller named the claim feature `implementer_environment` (and `implementer_network` for a rule); a turn with neither carries nothing (the size of the VM is the Dispatcher's business, it reaches the Worker as the VM it runs in). `setupScript`, when present, is literal text of at most 64 KB of UTF-8, written by a member of the workspace: it is data to run, never a command of the app, and it holds no secret by design (there is no field for one). `network`, when present, is the rule the network door enforces; absent means `off`. At least one of the two is present. `name` is for the run's log line only.
 */
export type ImplementerEnvironment = {
  [k: string]: unknown;
} & {
  name: string;
  setupScript?: string;
  network?: ImplementerNetworkRule;
};
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
} & {
  kind: string;
  partId: string;
  seq: number;
  startedAt?: number;
  endedAt?: number;
  [k: string]: unknown;
};
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
  implementer?: ImplementerResult;
  /**
   * What the run used. A failed result carries it too, whenever the run made at least one model call before it failed (a timeout at the end, an answer the validator refuses, a publish error): the app counts such a run exactly like a successful one. A run that failed before its first model call reports null. The cost follows the same rule as for a successful run: exact, or null when any call is unpriced; the token counters are reported either way.
   */
  usage?: RunnerUsage | null;
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
} & (
  | {
      mode?: "imported";
      [k: string]: unknown;
    }
  | {
      mode?: "summary_only";
      [k: string]: unknown;
    }
);

/**
 * #424: the query string of GET /api/workers/v1/jobs/{id}, as an object of its parameters. Both are optional comma separated lists: `features` (the names of KnownClaimFeature, unknown names are ignored) and `llmProviders` (slugs of LlmProviderId: the LLM providers the Worker can run; absent means `openrouter`). The app ignores the list today (the claim issue of epic #420 will use it); it still always sends `openrouter`.
 */
export interface WorkerJobDetailsRequest {
  features?: string;
  llmProviders?: string;
  [k: string]: unknown;
}
/**
 * 200 from GET /api/workers/v1/jobs/{id}: the job, with the git token and the model key minted at this call. Cache-Control is always no-store. The credential is not repeated here and there is no lease token: the credential is the proof of the claim.
 */
export interface WorkerJobDetailsResponse {
  version: 1;
  job: {
    /**
     * The id of a job (a UUID).
     */
    id: string;
    /**
     * ISO 8601, UTC.
     */
    leaseExpiresAt: string;
    /**
     * How often to send a heartbeat; the lease is several times longer.
     */
    heartbeatIntervalSeconds: number;
    /**
     * When the git token stops working; null if it does not expire.
     */
    tokenExpiresAt: string | null;
    input: RunnerJobInput;
    [k: string]: unknown;
  };
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
  /**
   * #553: whose key pays for a native job (a job that runs through the passthrough proxy) and what bounds its cost. Optional, additive, and sent only to a caller that named the claim feature `dynamic_cost_policy`; a job without it is a job of today. A closed object. `managed` (the instance operator's key, which we pay): `priceBook` is the confirmed price of the model (the app's price confirmation, #549) and is the runner's **only** price source, never the engine's own cost and never models.dev; an unknown cost ends the run with `dynamic_accounting_failed`, which billing treats as our fault; there is no token cap. `own` (the workspace's key, the user pays the provider): `priceBook` is the catalog's price when it states one, else null; an unknown cost does not end the run, it is bound by `maxTotalTokens` (prompt, cache and completion tokens in all) and the clock, and the result reports `costUsd: null`, which billing charges as minutes only. A call that stated no usage at all still fails the run.
   */
  cost?:
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
  /**
   * US dollars per million tokens as an exact decimal text (no exponent, no sign), for example "0.02016". Zero is a free model.
   */
  inputUsdPerMtok?: string;
  /**
   * US dollars per million tokens as an exact decimal text (no exponent, no sign), for example "0.02016". Zero is a free model.
   */
  outputUsdPerMtok?: string;
}
/**
 * #553: a price book in the JSON form of the app (`priceBookToJson`; `fakes/fixtures/price-books.json` is read by the app's and the runner's readers): the base level, models.dev's older `contextOver200k` level and up to 64 tiers, each for a prompt above `contextOver` tokens, from the smallest up. The runner reads it strictly and, for the book of a claim, does not price a cache read as input when the level has no read price (the call is then unpriced).
 */
export interface DynamicPriceBook {
  /**
   * #553: a price in whole micro-USD per million tokens as digits only (2.50 USD is "2500000"); at most 100000 USD per million tokens.
   */
  input: string;
  /**
   * #553: a price in whole micro-USD per million tokens as digits only (2.50 USD is "2500000"); at most 100000 USD per million tokens.
   */
  output: string;
  cacheRead?: string | null;
  cacheWrite5m?: string | null;
  cacheWrite1h?: string | null;
  reasoning?: string | null;
  inputAudio?: string | null;
  outputAudio?: string | null;
  contextOver200k?: DynamicPriceLevel | null;
  /**
   * @maxItems 64
   */
  tiers?: {
    contextOver: number;
    /**
     * #553: a price in whole micro-USD per million tokens as digits only (2.50 USD is "2500000"); at most 100000 USD per million tokens.
     */
    input: string;
    /**
     * #553: a price in whole micro-USD per million tokens as digits only (2.50 USD is "2500000"); at most 100000 USD per million tokens.
     */
    output: string;
    cacheRead?: string | null;
    cacheWrite5m?: string | null;
    cacheWrite1h?: string | null;
    reasoning?: string | null;
    inputAudio?: string | null;
    outputAudio?: string | null;
  }[];
}
/**
 * #553: the prices of one level of a price book. `input` and `output` are required, every other price may be null or left out and then means "not priced", never zero. The audio prices are read and not used: a call with audio tokens is unknown.
 */
export interface DynamicPriceLevel {
  /**
   * #553: a price in whole micro-USD per million tokens as digits only (2.50 USD is "2500000"); at most 100000 USD per million tokens.
   */
  input: string;
  /**
   * #553: a price in whole micro-USD per million tokens as digits only (2.50 USD is "2500000"); at most 100000 USD per million tokens.
   */
  output: string;
  cacheRead?: string | null;
  cacheWrite5m?: string | null;
  cacheWrite1h?: string | null;
  reasoning?: string | null;
  inputAudio?: string | null;
  outputAudio?: string | null;
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
  checkout: string | null;
  snapshot?: boolean;
  previousSummary?: string | null;
  digest?: string | null;
}
/**
 * #838: a branch of the session the last turn pushed: its name and the full commit id of the tip it pushed.
 */
export interface ImplementerResumeBranch {
  /**
   * #746: the name of a branch as a job carries it: a non-empty text of at most 255 characters without whitespace and not starting with a dash (so it can never be read as an option). Whether it is a valid git ref name is decided by the app when the turn is submitted and again by the runner before it runs git; this is the floor both share.
   */
  name: string;
  head: string;
}
/**
 * Extra options of the PR-Agent tools, as strings. The review tool's options (PR_REVIEWER__*) are used; a previous release's option families for the removed tools (PR_DESCRIPTION__*, PR_CODE_SUGGESTIONS__*, PR_QUESTIONS__*) are accepted for v1 compatibility and ignored. Nothing else is allowed here (credentials, endpoints and the model have their own fields).
 */
export interface JobEnv {
  [k: string]: string;
}
/**
 * The body of POST /api/workers/v1/jobs/{id}/heartbeat: empty (the credential identifies the job). A body is accepted and ignored.
 */
export interface WorkerHeartbeatRequest {
  [k: string]: unknown;
}
/**
 * 200 from the heartbeat: the lease is extended. 409 RUNNER_LEASE_LOST means the lease is lost: stop and deliver nothing.
 */
export interface WorkerHeartbeatResponse {
  version: 1;
  job: {
    /**
     * The id of a job (a UUID).
     */
    id: string;
    /**
     * ISO 8601, UTC.
     */
    heartbeatAt: string;
    /**
     * ISO 8601, UTC.
     */
    leaseExpiresAt: string;
    /**
     * #396: true when a newer push replaced this run; see HeartbeatResponse in runner-api.v1.json. Sent only to a Worker that named the feature `supersede` in its details request.
     */
    superseded?: boolean;
    /**
     * #891: true while a member has asked for this run to stop; see HeartbeatResponse in runner-api.v1.json. The Worker ends the turn, pushes what is committed and reports errorCode `cancelled`.
     */
    cancelRequested?: boolean;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
/**
 * #745: the body of POST /api/workers/v1/jobs/{id}/steps: a batch of the records of the running turn of the Implementer (the live view), at most 50 in at most 48 KiB. The credential identifies the job and proves the claim, so the body holds no lease token. The same rules and answers as POST /api/runners/v1/jobs/{id}/steps (`StepsRequest` in runner-api.v1.json): the call does NOT extend the lease, 409 RUNNER_LEASE_LOST for a lost claim, 409 RUNNER_JOB_ENDED when the job is over, 400 RUNNER_REQUEST_INVALID for a job that is not a turn of the Implementer or a record that does not fit.
 */
export interface WorkerStepsRequest {
  /**
   * @minItems 1
   * @maxItems 50
   */
  records: [StepRecord, ...StepRecord[]];
  [k: string]: unknown;
}
/**
 * #745: 200 from the Worker's steps call: `StepsResponse` of runner-api.v1.json.
 */
export interface StepsResponse {
  version: 1;
  stored: number;
  stale: number;
  dropped: number;
  [k: string]: unknown;
}
/**
 * #839: the query string of PUT /api/workers/v1/jobs/{id}/session, as an object of its parameters (every value is decimal digits or text in the URL). One request carries one PART of the session snapshot of a running turn of the Implementer (follow-up turns): the engine's export as the runner made it (JSON, secrets taken out, gzipped), at most 8 MiB gzipped. A function of the platform takes no request body over 4.5 MB, so the file is cut into parts of exactly 3 MiB (`bytes` / 3145728, rounded up, at most 3) and the last part is whatever is left; the body of the request is the bytes of the part (`application/octet-stream`), read up to 3 MiB (413 RUNNER_BODY_TOO_LARGE above) and exactly as long as `bytes` says for that part (400 otherwise). Every part carries the description of the whole file: `parts` (the count, which must be what `bytes` makes), `part` (this part's index from 0), `bytes` (the size of the gzip file), `rawBytes` (the size of the JSON inside it), `sha256` (the lower case hex digest of the gzip file) and `opencodeVersion` (the engine that wrote it). A part is judged on its own and may arrive in any order or twice. The app keeps the parts of the job apart; when the last one is in it puts them together, checks size and digest, and swaps the snapshot in for the session's old one (one snapshot for each session, replaced by each turn, kept for good; the old one stays readable until then). 400 RUNNER_REQUEST_INVALID names the wrong fields (`fields`), also `body` for parts that do not make the announced file or disagree with each other (nothing of that upload is kept). The call proves the claim and nothing more: it does NOT extend the lease. 409 RUNNER_JOB_ENDED when the job is over, 401 WORKER_CREDENTIAL_INVALID for a credential that is not the job's, 400 for a job that is not a turn of the Implementer. The sender is best effort: a snapshot that is not stored means the next turn starts from a summary.
 */
export interface SessionPartQuery {
  part: string;
  parts: string;
  bytes: string;
  rawBytes: string;
  sha256: string;
  opencodeVersion: string;
  [k: string]: unknown;
}
/**
 * #839: 200 from the snapshot call. `part` and `parts` repeat the request's; `complete` is true once the whole snapshot is stored, also for a part sent again after that. Repeating a part answers 200.
 */
export interface SessionPartResponse {
  version: 1;
  part: number;
  parts: number;
  complete: boolean;
  [k: string]: unknown;
}
/**
 * #840: the query string of GET /api/workers/v1/jobs/{id}/resume-session, as an object of its parameters. The Worker of a follow-up turn (`implementer.resume.snapshot` true) fetches the session snapshot the app stored for the job's own session (the file `PUT .../session` delivered, replaced by each turn): the engine's export, gzipped, at most 8 MiB. A response body is held to 4.5 MB like a request body, so the file comes in the same parts of exactly 3 MiB (`bytes` / 3145728, rounded up, at most 3; the last part is whatever is left) and `part` (from 0, default 0) names the one to send. 200 `application/octet-stream`: the bytes of that part, with the description of the whole file in the headers `ResumeSessionHeaders` (every part carries it, so a part is judged on its own and the parts may be fetched in any order and twice). 204 without a body: the session has no stored snapshot (never saved, or not by a turn that could). 400 RUNNER_REQUEST_INVALID (`fields`: `part`) for a part that is not a number or beyond the last. 401 WORKER_CREDENTIAL_INVALID, 409 RUNNER_JOB_ENDED / RUNNER_LEASE_LOST as for every Worker call, and 400 for a job that is not a turn of the Implementer. The call reads a snapshot of the job's own session and of no other: the app finds the session from the job. It proves the claim and nothing more: it does NOT extend the lease. The Worker checks the size and the sha256 of the whole file; a file it cannot fetch or read means the turn continues from a summary (`ImplementerResumeResult`), never a failed turn. The file holds what the earlier turns read and said, secrets of the turn taken out, tool outputs included (see the session snapshot in docs/implementer.md).
 */
export interface ResumeSessionQuery {
  part?: string;
  [k: string]: unknown;
}
/**
 * #840: the response headers of a 200 from GET /api/workers/v1/jobs/{id}/resume-session, as an object of lower-case header names (every value is text in the header). They describe the WHOLE file, not the part: `x-snapshot-parts` (how many parts, 1 to 3, which is what `x-snapshot-bytes` makes), `x-snapshot-bytes` (the size of the gzip file), `x-snapshot-raw-bytes` (the size of the JSON inside it), `x-snapshot-sha256` (the lower case hex digest of the gzip file) and `x-snapshot-opencode-version` (the engine that wrote it). `Content-Length` is the size of this part. `Cache-Control` is `no-store`.
 */
export interface ResumeSessionHeaders {
  "x-snapshot-parts": string;
  "x-snapshot-bytes": string;
  "x-snapshot-raw-bytes": string;
  "x-snapshot-sha256": string;
  "x-snapshot-opencode-version": string;
  [k: string]: unknown;
}
/**
 * The body of POST /api/workers/v1/jobs/{id}/result. The whole request body must not exceed 65536 bytes (413 otherwise). The app applies the redaction of the runner API's complete call, including the model key remembered at fetch. A result with errorCode runner_shutdown or launch_failed is not stored: the job is given back and counts an attempt.
 */
export interface WorkerResultRequest {
  result: RunnerResult;
  [k: string]: unknown;
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
    /**
     * #746: what happened to a file between the base commit and the head commit.
     */
    status:
      "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange";
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
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
      ]
    | [
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
      ]
    | [
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
      ]
    | [
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
      ]
    | [
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
        {
          /**
           * The engine's tools; every other name a model called is `other`.
           */
          name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
          count: number;
        },
      ];
}
/**
 * One tool call. isRepeat is true when the same tool with the same normalised arguments already ran in this job; the arguments themselves are never sent. resultBytes is the size of the result the model was shown, null when it never was.
 */
export interface RunnerToolCallTrace {
  index: number;
  /**
   * The engine's tools; every other name a model called is `other`.
   */
  name: "read" | "grep" | "glob" | "StructuredOutput" | "other";
  resultBytes: number | null;
  isRepeat: boolean;
}
/**
 * 200 for a result and for the repetition of the same result (alreadyCompleted: true); a different result for a finished job is 409 RUNNER_RESULT_CONFLICT. After the job reached a final state only a repeat of the same result is accepted.
 */
export interface WorkerResultResponse {
  version: 1;
  job: {
    /**
     * The id of a job (a UUID).
     */
    id: string;
    /**
     * succeeded or failed: the job is finished. queued: the job was given back (runner_shutdown, launch_failed) and waits for another claim; it fails instead if that was the last allowed attempt. superseded (#397): the run was replaced by a newer push; its result is stored once and the job stays superseded. cancelled (#891): the Worker reported errorCode `cancelled` after it stopped a turn a member asked it to stop.
     */
    status: "succeeded" | "failed" | "queued" | "superseded" | "cancelled";
    [k: string]: unknown;
  };
  alreadyCompleted: boolean;
  [k: string]: unknown;
}
/**
 * Every error of the Worker API. The same body as the runner API's ErrorResponse; the codes are those of ApiErrorCode.
 */
export interface WorkerErrorResponse {
  error: {
    /**
     * Every error of the API has one of these codes. 401 RUNNER_UNAUTHORIZED, 400 RUNNER_ID_INVALID / RUNNER_REQUEST_INVALID, 404 RUNNER_JOB_NOT_FOUND, 409 RUNNER_LEASE_LOST / RUNNER_RESULT_CONFLICT, 413 RUNNER_BODY_TOO_LARGE, 503 RUNNER_GIT_ACCESS_UNAVAILABLE (with Retry-After), 500 RUNNER_INTERNAL_ERROR. #318 adds 401 WORKER_CREDENTIAL_INVALID (a Worker route got a credential that is not the job's: wrong job, unknown, expired or from an earlier claim; also the fourth call of the details route in one claim, whose three calls are spent: the Worker has nothing left to fetch and stops, the claim itself is not lost) and 409 RUNNER_JOB_ENDED (the app ended the job, for example after a permanent access failure at fetch; the Worker stops). #854 adds 401 RUNNER_REGISTRATION_TOKEN_INVALID (the registration token of a customer's runner is unknown, used or expired: one answer for all three) and 426 RUNNER_UPDATE_NEEDED (a customer's runner whose base is older than the minimum the app requires gets no job; the error carries `minBaseVersion`). A customer's runner authenticates with its own credential (contracts/runner-registration.v1.json); a revoked credential is a plain 401 RUNNER_UNAUTHORIZED. #971 adds 422 RUNNER_LABEL_RESERVED (a customer's runner announced a label of the platform's reserved namespace `cr:` in `POST /api/runners/v1/register` or `PUT /api/runners/v1/self`; `fields` names each by position, `labels[1]`, with the field code `reserved`; nothing is stored. Only the platform identity, the Dispatcher's shared token, may carry such a label, and it is the identity that decides, never the text).
     */
    code:
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
    message: string;
    retryAfterSeconds?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
