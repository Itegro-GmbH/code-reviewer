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
//  - the source changed (another Jira project or connection): the old webhook is deleted at Jira, a new one registered;
//  - the project is off or its source is not Jira any more: the webhook is deleted at Jira, then the row goes. A deletion that fails leaves
//    the row `removing` for the next reconcile (the nightly job); until then deliveries of it are refused because the project no longer
//    has that source.
//
// A failure never throws: it is recorded on the row (`error_code`) and returned. What triggers a reconcile: a project switched on or off
// (`project-webhook-hooks.ts`), and the nightly job (`webhook-nightly.ts`). Two reconciles of one project at the same moment can register
// twice at Jira; the row keeps the last one and the other is deleted by Jira when it expires. Nothing here logs a secret or an address.
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

  /** Registers the webhook of a row that has none at Jira, with a secret made now. */
  async function register(row: StoredJiraWebhook): Promise<ReconcileResult> {
    const secret = newSecret();
    if (!(await webhooks.reset(row.id, hashWebhookSecret(secret))))
      return { outcome: "none" };
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
    const expiresAt = new Date(now().getTime() + 30 * 24 * 60 * 60 * 1000);
    await webhooks.markRegistered(
      row.id,
      registered.webhookId,
      expiresAt.toISOString(),
    );
    return { outcome: "registered" };
  }

  /** Deletes the row's webhook at Jira and then the row; a deletion that fails keeps the row, `removing`. */
  async function drop(row: StoredJiraWebhook): Promise<ReconcileResult> {
    if (row.jiraWebhookId !== null) {
      const removed = await api.remove(row.connectionId, [row.jiraWebhookId]);
      if (!removed.ok) {
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
