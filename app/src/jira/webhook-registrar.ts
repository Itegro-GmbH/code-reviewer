// SPDX-License-Identifier: LicenseRef-Proprietary

// The life of the webhooks the factory registers itself at a Jira site (#1039, owner decision 2026-11-14: no admin step in Jira). A project
// whose ticket source is a Jira project has ONE dynamic webhook for the JQL filter `project = KEY` and the events the factory follows. This
// module brings reality to what the project's source says it should be, and is safe to run again at any time (`reconcile`):
//
//  - the project has a Jira source and no webhook: a row is made and the webhook registered at Jira, its address carrying a secret made now
//    (only the hash is stored, `webhook-verify.ts`);
//  - the row is `pending` (an earlier registration failed, or never ran): registered again, with a new secret;
//  - the row is `active` and ends within `EXTEND_WITHIN_MS` (Atlassian ends a webhook registered through the REST API after 30 days; each
//    extension adds 30 more): extended. Jira that no longer knows the webhook (it expired more than three months ago): registered again;
//  - the row is `active` and was registered more than `ROTATE_AFTER_MS` ago: ROTATED. The secret is in the address Jira calls, which ends
//    up in the request logs of the platform and its log drains, so it does not live as long as the webhook can. A new webhook with a new
//    secret is registered first, and the old one is deleted after: both secrets are accepted while this runs (`pending_secret_hash`), so no
//    delivery is lost. A rotation that fails leaves the old webhook as it was (and extends it when it ends soon); it is tried again;
//  - the source changed (another Jira project or connection): the old webhook is deleted at Jira, a new one registered;
//  - the project is off or its source is not Jira any more: the webhook is deleted at Jira, then the row goes. A deletion that fails leaves
//    the row `removing` for the next reconcile (the nightly job); until then deliveries of it are refused because the project no longer
//    has that source. A deletion Jira REFUSES (401, 403, a connection that is broken or gone) cannot succeed later either, and Jira ends
//    the webhook itself within 30 days: the row goes anyway, so the new source is not stuck behind it.
//
// Registering is a compare-and-set over the row (`beginRegistration`, `markRegistered`): the secret of the address is stored as pending
// before Jira is asked and becomes THE secret only when the same registration marks itself done. Two reconciles of one project at the same
// moment therefore leave the row with the Jira id and the secret of ONE of them, and the other deletes the webhook it made. A registration
// whose outcome is unknown (Jira did not answer) may have made a webhook; Jira does not tell the address of a webhook, so the next
// registration looks for webhooks of the filter `project = KEY` that no row of the workspace knows and that end about 30 days after the
// failed attempt, and deletes those.
//
// A failure never throws: it is recorded on the row (`error_code`) and returned. What triggers a reconcile: a project switched on or off
// (`project-hooks.ts`), and the nightly job (`src/cron/jira-webhooks.ts`). Nothing here logs a secret or an address.
import type {
  JiraWebhooksRepository,
  StoredJiraWebhook,
} from "../db/repositories/jira-webhooks-repository.ts";
import {
  jiraSourceOf,
  type StoredProject,
} from "../db/repositories/projects-repository.ts";
import { JIRA_WEBHOOK_EVENTS } from "./webhook-events.ts";
import { hashWebhookSecret, newWebhookSecret } from "./webhook-verify.ts";
import type { JiraWebhookApi, JiraWebhookFailure } from "./webhooks-api.ts";

/** A webhook that ends within this long is extended. The nightly job runs every day, so one that is missed still has days left. */
export const EXTEND_WITHIN_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * A webhook registered this long ago is rotated (new secret) by the nightly job. Atlassian ends a webhook after 30 days unless it is
 * extended, so 25 days leaves five nights of tries before a registration is old enough to matter, and the extension (at 20 days) comes first.
 */
export const ROTATE_AFTER_MS = 25 * 24 * 60 * 60 * 1000;

/** How close to "the failed attempt plus 30 days" a webhook's end must be for it to count as that attempt's leftover. */
const ORPHAN_WINDOW_MS = 2 * 60 * 60 * 1000;
const WEBHOOK_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** The failures of a deletion that asking again does not mend. */
const REFUSED: ReadonlySet<string> = new Set([
  "jira_forbidden",
  "jira_connection_broken",
  "jira_connection_not_found",
]);

/** The path Jira calls; the registration's id and secret ride in the query (`w`, `s`). */
export const JIRA_WEBHOOK_PATH = "/api/webhooks/jira";

/** The address Jira calls for one registration. Atlassian requires https and the base address of the app. */
export function jiraWebhookUrl(
  publicUrl: string,
  registrationId: string,
  secret: string,
): string {
  const url = new URL(JIRA_WEBHOOK_PATH, publicUrl);
  url.searchParams.set("w", registrationId);
  url.searchParams.set("s", secret);
  return url.toString();
}

export type ReconcileOutcome =
  "none" | "registered" | "extended" | "unchanged" | "removed" | "failed";

export type ReconcileResult = {
  outcome: ReconcileOutcome;
  /** The code of the failure when the outcome is `failed`. */
  error?: JiraWebhookFailure["error"];
};

export type JiraWebhookRegistrar = {
  /** Brings the webhook of the project to what its source says. Never throws what Jira or the database answer wrongly, except a database failure. */
  reconcile(projectId: string): Promise<ReconcileResult>;
};

export type JiraWebhookRegistrarDependencies = {
  webhooks: JiraWebhooksRepository;
  projects: { getById(projectId: string): Promise<StoredProject | undefined> };
  api: JiraWebhookApi;
  /** The public address of the app (`BETTER_AUTH_URL`): the base of the address Jira calls. */
  publicUrl: string;
  now?: () => Date;
  newId?: () => string;
  newSecret?: () => string;
  log?: (line: string) => void;
};

export function createJiraWebhookRegistrar(
  deps: JiraWebhookRegistrarDependencies,
): JiraWebhookRegistrar {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const newSecret = deps.newSecret ?? newWebhookSecret;
  const log = deps.log ?? ((line) => console.error(line));
  const { webhooks, api } = deps;

  /** Takes back a webhook this registrar made and the row does not want. A failure is logged; Jira ends the webhook itself within 30 days. */
  async function takeBack(row: StoredJiraWebhook, webhookId: string) {
    const removed = await api.remove(row.connectionId, [webhookId]);
    if (!removed.ok)
      log(
        `[jira] JIRA_WEBHOOK_TAKE_BACK_FAILED: ${removed.error} (project ${row.projectId})`,
      );
  }

  /**
   * After a registration of unknown outcome (Jira did not answer): deletes the webhooks of this project's filter that no row of the
   * workspace knows and that end about 30 days after that attempt. Another workspace's webhook of the same user, site and project key could
   * match too, were it made within two hours of the attempt; its next extension then finds it gone and registers it again.
   */
  async function sweepLeftovers(row: StoredJiraWebhook) {
    const listed = await api.list(row.connectionId);
    if (!listed.ok) return;
    const known = new Set(
      (await webhooks.list())
        .filter((other) => other.connectionId === row.connectionId)
        .map((other) => other.jiraWebhookId),
    );
    const attemptEnds = Date.parse(row.updatedAt) + WEBHOOK_LIFE_MS;
    const leftovers = listed.webhooks.filter(
      (hook) =>
        hook.jql === `project = ${row.projectKey}` &&
        !known.has(hook.id) &&
        Math.abs(Date.parse(hook.expiresAt) - attemptEnds) <= ORPHAN_WINDOW_MS,
    );
    if (leftovers.length === 0) return;
    const removed = await api.remove(
      row.connectionId,
      leftovers.map((hook) => hook.id),
    );
    log(
      removed.ok
        ? `[jira] JIRA_WEBHOOK_LEFTOVERS_REMOVED: ${String(leftovers.length)} (project ${row.projectId})`
        : `[jira] JIRA_WEBHOOK_LEFTOVERS_FAILED: ${removed.error} (project ${row.projectId})`,
    );
  }

  /**
   * Registers a webhook for the row with a secret made now: for a row that has none at Jira, one Jira lost, or (a rotation) one that is
   * replaced. The old webhook of the row, if any, is deleted after the new one is the row's.
   */
  async function register(row: StoredJiraWebhook): Promise<ReconcileResult> {
    const secret = newSecret();
    const secretHash = hashWebhookSecret(secret);
    // Another reconcile that finished or removed the row since it was read has the say: nothing is started over it.
    if (
      !(await webhooks.beginRegistration(row.id, secretHash, row.jiraWebhookId))
    )
      return { outcome: "none" };
    if (row.errorCode === "jira_unavailable") await sweepLeftovers(row);
    const registered = await api.register(row.connectionId, {
      url: jiraWebhookUrl(deps.publicUrl, row.id, secret),
      jql: `project = ${row.projectKey}`,
      events: JIRA_WEBHOOK_EVENTS,
    });
    if (!registered.ok) {
      await webhooks.markError(row.id, registered.error);
      log(
        `[jira] JIRA_WEBHOOK_REGISTER_FAILED: ${registered.error} (project ${row.projectId})`,
      );
      return { outcome: "failed", error: registered.error };
    }
    // Atlassian does not say when a new webhook ends: the documented life is 30 days from now.
    const expiresAt = new Date(now().getTime() + WEBHOOK_LIFE_MS);
    const marked = await webhooks.markRegistered(
      row.id,
      registered.webhookId,
      expiresAt.toISOString(),
      secretHash,
    );
    if (!marked) {
      // Another registration began meanwhile (its secret is the row's now), or the row is being removed: this webhook is nobody's.
      await takeBack(row, registered.webhookId);
      return { outcome: "none" };
    }
    if (row.jiraWebhookId !== null) await takeBack(row, row.jiraWebhookId);
    return { outcome: "registered" };
  }

  /** Deletes the row's webhook at Jira and then the row; a deletion that fails keeps the row, `removing`. */
  async function drop(row: StoredJiraWebhook): Promise<ReconcileResult> {
    if (row.jiraWebhookId !== null) {
      const removed = await api.remove(row.connectionId, [row.jiraWebhookId]);
      if (!removed.ok && REFUSED.has(removed.error))
        // Nothing will change by asking again; Jira ends the webhook (and then refuses its deliveries) within 30 days.
        log(
          `[jira] JIRA_WEBHOOK_REMOVE_REFUSED: ${removed.error}, the row goes, Jira ends the webhook itself (project ${row.projectId})`,
        );
      else if (!removed.ok) {
        await webhooks.markRemoving(row.projectId);
        await webhooks.markError(row.id, removed.error);
        log(
          `[jira] JIRA_WEBHOOK_REMOVE_FAILED: ${removed.error} (project ${row.projectId})`,
        );
        return { outcome: "failed", error: removed.error };
      }
    }
    await webhooks.remove(row.id);
    return { outcome: "removed" };
  }

  async function extend(row: StoredJiraWebhook): Promise<ReconcileResult> {
    if (row.jiraWebhookId === null) return register(row);
    const registeredAt = Date.parse(row.registeredAt ?? row.createdAt);
    if (now().getTime() - registeredAt > ROTATE_AFTER_MS) {
      const rotated = await register(row);
      // A rotation that did not happen leaves the old webhook as it is; it is not allowed to expire because of it.
      if (rotated.outcome !== "failed") return rotated;
      log(
        `[jira] JIRA_WEBHOOK_ROTATE_FAILED: ${rotated.error ?? "unknown"} (project ${row.projectId})`,
      );
    }
    const expires = row.expiresAt === null ? 0 : Date.parse(row.expiresAt);
    if (expires - now().getTime() > EXTEND_WITHIN_MS)
      return { outcome: "unchanged" };
    const extended = await api.extend(row.connectionId, [row.jiraWebhookId]);
    if (extended.ok) {
      await webhooks.markExtended(row.id, extended.expiresAt);
      return { outcome: "extended" };
    }
    // Jira has forgotten it (it ended more than three months ago): a new webhook takes its place.
    if (extended.error === "jira_webhook_gone") return register(row);
    await webhooks.markError(row.id, extended.error);
    log(
      `[jira] JIRA_WEBHOOK_EXTEND_FAILED: ${extended.error} (project ${row.projectId})`,
    );
    return { outcome: "failed", error: extended.error };
  }

  return {
    async reconcile(projectId) {
      const project = await deps.projects.getById(projectId);
      const wanted =
        project === undefined || !project.active
          ? null
          : jiraSourceOf(project.ticketSource);
      let row = await webhooks.getByProject(projectId);

      if (wanted === null)
        return row === undefined ? { outcome: "none" } : drop(row);

      // Another connection or project, or a row whose removal is still due: the old webhook goes first.
      if (
        row !== undefined &&
        (row.status === "removing" ||
          row.connectionId !== wanted.connectionId ||
          row.projectKey !== wanted.projectKey)
      ) {
        const dropped = await drop(row);
        if (dropped.outcome === "failed") return dropped;
        row = undefined;
      }

      if (row === undefined) {
        const created = await webhooks.create({
          id: newId(),
          projectId,
          connectionId: wanted.connectionId,
          projectKey: wanted.projectKey,
          secretHash: hashWebhookSecret(newSecret()),
        });
        // Undefined: the connection is none of this workspace's, or another reconcile made the row meanwhile.
        if (created === undefined) {
          const meanwhile = await webhooks.getByProject(projectId);
          if (meanwhile === undefined)
            return { outcome: "failed", error: "jira_connection_not_found" };
          return { outcome: "unchanged" };
        }
        return register(created);
      }
      return row.status === "pending" ? register(row) : extend(row);
    },
  };
}
