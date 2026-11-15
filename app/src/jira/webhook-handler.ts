// SPDX-License-Identifier: LicenseRef-Proprietary

// The handler behind `POST /api/webhooks/jira` (#1039, epic #1034): the dynamic webhooks the factory registers itself at a Jira site
// (`webhook-registrar.ts`) call it. A function of its collaborators, so the route file only wires the real ones in (`webhook-shared.ts`) and
// tests wire fakes in. The order is the contract; each step ends the request on failure, and nothing before the claim of the delivery has a
// side effect except noting, once per registration, that a bearer token verified (step 2):
//
//   1. config    the Atlassian app is configured at all (the client secret verifies the bearer token)                          404
//   2. verify    the registration the address names (`w`) exists and is not being removed, the secret in the address (`s`) is its
//                secret (or its pending one), and a bearer token verifies (`webhook-verify.ts`): one that does not is refused, a
//                missing one is refused once a token was seen for the registration (trust on first use)                         401
//                This comes before the body is read: an unauthenticated request costs a lookup, not a megabyte.
//   3. size      the body is read with a 1 MB limit                                                                              413
//   4. shape     the body is JSON                                                                                                400
//   5. relevance an event the factory does not follow, or one that is no issue, is answered at once                              200
//   6. claim     the delivery is claimed under `jira-<registration>-<identifier>` (Jira's identifier is the same across retries;
//                a delivery without a usable `X-Atlassian-Webhook-Identifier` is claimed under a hash of its body instead, as
//                the same retry has the same body); a succeeded delivery is a duplicate (200), one another request handles right
//                now is 409 (Jira retries it)
//   7. attribute the registration names the project; it must still be an active one whose ticket source is exactly the Jira project the
//                webhook watches, and the issue must be of that Jira project (everything after this runs in the project's workspace)
//   8. mirror    the issue is written into the ticket mirror (`mirror.ts`); a failure is logged and never stops the trigger
//   9. trigger   a change of the status starts the lanes that wait for the new status (`workflow-runs/jira-status-trigger.ts`); a failure
//                releases the claim and answers 503 (Jira retries up to five times)
//
// Everything is answered 200 except a refusal or a failure: Jira retries 408, 409, 425, 429 and 5xx and treats everything else as final.
// Nothing here logs the secret, the address, a token or a body: lines name the delivery, the event and the outcome.
import "server-only";
import { createHash } from "node:crypto";
import type { JiraWebhookDirectory } from "../db/repositories/jira-webhook-directory-repository.ts";
import type { StoredProject } from "../db/repositories/projects-repository.ts";
import { jiraSourceOf } from "../db/repositories/projects-repository.ts";
import type {
  WebhookDeliveriesRepository,
  WebhookDeliveryOutcome,
} from "../db/repositories/webhook-deliveries-repository.ts";
import { readLimitedBody } from "../webhooks/limited-body.ts";
import {
  consoleWebhookLogger,
  type WebhookLogger,
} from "../webhooks/logger.ts";
import type { JiraMirror } from "./mirror.ts";
import { parseJiraDelivery } from "./webhook-events.ts";
import { verifyJiraDelivery } from "./webhook-verify.ts";

/** 1 MiB: a Jira payload is a few kilobytes (the issue without `expand`, a changelog). */
export const JIRA_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export const JIRA_WEBHOOK_ERROR_CODES = [
  /** The Atlassian app is not configured on this server: the feature is off. 404. */
  "JIRA_WEBHOOK_NOT_CONFIGURED",
  /** The body is larger than the limit. 413. */
  "JIRA_WEBHOOK_BODY_TOO_LARGE",
  /** The registration is unknown or being removed, the secret in the address is missing or wrong, or the bearer token does not verify or is missing after one was seen. 401. */
  "JIRA_WEBHOOK_UNAUTHORIZED",
  /** The body is not valid JSON. 400. */
  "JIRA_WEBHOOK_BODY_NOT_JSON",
  /** Another request is handling this delivery right now; Jira retries it. 409. */
  "JIRA_WEBHOOK_IN_PROGRESS",
  /** Handling the delivery failed; Jira retries it. 503. */
  "JIRA_WEBHOOK_PROCESSING_FAILED",
] as const;
export type JiraWebhookErrorCode = (typeof JIRA_WEBHOOK_ERROR_CODES)[number];

/** What the route answers with 200: it only names what happened, for Jira's delivery log. */
export type JiraWebhookOutcome =
  "duplicate" | "ignored" | "tracker_updated" | "workflow_runs_started";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const REGISTRATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * What starts the lanes a change of status in Jira starts: `JiraStatusTrigger` of `src/workflow-runs/`, which this module does not import
 * (the engine's wiring reaches this folder; the route wires the two together), as for the GitHub webhook.
 */
export type JiraStatusStarter = {
  start(
    deliveryId: string,
    move: {
      projectId: string;
      connectionId: string;
      projectKey: string;
      issueKey: string;
      from: string | null;
      to: string;
      actor?: { accountId: string; name: string };
    },
  ): Promise<{
    matched: number;
    started: number;
    existing: number;
    skipped: number;
    busy: number;
  }>;
};

/** What acts inside the workspace of the registration. */
export type JiraWorkspaceCollaborators = {
  /** Notes that a bearer token that verified came with a delivery of the registration (the first time stays). */
  registrations: { markBearerSeen(registrationId: string): Promise<boolean> };
  projects: { getById(projectId: string): Promise<StoredProject | undefined> };
  /** The full name of the repository the code lives in (where the mirror's rows sit); undefined for none. */
  repositoryName(repositoryId: string): Promise<string | undefined>;
  mirror: JiraMirror;
  /** Left out where a server has no workflow engine: a status change is then only written into the ticket mirror. */
  statuses?: JiraStatusStarter;
};

export type JiraWebhookDeps = {
  directory: Pick<JiraWebhookDirectory, "findById">;
  deliveries: WebhookDeliveriesRepository;
  /** The client secret of the Atlassian app; undefined when the feature is off. Read on every request. */
  clientSecret(): string | undefined;
  /** The collaborators of one workspace; called with the workspace of the registration. */
  workspace(workspaceId: string): JiraWorkspaceCollaborators;
  logger?: WebhookLogger;
  maxBodyBytes?: number;
  now?: () => Date;
};

export type JiraWebhookHandler = (request: Request) => Promise<Response>;

const fail = (status: number, error: JiraWebhookErrorCode) =>
  Response.json({ error }, { status });
const accepted = (outcome: JiraWebhookOutcome) =>
  Response.json({ status: "accepted", outcome }, { status: 200 });

/** The stable code of an error, or its class name: never its message. */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown error";
}

export function createJiraWebhookHandler(
  deps: JiraWebhookDeps,
): JiraWebhookHandler {
  const logger = deps.logger ?? consoleWebhookLogger;
  const maxBodyBytes = deps.maxBodyBytes ?? JIRA_WEBHOOK_MAX_BODY_BYTES;
  const now = deps.now ?? (() => new Date());

  return async (request) => {
    const clientSecret = deps.clientSecret();
    if (clientSecret === undefined)
      return fail(404, "JIRA_WEBHOOK_NOT_CONFIGURED");

    // The address names the registration; whether it exists, and a wrong secret, look the same from outside.
    const address = new URL(request.url);
    const registrationId = address.searchParams.get("w") ?? "";
    const registration = REGISTRATION_ID.test(registrationId)
      ? await deps.directory.findById(registrationId)
      : undefined;
    if (registration === undefined || registration.status === "removing") {
      logger.warn("[jira-webhook] refused: unknown or removed registration");
      return fail(401, "JIRA_WEBHOOK_UNAUTHORIZED");
    }
    const verdict = verifyJiraDelivery({
      urlSecret: address.searchParams.get("s"),
      storedSecretHash: registration.secretHash,
      pendingSecretHash: registration.pendingSecretHash,
      bearerSeen: registration.bearerSeenAt !== null,
      authorization: request.headers.get("authorization"),
      clientSecret,
      now: now(),
    });
    if (!verdict.ok) {
      logger.warn(
        `[jira-webhook] refused: registration=${registration.id} reason=${verdict.reason}`,
      );
      return fail(401, "JIRA_WEBHOOK_UNAUTHORIZED");
    }
    if (verdict.bearer === "verified" && registration.bearerSeenAt === null) {
      // From now on a delivery of this registration without a token is refused. A failure to note it only delays that.
      try {
        await deps
          .workspace(registration.workspaceId)
          .registrations.markBearerSeen(registration.id);
      } catch (error) {
        logger.warn(
          `[jira-webhook] registration=${registration.id} the bearer token could not be noted (${errorCodeOf(error)})`,
        );
      }
    }

    const body = await readLimitedBody(request, maxBodyBytes);
    if (!body.ok) return fail(413, "JIRA_WEBHOOK_BODY_TOO_LARGE");
    let payload: unknown;
    try {
      payload = JSON.parse(body.text);
    } catch {
      return fail(400, "JIRA_WEBHOOK_BODY_NOT_JSON");
    }

    const change = parseJiraDelivery(payload, registration.siteUrl);
    if (change.kind === "ignored") {
      logger.info(
        `[jira-webhook] registration=${registration.id} ignored: ${change.reason}`,
      );
      return accepted("ignored");
    }
    // Jira names the registrations a delivery matched; one that is not this one is not for this address.
    if (
      registration.jiraWebhookId !== null &&
      change.matchedWebhookIds.length > 0 &&
      !change.matchedWebhookIds.includes(Number(registration.jiraWebhookId))
    ) {
      logger.info(
        `[jira-webhook] registration=${registration.id} ignored: it names other webhooks`,
      );
      return accepted("ignored");
    }

    // Jira treats a 4xx as final, so a missing or odd identifier must not be refused: the retries of one delivery carry one body.
    const header = request.headers.get("x-atlassian-webhook-identifier");
    const identifier =
      header !== null && IDENTIFIER.test(header)
        ? header
        : `b-${createHash("sha256").update(body.text).digest("hex").slice(0, 32)}`;
    if (identifier !== header)
      logger.info(
        `[jira-webhook] registration=${registration.id} no usable X-Atlassian-Webhook-Identifier: de-duplicated by a body hash`,
      );
    const deliveryId = `${registration.id}-${identifier}`;
    const eventName =
      change.kind === "issue_deleted"
        ? "jira:issue_deleted"
        : `jira:${change.event}`;
    const claim = await deps.deliveries.claim(
      `jira-${deliveryId}`,
      eventName.slice(0, 64),
    );
    if (claim.status === "duplicate") return accepted("duplicate");
    if (claim.status === "in_progress")
      return fail(409, "JIRA_WEBHOOK_IN_PROGRESS");

    const finish = async (
      outcome: Exclude<WebhookDeliveryOutcome, "processing">,
    ) => {
      await deps.deliveries.complete(
        `jira-${deliveryId}`,
        claim.token,
        outcome,
      );
    };

    try {
      const workspace = deps.workspace(registration.workspaceId);
      const project = await workspace.projects.getById(registration.projectId);
      const source =
        project === undefined ? null : jiraSourceOf(project.ticketSource);
      const issueKey =
        change.kind === "issue_deleted" ? change.key : change.issue.key;
      const issueProject = issueKey.slice(0, issueKey.lastIndexOf("-"));
      if (
        project === undefined ||
        !project.active ||
        source === null ||
        source.connectionId !== registration.connectionId ||
        source.projectKey !== registration.projectKey ||
        issueProject !== registration.projectKey
      ) {
        logger.info(
          `[jira-webhook] delivery=${deliveryId} ignored: the project is off, its source is another one, or the issue is of another Jira project`,
        );
        await finish("ignored");
        return accepted("ignored");
      }
      const repoFullName = await workspace.repositoryName(project.repositoryId);
      if (repoFullName === undefined) {
        logger.info(
          `[jira-webhook] delivery=${deliveryId} ignored: the repository of the project is gone`,
        );
        await finish("ignored");
        return accepted("ignored");
      }

      let mirrored = false;
      let mirrorFailure: { error: unknown } | undefined;
      try {
        mirrored =
          (await workspace.mirror.apply(
            { repositoryId: project.repositoryId, repoFullName },
            change,
          )) === "updated";
      } catch (error) {
        logger.error(
          `[jira-webhook] delivery=${deliveryId} event=${eventName} the ticket mirror could not be updated (${errorCodeOf(error)})`,
        );
        mirrorFailure = { error };
      }

      let started = 0;
      if (
        change.kind === "issue_changed" &&
        change.status !== undefined &&
        workspace.statuses !== undefined
      ) {
        const result = await workspace.statuses.start(deliveryId, {
          projectId: project.id,
          connectionId: registration.connectionId,
          projectKey: registration.projectKey,
          issueKey: change.issue.key,
          from: change.status.from,
          to: change.status.to,
          ...(change.actor === undefined ? {} : { actor: change.actor }),
        });
        if (result.matched > 0)
          logger.info(
            `[jira-webhook] delivery=${deliveryId} an issue moved to a status that ${result.matched} lane(s) wait for: started=${result.started} existing=${result.existing} skipped=${result.skipped} busy=${result.busy}`,
          );
        started = result.started + result.existing;
      }

      // A delivery that only the mirror uses is tried again by Jira when the mirror failed; one that started a run goes on.
      if (mirrorFailure !== undefined && started === 0)
        throw mirrorFailure.error;
      const outcome: Exclude<JiraWebhookOutcome, "duplicate"> =
        started > 0
          ? "workflow_runs_started"
          : mirrored
            ? "tracker_updated"
            : "ignored";
      await finish(outcome);
      return accepted(outcome);
    } catch (error) {
      // Not completed: Jira retries the delivery and finds the runs that were written.
      logger.error(
        `[jira-webhook] delivery=${deliveryId} event=${eventName} failed (${errorCodeOf(error)})`,
      );
      await deps.deliveries.release(`jira-${deliveryId}`, claim.token);
      return fail(503, "JIRA_WEBHOOK_PROCESSING_FAILED");
    }
  };
}
