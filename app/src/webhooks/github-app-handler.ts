// SPDX-License-Identifier: LicenseRef-Proprietary

// The handler behind `POST /api/webhooks/github-app`. It is a function of its collaborators, so the
// route file only wires the real ones in (`shared.ts`) and tests wire fakes in.
//
// The order is the contract; each step ends the request on failure, and nothing before the claim of
// the delivery id has a side effect:
//
//   1. size      the body is read with a 1 MB limit                               413
//   2. signature `verifyWebhook(null, request)`: HMAC of the exact bytes           401
//   3. shape     the event and delivery headers exist, the body is JSON            400
//   4. relevance an event the app does not use is answered at once                 202
//   5. claim     the delivery id is claimed; a succeeded id is a duplicate         202
//                an id another request is handling right now                        409
//   6. identify  `identifyWebhook` names the installation; the integration is loaded, and with it
//                the workspace the delivery belongs to (everything after this runs in that
//                workspace: its projects, its settings, its job queue)
//   6b. mirror   the events the ticket mirror follows (#923) update its cache first, in the workspace of the delivery; a failure of the
//                mirror never stops what else the delivery does (a review, a workflow), and an event that only the mirror uses
//                (`sub_issues`, `projects_v2_item`, `check_suite`) is answered `tracker_updated`, or `ignored`
//   7. translate `parseEvent`: a review trigger, an installation change, a label on an issue or "ignored"
//   8. act       label on an issue -> the workflows the label starts get their runs (#845; no project is needed: the repository
//                must be an active one of the workspace);
//                trigger -> the repository must have an active project, then the trigger
//                policy (automatic-review-policy.ts: drafts, settings;
//                then the commit still being the head, checked against GitHub, failing open) or,
//                for a comment command, the project's list of allowed commands; then
//                `canTrigger`, then the intake;
//                closed pull request -> its waiting jobs are dropped;
//                change -> the shared sync; an unusable payload                     202, 400
//
// Only a delivery that succeeded (a trigger handed over, an installation synchronized) stays a
// duplicate; one that was turned away or failed can be redelivered with the same id. A failure after
// the claim releases it and answers with a 5xx. The answer is sent when the work is done: the work is small (a few
// GitHub calls at most, each with a 15 second timeout), and a failure has to reach GitHub as a status
// code, which `after()` could not do.
import "server-only";
import type { WebhookDeliveriesRepository } from "../db/repositories/webhook-deliveries-repository.ts";
import type { IntegrationDirectory } from "../db/repositories/integration-directory-repository.ts";
import { hasSafeMessage } from "../integrations/errors.ts";
import type { IntegrationRegistry } from "../integrations/registry.ts";
import type { IntegrationSyncService } from "../integrations/sync/service.ts";
import type { IntegrationProvider } from "../integrations/provider.ts";
import type {
  Integration,
  IntegrationEvent,
  IntegrationType,
  IssueLabeled,
  PullRequestRef,
} from "../integrations/types.ts";
import {
  WebhookPayloadError,
  WebhookProcessingError,
  type WebhookAcceptedOutcome,
  type WebhookErrorCode,
} from "./errors.ts";
import { readLimitedBody } from "./limited-body.ts";
import { consoleWebhookLogger, type WebhookLogger } from "./logger.ts";
import type { ProjectService } from "../projects/service.ts";
import type { ReviewSettings } from "../review-settings/settings.ts";
import {
  type AutomaticSkipReason,
  type PullRequestTrigger,
  checkAgainstCurrentPullRequest,
  decideAutomaticTrigger,
} from "./automatic-review-policy.ts";
import { isCommandAllowed } from "../review-settings/effective.ts";
import type { ReviewTriggerIntake } from "./review-trigger-intake.ts";
import type { TrackerMirror } from "../tracker/mirror.ts";

/** 1 MiB. GitHub's own limit is 25 MB, but the payloads this app reads are a few kilobytes. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

const TYPE: IntegrationType = "github_app";

/** The events that can start a review or change what the app knows about the installation. */
const REVIEW_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "issue_comment",
]);
/** The events that can start a workflow (#845). */
const WORKFLOW_EVENTS: ReadonlySet<string> = new Set(["issues"]);
/** The events the ticket mirror follows (#923); the first three also start reviews or workflows, the others are used by the mirror only. */
const TRACKER_EVENTS: ReadonlySet<string> = new Set([
  "issues",
  "issue_comment",
  "pull_request",
  "sub_issues",
  "projects_v2_item",
  "check_suite",
]);
const TRACKER_ONLY_EVENTS: ReadonlySet<string> = new Set([
  "sub_issues",
  "projects_v2_item",
  "check_suite",
]);
const INSTALLATION_EVENTS: ReadonlySet<string> = new Set([
  "installation",
  "installation_repositories",
]);

// Letters, digits, `_`, `-`, `.`; GitHub's delivery id is a UUID, its event names are snake case.
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Which repositories are reviewed at all: the project service. Review triggers for a repository
 * without an active project are answered `project_not_active`.
 */
export type ProjectGate = Pick<ProjectService, "hasActiveProject">;

/** What the trigger policy needs besides the trigger: the head check. */
export type AutomaticReviewDeps = {
  /** How long the check against GitHub's current head may take (default 5 seconds). */
  headCheckTimeoutMs?: number;
};

/**
 * What starts the workflows a label on an issue starts (#845): `LabelTrigger` of `src/workflow-runs/`, which this module does not import
 * (the engine imports the webhook's body reader; the route wires the two together).
 */
export type WorkflowStarter = {
  start(
    deliveryId: string,
    labeled: IssueLabeled,
  ): Promise<{
    /** The workflows whose trigger is this label. */
    matched: number;
    /** The runs this delivery wrote now. */
    started: number;
    /** The runs an earlier try of the same delivery had written. */
    existing: number;
    /** Matched workflows that start nothing (a step of a kind the engine does not run, a reserved one). */
    skipped: number;
    /** Matched workflows that already have a running run for the issue. */
    busy: number;
  }>;
};

/** The collaborators that act inside one workspace. */
export type WorkspaceCollaborators = {
  /** Which repositories of the workspace are reviewed at all. */
  projects: ProjectGate;
  /**
   * The settings a review of the repository's project uses (project over global over built-in), or
   * `undefined` when the repository has no project.
   */
  settingsFor(
    integrationId: string,
    repositoryExternalId: string,
  ): Promise<ReviewSettings | undefined>;
  intake: ReviewTriggerIntake;
  /**
   * Starts the workflows a label on an issue starts (#845). Left out where a server has no workflow engine: a label then starts
   * nothing (`ignored`).
   */
  workflows?: WorkflowStarter;
  /** The ticket mirror of the workspace (#923). Left out where a server has none: the events it follows are then used for what else they do. */
  tracker?: TrackerMirror;
};

export type GithubAppWebhookDeps = {
  registry: IntegrationRegistry;
  /**
   * Finds the integration an installation id belongs to, in any workspace: the delivery names the
   * installation before anybody knows the workspace, and the integration says which one it is.
   */
  integrations: Pick<IntegrationDirectory, "findByExternalId">;
  deliveries: WebhookDeliveriesRepository;
  /** The process-wide sync service (`getIntegrationSync()`), never one created for the route. */
  sync: Pick<IntegrationSyncService, "handleInstallationChange">;
  /** The collaborators of one workspace; called with the workspace of the delivery's integration. */
  workspace: (workspaceId: string) => WorkspaceCollaborators;
  automatic: AutomaticReviewDeps;
  logger?: WebhookLogger;
  maxBodyBytes?: number;
  /**
   * Whether anybody has started to configure the GitHub App. An instance that is not connected to
   * GitHub is in its normal state, not broken: a delivery that cannot be verified is then refused
   * as always, but the log does not call it an error. Default: configured.
   */
  githubAppConfigured?: () => boolean | Promise<boolean>;
};

export type WebhookHandler = (request: Request) => Promise<Response>;

function fail(status: number, error: WebhookErrorCode): Response {
  return Response.json({ error }, { status });
}

function accepted(outcome: WebhookAcceptedOutcome): Response {
  return Response.json({ status: "accepted", outcome }, { status: 202 });
}

/** How long the head check may take: well inside the 10 seconds GitHub waits for the answer. */
export const HEAD_CHECK_TIMEOUT_MS = 5000;

class HeadCheckTimeout extends Error {
  readonly code = "HEAD_CHECK_TIMEOUT";
}

/**
 * Runs `run` with a signal that fires after `ms`. The slow request is aborted (the connection is
 * closed), and the answer is not waited for either, for a provider that ignores the signal. The
 * timeout is rejected before the signal fires, so the failure is always HEAD_CHECK_TIMEOUT and
 * never the provider's own code for an aborted request.
 */
function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const failure = new HeadCheckTimeout();
      reject(failure);
      controller.abort(failure);
    }, ms);
  });
  // `run` may throw before it returns a promise: that is a rejection too, and the timer is cleared.
  const attempt = (async () => run(controller.signal))();
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

/** The stable code of an error, or its class name: never its message, which may name a response. */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown error";
}

/** Lines about an error never carry more than its safe message. */
function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown error";
  return hasSafeMessage(error) ? `${name}: ${error.message}` : name;
}

// A delivery about an installation that has no row yet. The provider needs an integration to
// translate it; the sync creates the real row after GitHub confirmed the installation.
function standIn(externalId: string): Integration {
  return {
    id: "unknown",
    // The stand-in is only handed to `parseEvent`, which reads nothing of it but the platform ids.
    workspaceId: "unknown",
    type: TYPE,
    displayName: "",
    externalId,
    config: {},
    credentials: null,
    webhookSecret: null,
    status: "active",
    createdAt: "",
    updatedAt: "",
  };
}

// Webhook secret problems are logged once per logger and process: an unauthenticated caller can
// repeat the request as often as it likes, and the route makes a new handler for every request. The
// record is kept on `globalThis` like the database connection and the sync service, because Next.js
// may load route handlers as separate module graphs.
const LOGGED_UNVERIFIABLE = Symbol.for("code-reviewer.webhook-unverifiable");
type GlobalWithLoggedSet = typeof globalThis & {
  [LOGGED_UNVERIFIABLE]?: WeakSet<WebhookLogger>;
};

function loggedUnverifiableFor(): WeakSet<WebhookLogger> {
  const holder = globalThis as GlobalWithLoggedSet;
  return (holder[LOGGED_UNVERIFIABLE] ??= new WeakSet());
}

export function createGithubAppWebhookHandler(
  deps: GithubAppWebhookDeps,
): WebhookHandler {
  const { registry, integrations, deliveries, sync, automatic } = deps;
  const logger = deps.logger ?? consoleWebhookLogger;
  const maxBodyBytes = deps.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;

  type Outcome = Exclude<
    WebhookAcceptedOutcome,
    "event_not_used" | "duplicate"
  >;

  /** A pull request event that starts no review; the reason is for the log, the answer is the same. */
  function skipped(
    deliveryId: string,
    prNumber: number,
    reason: AutomaticSkipReason,
  ): "trigger_skipped" {
    logger.info(
      `[webhook] delivery=${deliveryId} pr=${prNumber} starts no review reason=${reason}`,
    );
    return "trigger_skipped";
  }

  /**
   * The pull request as GitHub reports it now, for the head check. A pull request GitHub does not
   * know is `not_found`; any other failure, and a call that takes longer than the timeout (GitHub
   * waits 10 seconds for our answer), is `unknown` and logged with its code only.
   */
  async function lookUpCurrentPullRequest(
    provider: IntegrationProvider,
    integration: Integration,
    trigger: PullRequestTrigger,
    deliveryId: string,
  ): Promise<
    | { kind: "found"; pullRequest: PullRequestRef }
    | { kind: "not_found" }
    | { kind: "unknown" }
  > {
    try {
      const pullRequest = await withTimeout(
        (signal) =>
          provider.getPullRequest(
            integration,
            trigger.repo,
            trigger.prNumber,
            signal,
          ),
        automatic.headCheckTimeoutMs ?? HEAD_CHECK_TIMEOUT_MS,
      );
      return { kind: "found", pullRequest };
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "INTEGRATION_PULL_REQUEST_NOT_FOUND")
        return { kind: "not_found" };
      logger.error(
        `[webhook] warning: delivery=${deliveryId} pr=${trigger.prNumber} the head commit could not be checked (${code}), the trigger is enqueued with the head of the payload`,
      );
      return { kind: "unknown" };
    }
  }

  /**
   * Hands the delivery to the ticket mirror of the integration's workspace (#923): the provider reads what changed, the mirror writes it.
   * Answers whether the cache changed. `strict`: a failure is thrown (a delivery only the mirror uses is tried again by GitHub);
   * otherwise it is logged by its code and the delivery goes on with what else it does.
   */
  async function mirrorTickets(
    provider: IntegrationProvider,
    integration: Integration,
    eventName: string,
    deliveryId: string,
    request: Request,
    strict: boolean,
  ): Promise<boolean> {
    const tracker = deps.workspace(integration.workspaceId).tracker;
    if (tracker === undefined || provider.parseTrackerChange === undefined)
      return false;
    try {
      const parsed = await provider.parseTrackerChange(integration, request);
      if (parsed.kind !== "change") {
        logger.info(
          `[webhook] delivery=${deliveryId} the ticket mirror takes nothing from it: ${parsed.reason}`,
        );
        return false;
      }
      return (await tracker.apply(integration, parsed.change)) === "updated";
    } catch (error) {
      logger.error(
        `[webhook] delivery=${deliveryId} event=${eventName} the ticket mirror could not be updated (${errorCodeOf(error)})`,
      );
      if (strict)
        throw new WebhookProcessingError(
          `the ticket mirror could not be updated (${errorCodeOf(error)})`,
          503,
        );
      return false;
    }
  }

  /** Steps 6 to 8: everything after the delivery was claimed. */
  async function handleDelivery(
    eventName: string,
    deliveryId: string,
    request: Request,
  ): Promise<Outcome> {
    const provider = registry.resolve(TYPE);

    const identity = await provider.identifyWebhook(request);
    if (identity === null) return "ignored";

    const integration = await integrations.findByExternalId(
      TYPE,
      identity.externalId,
    );
    const isInstallationEvent = INSTALLATION_EVENTS.has(eventName);

    // A suspended, removed or disconnected installation reviews nothing; its own events still go through
    // (they are how a suspended one comes back).
    if (
      integration !== undefined &&
      integration.status !== "active" &&
      !isInstallationEvent
    )
      return "integration_disabled";
    // Only an installation event can introduce an installation we do not know yet.
    if (integration === undefined && !isInstallationEvent)
      return "unknown_installation";

    // The ticket mirror (#923) hears the event first. A delivery that is also a review trigger or a label must still reach those, so a
    // failure of the mirror is logged there; an event only the mirror uses fails the delivery, so that GitHub can redeliver it.
    let mirrored = false;
    if (integration !== undefined && TRACKER_EVENTS.has(eventName)) {
      mirrored = await mirrorTickets(
        provider,
        integration,
        eventName,
        deliveryId,
        request,
        TRACKER_ONLY_EVENTS.has(eventName),
      );
      if (TRACKER_ONLY_EVENTS.has(eventName))
        return mirrored ? "tracker_updated" : "ignored";
    }

    const event: IntegrationEvent = await provider.parseEvent(
      integration ?? standIn(identity.externalId),
      request,
    );

    if (event.kind === "ignored") {
      logger.info(`[webhook] ignored: ${event.reason}`);
      return mirrored ? "tracker_updated" : "ignored";
    }

    if (event.kind === "installation_changed") {
      const result = await sync.handleInstallationChange({
        type: TYPE,
        externalId: event.externalId,
        action: event.action,
      });
      if (result.outcome === "failed")
        throw new WebhookProcessingError(
          `the installation could not be synchronized (${result.summary.errors.map((error) => error.code).join(", ")})`,
          503,
        );
      // An installation no workspace has linked is only noted; nothing else is done for it.
      return result.outcome === "unclaimed"
        ? "installation_unclaimed"
        : "installation_changed";
    }

    // A payload that lacks what the app reads cannot be handled, now or on a redelivery: the sender
    // gets a 400 and nothing is recorded or released as a success.
    if (event.kind === "invalid_payload")
      throw new WebhookPayloadError(event.reason);

    // Only an installation event reaches here without a row, and it never yields a review trigger;
    // the check keeps that true even if a provider changes.
    if (integration === undefined) return "unknown_installation";

    // From here on the delivery is the business of the workspace the installation is linked to.
    const { projects, settingsFor, intake, workflows } = deps.workspace(
      integration.workspaceId,
    );

    // A label on an issue starts the workflows that wait for exactly this label (#845). Nobody is asked whether they may label: GitHub
    // decides that. The repository must be an active one of the workspace (a project is not needed). The runs are written under the id
    // of the delivery, so a retry of it starts nothing twice.
    if (event.kind === "issue_labeled") {
      if (workflows === undefined) return "ignored";
      const started = await workflows.start(deliveryId, event.labeled);
      logger.info(
        `[webhook] delivery=${deliveryId} issue=${event.labeled.issue.number} label matched ${started.matched} workflow(s): started=${started.started} existing=${started.existing} skipped=${started.skipped} busy=${started.busy}`,
      );
      return started.started + started.existing > 0
        ? "workflow_runs_started"
        : "no_workflow_matched";
    }

    // A closed pull request starts nothing; the jobs still waiting for it are dropped. Only for a
    // repository with an active project (deactivating a project drops its waiting jobs already).
    if (event.kind === "pull_request_closed") {
      if (
        !(await projects.hasActiveProject(
          integration.id,
          event.repo.externalId,
        ))
      )
        return "project_not_active";
      await intake.discardWaitingJobs(event.repo, integration, event.prNumber);
      return "waiting_jobs_discarded";
    }

    // A pull request turned into a draft is not reviewed automatically any more, so the automatic
    // jobs that wait for it are dropped (a review a person asked for stays).
    if (event.kind === "pull_request_drafted") {
      if (
        !(await projects.hasActiveProject(
          integration.id,
          event.repo.externalId,
        ))
      )
        return "project_not_active";
      await intake.discardWaitingAutomaticJobs(
        event.repo,
        integration,
        event.prNumber,
      );
      return "waiting_jobs_discarded";
    }

    // Only repositories with an active project are reviewed. Asked before `canTrigger` (one more
    // GitHub call for a command); `parseEvent` has already read the payload, and for a comment it
    // may have asked GitHub, because only it knows which repository the delivery is about.
    if (
      !(await projects.hasActiveProject(
        integration.id,
        event.trigger.repo.externalId,
      ))
    )
      return "project_not_active";

    const trigger = event.trigger;

    // The settings of the project decide for a command (which ones people may use) and for an
    // automatic trigger (the policy below).
    const settings = await settingsFor(integration.id, trigger.repo.externalId);
    if (settings === undefined) return "project_not_active";

    // A comment command is not subject to the policy for automatic reviews (drafts, the automatic
    // switches): a person asked for it. The project decides which commands people may
    // use at all.
    if (trigger.kind === "command") {
      if (!isCommandAllowed(settings, trigger.command)) {
        // Names the command, never the arguments: they are the user's words.
        logger.info(
          `[webhook] delivery=${deliveryId} pr=${trigger.prNumber} command=${trigger.command} is not allowed in the project of ${trigger.repo.fullName}`,
        );
        return "command_not_allowed";
      }
    } else {
      // The trigger policy for pull request events.
      const decision = decideAutomaticTrigger({
        trigger,
        settings,
      });
      if (decision.action === "skip")
        return skipped(deliveryId, trigger.prNumber, decision.reason);

      // Deliveries arrive late and out of order. Before the trigger takes the place of a waiting
      // job, ask GitHub whether its commit is still the head (one call), so a late delivery for an
      // older commit cannot replace the job of the newest one. The check fails open: the job queue
      // is durable, so when GitHub cannot answer in time the trigger is enqueued with the head of
      // the payload instead of losing the review.
      const current = await lookUpCurrentPullRequest(
        provider,
        integration,
        trigger,
        deliveryId,
      );
      if (current.kind === "not_found")
        return skipped(deliveryId, trigger.prNumber, "pull_request_not_found");
      if (current.kind === "found") {
        const stale = checkAgainstCurrentPullRequest(
          trigger,
          current.pullRequest,
        );
        if (stale !== null)
          return skipped(deliveryId, trigger.prNumber, stale.reason);
      }
    }

    if (!(await provider.canTrigger(integration, trigger)))
      return "trigger_not_allowed";
    await intake.enqueueReviewTrigger(trigger, integration, {
      deliveryId,
      event: eventName,
    });
    return "trigger_enqueued";
  }

  async function handleRequest(request: Request): Promise<Response> {
    // 1. size
    const body = await readLimitedBody(request, maxBodyBytes);
    if (!body.ok) return fail(413, "WEBHOOK_BODY_TOO_LARGE");

    // The provider reads the exact bytes again, so it gets a request of its own with them.
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    const verified = new Request(request.url, {
      method: "POST",
      headers,
      body: body.bytes as BodyInit,
    });

    // 2. signature
    const provider = registry.resolve(TYPE);
    let genuine: boolean;
    try {
      genuine = await provider.verifyWebhook(null, verified);
    } catch (error) {
      // A delivery that cannot be verified is refused like a forged one; callers learn nothing about
      // the configuration. The operator reads the cause in the log.
      const logged = loggedUnverifiableFor();
      if (
        !logged.has(logger) &&
        ((await deps.githubAppConfigured?.()) ?? true)
      ) {
        logged.add(logger);
        logger.error(
          `[webhook] deliveries cannot be verified: ${describeError(error)}`,
        );
      }
      return fail(401, "WEBHOOK_SIGNATURE_INVALID");
    }
    if (!genuine) {
      logger.info("[webhook] refused a delivery with an invalid signature");
      return fail(401, "WEBHOOK_SIGNATURE_INVALID");
    }

    // 3. shape
    const eventName = request.headers.get("x-github-event");
    if (eventName === null || !EVENT_NAME.test(eventName))
      return fail(400, "WEBHOOK_EVENT_HEADER_INVALID");
    const deliveryId = request.headers.get("x-github-delivery");
    if (deliveryId === null || !DELIVERY_ID.test(deliveryId))
      return fail(400, "WEBHOOK_DELIVERY_HEADER_INVALID");
    try {
      JSON.parse(body.text);
    } catch {
      return fail(400, "WEBHOOK_BODY_NOT_JSON");
    }

    // 4. relevance
    if (
      !REVIEW_EVENTS.has(eventName) &&
      !WORKFLOW_EVENTS.has(eventName) &&
      !TRACKER_ONLY_EVENTS.has(eventName) &&
      !INSTALLATION_EVENTS.has(eventName)
    )
      return accepted("event_not_used");

    // 5. claim
    const label = `delivery=${deliveryId} event=${eventName}`;
    let token: string;
    try {
      const claim = await deliveries.claim(deliveryId, eventName);
      if (claim.status === "duplicate") {
        logger.info(`[webhook] ${label} outcome=duplicate`);
        return accepted("duplicate");
      }
      if (claim.status === "in_progress") {
        logger.info(`[webhook] ${label} is being handled by another request`);
        return fail(409, "WEBHOOK_DELIVERY_IN_PROGRESS");
      }
      token = claim.token;
    } catch (error) {
      logger.error(
        `[webhook] ${label} cannot be recorded: ${describeError(error)}`,
      );
      return fail(500, "WEBHOOK_PROCESSING_FAILED");
    }

    // 6. to 8.
    let outcome: Outcome;
    try {
      outcome = await handleDelivery(eventName, deliveryId, verified);
    } catch (error) {
      logger.error(`[webhook] ${label} failed: ${describeError(error)}`);
      // Forget the claim so the redelivery is handled. If this fails too, the claim runs out by
      // itself (WEBHOOK_DELIVERY_PROCESSING_LEASE_MS).
      await deliveries
        .release(deliveryId, token)
        .catch((releaseError: unknown) =>
          logger.error(
            `[webhook] ${label} cannot be released: ${describeError(releaseError)}`,
          ),
        );
      if (error instanceof WebhookPayloadError)
        return fail(400, "WEBHOOK_PAYLOAD_INVALID");
      return fail(
        error instanceof WebhookProcessingError ? error.status : 500,
        "WEBHOOK_PROCESSING_FAILED",
      );
    }

    // Only a succeeded delivery stays claimed; the other outcomes are recorded for diagnostics and
    // the same id can be handled again (see the repository).
    await deliveries
      .complete(deliveryId, token, outcome)
      .catch((error: unknown) =>
        logger.error(
          `[webhook] ${label} outcome cannot be recorded: ${describeError(error)}`,
        ),
      );
    logger.info(`[webhook] ${label} outcome=${outcome}`);
    return accepted(outcome);
  }

  return async function handle(request) {
    try {
      return await handleRequest(request);
    } catch (error) {
      // Nothing before the claim is expected to throw (a stream error, a registry problem). The
      // caller gets a generic answer, the log gets the cause.
      logger.error(`[webhook] request failed: ${describeError(error)}`);
      return fail(500, "WEBHOOK_PROCESSING_FAILED");
    }
  };
}
