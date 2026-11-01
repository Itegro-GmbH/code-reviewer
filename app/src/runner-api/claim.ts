// SPDX-License-Identifier: LicenseRef-Proprietary

// POST /api/runners/v1/claim: hands the next job to a runner, with everything it needs to run it.
//
// The credentials are created here, at claim time, and nowhere else (never when the job is queued):
// the job is claimed first (so it has a holder and a lease), then, in this order,
//
//   1. the claim guard may refuse it (the project is off, see claim-guard.ts),
//   2. the provider, model and (on the operator's key) catalog entry are chosen (`selectModel`, claim-selection.ts), and
//      only then the key of that provider is loaded (`keyFor`): the key follows the selection, never the other way round,
//   3. the pull request must still exist and be open (`getPullRequest`),
//   4. the git credentials are created for exactly this repository (`jobAccess`, the only call that
//      mints a token for a job) and revealed once, into the response.
//
// A job that cannot run for a reason that will not go away ends as failed with a stable code, and
// the runner is handed the next job (it never hears of it). A reason that may pass (GitHub is down or
// rate limiting, the pull request could not be read) gives the job back with `release` (a lost
// attempt, capped like a lapsed lease) and answers 503 with Retry-After.
//
// Nothing in here logs or keeps a credential: the revealed access exists only as a local value that
// is built as late as possible and dropped with the response.
//
// #753: a turn of the Implementer (the kind `implementer`) takes the same road with two differences. Its facts are the turn's, not a
// pull request's: nothing reads a pull request, the installation must hold the write permission (`git_write_not_granted`), and
// step 4 creates a token that may write exactly this repository (`implementerAccess`) and builds the `implementer` block of the
// input. The model must be a native one (entry and cost policy) that serves the Dynamic kind.
//
// #320: a claim that names the feature `worker_credential` (a Dispatcher) runs steps 1 to 3 only and
// answers with a per-job credential and no input. Step 4 (`buildJobInput`: the job's input, with the git
// credentials and the model key) runs when the Worker fetches the job (`worker-fetch.ts`), by the same
// code, so the Dispatcher never sees a secret of the job.
import "server-only";
import type { AttemptedShas } from "../db/repositories/jobs-repository.ts";
import type { IntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import type {
  StoredImplementerSession,
  StoredImplementerTurn,
} from "../db/repositories/implementer-repository.ts";
import type { RepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { IntegrationError } from "../integrations/errors.ts";
import { revealGitAccess } from "../integrations/normalized.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type {
  GitAccess,
  GitPlatform,
  Integration,
  IntegrationType,
  RepoRef,
  ReviewCommand,
} from "../integrations/types.ts";
import type { RunnerQueue } from "../jobs/runner-queue.ts";
import type { ClaimResult, Job, JobErrorCode } from "../jobs/job-types.ts";
import { REVIEW_SETTING_LIMITS } from "../review-settings/settings.ts";
import { withClaimedKeyMode } from "../workspaces/effective-key-mode.ts";
import type { ResolvedEntitlements } from "../workspaces/entitlements.ts";
import { revealLlmAccess, type LlmAccessResult } from "../llm/access.ts";
import { llmProviderDescriptors as DEFAULT_PROVIDERS } from "../llm/providers/index.ts";
import type { LlmProvider } from "../llm/config.ts";
import { MANAGED_MODEL_UNAVAILABLE, type Selection } from "../llm/selection.ts";
import type { UsageKeyMode } from "../usage/usage-records.ts";
import { dynamicCapabilitiesOf } from "../llm/dynamic-capabilities.ts";
import type {
  ModelCapabilityChecker,
  ModelCapabilityResult,
} from "../llm/model-capabilities.ts";
import { reviewTokenBudget } from "../model-catalog/token-budget.ts";
import {
  PROVIDER_ADDRESS_CHANGED,
  type NativeCostService,
} from "../native-cost/service.ts";
import type { CostPolicyJson } from "../native-cost/policy.ts";
import type { JobModelEntry } from "../models-dev/job-entry.ts";
import type { KnownContextWindow } from "./known-context-window.ts";
import type { ClaimedKeys } from "./claimed-keys.ts";
import type { ProviderPins } from "./provider-pins.ts";
import type { ClaimGuard } from "./claim-guard.ts";
import { selectModel, type SelectionDeps } from "./claim-selection.ts";
import { jobCostLimit } from "./job-cost-limit.ts";
import {
  RUNNER_API_VERSION,
  RUNNER_ENV_KEY_PATTERN,
  type AnyJobInput,
  type ClaimBase,
  type ClaimFeature,
  type ClaimResponse,
  type DynamicModelCapabilities,
  type DynamicReviewOptions,
  type SplitClaimResponse,
} from "./contract.ts";
import type { RunnerEngine } from "../jobs/runner-capabilities.ts";
import type { JobOptions, JobOptionsSource } from "./job-options.ts";
import { describeError, type RunnerApiLogger } from "./logger.ts";
import { refusalForKind } from "./kind-guard.ts";
import { DEFAULT_TOKEN_LIFETIME_MS } from "./write-token.ts";
import type { UndeliveredTokenRevoker } from "./write-token.ts";
import type { GitTokenEntry } from "./claimed-keys.ts";
import { keyModeForJob } from "../llm/resolve.ts";
import type { ModelChoice } from "../db/implementer-model-choice.ts";
import { callerLlmProviders } from "./requests.ts";
import { errorResponse, jsonResponse, noContent } from "./responses.ts";
import type { ClaimOptions } from "../db/repositories/runner-jobs-repository.ts";

/**
 * The codes a job gets when it ends at claim time. Branch on these, not on messages. The queue's
 * own `pull_request_closed` and the guard's codes come on top.
 */
export const CLAIM_FAILURE_CODES = [
  "llm_not_configured",
  "git_connection_disabled",
  "git_connection_gone",
  "git_connection_suspended",
  "git_scope_refused",
  "git_app_auth_failed",
  "git_access_failed",
  "pr_not_found",
  "pull_request_closed",
  "job_args_invalid",
  "job_env_invalid",
  "job_llm_options_invalid",
  // #195: the claimed job's kind is not one the runner advertised (a raced settings change), or its
  // Dynamic options are missing/unusable. The runner is never silently given the other engine.
  "dynamic_engine_unavailable",
  "dynamic_config_invalid",
  // #746, #753: the claimed job is a turn of the Implementer and the caller cannot run one (it did not advertise the engine, or this
  // deployment does not have the capability).
  "implementer_engine_unavailable",
  // #753: the turn's options cannot be used (its record is missing, or its model is not a native one with a cost policy).
  "implementer_config_invalid",
  // #753: the installation has not accepted the permission to write contents; the owner of the installation has to accept it.
  "git_write_not_granted",
  // #279: the provider's metadata says the model lacks tool calling or a required tool choice.
  "dynamic_model_features_unsupported",
  // #432 (ADR 0005, 2.8): the job runs on the operator's key and the catalog entry it selects cannot be used (none
  // selected, unknown, not released, not for this kind, not in the plan, or its provider is not available). Never a move to
  // another entry.
  "managed_model_unavailable",
  // #432: the provider an own project selected is one the app does not know or the runner did not advertise.
  "llm_provider_unsupported",
  // #555: an own job names a catalog model the catalog no longer serves (its row is gone). Never a move to another model.
  "llm_model_unavailable",
  // #588: an own job names a catalog provider whose trusted address is no longer the one the project pinned when it selected it.
  // The key is not sent anywhere; an Owner or Admin confirms the new address in the settings of the project. Free.
  "provider_address_changed",
] as const;

/** Why a job is given back (the code becomes the job's error code if it was the last attempt). */
export const CLAIM_RELEASE_REASONS = [
  "git_access_unavailable",
  "pull_request_unavailable",
  "claim_failed",
  // #553: the price check of a managed native job failed itself (the database could not be read); not the model's fault.
  "price_check_failed",
  // #588: the pin of a legacy selection could not be adopted (the settings could not be written, or the project changed meanwhile);
  // the job is judged again. Not the model's fault.
  "provider_pin_check_failed",
  // #320: the Dispatcher could not start the Worker (reported with the Worker API's result call).
  "launch_failed",
  // #375: the Worker's container ended with an error before it reported a result (the Dispatcher's release call).
  "worker_exited",
] as const;

/**
 * #753: how long a turn of the Implementer may run, in seconds. A constant of the kind: the Dispatcher stops the Worker at its
 * own per-kind job timeout of the same length, and the runner keeps the last minutes of it for the final commit and push.
 */
export const IMPLEMENTER_TIME_LIMIT_SECONDS = 3600;

/** When the platform does not say how long to wait. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 900;
/** How many jobs one claim request may end at claim time before it answers 204 and lets the runner ask again. */
const MAX_REFUSED_PER_REQUEST = 25;

export type ClaimDeps = {
  queue: Pick<
    RunnerQueue,
    "claimNext" | "complete" | "release" | "cancelClaimed"
  >;
  /**
   * The repositories and integrations of one workspace. A claim serves the whole instance, so the
   * workspace is the one the claimed job names (`job.workspaceId`).
   */
  repositories: (workspaceId: string) => Pick<RepositoriesRepository, "get">;
  integrations: (workspaceId: string) => Pick<IntegrationsRepository, "get">;
  /**
   * The exact head of the last successful review of the claimed job's pull request for the same
   * review kind (#199), or null when there is none. Only a Dynamic claim asks; it becomes the
   * `previousReviewedSha` the checkout and the publisher compare against.
   */
  previousReviewedSha: (job: Job) => Promise<string | null>;
  /**
   * The heads of the earlier jobs of that pull request that did not succeed (#255), newest first. A
   * run may have written the summary before it ended; the publisher accepts these heads as a state
   * it can account for, so one lost run never wedges the pull request. `truncated` (#257) says the
   * list was cut, so the runner can recover a state head that fell out of it. Only a Dynamic claim asks.
   */
  attemptedShas: (job: Job) => Promise<AttemptedShas>;
  registry: IntegrationRegistry;
  guard: ClaimGuard;
  jobOptions: JobOptionsSource;
  /**
   * #689: the most one review may cost, in whole US cents, as the operator set it in the admin portal (the instance setting
   * `review_max_cost_cents`; 1.00 USD until it is set). Read when a job's input is built, so a change reaches the next job.
   */
  operatorCostLimitCents: () => Promise<number>;
  /**
   * The key a job needs, once its provider is chosen (`selectModel`): the workspace's own key of the selection's provider,
   * or the operator's key of it, as the selection says. Called for the selected job's workspace only, after the
   * selection, never before. Nothing of another workspace or another provider is read.
   */
  keyFor: (
    workspaceId: string,
    selection: Selection,
  ) => Promise<LlmAccessResult>;
  /**
   * The entitlements of ONE workspace as they are stored right now (`readEntitlements`), without a key mode: the standing
   * (suspended, unreadable) and the model access. The Worker's fetch asks for the standing before it hands out a key, because
   * the claim that admitted the job is behind it (#276).
   */
  entitlementsFor: (workspaceId: string) => Promise<ResolvedEntitlements>;
  /**
   * Whose key the claimed job runs on, as its claim decided and recorded it in the usage record (src/usage/README.md, #496).
   * Read by the checks of the claim and of the Worker's fetch, which never decide it again: a choice of the workspace after
   * the claim does not reach the job. `undefined` when the job has no record.
   */
  claimedKeyMode: (job: Job) => Promise<UsageKeyMode | undefined>;
  /**
   * #753: the turn (and its session) an implementer job runs: the instruction, the branch, the base branch, the model it was
   * started with and its cost limit. Asked only for a job of that kind, in the job's own workspace; `undefined` for a job that
   * is not a turn.
   */
  implementerTurn: (job: Job) => Promise<
    | {
        turn: StoredImplementerTurn;
        session: StoredImplementerSession;
      }
    | undefined
  >;
  /**
   * Notes the provider and, for a job on the operator's key, the catalog entry (id and name as they are now) the job was
   * given in its usage record (#432): never the model. The claim reserved the record already; a failure gives the job back.
   */
  recordSelection: (job: Job, selection: Selection) => Promise<void>;
  /** The catalog entries and defaults a job on the operator's key is chosen from (#432); an own job reads none. */
  catalog: SelectionDeps["catalog"];
  /** The providers of the app (the resolver's own registry unless a test brings a second provider). */
  providers?: SelectionDeps["providers"];
  /** The model of a kind when no layer of the settings sets one: `LLM_MODEL`, or the Dynamic default (#432). */
  builtInModel: SelectionDeps["builtInModel"];
  /**
   * Where the key handed out with a claim is noted (encrypted, in the database), so a rotated key can still be masked,
   * and the model of a catalog entry (#280, #432), so it can be masked in the result even if the operator changes the entry.
   */
  claimedKeys: Pick<
    ClaimedKeys,
    | "remember"
    | "rememberModel"
    | "rememberNative"
    | "rememberGitToken"
    | "hasGitTokens"
  >;
  /**
   * #753: switches off a write token of a turn of the Implementer that was made and never handed to a Worker (the fetch failed
   * after it). Only that token: the ones an earlier fetch handed over are in use. Never rejects; does nothing for another kind.
   */
  revokeUndelivered: UndeliveredTokenRevoker;
  /**
   * #790: the addresses the projects of a workspace pinned for a catalog provider (`createPinnedAddressReader`). A turn has no
   * project of its own, so a workspace's key goes only to an address its projects pinned, as for a Dynamic review.
   */
  pinnedAddresses: (workspaceId: string, slug: string) => Promise<string[]>;
  /**
   * #279: where the metadata of a Dynamic job's model is read when its claim is built (the provider's
   * public endpoint metadata, cached for a short time). Left out, a claim reads none and a Dynamic job
   * carries no capabilities, as before.
   */
  modelCapabilities?: ModelCapabilityChecker;
  /**
   * #689: the context window the public catalog (models.dev, in the app's database) states for a model, for a Diff job on the
   * workspace's own key: such a job never asks the customer's provider, so this is how its token budget is cut to the window of
   * its model. Left out, no window is known from the catalog and the instance's `LLM_MAX_TOKENS` or the built-in value is used.
   */
  knownContextWindow?: KnownContextWindow;
  /**
   * #553: the cost policy of a native job (a job whose selection names a catalog model, src/native-cost/). Left out, no job
   * is native: the claim is exactly the claim of today. The running server wires it (`getNativeCost()`).
   */
  nativeCost?: Pick<NativeCostService, "refOf" | "policyFor" | "entryFor">;
  /**
   * #588: where the address a selection of a catalog provider was pinned to is adopted for a selection made before pins existed:
   * the claim pins the address it is about to send the key to, once. Answers the pin in force, or null when the project no
   * longer selects the provider. Only asked for such a selection.
   */
  providerPins: ProviderPins;
  now: () => Date;
  logger: RunnerApiLogger;
  heartbeatIntervalSeconds: number;
};

/** Why a job does not go on: it ends, it is cancelled, or it is given back to try again later. */
export type Refusal =
  | { kind: "refused"; errorCode: string; detail?: string }
  | { kind: "cancelled"; errorCode: JobErrorCode }
  | { kind: "retry"; reason: string; retryAfterSeconds: number };

type Prepared =
  | {
      kind: "ready";
      response: ClaimResponse;
      entryModel: string | null;
      native: boolean;
      /** #753: the write token of a turn, which the claim remembers before the input leaves and switches off if it cannot. */
      writeToken: GitTokenEntry | null;
    }
  /** #320: the claim of a Dispatcher: the credential and no input. */
  | { kind: "split"; response: SplitClaimResponse }
  | Refusal;

/** What the checks of a job established; the input of the job is built from it. */
export type Checked = {
  kind: "checked";
  /** What the job runs on: provider, model and, on the operator's key, the catalog entry (#432). */
  selection: Selection;
  /** The key of the selection's provider; `access.model` is the instance's, the job's model is `selection.model`. */
  llm: Extract<LlmAccessResult, { ok: true }>;
  command: ReviewCommand;
  options: JobOptions;
  llmOptions: { maxCostCents?: number };
  /** The Dynamic options of a Dynamic job; null for a Diff job. */
  dynamic: DynamicReviewOptions | null;
  /** #553: the cost policy of a native Dynamic job (`dynamic.cost`); null for every other job. */
  cost: CostPolicyJson | null;
  /** #578: the entry of the model of a native Dynamic job (`dynamic.modelEntry`); null exactly when `cost` is. */
  modelEntry: JobModelEntry | null;
  integration: Integration;
  repo: RepoRef;
  prUrl: string;
  baseRef: string;
  /** #753: what the turn of an implementer job asks for; null for every other job. */
  implementer: {
    instruction: string;
    branch: string;
    baseBranch: string;
    /** The https address the runner clones from and pushes to, with no credential in it (`cloneUrlOf`). */
    cloneUrl: string;
  } | null;
};

/** What `buildJobInput` made: the input of the job and when its git token stops working. */
export type Built = {
  kind: "built";
  input: AnyJobInput;
  tokenExpiresAt: string | null;
  /** The model of the catalog entry the job runs on, or null for an own job; remembered for masking (#280, #432). */
  entryModel: string | null;
  /** #578: the input carries a native model entry (`dynamic.modelEntry`); remembered for the report. */
  native: boolean;
  /**
   * #753: the write token of a turn of the Implementer (the same value as `input.git.token`), or null. The caller remembers it
   * before the input leaves and switches it off when the input does not (`revokeUndelivered`).
   */
  writeToken: GitTokenEntry | null;
};

function refuse(errorCode: string, detail?: string): Refusal {
  return detail === undefined
    ? { kind: "refused", errorCode }
    : { kind: "refused", errorCode, detail };
}

export function retryAfterOf(error: unknown): number {
  const seconds =
    error instanceof IntegrationError ? error.retryAfterSeconds : null;
  return Math.min(
    Math.max(Math.ceil(seconds ?? DEFAULT_RETRY_AFTER_SECONDS), 1),
    MAX_RETRY_AFTER_SECONDS,
  );
}

function accessFailureCode(error: IntegrationError): string {
  switch (error.code) {
    case "INTEGRATION_ACCESS_CONNECTION_GONE":
      return "git_connection_gone";
    case "INTEGRATION_ACCESS_CONNECTION_SUSPENDED":
      return "git_connection_suspended";
    case "INTEGRATION_ACCESS_SCOPE_REFUSED":
      return "git_scope_refused";
    case "INTEGRATION_ACCESS_APP_AUTH_FAILED":
      return "git_app_auth_failed";
    // #753: the installation has not accepted contents write (a race with the check that ran just before the token).
    case "INTEGRATION_ACCESS_PERMISSION_NOT_GRANTED":
      return "git_write_not_granted";
    // #753: this deployment does not offer the Implementer, whatever the App was set to by hand.
    case "INTEGRATION_CAPABILITY_ABSENT":
      return "implementer_engine_unavailable";
    default:
      return "git_access_failed";
  }
}

/** The platform each integration type talks to; the runner knows GitHub only. */
const PLATFORM_OF: Record<IntegrationType, GitPlatform> = {
  github_app: "github",
};

/**
 * The cost limit a project chose, as the job takes it: a null is left out (the runner refuses a `maxCostUsd` outside its
 * range). Null when the value is one the runner would refuse. The model is not here: the provider and model of a job are chosen
 * by the resolver (`selectModel`), which also checks the model id. Neither is the token budget: since #689 no setting names it,
 * the claim decides it from the model (`reviewTokenBudget`).
 */
function llmOptionsOf(options: JobOptions): { maxCostCents?: number } | null {
  const { maxCostCents } = options.llm ?? {};
  const chosen: { maxCostCents?: number } = {};
  if (maxCostCents !== undefined && maxCostCents !== null) {
    const { min, max } = REVIEW_SETTING_LIMITS.maxCostCents;
    if (
      !Number.isInteger(maxCostCents) ||
      maxCostCents < min ||
      maxCostCents > max
    )
      return null;
    chosen.maxCostCents = maxCostCents;
  }
  return chosen;
}

/**
 * #753: the options of a turn: what the settings of a project are for a review. The model is the one the task was started with
 * (`{entryId}` on the operator's key, `{provider, model}` on the workspace's own), the cost limit the customer's limit for this
 * turn. A turn takes nothing from the project: no PR-Agent environment, no skill, no layer of settings.
 */
function implementerOptionsOf(
  choice: ModelChoice,
  costLimitCents: number | null,
): JobOptions {
  return {
    env: {},
    selection:
      "entryId" in choice
        ? { layers: {}, entryId: choice.entryId }
        : {
            layers: {
              project: { provider: choice.provider, model: choice.model },
            },
            entryId: null,
          },
    llm: { maxCostCents: costLimitCents },
  };
}

/**
 * The address the runner clones a repository from and pushes to (#753): the repository's own https address with `.git` after
 * it. The runner's workspace takes an https address with a host and no credential, query or fragment, and the token goes in
 * its environment, never in the address; an address that is not of that shape is refused here (null) instead of by the runner.
 */
export function cloneUrlOf(repositoryUrl: string): string | null {
  if (/\s/.test(repositoryUrl)) return null;
  let parsed: URL;
  try {
    parsed = new URL(repositoryUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname === "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "" || path.endsWith(".git")) return null;
  const cloneUrl = `https://${parsed.host}${path}.git`;
  return /^https:\/\/[^\s@]+$/.test(cloneUrl) ? cloneUrl : null;
}

/** `/review` takes no arguments; it is the only command a claim may hand out (#203). */
function commandOf(job: Job): ReviewCommand | null {
  return job.command === "review" ? "review" : null;
}

/** The largest skill text a Dynamic job may carry, in UTF-8 bytes (`PROJECT_DYNAMIC_LIMITS`). */
const MAX_DYNAMIC_SKILL_BYTES = 16 * 1024;
const MAX_DYNAMIC_MODEL_CHARS = 200;

/**
 * The Dynamic options of a job (#195), taken from the project's settings resolved at claim time, with the model the
 * resolver chose (#432). Only model/skill/limits: there is no field for the fixed core, a command, an endpoint or a permission,
 * so nothing of that kind can be smuggled in. `null` when the options are missing or unusable.
 */
function dynamicOptionsOf(
  options: JobOptions,
  model: string,
): DynamicReviewOptions | null {
  const dynamic = options.dynamic;
  if (dynamic === undefined) return null;
  if (model.length > MAX_DYNAMIC_MODEL_CHARS) return null;
  if (
    new TextEncoder().encode(dynamic.skill).byteLength > MAX_DYNAMIC_SKILL_BYTES
  )
    return null;
  if (
    !Number.isInteger(dynamic.maxFindings) ||
    dynamic.maxFindings < 1 ||
    dynamic.maxFindings > 30
  )
    return null;
  return {
    model,
    skill: dynamic.skill,
    limits: { maxFindings: dynamic.maxFindings },
  };
}

/**
 * The checkout facts a Dynamic job carries. The head SHA is the one that was queued; the base is the
 * identity the provider reported. `comparison` is a declared mode, not proof: the checkout verifies
 * completeness before it trusts it, and `previousReviewedSha` is the head of the last successful
 * review of the same kind (#199), or null; `attemptedShas` are the heads of the earlier jobs that did
 * not succeed (#255, left out when there are none) and `attemptedShasTruncated` (#257) says the list was
 * cut, left out unless true. Nothing here is a permission or an endpoint.
 */
function claimBaseOf(
  repositoryFullName: string,
  baseRef: string,
  headSha: string,
  previousReviewedSha: string | null,
  attempted: AttemptedShas,
): ClaimBase {
  return {
    repository: repositoryFullName,
    baseRef,
    headSha,
    previousReviewedSha,
    // Left out when empty or false: a runner from before #255/#257 has a closed job contract and
    // rejects a key it does not know.
    ...(attempted.shas.length === 0 ? {} : { attemptedShas: attempted.shas }),
    ...(attempted.truncated ? { attemptedShasTruncated: true } : {}),
    comparison: "full",
  };
}

type ModelCapabilitiesDecision =
  | { kind: "send"; capabilities: DynamicModelCapabilities }
  /** Nothing is sent: the runner's own descriptor applies, exactly as without this feature. */
  | { kind: "none" }
  | { kind: "unsupported" };

/**
 * #279: what the provider's metadata says about the job's Dynamic model (`result`, read by the caller when the claim is
 * built: a short cache sits in front of the provider, so this is not a request per claim). Three outcomes:
 *
 * - A model whose metadata says it cannot do what Dynamic Review needs ends the job, whatever runner claimed it, before
 *   any credential exists.
 * - Metadata that cannot be read (provider unreachable, model unknown to it, no usable window) sends nothing and the
 *   claim goes on: the runner falls back to its own descriptor, and nothing is invented.
 * - Otherwise the descriptor goes to a runner that advertised `dynamic_capabilities` and only to such a runner: the
 *   job input of a previous-release runner is closed and would refuse the key.
 */
function modelCapabilitiesOf(
  deps: ClaimDeps,
  job: Job,
  result: ModelCapabilityResult | undefined,
  features: readonly ClaimFeature[],
): ModelCapabilitiesDecision {
  if (result === undefined) return { kind: "none" };
  if (result.outcome === "unsupported") return { kind: "unsupported" };
  const fallback = (why: string): ModelCapabilitiesDecision => {
    deps.logger.info(
      `[runner-api] job=${job.id} model capabilities not read (${why}); the runner's own descriptor applies`,
    );
    return { kind: "none" };
  };
  if (result.outcome !== "supported") return fallback(result.outcome);
  const capabilities = dynamicCapabilitiesOf(result.capabilities);
  if (capabilities === null) return fallback("no_usable_context_window");
  if (!features.includes("dynamic_capabilities")) return { kind: "none" };
  deps.logger.info(`[runner-api] job=${job.id} model capabilities sent`);
  return { kind: "send", capabilities };
}

/** The context window of a model the provider's metadata states, or null (it was not read, or states none). */
function contextWindowOf(
  result: ModelCapabilityResult | undefined,
): number | null {
  if (result === undefined) return null;
  return result.outcome === "supported" || result.outcome === "unsupported"
    ? result.capabilities.contextLength
    : null;
}

/**
 * The context window a job's token budget is cut to (#689), or null when none is known. Never read from the customer's
 * provider for a job on the workspace's own key.
 *
 * - On the operator's key: the window the provider's metadata states for the entry's model, else the one last read for it.
 * - On the workspace's own key: the smallest window the public catalog states for the model and its fallback model (a review
 *   may run on either), else the window last read, else the instance's `LLM_MAX_TOKENS`, else none.
 */
async function reviewContextWindow(
  deps: ClaimDeps,
  input: {
    selection: Selection;
    metadata: ModelCapabilityResult | undefined;
    fallbackModels: readonly string[];
    managed: boolean;
    instanceWindow: number | null;
  },
): Promise<number | null> {
  const { selection, metadata, managed } = input;
  const own =
    contextWindowOf(metadata) ??
    deps.modelCapabilities?.lastKnownContextLength?.(
      selection.model,
      selection.provider as LlmProvider,
    ) ??
    null;
  if (managed) return own;
  const lookup = deps.knownContextWindow;
  const catalog =
    lookup === undefined
      ? []
      : await Promise.all(
          [selection.model, ...input.fallbackModels].map((model) =>
            lookup(selection.provider, model),
          ),
        );
  const known = [own, ...catalog].filter(
    (window): window is number => window !== null,
  );
  return known.length > 0 ? Math.min(...known) : input.instanceWindow;
}

/** How `checkJob` is asked. */
export type CheckOptions = {
  /**
   * The engines the claimant advertised. A Dynamic job needs `opencode`. `null` when that was already
   * decided at claim (the Worker's fetch): the job is Dynamic because the claim allowed it.
   */
  engines: readonly RunnerEngine[] | null;
  /**
   * What a pull request that cannot be read means. At claim (false) every failure but "not found" gives
   * the job back to try later, as it always did. At the Worker's fetch (true) a permanent failure of the
   * connection (the installation was removed, the app is suspended, the scope was refused) ends the job
   * with its stable code instead, like the same failure when the credentials are created.
   */
  classifyReadFailures: boolean;
  /**
   * The LLM providers of the caller that will run the job: what a runner advertised in its claim, or a Worker in its
   * details call (the caller applies the rule for an absent list, `callerLlmProviders`). A provider other than the
   * default goes only to a caller that listed it. `null` when the caller is not known yet: the claim of a Dispatcher that
   * named no providers cannot judge what its Worker can run, so every provider of the app passes and the Worker's fetch
   * decides (contracts/README.md, "Rolling out providers").
   */
  runnerProviders: readonly string[] | null;
};

type CostDecision =
  | {
      kind: "decided";
      policy: CostPolicyJson | null;
      /** #578: the entry of the model of a native job; absent exactly when `policy` is null. */
      entry?: JobModelEntry;
      /** Which confirmation priced a managed run, for the log. */
      confirmation?: { id: number; hashVersion: number };
    }
  | { kind: "refused"; errorCode: string; detail: string }
  /** The price check or the adoption of the pin failed itself (the database could not be read): not the model's fault, so the job is given back. */
  | {
      kind: "retry";
      reason: "price_check_failed" | "provider_pin_check_failed";
    };

/**
 * #553: the cost policy of a native Dynamic job, or none. A job is native when its selection names a catalog model
 * (`nativeCost.refOf`); a Diff job and a job without `nativeCost` are not, and nothing is asked for them. The managed key is
 * refused with `managed_model_unavailable` (the log carries the opaque entry id, the kind and the stable code, never a
 * provider, a model or a price); the own key always gets a policy.
 */
async function costOf(
  deps: ClaimDeps,
  job: Job,
  selection: Selection,
): Promise<CostDecision> {
  const native = deps.nativeCost;
  // A turn of the Implementer runs on the Dynamic engine, so it is priced and bounded as a Dynamic job is (#753).
  if (
    native === undefined ||
    (job.reviewKind !== "dynamic" && job.reviewKind !== "implementer")
  )
    return { kind: "decided", policy: null };
  const ref = native.refOf(selection);
  if (ref === null) return { kind: "decided", policy: null };
  const outcome = await native.policyFor(selection.keyMode, ref);
  if (!outcome.ok) {
    // #549: `check_failed` is the one reason that may pass, because it says the check failed and not the model.
    if (outcome.reason === "check_failed")
      return { kind: "retry", reason: "price_check_failed" };
    return {
      kind: "refused",
      errorCode: MANAGED_MODEL_UNAVAILABLE,
      detail: `${whose(selection)}kind=${selection.kind} reason=${outcome.code}:${outcome.reason}`,
    };
  }
  // #578: what the runner is told about the model. The price is judged first, so a managed model with no confirmed price
  // keeps the refusal it always had. A model the catalog cannot describe (or whose provider's address is not trusted) is
  // refused like an unavailable one: on the operator's key, which we pay, as `managed_model_unavailable` (free); on the
  // workspace's own key as a model Dynamic Review cannot use. No key exists yet in either case.
  const catalog = selection.keyMode === "own" && selection.catalog === true;
  // A Dynamic job holds to the address its project pinned. A turn has no project of its own (#753, #790), so it holds to what the
  // workspace's projects pinned for the provider: no pin, the catalog's trusted address; one pin, exactly that address (a catalog
  // that moved since refuses the job below, `provider_address_changed`, and the key goes nowhere); several different pins, no
  // address can be the one all of them selected, so the key is not sent anywhere either.
  let pinned = catalog ? selection.pinnedAddress : undefined;
  if (catalog && job.reviewKind === "implementer") {
    const pins = await deps.pinnedAddresses(
      job.workspaceId,
      selection.provider,
    );
    if (pins.length > 1)
      return {
        kind: "refused",
        errorCode: entryRefusalCode(selection, "provider_address_changed"),
        detail: `${whose(selection)}kind=${selection.kind} reason=entry_provider_address_changed`,
      };
    pinned = pins[0];
  }
  const entry = await native.entryFor(ref, pinned);
  if (!entry.ok) {
    if (entry.code === "check_failed")
      return { kind: "retry", reason: "price_check_failed" };
    return {
      kind: "refused",
      errorCode: entryRefusalCode(selection, entry.code),
      detail: `${whose(selection)}kind=${selection.kind} reason=entry_${entry.code}`,
    };
  }
  // #588: a selection made before pins existed is pinned now, to the address this claim is about to send the key to. If another
  // pin got there first, the job holds to that one, as every other claim does.
  // A turn has no project that pinned the address: the model was chosen when the task was accepted, so the address the catalog
  // trusts now is the one it is sent to (#753).
  if (catalog && entry.unpinned === true && job.reviewKind !== "implementer") {
    let inForce: string | null;
    try {
      inForce = await deps.providerPins.adopt(
        job,
        selection.provider,
        entry.entry.upstreamBaseUrl,
      );
    } catch {
      // No error text: it could carry whatever the failing layer held. The job is given back and judged again.
      return { kind: "retry", reason: "provider_pin_check_failed" };
    }
    if (inForce === null)
      return { kind: "retry", reason: "provider_pin_check_failed" };
    if (inForce !== entry.entry.upstreamBaseUrl)
      return {
        kind: "refused",
        errorCode: entryRefusalCode(selection, "provider_address_changed"),
        detail: `${whose(selection)}kind=${selection.kind} reason=entry_provider_address_changed`,
      };
  }
  // #555 (decision of 2026-10-19 on #548): a model models.dev stopped listing keeps being served from its last known row.
  if (entry.unlisted === true)
    deps.logger.info(
      `[runner-api] job=${job.id} selection model no longer listed by the catalog; the last known row serves`,
    );
  return {
    kind: "decided",
    policy: outcome.policy,
    entry: entry.entry,
    ...(outcome.confirmation === null
      ? {}
      : { confirmation: outcome.confirmation }),
  };
}

/**
 * The code a job ends with when its entry cannot be built. The operator's key: `managed_model_unavailable` (free). The own key of a
 * catalog provider (#555) names what the member can act on: a model the catalog does not describe (its row is gone, or makes no
 * entry) is `llm_model_unavailable`, and a provider that cannot carry a key (not supported, blocked by `url_changed` or a refused
 * address, an address that is not the plain public https one, `upstream_not_registry`) is `llm_provider_unsupported`. The own key
 * of a registry provider keeps `dynamic_model_features_unsupported` (#578).
 */
function entryRefusalCode(
  selection: Selection,
  code: Extract<
    Awaited<ReturnType<NativeCostService["entryFor"]>>,
    { ok: false }
  >["code"],
): string {
  if (selection.keyMode === "managed") return MANAGED_MODEL_UNAVAILABLE;
  if (selection.catalog !== true) return "dynamic_model_features_unsupported";
  // #588: the catalog's address moved since the workspace selected the provider; the key stays where it is.
  if (code === "provider_address_changed") return PROVIDER_ADDRESS_CHANGED;
  return code === "model_not_in_catalog" ||
    code === "entry_invalid" ||
    code === "model_not_of_provider"
    ? "llm_model_unavailable"
    : "llm_provider_unsupported";
}

/** The opaque id of the catalog entry for the log of a job on the operator's key; nothing for an own key. */
function whose(selection: Selection): string {
  return selection.keyMode === "managed" ? `entry=${selection.entry.id} ` : "";
}

/**
 * What a read of the platform that failed means for the job (the pull request of a review, the installation of a turn). At the
 * claim every failure gives the job back to try later; at the Worker's fetch (`classifyReadFailures`) a permanent failure of the
 * connection (removed, suspended, scope refused) ends the job with its stable code instead, like the same failure when the
 * credentials are created. `what` is for the log; the text of the error never is.
 */
function unreadable(
  deps: ClaimDeps,
  job: Job,
  error: unknown,
  classifyReadFailures: boolean,
  what: string,
): Refusal {
  deps.logger.error(
    `[runner-api] job=${job.id} ${what}: ${describeError(error)}`,
  );
  if (
    classifyReadFailures &&
    error instanceof IntegrationError &&
    !error.retryable &&
    error.code.startsWith("INTEGRATION_ACCESS_")
  )
    return refuse(accessFailureCode(error));
  return {
    kind: "retry",
    reason: "pull_request_unavailable",
    retryAfterSeconds: retryAfterOf(error),
  };
}

/**
 * Steps 1 to 3 of the module comment: the guard, the selection and the key it names, the options of the job and the
 * pull request. Nothing here creates or reveals a credential of the job.
 */
export async function checkJob(
  deps: ClaimDeps,
  job: Job,
  { engines, classifyReadFailures, runnerProviders }: CheckOptions,
): Promise<Checked | Refusal> {
  // #746, #753: first, before the guard, the entitlements or the key are looked at: a turn of the Implementer goes only to a caller
  // that advertised the engine, and is never read as a Diff job (everything below branches on `dynamic` alone).
  const unbuilt = refusalForKind(job.reviewKind, engines);
  if (unbuilt !== null) return refuse(unbuilt);
  const decision = await deps.guard.check(job);
  if (!decision.allow)
    return decision.outcome === "cancel"
      ? { kind: "cancelled", errorCode: decision.errorCode }
      : refuse(decision.errorCode);

  // Whose key the job runs on is what its claim decided (#496), read from the usage record: the claim of the runner, the
  // Worker's fetch and any fetch again of the same claim cannot differ. Entitlements that cannot be read fail the selection
  // closed (it is not known whose key applies); nothing of another workspace is looked at.
  const stored = await deps.entitlementsFor(job.workspaceId);
  const claimedKeyMode = await deps.claimedKeyMode(job);
  // A claimed job always has its record; without one nobody decided, and the job is given back rather than decided here.
  if (claimedKeyMode === undefined)
    throw new Error(`Claimed job ${job.id} has no usage record.`);
  const entitlements = withClaimedKeyMode(stored, claimedKeyMode);

  const command = commandOf(job);
  if (command === null) return refuse("job_args_invalid");
  // #753: a turn takes its options from its own record. Without one (a job of this kind that is no turn) nothing can run.
  const turn =
    job.reviewKind === "implementer"
      ? await deps.implementerTurn(job)
      : undefined;
  if (job.reviewKind === "implementer" && turn === undefined)
    return refuse("implementer_config_invalid", "reason=turn_missing");
  if (turn !== undefined) {
    // The model of a turn is the one it was started with, for the key mode it was started in. If the workspace changed its key
    // mode since, the choice no longer fits and the turn ends: it is never moved to another entry, provider or model.
    const mode = keyModeForJob(entitlements);
    if (mode === "managed" && !("entryId" in turn.turn.modelChoice))
      return refuse(
        MANAGED_MODEL_UNAVAILABLE,
        "kind=dynamic reason=choice_not_an_entry",
      );
    if (mode === "own" && "entryId" in turn.turn.modelChoice)
      return refuse(
        "llm_model_unavailable",
        "kind=dynamic reason=key_mode_changed",
      );
  }
  // The provider, the model and (on the operator's key) the catalog entry are chosen first, from the settings of the
  // project for the job's pinned kind; the operator chooses the model of a workspace on its key, never the tenant
  // (#276, #432). Any failure ends the job closed: no move to another entry, provider or the instance's model. The key
  // follows only a selection that succeeded.
  const options =
    turn === undefined
      ? await deps.jobOptions.optionsFor(job)
      : implementerOptionsOf(turn.turn.modelChoice, turn.turn.costLimitCents);
  // A catalog model needs the native path: its entry from the catalog and its cost policy (the token cap) come from `nativeCost`.
  const nativeModels = deps.nativeCost !== undefined;
  const selected = await selectModel({ ...deps, nativeModels }, job, {
    options,
    entitlements,
    runnerProviders:
      runnerProviders ?? (deps.providers ?? DEFAULT_PROVIDERS).ids,
  });
  if (!selected.ok) return refuse(selected.errorCode, selected.detail);
  const { selection } = selected;
  await deps.recordSelection(job, selection);

  // #553: the cost of a native Dynamic job. On the operator's key, which we pay, a model whose price is not confirmed ends
  // the job here, before any key, token or VM exists; the own key is never refused for a price.
  const cost = await costOf(deps, job, selection);
  if (cost.kind === "refused") return refuse(cost.errorCode, cost.detail);
  if (cost.kind === "retry")
    return {
      kind: "retry",
      reason: cost.reason,
      retryAfterSeconds: DEFAULT_RETRY_AFTER_SECONDS,
    };
  // #753: the input of a turn has no field for a model without an entry and a cost policy, so a selection that is not native ends
  // the job here, before any key or token exists (the native path is mandatory for the Implementer).
  if (turn !== undefined && (cost.policy === null || cost.entry === undefined))
    return refuse(
      "implementer_config_invalid",
      "kind=dynamic reason=native_required",
    );
  // The log names the entry and the kind of a job on the operator's key, never a model or a provider; the log of
  // a job on the workspace's own key names no model either. A managed native job also names the confirmation that priced it
  // (its id and the version of its hash), so a price in dispute can be traced.
  deps.logger.info(
    selection.keyMode === "managed"
      ? `[runner-api] job=${job.id} selection entry=${selection.entry.id} kind=${selection.kind} origin=${selection.entry.origin}${
          cost.confirmation === undefined
            ? ""
            : ` confirmation=${String(cost.confirmation.id)} hash=${String(cost.confirmation.hashVersion)}`
        }`
      : `[runner-api] job=${job.id} selection kind=${selection.kind} key=own`,
  );

  // Only now the key of the selected provider: the workspace's own, or the operator's, as the selection says.
  const llm = await deps.keyFor(job.workspaceId, selection);
  // The log names the variables that are wrong and why (names and codes, never a value), or else the
  // reason the workspace has no access.
  if (!llm.ok)
    return refuse(
      llm.errorCode,
      llm.issues.length > 0
        ? llm.issues
            .map((issue) => `${issue.variable}: ${issue.code}`)
            .join(", ")
        : llm.reason,
    );

  if (Object.keys(options.env).some((key) => !RUNNER_ENV_KEY_PATTERN.test(key)))
    return refuse("job_env_invalid");
  const llmOptions = llmOptionsOf(options);
  if (llmOptions === null) return refuse("job_llm_options_invalid");

  // #195: a Dynamic job is only built for a runner that advertised `opencode`, and it must carry the
  // project's Dynamic options. Both are checked before any credential is created.
  const dynamic =
    job.reviewKind === "dynamic"
      ? dynamicOptionsOf(options, selection.model)
      : null;
  if (job.reviewKind === "dynamic") {
    if (engines !== null && !engines.includes("opencode"))
      return refuse("dynamic_engine_unavailable");
    if (dynamic === null) return refuse("dynamic_config_invalid");
  }

  if (job.leaseExpiresAt === null)
    throw new Error(`Claimed job ${job.id} has no lease expiry.`);

  const repository = await deps
    .repositories(job.workspaceId)
    .get(job.repositoryId);
  const integration =
    repository === undefined
      ? undefined
      : await deps.integrations(job.workspaceId).get(repository.integrationId);
  if (
    repository === undefined ||
    integration === undefined ||
    integration.status !== "active"
  )
    return refuse("git_connection_disabled");
  // The runner speaks GitHub only: refuse before anything is created if this connection is not.
  if (PLATFORM_OF[integration.type] !== "github")
    return refuse("git_access_failed");
  const provider = deps.registry.resolve(integration.type);
  const repo: RepoRef = {
    integrationId: repository.integrationId,
    externalId: repository.externalId,
    fullName: repository.fullName,
    url: repository.url,
  };

  // #753: a turn has no pull request to read. What it needs from the platform is the permission to write the contents of its
  // repository, which the installation must have accepted; without it nothing is created and the job ends for good.
  if (turn !== undefined) {
    const cloneUrl = cloneUrlOf(repo.url);
    if (cloneUrl === null)
      return refuse("implementer_config_invalid", "reason=clone_url");
    try {
      const held = await provider.installationPermissions(integration);
      if (!held.contentsWrite) return refuse("git_write_not_granted");
    } catch (error) {
      return unreadable(
        deps,
        job,
        error,
        classifyReadFailures,
        "the installation could not be read",
      );
    }
    return {
      kind: "checked",
      selection,
      llm,
      command,
      options,
      llmOptions,
      dynamic,
      cost: cost.policy,
      modelEntry: cost.entry ?? null,
      integration,
      repo,
      prUrl: job.prUrl,
      baseRef: turn.session.baseBranch,
      implementer: {
        instruction: turn.turn.instruction,
        branch: turn.session.branch,
        baseBranch: turn.session.baseBranch,
        cloneUrl,
      },
    };
  }

  // The pull request must still be there and open; its URL and base branch come from the platform.
  let prUrl: string;
  let baseRef: string;
  try {
    const pullRequest = await provider.getPullRequest(
      integration,
      repo,
      job.prNumber,
    );
    if (pullRequest.state !== "open") return refuse("pull_request_closed");
    prUrl = pullRequest.url;
    baseRef = pullRequest.baseRef;
  } catch (error) {
    if (
      error instanceof IntegrationError &&
      error.code === "INTEGRATION_PULL_REQUEST_NOT_FOUND"
    )
      return refuse("pr_not_found");
    return unreadable(
      deps,
      job,
      error,
      classifyReadFailures,
      "the pull request could not be read",
    );
  }

  return {
    kind: "checked",
    selection,
    llm,
    command,
    options,
    llmOptions,
    dynamic,
    cost: cost.policy,
    modelEntry: cost.entry ?? null,
    integration,
    repo,
    prUrl,
    baseRef,
    implementer: null,
  };
}

/**
 * Step 4 of the module comment, the only place that creates credentials for a job: the model's
 * capabilities (#279), the git credentials for exactly this repository, and the job's input with the
 * key revealed. Both the legacy claim and the Worker's fetch call it. The revealed copy is a plain
 * object that only lives until the response is built.
 */
export async function buildJobInput(
  deps: ClaimDeps,
  job: Job,
  checked: Checked,
  features: readonly ClaimFeature[],
): Promise<Built | Refusal> {
  const {
    selection,
    llm,
    command,
    options,
    llmOptions,
    dynamic,
    cost,
    modelEntry,
    integration,
    repo,
    implementer,
  } = checked;
  // #746, #753: a second wall for the kind, in case a caller reaches the build without the check: a turn is built from its own
  // facts, its model entry and its cost policy, and from nothing else.
  const unbuilt = refusalForKind(job.reviewKind, null);
  if (unbuilt !== null) return refuse(unbuilt);
  if (
    job.reviewKind === "implementer" &&
    (implementer === null || cost === null || modelEntry === null)
  )
    return refuse("implementer_engine_unavailable");
  // #553: a cost policy goes only to a caller that enforces one. A runner that did not read it would run without the bound
  // (the price book of the managed key, the token cap of an own key), so the job ends here, before any credential exists.
  if (cost !== null && !features.includes("dynamic_cost_policy"))
    return refuse("dynamic_engine_unavailable");
  // #666, #689: the cost limit of a review, Diff or Dynamic, is the smaller of the customer's own limit and the operator's maximum
  // (the admin portal). The job is a closed object, so what is sent depends on what the caller named (`job-cost-limit.ts`). A
  // caller that names neither feature is a runner or Worker image older than the app, which a release can briefly leave
  // behind. The job is not refused for that: a refused review is worse than a limit that is not kept for a short window, so it
  // runs with the runner's own limit alone, and the log says so.
  const costLimit = jobCostLimit({
    customerCents: llmOptions.maxCostCents,
    operatorCents: await deps.operatorCostLimitCents(),
    features,
  });
  // #790: the cost limit is the brake of a turn, and the runner has no limit of its own for this kind, so a caller that names
  // neither feature cannot run one: it ends here, as for an engine that cannot run the kind, before any credential exists.
  if (implementer !== null && costLimit.enforced === "none")
    return refuse("implementer_engine_unavailable");
  if (costLimit.enforced === "none")
    deps.logger.info(
      `[runner-api] job=${job.id} carries no cost limit: the runner names neither claim feature cost_limit nor operator_cost_limit, so a Dynamic Review is held only to the runner's own RUNNER_DYNAMIC_MAX_COST_USD and a Diff Review to none`,
    );
  const managed = selection.keyMode === "managed";
  const provider = deps.registry.resolve(integration.type);

  // #279: the model's capabilities. The read can wait on the provider, so it comes after every cheap
  // local refusal above, and still before the git credentials are created. A job on the operator's key (#280, #432) reads
  // its model's metadata too, Diff or Dynamic, for the context window its token budget is cut to: one read serves both (a
  // Dynamic job's model is the entry's). The metadata is read from the selection's provider. A Diff job on the workspace's own
  // key asks nobody (PR-Agent handles the models of the workspace). A native job (#578) reads none: its entry states the
  // window, the output bound and the flags of the model.
  const modelToRead =
    (dynamic !== null || managed) && modelEntry === null
      ? selection.model
      : null;
  // The claim of a job on the operator's key asks as a claim (an outage costs one wait, not one per claim) and names the
  // entry in the log line instead of the model.
  const metadata =
    modelToRead === null || deps.modelCapabilities === undefined
      ? undefined
      : await deps.modelCapabilities.check(modelToRead, {
          provider: selection.provider as LlmProvider,
          ...(selection.keyMode === "managed"
            ? { forClaim: true, logAs: `entry=${selection.entry.id}` }
            : {}),
        });
  let capabilities: DynamicModelCapabilities | undefined;
  if (dynamic !== null) {
    const decision = modelCapabilitiesOf(deps, job, metadata, features);
    if (decision.kind === "unsupported")
      return refuse("dynamic_model_features_unsupported");
    if (decision.kind === "send") capabilities = decision.capabilities;
  }

  // The one place that creates credentials for a job. A turn gets a token that may write this one repository, a review job one that
  // may not (#753).
  let git: GitAccess;
  try {
    git = revealGitAccess(
      job.reviewKind === "implementer"
        ? await provider.implementerAccess(integration, repo)
        : await provider.jobAccess(integration, repo),
    );
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    deps.logger.error(
      `[runner-api] job=${job.id} credentials could not be created: ${describeError(error)}`,
    );
    if (error.retryable)
      return {
        kind: "retry",
        reason: "git_access_unavailable",
        retryAfterSeconds: retryAfterOf(error),
      };
    return refuse(accessFailureCode(error));
  }
  // The runner needs the login the bot acts as; only the access itself can say.
  if (git.provider !== "github" || git.botLogin === null)
    return refuse("git_access_failed");

  // Nothing below may fail without the write token of a turn being switched off: it is not yet in the input that would carry it (#753).
  let llmAccess: ReturnType<typeof revealLlmAccess>;
  let maxTokens: number;
  let previousReviewedSha: string | null;
  let attempted: AttemptedShas;
  try {
    // The instance's model and context window are the defaults; the review settings of the project
    // replace them. The job never carries `fallbackModels`: the MVP has no fallback chain.
    llmAccess = revealLlmAccess(llm.access);
    // #689: no setting names the token budget; the app decides it from the context window of the model: the window the provider's
    // metadata states, else the one last read for it (the provider may be down); on the workspace's own key, which asks nobody, the
    // smallest window the public catalog states for the model and its fallback model, else the instance's `LLM_MAX_TOKENS`, else
    // the built-in value. Never sent unclamped. A native job (#578) states its window in its entry, but it
    // runs no PR-Agent and never reads the field: it gets the built-in value like the others.
    maxTokens = reviewTokenBudget(
      await reviewContextWindow(deps, {
        selection,
        metadata,
        fallbackModels: options.llm?.fallbackModels ?? [],
        managed,
        instanceWindow: llmAccess.contextWindowTokens,
      }),
    );
    // #199: the head of the last successful Dynamic review of this pull request, so the dynamic job
    // can compare against it. A Diff job never carries a base, so it is not looked up.
    previousReviewedSha =
      job.reviewKind === "dynamic" ? await deps.previousReviewedSha(job) : null;
    attempted =
      job.reviewKind === "dynamic"
        ? await deps.attemptedShas(job)
        : { shas: [], truncated: false };
  } catch (error) {
    await deps.revokeUndelivered(job, writeTokenOf(git));
    throw error;
  }

  // The exact legacy Diff payload for every Diff job, whatever kind of runner asked: the keys are in
  // the order the previous release wrote them, byte for byte (prUrl, command, git, llm, env;
  // llm.provider, model, apiKey, maxTokens), so a golden serialization matches. A Dynamic job is only
  // ever handed to a runner that advertised `opencode`, so its tagged fields never reach an old runner.
  const input: AnyJobInput =
    implementer !== null && cost !== null && modelEntry !== null
      ? {
          reviewKind: "implementer",
          implementer: {
            repo: { fullName: repo.fullName, cloneUrl: implementer.cloneUrl },
            baseBranch: implementer.baseBranch,
            branch: implementer.branch,
            instruction: implementer.instruction,
            limits: { timeLimitSeconds: IMPLEMENTER_TIME_LIMIT_SECONDS },
            cost,
            modelEntry,
          },
          git: {
            provider: "github",
            baseUrl: git.baseUrl,
            token: git.token,
            botLogin: git.botLogin,
          },
          llm: {
            provider: selection.provider,
            model: selection.model,
            apiKey: llmAccess.apiKey,
            maxTokens,
            ...costLimit.fields,
          },
          env: {},
        }
      : dynamic === null
        ? {
            prUrl: checked.prUrl,
            command,
            git: {
              provider: "github",
              baseUrl: git.baseUrl,
              token: git.token,
              botLogin: git.botLogin,
            },
            llm: {
              provider: selection.provider,
              model: selection.model,
              apiKey: llmAccess.apiKey,
              maxTokens,
              ...costLimit.fields,
            },
            env: options.env,
          }
        : {
            prUrl: checked.prUrl,
            command,
            reviewKind: "dynamic",
            dynamic: {
              ...dynamic,
              ...(capabilities === undefined ? {} : { capabilities }),
              ...(cost === null ? {} : { cost }),
              ...(modelEntry === null ? {} : { modelEntry }),
            },
            base: claimBaseOf(
              repo.fullName,
              checked.baseRef,
              job.headSha,
              previousReviewedSha,
              attempted,
            ),
            git: {
              provider: "github",
              baseUrl: git.baseUrl,
              token: git.token,
              botLogin: git.botLogin,
            },
            llm: {
              provider: selection.provider,
              model: selection.model,
              apiKey: llmAccess.apiKey,
              maxTokens,
              ...costLimit.fields,
            },
            env: {},
          };
  return {
    kind: "built",
    input,
    tokenExpiresAt: git.expiresAt,
    entryModel: managed ? selection.model : null,
    native: modelEntry !== null,
    writeToken: implementer === null ? null : writeTokenOf(git),
  };
}

async function prepare(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  engines: readonly RunnerEngine[],
  features: readonly ClaimFeature[],
  split: boolean,
  llmProviders: readonly string[] | undefined,
): Promise<Prepared> {
  const { job, leaseToken } = claimed;
  const checked = await checkJob(deps, job, {
    engines,
    classifyReadFailures: false,
    // A Dispatcher's claim says nothing certain about the Worker that will fetch the job; a runner's claim is the caller.
    runnerProviders: split
      ? (llmProviders ?? null)
      : callerLlmProviders(llmProviders),
  });
  if (checked.kind !== "checked") return checked;

  // #320: a Dispatcher gets the per-job credential and nothing of the job's input; the Worker fetches
  // that (and with it the git token and the model key) with the credential.
  if (split) {
    if (claimed.credential === undefined)
      throw new Error(`Claim of job ${job.id} has no credential.`);
    if (job.leaseExpiresAt === null)
      throw new Error(`Claimed job ${job.id} has no lease expiry.`);
    return {
      kind: "split",
      response: {
        version: RUNNER_API_VERSION,
        job: {
          id: job.id,
          credential: claimed.credential,
          reviewKind: job.reviewKind,
          leaseExpiresAt: job.leaseExpiresAt,
          heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
        },
      },
    };
  }

  const built = await buildJobInput(deps, job, checked, features);
  if (built.kind !== "built") return built;
  if (job.leaseExpiresAt === null)
    throw new Error(`Claimed job ${job.id} has no lease expiry.`);
  return {
    kind: "ready",
    entryModel: built.entryModel,
    native: built.native,
    writeToken: built.writeToken,
    response: {
      version: RUNNER_API_VERSION,
      job: {
        id: job.id,
        leaseToken,
        leaseExpiresAt: job.leaseExpiresAt,
        heartbeatIntervalSeconds: deps.heartbeatIntervalSeconds,
        tokenExpiresAt: built.tokenExpiresAt,
        input: built.input,
      },
    },
  };
}

/**
 * Who a job is ended for, as the log names it: the claim of a runner (`claim runner=a`, stage `claim`)
 * or the fetch of a Worker (`fetch worker`, stage `fetch`, #320). Never a secret.
 */
export type Origin = { label: string; stage: "claim" | "fetch" };

/** Ends a claimed job as failed with a code; the runner is not told. Throws if the queue fails. */
export async function endJob(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  origin: Origin,
  errorCode: string,
  detail?: string,
): Promise<"ended" | "not_holder"> {
  const result = await deps.queue.complete(claimed.job.id, claimed.leaseToken, {
    ok: false,
    errorCode,
  });
  if (result.status !== "completed") {
    // Not ours any more (the lease ran out in the meantime); whoever holds the job now decides.
    deps.logger.error(
      `[runner-api] ${origin.label} job=${claimed.job.id} could not be ended at ${origin.stage}: ${result.status}`,
    );
    return "not_holder";
  }
  deps.logger.info(
    `[runner-api] ${origin.label} job=${claimed.job.id} ended at ${origin.stage}: ${errorCode}${detail === undefined || detail === "" ? "" : ` (${detail})`}`,
  );
  return "ended";
}

/**
 * Ends a claimed job as cancelled, the way a deactivation ends a waiting one: one statement fenced by
 * the lease token (`cancelClaimed`), no attempt counted, never queued in between. Only this job is
 * touched; the other waiting jobs of the repository were cancelled by the deactivation. Throws if the
 * queue fails; the caller gives the job back.
 */
export async function cancelJob(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  origin: Origin,
  errorCode: JobErrorCode,
): Promise<"cancelled" | "not_holder"> {
  const result = await deps.queue.cancelClaimed(
    claimed.job.id,
    claimed.leaseToken,
    errorCode,
  );
  if (result.status === "not_holder") {
    // Not ours any more (the lease ran out in the meantime); whoever holds the job now decides.
    deps.logger.error(
      `[runner-api] ${origin.label} job=${claimed.job.id} could not be cancelled at ${origin.stage}: not_holder`,
    );
    return "not_holder";
  }
  deps.logger.info(
    `[runner-api] ${origin.label} job=${claimed.job.id} cancelled at ${origin.stage}: ${errorCode}`,
  );
  return "cancelled";
}

/** The token of a turn with the time it expires; a platform that says none gets the lifetime GitHub gives. */
function writeTokenOf(git: GitAccess, now: Date = new Date()): GitTokenEntry {
  return {
    token: git.token,
    expiresAt:
      git.expiresAt ??
      new Date(now.getTime() + DEFAULT_TOKEN_LIFETIME_MS).toISOString(),
  };
}

/**
 * #753: whether no input of this turn was ever handed to a Worker. Every write token is remembered before an input leaves, so a
 * job whose ledger is empty has handed out none; one that has a token has a Worker that may run and push. Only for a turn;
 * a failed lookup says no (the safe answer: the job is not requeued).
 */
export async function noInputHandedOut(
  deps: Pick<ClaimDeps, "claimedKeys">,
  job: Pick<Job, "id" | "reviewKind">,
): Promise<boolean> {
  if (job.reviewKind !== "implementer") return false;
  try {
    return !(await deps.claimedKeys.hasGitTokens(job.id));
  } catch {
    return false;
  }
}

/** Gives the job back after an unexpected failure, so it is not stuck under a lease nobody uses. */
export async function giveBack(
  deps: ClaimDeps,
  claimed: NonNullable<ClaimResult>,
  reason: string,
  retryAt?: Date,
  /**
   * #753: no input of this job ever reached a Worker (`noInputHandedOut`, asked before the call was built), so a turn of the
   * Implementer ran nothing and pushed nothing and waits again like any other job instead of failing on its first lost attempt.
   * A turn whose Worker already has an input is never requeued: its Worker may be running.
   */
  beforeStart = false,
): Promise<void> {
  const release = {
    ...(retryAt === undefined ? {} : { retryAt }),
    ...(beforeStart ? { beforeStart: true } : {}),
  };
  try {
    await deps.queue.release(
      claimed.job.id,
      claimed.leaseToken,
      reason,
      Object.keys(release).length === 0 ? undefined : release,
    );
  } catch (error) {
    deps.logger.error(
      `[runner-api] job=${claimed.job.id} could not be given back: ${describeError(error)}`,
    );
  }
}

export async function handleClaim(
  deps: ClaimDeps,
  runnerId: string,
  engines: readonly RunnerEngine[],
  features: readonly ClaimFeature[] = [],
  target: {
    jobId?: string;
    maxRunning?: number;
    /** #424: the providers the caller advertised in its claim; absent means the default provider only. */
    llmProviders?: readonly string[];
  } = {},
): Promise<Response> {
  // #320: a Dispatcher names `worker_credential` and gets a per-job credential instead of the input.
  const split = features.includes("worker_credential");
  const origin: Origin = { label: `claim runner=${runnerId}`, stage: "claim" };
  for (let refused = 0; refused < MAX_REFUSED_PER_REQUEST; refused += 1) {
    // #322: `jobId` and `maxRunning` are passed to the queue only when the caller sent them, so the
    // claim of a runner of the previous release makes exactly the call it made before.
    const claimOptions: ClaimOptions = {
      ...(split ? { workerCredential: true } : {}),
      // #397: a Dispatcher is not the holder; its Worker says so with its job details request.
      ...(!split && features.includes("supersede")
        ? { acceptsSupersede: true }
        : {}),
      ...(target.jobId === undefined ? {} : { jobId: target.jobId }),
      ...(target.maxRunning === undefined
        ? {}
        : { maxRunning: target.maxRunning }),
    };
    const claimed =
      Object.keys(claimOptions).length > 0
        ? await deps.queue.claimNext(runnerId, engines, claimOptions)
        : await deps.queue.claimNext(runnerId, engines);
    if (claimed === null) return noContent();

    // Whatever goes wrong from here on, the job is given back instead of staying under a lease that
    // nobody uses (it would only run out after two minutes). The write token of a turn that was made is switched off then (#753).
    let writeToken: GitTokenEntry | null = null;
    const beforeStart = await noInputHandedOut(deps, claimed.job);
    try {
      const prepared = await prepare(
        deps,
        claimed,
        engines,
        features,
        split,
        target.llmProviders,
      );
      if (prepared.kind === "ready") writeToken = prepared.writeToken;

      if (prepared.kind === "refused") {
        await endJob(
          deps,
          claimed,
          origin,
          prepared.errorCode,
          prepared.detail,
        );
        continue;
      }

      if (prepared.kind === "cancelled") {
        await cancelJob(deps, claimed, origin, prepared.errorCode);
        continue;
      }

      if (prepared.kind === "retry") {
        await giveBack(
          deps,
          claimed,
          prepared.reason,
          new Date(deps.now().getTime() + prepared.retryAfterSeconds * 1000),
          beforeStart,
        );
        deps.logger.info(
          `[runner-api] ${origin.label} job=${claimed.job.id} given back: ${prepared.reason}`,
        );
        return errorResponse(503, "RUNNER_GIT_ACCESS_UNAVAILABLE", {
          retryAfterSeconds: prepared.retryAfterSeconds,
        });
      }

      if (prepared.kind === "split") {
        // The credential is in the response and nowhere else: not in the log line, not in the database.
        deps.logger.info(
          `[runner-api] ${origin.label} job=${claimed.job.id} command=${claimed.job.command} credential issued`,
        );
        return jsonResponse(200, prepared.response);
      }

      // Before the key leaves with the response: if it cannot be remembered, the job is given back (below)
      // and no runner has the key.
      await deps.claimedKeys.remember(
        claimed.job.id,
        prepared.response.job.input.llm.apiKey,
      );
      if (prepared.entryModel !== null)
        await deps.claimedKeys.rememberModel(
          claimed.job.id,
          prepared.entryModel,
        );
      await deps.claimedKeys.rememberNative(claimed.job.id, prepared.native);
      // The token is remembered (sealed) before it leaves, so the end of the turn can switch it off (#753).
      if (prepared.writeToken !== null)
        await deps.claimedKeys.rememberGitToken(
          claimed.job.id,
          prepared.writeToken.token,
          prepared.writeToken.expiresAt,
        );
      deps.logger.info(
        `[runner-api] ${origin.label} job=${claimed.job.id} command=${claimed.job.command}`,
      );
      return jsonResponse(200, prepared.response);
    } catch (error) {
      deps.logger.error(
        `[runner-api] ${origin.label} job=${claimed.job.id} failed: ${describeError(error)}`,
      );
      if (writeToken !== null)
        await deps.revokeUndelivered(claimed.job, writeToken);
      await giveBack(deps, claimed, "claim_failed", undefined, beforeStart);
      return errorResponse(500, "RUNNER_INTERNAL_ERROR");
    }
  }
  // Many jobs in a row ended at claim time; let the runner ask again instead of holding the request.
  return noContent();
}
