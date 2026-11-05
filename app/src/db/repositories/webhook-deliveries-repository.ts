// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the webhook_deliveries table: the record of which deliveries were accepted, so that a
// redelivery of a delivery that already succeeded does not produce a second trigger. The only code
// that reads or writes the table.
//
// GitHub's "Redeliver" sends the same `X-GitHub-Delivery` id again, so the id is also how a manual
// retry reaches the app. That decides the rules:
//
// - `claim` inserts the row with the outcome "processing" and returns a token that proves ownership.
//   Only the owner can `complete` or `release` the claim, so a request that stalled past its lease
//   cannot overwrite the claim of the request that took over.
// - Only the outcomes in `WEBHOOK_DELIVERY_FINAL_OUTCOMES` (a trigger was handed over, an
//   installation was synchronized) make the id a duplicate. Every other outcome is recorded for
//   diagnostics, but the id can be claimed again: a delivery that was turned away for a reason that
//   can change (the installation was not known yet, write access is granted later) is repaired by
//   redelivering it.
// - A request that arrives while another one holds a fresh claim gets "in_progress", not
//   "duplicate": the first one may still fail and release, and GitHub must then see a failed
//   delivery it can redeliver.
// - A claim that is neither completed nor released (the request died) can be taken over once its
//   lease ran out.
// - Rows older than 7 days are pruned, at most every 10 minutes per process.
import "server-only";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";

/** How long a delivery is remembered. GitHub keeps redeliveries available for about three days. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 7;

/** The retention `DELETE` runs at most this often per database connection. */
export const WEBHOOK_DELIVERY_PRUNE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * How long a claim without an outcome counts as "being processed". Longer than any request can
 * take, so only a request that died leaves a claim that runs out.
 */
export const WEBHOOK_DELIVERY_PROCESSING_LEASE_MS = 5 * 60 * 1000;

/** What came of a delivery. Stored in the database, so a value is never renamed or reused. */
export const WEBHOOK_DELIVERY_OUTCOMES = [
  /** Claimed, not finished (the only state of a row that is still being handled). */
  "processing",
  /** Genuine, but nothing to do for it (an irrelevant action, an unidentified installation). */
  "ignored",
  /** The installation is not known and the delivery cannot introduce it. */
  "unknown_installation",
  /** The installation is suspended or removed, so its pull requests are not reviewed. */
  "integration_disabled",
  /** The platform said the actor may not start a review. */
  "trigger_not_allowed",
  /** The repository has no active project, so nothing is reviewed. */
  "project_not_active",
  /** A comment command that the project's settings do not allow. */
  "command_not_allowed",
  /** A review trigger was handed to the intake. */
  "trigger_enqueued",
  /** A pull request event that starts no review (a draft, a closed pull request, a setting, a stale commit). */
  "trigger_skipped",
  /** A pull request was closed and the jobs waiting for it were dropped. */
  "waiting_jobs_discarded",
  /** An issue got a label and the workflows started by it have their runs (#845). */
  "workflow_runs_started",
  /** An issue got a label and no workflow starts for it (not final: a workflow saved later is started by a redelivery). */
  "no_workflow_matched",
  /** The installation or its repositories were synchronized. */
  "installation_changed",
  /** An installation no workspace has linked: noted as unclaimed, nothing was created (not final: it can be redelivered). */
  "installation_unclaimed",
] as const;
export type WebhookDeliveryOutcome = (typeof WEBHOOK_DELIVERY_OUTCOMES)[number];

/** The outcomes after which the same delivery id is a duplicate. */
export const WEBHOOK_DELIVERY_FINAL_OUTCOMES = [
  "trigger_enqueued",
  "workflow_runs_started",
  "installation_changed",
] as const satisfies readonly WebhookDeliveryOutcome[];

export type WebhookDeliveryClaim =
  | { status: "claimed"; token: string }
  /** The delivery succeeded before; there is nothing to do. */
  | { status: "duplicate" }
  /** Another request is handling the delivery right now. */
  | { status: "in_progress" };

export type WebhookDeliveriesRepository = {
  /** Claims the delivery for this request, or says why it cannot. Also prunes old rows now and then. */
  claim(deliveryId: string, event: string): Promise<WebhookDeliveryClaim>;
  /** Records what came of a claimed delivery. Does nothing unless `token` owns the claim. */
  complete(
    deliveryId: string,
    token: string,
    outcome: Exclude<WebhookDeliveryOutcome, "processing">,
  ): Promise<void>;
  /** Removes a claim without an outcome. Does nothing unless `token` owns the claim. */
  release(deliveryId: string, token: string): Promise<void>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// One timestamp per connection, shared by every repository object made for it (the route makes a new
// one per request).
const lastPruned = new WeakMap<object, number>();

export function createWebhookDeliveriesRepository(
  db: Kysely<Database>,
  now: () => Date = () => new Date(),
  newToken: () => string = () => crypto.randomUUID(),
): WebhookDeliveriesRepository {
  async function pruneIfDue(current: Date) {
    const previous = lastPruned.get(db);
    if (
      previous !== undefined &&
      current.getTime() - previous < WEBHOOK_DELIVERY_PRUNE_INTERVAL_MS
    )
      return;
    lastPruned.set(db, current.getTime());
    await db
      .deleteFrom("webhook_deliveries")
      .where(
        "received_at",
        "<",
        formatTimestamp(
          new Date(
            current.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * DAY_MS,
          ),
        ),
      )
      .execute();
  }

  return {
    async claim(deliveryId, event) {
      const current = now();
      await pruneIfDue(current);
      const token = newToken();
      const timestamp = formatTimestamp(current);

      // Each statement is a single, atomic write: of several simultaneous requests exactly one
      // inserts, and exactly one takes over a row that may be claimed again.
      const inserted = await db
        .insertInto("webhook_deliveries")
        .values({
          delivery_id: deliveryId,
          event,
          outcome: "processing",
          claim_token: token,
          received_at: timestamp,
        })
        .onConflict((conflict) => conflict.column("delivery_id").doNothing())
        .executeTakeFirst();
      if (Number(inserted.numInsertedOrUpdatedRows) > 0)
        return { status: "claimed", token };

      const leaseEnds = formatTimestamp(
        new Date(current.getTime() - WEBHOOK_DELIVERY_PROCESSING_LEASE_MS),
      );
      const takenOver = await db
        .updateTable("webhook_deliveries")
        .set({
          event,
          outcome: "processing",
          claim_token: token,
          received_at: timestamp,
        })
        .where("delivery_id", "=", deliveryId)
        .where("outcome", "not in", [...WEBHOOK_DELIVERY_FINAL_OUTCOMES])
        .where((eb) =>
          eb.not(
            eb.and([
              eb("outcome", "=", "processing"),
              eb("received_at", ">=", leaseEnds),
            ]),
          ),
        )
        .executeTakeFirst();
      if (Number(takenOver.numUpdatedRows) > 0)
        return { status: "claimed", token };

      const row = await db
        .selectFrom("webhook_deliveries")
        .select("outcome")
        .where("delivery_id", "=", deliveryId)
        .executeTakeFirst();
      // A row that vanished was released a moment ago by the request that held it.
      return row === undefined || row.outcome === "processing"
        ? { status: "in_progress" }
        : { status: "duplicate" };
    },

    async complete(deliveryId, token, outcome) {
      await db
        .updateTable("webhook_deliveries")
        .set({ outcome })
        .where("delivery_id", "=", deliveryId)
        .where("claim_token", "=", token)
        .where("outcome", "=", "processing")
        .execute();
    },

    async release(deliveryId, token) {
      await db
        .deleteFrom("webhook_deliveries")
        .where("delivery_id", "=", deliveryId)
        .where("claim_token", "=", token)
        .where("outcome", "=", "processing")
        .execute();
    },
  };
}
