// SPDX-License-Identifier: LicenseRef-Proprietary

// Access to the session snapshots of ONE workspace (the tables `implementer_session_snapshots` and `implementer_session_snapshot_parts`;
// the factory takes the workspace id, see ../workspace-scope.ts): the conversation of an Implementer session, kept so that a later turn
// can import it into a new VM (#839, follow-up turns). A row of another workspace is simply not there.
//
// One snapshot for each session, replaced by the snapshot of each turn, and **never deleted** otherwise (owner's decision of
// 2026-11-04); the erasure of a workspace is the one way a snapshot goes. It arrives in parts (`recordPart`): every part is kept
// apart until the last one is in, then the parts are put together, checked against the size and digest the runner announced, and swapped
// in for the old snapshot in the same transaction, so a reader sees the old snapshot or the new one and never half of one.
//
// The write proves the claim in the transaction that stores: the job must be a running turn of the Implementer of this workspace with
// this lease token (the job row is locked `FOR NO KEY UPDATE`, like the steps), and it does NOT extend the lease. The parts of one
// turn therefore take turns. The data is base64 text (the schema holds text and integers only); a part's base64 is decoded when the
// parts are put together, so nothing depends on where a part is cut.
import "server-only";
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { formatTimestamp } from "../codecs.ts";
import type { Database } from "../schema.ts";
import type { WorkspaceId } from "../workspace-scope.ts";

/** One part of an upload: the description of the whole file and the bytes of this part. */
export type SnapshotPartWrite = {
  index: number;
  count: number;
  /** The size of the whole gzip file. */
  size: number;
  /** The size of the JSON inside it. */
  rawBytes: number;
  /** Hex digest of the whole gzip file. */
  sha256: string;
  opencodeVersion: string;
  data: Uint8Array;
};

export type RecordPartResult =
  /** The job is not a running turn of the Implementer of this workspace with this lease token: nothing is stored. */
  | { status: "not_holder" }
  /** The job has no turn (never the case for a turn of the Implementer): nothing is stored. */
  | { status: "no_session" }
  /** The parts do not agree with each other, or do not make the file they announce: nothing of this upload is kept. */
  | { status: "invalid" }
  | {
      status: "ok";
      /** True once the snapshot is whole and stored (also for a part sent again after that). */
      complete: boolean;
    };

/** A stored snapshot without its bytes. Timestamps are ISO 8601 text in UTC. */
export type StoredSessionSnapshot = {
  sessionId: string;
  /** The turn it came from. */
  jobId: string;
  turnNumber: number;
  opencodeVersion: string;
  /** The size of the gzip file, and of the JSON inside it. */
  bytes: number;
  rawBytes: number;
  sha256: string;
  createdAt: string;
  updatedAt: string;
};

export type ImplementerSnapshotsRepository = {
  /**
   * Stores one part of the snapshot of the running turn `jobId` held with `leaseToken`. When it is the last one missing, the snapshot is
   * put together, checked and swapped in for the session's old one. Idempotent: a part sent again changes nothing.
   */
  recordPart(
    jobId: string,
    leaseToken: string,
    part: SnapshotPartWrite,
  ): Promise<RecordPartResult>;
  /** The snapshot of a session without its bytes, or undefined. */
  find(sessionId: string): Promise<StoredSessionSnapshot | undefined>;
  /** The snapshot of a session with its gzip file, or undefined. */
  read(
    sessionId: string,
  ): Promise<{ snapshot: StoredSessionSnapshot; data: Uint8Array } | undefined>;
};

function describe(row: {
  session_id: string;
  job_id: string;
  turn_number: number;
  opencode_version: string;
  bytes: number;
  raw_bytes: number;
  sha256: string;
  created_at: string;
  updated_at: string;
}): StoredSessionSnapshot {
  return {
    sessionId: row.session_id,
    jobId: row.job_id,
    turnNumber: row.turn_number,
    opencodeVersion: row.opencode_version,
    bytes: row.bytes,
    rawBytes: row.raw_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createImplementerSnapshotsRepository(
  db: Kysely<Database>,
  workspaceId: WorkspaceId,
  now: () => Date = () => new Date(),
): ImplementerSnapshotsRepository {
  function inTransaction<T>(
    run: (executor: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    return db.isTransaction ? run(db) : db.transaction().execute(run);
  }

  return {
    recordPart(jobId, leaseToken, part) {
      return inTransaction<RecordPartResult>(async (trx) => {
        // The lock that does not block the foreign keys of the rows being inserted, and conflicts with itself: the parts of one turn
        // take turns, so "the last part missing" is decided on what the parts before have committed. A result, a heartbeat or the
        // reaper updating the job waits for this transaction (or this one for it), so a part never lands after the turn has ended on
        // a lease it checked before.
        const held = await trx
          .selectFrom("jobs")
          .select("id")
          .where("id", "=", jobId)
          .where("workspace_id", "=", workspaceId)
          .where("lease_token", "=", leaseToken)
          .where("status", "=", "running")
          .where("review_kind", "=", "implementer")
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (held === undefined) return { status: "not_holder" };
        const turn = await trx
          .selectFrom("implementer_turns")
          .select(["session_id", "number"])
          .where("job_id", "=", jobId)
          .where("workspace_id", "=", workspaceId)
          .executeTakeFirst();
        if (turn === undefined) return { status: "no_session" };

        const stored = await trx
          .selectFrom("implementer_session_snapshots")
          .select(["job_id", "sha256", "turn_number"])
          .where("session_id", "=", turn.session_id)
          .where("workspace_id", "=", workspaceId)
          .executeTakeFirst();
        // The snapshot of this very turn is already in: a part that is sent again after the last one made it whole.
        if (
          stored !== undefined &&
          stored.job_id === jobId &&
          stored.sha256 === part.sha256
        )
          return { status: "ok", complete: true };

        // An upload that never finished (a turn that ended in the middle of it) leaves parts behind; a session has one running turn
        // at a time, so the parts of any other job of this session are stale.
        await trx
          .deleteFrom("implementer_session_snapshot_parts")
          .where("session_id", "=", turn.session_id)
          .where("workspace_id", "=", workspaceId)
          .where("job_id", "!=", jobId)
          .execute();

        const timestamp = formatTimestamp(now());
        await trx
          .insertInto("implementer_session_snapshot_parts")
          .values({
            job_id: jobId,
            part_index: part.index,
            workspace_id: workspaceId,
            session_id: turn.session_id,
            part_count: part.count,
            opencode_version: part.opencodeVersion,
            bytes: part.size,
            raw_bytes: part.rawBytes,
            sha256: part.sha256,
            data: Buffer.from(part.data).toString("base64"),
            created_at: timestamp,
          })
          .onConflict((conflict) =>
            conflict.columns(["job_id", "part_index"]).doUpdateSet((eb) => ({
              part_count: eb.ref("excluded.part_count"),
              opencode_version: eb.ref("excluded.opencode_version"),
              bytes: eb.ref("excluded.bytes"),
              raw_bytes: eb.ref("excluded.raw_bytes"),
              sha256: eb.ref("excluded.sha256"),
              data: eb.ref("excluded.data"),
            })),
          )
          .execute();

        const parts = await trx
          .selectFrom("implementer_session_snapshot_parts")
          .selectAll()
          .where("job_id", "=", jobId)
          .where("workspace_id", "=", workspaceId)
          .orderBy("part_index")
          .execute();
        const agree = parts.every(
          (row) =>
            row.part_count === part.count &&
            row.bytes === part.size &&
            row.raw_bytes === part.rawBytes &&
            row.sha256 === part.sha256 &&
            row.opencode_version === part.opencodeVersion,
        );
        if (!agree) {
          await trx
            .deleteFrom("implementer_session_snapshot_parts")
            .where("job_id", "=", jobId)
            .where("workspace_id", "=", workspaceId)
            .execute();
          return { status: "invalid" };
        }
        if (parts.length < part.count) return { status: "ok", complete: false };

        const whole = Buffer.concat(
          parts.map((row) => Buffer.from(row.data, "base64")),
        );
        const sound =
          parts.every((row, position) => row.part_index === position) &&
          whole.byteLength === part.size &&
          createHash("sha256").update(whole).digest("hex") === part.sha256;
        await trx
          .deleteFrom("implementer_session_snapshot_parts")
          .where("job_id", "=", jobId)
          .where("workspace_id", "=", workspaceId)
          .execute();
        if (!sound) return { status: "invalid" };

        // An older turn never replaces a newer snapshot (a session has one running turn, so this is a second line of defence).
        if (stored === undefined || stored.turn_number <= turn.number)
          await trx
            .insertInto("implementer_session_snapshots")
            .values({
              session_id: turn.session_id,
              workspace_id: workspaceId,
              job_id: jobId,
              turn_number: turn.number,
              opencode_version: part.opencodeVersion,
              bytes: part.size,
              raw_bytes: part.rawBytes,
              sha256: part.sha256,
              data: whole.toString("base64"),
              created_at: timestamp,
              updated_at: timestamp,
            })
            .onConflict((conflict) =>
              conflict
                .column("session_id")
                .doUpdateSet((eb) => ({
                  job_id: eb.ref("excluded.job_id"),
                  turn_number: eb.ref("excluded.turn_number"),
                  opencode_version: eb.ref("excluded.opencode_version"),
                  bytes: eb.ref("excluded.bytes"),
                  raw_bytes: eb.ref("excluded.raw_bytes"),
                  sha256: eb.ref("excluded.sha256"),
                  data: eb.ref("excluded.data"),
                  updated_at: eb.ref("excluded.updated_at"),
                }))
                .where((eb) =>
                  eb.and([
                    eb(
                      "implementer_session_snapshots.workspace_id",
                      "=",
                      workspaceId,
                    ),
                    eb(
                      "implementer_session_snapshots.turn_number",
                      "<=",
                      eb.ref("excluded.turn_number"),
                    ),
                  ]),
                ),
            )
            .execute();
        return { status: "ok", complete: true };
      });
    },

    async find(sessionId) {
      const row = await db
        .selectFrom("implementer_session_snapshots")
        .select([
          "session_id",
          "job_id",
          "turn_number",
          "opencode_version",
          "bytes",
          "raw_bytes",
          "sha256",
          "created_at",
          "updated_at",
        ])
        .where("session_id", "=", sessionId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined ? undefined : describe(row);
    },

    async read(sessionId) {
      const row = await db
        .selectFrom("implementer_session_snapshots")
        .selectAll()
        .where("session_id", "=", sessionId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { snapshot: describe(row), data: Buffer.from(row.data, "base64") };
    },
  };
}
