// SPDX-License-Identifier: LicenseRef-Proprietary

// The life of the webhooks the factory registers itself at a Jira site (#1039, owner decision 2026-11-14: no admin step in Jira). A project
// whose ticket source is a Jira project has ONE dynamic webhook for the JQL filter `project = KEY` and the events the factory follows. This
// module brings reality to what the project's source says it should be, and is safe to run again at any time (`reconcile`).
//
// ONE ADDRESS PER CONNECTION (#1131). Jira allows one address per app and user for the dynamic webhooks of an OAuth 2.0 app (and 5 webhooks),
// so all webhooks of a connection are registered with the same address, `/api/webhooks/jira?c=<connection>&s=<secret>`, and one webhook per
// project (its own JQL filter) behind it; a delivery is told apart by the project of its issue. The secret is DERIVED from the app secret, the
// connection and the connection's generation (`deriveWebhookSecret`), so a second project can register under the address although only the
// generation is stored. Before every reconcile of a project its connection is brought to ONE address (`settleAddress`):
//
//  - a webhook of the connection is still registered under its own per-project address (made before #1131): all webhooks of the connection
//    are deleted at Jira, the rows become `pending` and are registered again under the shared address at once. Jira refuses a second address
//    while one exists, so there is no way to overlap, and a delivery in that gap is lost (a 401 is final at Jira, and a lost `-> status` event
//    is not repaired by the mirror's resync: the trigger only fires from deliveries). The gap is kept as short as it can be: the first webhook
//    is registered, the others at the same time, each retried a few times at once (`REGISTER_RETRY_DELAYS_MS`); and when it cannot be
//    closed (Jira is down) the rows stay `pending`, marked `jira_webhook_move_pending` (or the code of the failure), and the frequent run of
//    the cron job (`?retry=pending`, every 15 minutes) tries again, so a project is never dark for a night. A failed deletion leaves
//    everything as it was and is tried again. An id Jira no longer knows never blocks the deletion (`webhooks-api.ts`);
//  - the address is older than `ROTATE_AFTER_MS`: ROTATED the same way, with the next generation, so a secret that leaked into a request
//    log (the address ends up in the logs of the platform and its log drains) is valid for 25 days at most. A rotation whose deletion fails
//    leaves the webhooks as they were (they are extended when they end soon); it is tried again. The age is the age of the generation: a
//    connection that has no webhook registered when it is old gets the next generation without any deletion;
//  - the app secret changed: the secret of the address is derived from it, so the address Jira holds carries a secret that is refused now.
//    The connection keeps the fingerprint (SHA-256) of the secret its address was registered with; another one means the same as an old
//    address: ROTATED at once, so no connection stays dark until the 25 days are over.
//
// Then, for the project:
//  - it has a Jira source and no webhook: a row is made and the webhook registered at Jira;
//  - the row is `pending` (an earlier registration failed, or never ran): registered again;
//  - the row is `active` and ends within `EXTEND_WITHIN_MS` (Atlassian ends a webhook registered through the REST API after 30 days; each
//    extension adds 30 more): extended. Jira that no longer knows the webhook (it expired more than three months ago): registered again;
//  - the source changed (another Jira project or connection): the old webhook is deleted at Jira, a new one registered;
//  - the project is off or its source is not Jira any more: the webhook is deleted at Jira, then the row goes. A deletion that fails leaves
//    the row `removing` for the next reconcile (the nightly job); until then deliveries of it are refused because the project no longer
//    has that source. A deletion Jira REFUSES (401, 403, a connection that is broken or gone) cannot succeed later either, and Jira ends
//    the webhook itself within 30 days: the row goes anyway, so the new source is not stuck behind it.
//
// Registering is a compare-and-set over the row (`beginRegistration`, `markRegistered`): a marker of the attempt is stored before Jira is
// asked and the row becomes `active` only when the same registration marks itself done. Two reconciles of one project at the same moment
// therefore leave the row with the Jira id of ONE of them, and the other deletes the webhook it made. A registration whose outcome is
// unknown (Jira did not answer) may have made a webhook; Jira does not tell the address of a webhook, so the next registration looks for
// webhooks of the filter `project = KEY` that no row of the workspace knows and that end about 30 days after the failed attempt, and deletes
// those. A registration that Jira refuses with "only a single URL" (an orphan under another address holds it: for example the unknown outcome
// of an old per-project registration) lists the webhooks of the app once and deletes those that no row of the workspace knows, except those
// made in the last minutes (another reconcile may be registering one at this moment). The webhooks of the same Jira user in another
// workspace are not told apart by Jira: they find themselves gone at their next extension and register again.
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
import { hashWebhookSecret } from "./webhook-verify.ts";
import type { JiraWebhookApi, JiraWebhookFailure } from "./webhooks-api.ts";

/** A webhook that ends within this long is extended. The nightly job runs every day, so one that is missed still has days left. */
export const EXTEND_WITHIN_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * The address of a connection is replaced (new secret) by the nightly job when it is this old. Atlassian ends a webhook after 30 days unless
 * it is extended, so 25 days leaves five nights of tries before an address is old enough to matter, and the extension (at 20 days) comes first.
 */
export const ROTATE_AFTER_MS = 25 * 24 * 60 * 60 * 1000;

/** How close to "the failed attempt plus 30 days" a webhook's end must be for it to count as that attempt's leftover. */
const ORPHAN_WINDOW_MS = 2 * 60 * 60 * 1000;
const WEBHOOK_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** The pauses between the tries of a registration after the deletions of a move (the gap without a webhook): three tries in all. */
export const REGISTER_RETRY_DELAYS_MS: readonly number[] = [300, 1500];

/** A webhook made this recently may be the registration of another reconcile that has not stored its id yet: not an orphan. */
const IN_FLIGHT_MS = 10 * 60 * 1000;

/** What the rows of a move carry until they are registered again (and what the frequent run of the cron job looks for). */
export const MOVE_PENDING_CODE = "jira_webhook_move_pending";

/** The failures of a deletion that asking again does not mend. */
const REFUSED: ReadonlySet<string> = new Set([
  "jira_forbidden",
  "jira_connection_broken",
  "jira_connection_not_found",
]);

/** The path Jira calls; the connection's id and its secret ride in the query (`c`, `s`). */
export const JIRA_WEBHOOK_PATH = "/api/webhooks/jira";

/** The address Jira calls for the webhooks of one connection. Atlassian requires https and the base address of the app. */
export function jiraWebhookUrl(
  publicUrl: string,
  connectionId: string,
  secret: string,
): string {
  const url = new URL(JIRA_WEBHOOK_PATH, publicUrl);
  url.searchParams.set("c", connectionId);
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
  /** The secret in the address of a connection for a generation (`deriveWebhookSecret` with the app secret). Never stored, never logged. */
  addressSecret(connectionId: string, generation: number): string;
  now?: () => Date;
  /** Waits (the pauses between the tries of a registration); a test passes one that does not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The pauses between the tries of a registration in a move; default `REGISTER_RETRY_DELAYS_MS`. */
  retryDelaysMs?: readonly number[];
  newId?: () => string;
  newAttempt?: () => string;
  log?: (line: string) => void;
};

export function createJiraWebhookRegistrar(
  deps: JiraWebhookRegistrarDependencies,
): JiraWebhookRegistrar {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const newAttempt = deps.newAttempt ?? (() => crypto.randomUUID());
  const log = deps.log ?? ((line) => console.error(line));
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const retryDelays = deps.retryDelaysMs ?? REGISTER_RETRY_DELAYS_MS;
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
  async function sweepLeftovers(
    row: StoredJiraWebhook,
    attemptedAt: number = Date.parse(row.updatedAt),
  ) {
    const listed = await api.list(row.connectionId);
    if (!listed.ok) return;
    const known = new Set(
      (await webhooks.list())
        .filter((other) => other.connectionId === row.connectionId)
        .map((other) => other.jiraWebhookId),
    );
    const attemptEnds = attemptedAt + WEBHOOK_LIFE_MS;
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
   * Jira refused a registration because another address holds the connection's user ("only a single URL"): lists the webhooks of the app
   * and deletes those that no row of the workspace knows (what an orphan is, whichever address it was made with; Jira does not say). Not
   * those made in the last minutes, which may be another reconcile's registration that has not stored its id yet. Answers whether it
   * deleted any.
   */
  async function removeUnknownWebhooks(
    row: StoredJiraWebhook,
  ): Promise<boolean> {
    const listed = await api.list(row.connectionId);
    if (!listed.ok) return false;
    const known = new Set(
      (await webhooks.list()).flatMap((other) =>
        other.jiraWebhookId === null ? [] : [other.jiraWebhookId],
      ),
    );
    const youngest = now().getTime() + WEBHOOK_LIFE_MS - IN_FLIGHT_MS;
    const orphans = listed.webhooks.filter(
      (hook) => !known.has(hook.id) && Date.parse(hook.expiresAt) <= youngest,
    );
    if (orphans.length === 0) return false;
    const removed = await api.remove(
      row.connectionId,
      orphans.map((hook) => hook.id),
    );
    log(
      removed.ok
        ? `[jira] JIRA_WEBHOOK_ORPHANS_REMOVED: ${String(orphans.length)} (project ${row.projectId})`
        : `[jira] JIRA_WEBHOOK_ORPHANS_FAILED: ${removed.error} (project ${row.projectId})`,
    );
    return removed.ok;
  }

  /**
   * Registers a webhook for the row under the address of its connection: for a row that has none at Jira, or one Jira lost. The old webhook
   * of the row, if any, is deleted after the new one is the row's.
   */
  async function register(
    row: StoredJiraWebhook,
    /** The pauses before each further try after Jira was unavailable (none: one try). */
    retries: readonly number[] = [],
  ): Promise<ReconcileResult> {
    const endpoint = await webhooks.getEndpoint(row.connectionId);
    if (endpoint === undefined)
      return { outcome: "failed", error: "jira_connection_not_found" };
    const attempt = newAttempt();
    // Another reconcile that finished or removed the row since it was read has the say: nothing is started over it.
    if (!(await webhooks.beginRegistration(row.id, attempt, row.jiraWebhookId)))
      return { outcome: "none" };
    if (row.errorCode === "jira_unavailable") await sweepLeftovers(row);
    const secret = deps.addressSecret(row.connectionId, endpoint.generation);
    const attemptRegister = () =>
      api.register(row.connectionId, {
        url: jiraWebhookUrl(deps.publicUrl, row.connectionId, secret),
        jql: `project = ${row.projectKey}`,
        events: JIRA_WEBHOOK_EVENTS,
      });
    let registered = await attemptRegister();
    const pauses = [...retries];
    let healed = false;
    while (!registered.ok) {
      if (registered.error === "jira_webhook_url_conflict" && !healed) {
        // An orphan holds the address: deleted once, then the registration is asked again.
        healed = true;
        if (!(await removeUnknownWebhooks(row))) break;
        registered = await attemptRegister();
        continue;
      }
      const pause =
        registered.error === "jira_unavailable" ? pauses.shift() : undefined;
      if (pause === undefined) break;
      await sleep(pause);
      // The failed try may have made a webhook all the same: it goes before another is made.
      await sweepLeftovers(row, now().getTime());
      registered = await attemptRegister();
    }
    if (!registered.ok) {
      await webhooks.markError(row.id, registered.error);
      log(
        `[jira] JIRA_WEBHOOK_REGISTER_FAILED: ${registered.error} (project ${row.projectId})`,
      );
      return { outcome: "failed", error: registered.error };
    }
    // A rotation that ran meanwhile deleted every webhook of the connection and counted the generation up: this one carries the old address
    // (its deliveries would be refused), so it is nobody's; the row is `pending` and the next reconcile registers it.
    const after = await webhooks.getEndpoint(row.connectionId);
    if (after?.generation !== endpoint.generation) {
      await takeBack(row, registered.webhookId);
      return { outcome: "none" };
    }
    // Atlassian does not say when a new webhook ends: the documented life is 30 days from now.
    const expiresAt = new Date(now().getTime() + WEBHOOK_LIFE_MS);
    const marked = await webhooks.markRegistered(
      row.id,
      registered.webhookId,
      expiresAt.toISOString(),
      attempt,
      hashWebhookSecret(secret),
    );
    if (!marked) {
      // Another registration began meanwhile (its marker is the row's now), or the row is being removed: this webhook is nobody's.
      await takeBack(row, registered.webhookId);
      return { outcome: "none" };
    }
    if (row.jiraWebhookId !== null) await takeBack(row, row.jiraWebhookId);
    return { outcome: "registered" };
  }

  /**
   * Brings the webhooks of the connection to ONE address (Jira allows one per app and user): moves those still under a per-project address
   * (before #1131) and replaces an address that is older than `ROTATE_AFTER_MS`. All webhooks of the connection are deleted at Jira, the
   * rows become `pending` and every one of them is registered again. The results of those registrations, by row id.
   */
  async function settleAddress(
    connectionId: string,
  ): Promise<Map<string, ReconcileResult>> {
    const results = new Map<string, ReconcileResult>();
    const endpoint = await webhooks.getEndpoint(connectionId);
    if (endpoint === undefined) return results;
    const rows = (await webhooks.list()).filter(
      (other) => other.connectionId === connectionId,
    );
    const registered = rows.filter((other) => other.jiraWebhookId !== null);
    const legacy = registered.some((other) => other.address === "project");
    const aged =
      endpoint.addressAt !== null &&
      now().getTime() - Date.parse(endpoint.addressAt) > ROTATE_AFTER_MS;
    const secretChanged =
      endpoint.secretFingerprint !== null &&
      endpoint.secretFingerprint !==
        hashWebhookSecret(
          deps.addressSecret(connectionId, endpoint.generation),
        );
    const held = registered.some((other) => other.address === "connection");
    // Webhooks hold the address: they are deleted and registered again. None does (the last project was switched off): an old address
    // only gets the next generation, there is nothing to delete.
    const rotate =
      (held && (aged || secretChanged)) || (aged && registered.length === 0);
    if (!legacy && !rotate) return results;
    if (held && secretChanged)
      log(
        `[jira] JIRA_WEBHOOK_SECRET_CHANGED: the address of connection ${connectionId} carries a secret that the app secret no longer gives, it is registered again`,
      );

    const removed = await api.remove(
      connectionId,
      registered.flatMap((other) =>
        other.jiraWebhookId === null ? [] : [other.jiraWebhookId],
      ),
    );
    if (!removed.ok) {
      log(
        `[jira] JIRA_WEBHOOK_ADDRESS_MOVE_FAILED: ${removed.error} (connection ${connectionId}, ${legacy ? "per-project addresses" : "rotation"})`,
      );
      return results;
    }
    // A move that does not happen (another reconcile moved first) leaves the rows as that one made them: nothing of theirs is touched.
    const moved = await webhooks.moveToSharedAddress(connectionId, {
      rotate,
      expectedGeneration: endpoint.generation,
      errorCode: MOVE_PENDING_CODE,
    });
    if (!moved) return results;
    // The gap without a webhook starts here: the first registration alone (it fixes the address at Jira), the others together.
    const pending = (await webhooks.list()).filter(
      (other) =>
        other.connectionId === connectionId && other.status === "pending",
    );
    const [first, ...others] = pending;
    if (first === undefined) return results;
    const outcomes = new Map<string, ReconcileResult>();
    outcomes.set(first.id, await register(first, retryDelays));
    await Promise.all(
      others.map(async (other) => {
        outcomes.set(other.id, await register(other, retryDelays));
      }),
    );
    for (const [id, outcome] of outcomes) {
      results.set(id, outcome);
      if (outcome.outcome === "failed")
        log(
          `[jira] JIRA_WEBHOOK_MOVE_REGISTER_FAILED: ${outcome.error ?? "unknown"} (connection ${connectionId}); the row stays pending and the next run tries again`,
        );
    }
    return results;
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
        });
        // Undefined: the connection is none of this workspace's, or another reconcile made the row meanwhile.
        if (created === undefined) {
          const meanwhile = await webhooks.getByProject(projectId);
          if (meanwhile === undefined)
            return { outcome: "failed", error: "jira_connection_not_found" };
          return { outcome: "unchanged" };
        }
        row = created;
      }
      // The connection first: its webhooks share one address, and a project cannot register next to one that has another.
      const settled = await settleAddress(wanted.connectionId);
      const done = settled.get(row.id);
      if (done !== undefined) return done;
      const current = (await webhooks.getByProject(projectId)) ?? row;
      return current.status === "pending" ? register(current) : extend(current);
    },
  };
}
