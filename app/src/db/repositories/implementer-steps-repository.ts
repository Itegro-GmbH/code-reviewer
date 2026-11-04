// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the steps of the turns of ONE workspace (the table `implementer_turn_steps`; the factory takes the workspace id, see
// ../workspace-scope.ts): what the agent thought and did, one row for each part, keyed by `(job_id, part_id)` (#745, live view).
// The runner sends a part again when it changes; the row keeps the highest `seq` it has seen, so a retry, or a batch that
// arrives behind a newer one, changes nothing. A row of another workspace is simply not there.
//
// The write proves the claim in the same transaction that stores the rows: the job must be a running turn of the Implementer of
// this workspace with this lease token. It does NOT extend the lease (only the heartbeat does). The caps of a turn are kept
// here, so no caller can skip them: at most `MAX_STEPS_PER_TURN` parts and `MAX_STEP_BYTES_PER_TURN` bytes of payload. A record
// past a cap is dropped and counted, never stored; a part that is already there may still change while the bytes allow it.
import "server-only";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { encodeJson, formatTimestamp, tryDecodeJson } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** The most parts a turn keeps. The runner stops at 15,000 (5,000 in full and 10,000 as name and status). */
export const MAX_STEPS_PER_TURN = 16_000;

/** The most payload a turn keeps, in bytes of JSON text. The runner stops at 2 MiB of text and about 1 MiB of short records. */
export const MAX_STEP_BYTES_PER_TURN = 6 * 1024 * 1024;

/** A record to store: `payload` is the record without `kind`, `partId` and `seq`, already cleaned by the caller. */
export type StepWrite = {
  partId: string;
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
};

/** A stored part as the rest of the app sees it. Timestamps are ISO 8601 text in UTC. */
export type StoredStep = {
  partId: string;
  seq: number;
  /** The `seq` of the first record of the part: the order the page shows the parts in. */
  ordinal: number;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type RecordStepsResult =
  /** The job is not a running turn of the Implementer of this workspace with this lease token: nothing is stored. */
  | { status: "not_holder" }
  | {
      status: "ok";
      /** Records that made or changed a row. */
      stored: number;
      /** Records that did not, because the part holds a record with an equal or higher `seq`. */
      stale: number;
      /** Records past a cap of the turn. */
      dropped: number;
    };

export type ImplementerStepsRepository = {
  /**
   * Stores a batch for the running turn `jobId` held with `leaseToken`. The higher `seq` of a part wins, whatever the order the
   * records come in, also within one batch. Idempotent: the same batch again stores nothing.
   */
  recordSteps(
    jobId: string,
    leaseToken: string,
    records: readonly StepWrite[],
  ): Promise<RecordStepsResult>;
  /** The parts of the turn with a `seq` above `afterSeq`, in the order of their `seq`, at most `limit`. */
  listAfter(
    jobId: string,
    afterSeq: number,
    limit: number,
  ): Promise<StoredStep[]>;
};

/** The document of a stored payload; what is not a JSON object (never written by this repository) reads as empty. */
function parsePayload(text: string): Record<string, unknown> {
  const decoded = tryDecodeJson<unknown>(text);
  return decoded.ok &&
    typeof decoded.value === "object" &&
    decoded.value !== null &&
    !Array.isArray(decoded.value)
    ? (decoded.value as Record<string, unknown>)
    : {};
}

export function createImplementerStepsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): ImplementerStepsRepository {
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  return {
    recordSteps(jobId, leaseToken, records) {
      return inTransaction<RecordStepsResult>(async (trx) => {
        // A share lock: a result that ends the turn at the same moment waits for this batch (or this batch for it), so a batch
        // never lands after the turn has ended on a lease it checked before.
        const held = await trx
          .selectFrom("jobs")
          .select("id")
          .where("id", "=", jobId)
          .where("workspace_id", "=", workspaceId)
          .where("lease_token", "=", leaseToken)
          .where("status", "=", "running")
          .where("review_kind", "=", "implementer")
          .forShare()
          .executeTakeFirst();
        if (held === undefined) return { status: "not_holder" };

        const totals = await sql<{
          rows: number;
          bytes: number;
        }>`select count(*)::int as rows, coalesce(sum(bytes), 0)::int as bytes
            from implementer_turn_steps
            where job_id = ${jobId} and workspace_id = ${workspaceId}`.execute(
          trx,
        );
        let rowCount = totals.rows[0]?.rows ?? 0;
        let byteCount = totals.rows[0]?.bytes ?? 0;

        const known = new Map<string, { seq: number; bytes: number }>();
        if (records.length > 0) {
          const existing = await trx
            .selectFrom("implementer_turn_steps")
            .select(["part_id", "seq", "bytes"])
            .where("job_id", "=", jobId)
            .where("workspace_id", "=", workspaceId)
            .where("part_id", "in", [
              ...new Set(records.map((record) => record.partId)),
            ])
            .execute();
          for (const row of existing)
            known.set(row.part_id, { seq: row.seq, bytes: row.bytes });
        }

        // The decision for each part: the record that wins within the batch and against the stored row, and whether the caps of
        // the turn leave room for it. Records are looked at in the order they came in; a later one with a higher `seq` replaces
        // the earlier one of its part (its bytes replace the earlier ones, so the caps count the final state).
        type Chosen = StepWrite & { json: string; bytes: number };
        const chosen = new Map<string, Chosen>();
        let stale = 0;
        let dropped = 0;
        for (const record of records) {
          const current = known.get(record.partId);
          if (current !== undefined && record.seq <= current.seq) {
            stale += 1;
            continue;
          }
          const json = encodeJson(record.payload);
          const bytes = Buffer.byteLength(json, "utf8");
          const growth = bytes - (current?.bytes ?? 0);
          if (current === undefined && rowCount >= MAX_STEPS_PER_TURN) {
            dropped += 1;
            continue;
          }
          if (byteCount + growth > MAX_STEP_BYTES_PER_TURN) {
            dropped += 1;
            continue;
          }
          if (current === undefined) rowCount += 1;
          byteCount += growth;
          known.set(record.partId, { seq: record.seq, bytes });
          // The part had a record in this batch already: it is replaced, and stored once.
          if (chosen.has(record.partId)) stale += 1;
          chosen.set(record.partId, { ...record, json, bytes });
        }

        if (chosen.size === 0)
          return { status: "ok", stored: 0, stale, dropped };

        const timestamp = formatTimestamp(now());
        // The guard on `seq` is in the statement too: another batch of the same turn may have stored a higher `seq` since the
        // rows were read, and it must not be overwritten.
        const written = await trx
          .insertInto("implementer_turn_steps")
          .values(
            [...chosen.values()].map((record) => ({
              job_id: jobId,
              part_id: record.partId,
              workspace_id: workspaceId,
              seq: record.seq,
              ordinal: record.seq,
              kind: record.kind,
              payload: record.json,
              bytes: record.bytes,
              created_at: timestamp,
              updated_at: timestamp,
            })),
          )
          .onConflict((conflict) =>
            conflict
              .columns(["job_id", "part_id"])
              .doUpdateSet((eb) => ({
                seq: eb.ref("excluded.seq"),
                kind: eb.ref("excluded.kind"),
                payload: eb.ref("excluded.payload"),
                bytes: eb.ref("excluded.bytes"),
                updated_at: eb.ref("excluded.updated_at"),
              }))
              .where((eb) =>
                eb.and([
                  eb("implementer_turn_steps.seq", "<", eb.ref("excluded.seq")),
                  eb("implementer_turn_steps.workspace_id", "=", workspaceId),
                ]),
              ),
          )
          .returning("part_id")
          .execute();
        return {
          status: "ok",
          stored: written.length,
          stale: stale + (chosen.size - written.length),
          dropped,
        };
      });
    },

    async listAfter(jobId, afterSeq, limit) {
      const rows = await db
        .selectFrom("implementer_turn_steps")
        .selectAll()
        .where("job_id", "=", jobId)
        .where("workspace_id", "=", workspaceId)
        .where("seq", ">", afterSeq)
        .orderBy("seq")
        .limit(limit)
        .execute();
      return rows.map((row) => ({
        partId: row.part_id,
        seq: row.seq,
        ordinal: row.ordinal,
        kind: row.kind,
        payload: parsePayload(row.payload),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },
  };
}
