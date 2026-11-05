// SPDX-License-Identifier: LicenseRef-Proprietary

// The conversation of an Implementer session (#839, follow-up turns), kept so that a later turn can import it into a new VM.
//
//  - `implementer_session_snapshots`: ONE row for each session, replaced by the snapshot of each turn. `data` is the engine's
//    export as the runner made it (JSON, secrets taken out, gzipped), as base64 text: the schema is text and integers only, the same
//    on both engines (`src/db/README.md`, "Portable schema conventions"); a snapshot is at most 8 MiB gzipped, so at most about 10.7 MB
//    of text, TOASTed by the database (out of line and uncompressed: `set storage external`). `turn_number` and `job_id` say which turn it came from and `opencode_version` which engine
//    wrote it (the import is tried whatever the version is; the version is what a failed import is explained with). `bytes` is the
//    size of the gzip file, `raw_bytes` of the JSON inside it, `sha256` the digest of the gzip file.
//  - `implementer_session_snapshot_parts`: where an upload waits until it is whole. A snapshot arrives in parts (a function of the
//    platform takes no request body over 4.5 MB, and a snapshot can be 8 MiB), and the old snapshot stays readable until the new one
//    is whole and checked, so the parts of a running upload are kept apart, keyed by the job and the index of the part. They are
//    deleted when the snapshot is swapped in; the parts of an upload that never finished are deleted by the next upload of the session (or the erasure of the workspace); they
//    are not deleted when the turn's result is delivered.
//
// Nothing here is ever deleted for its age (owner's decision of 2026-11-04: the stored conversation is kept for good); the erasure of
// a workspace removes both tables before the turns, the sessions and the jobs.
//
// The database keeps the workspaces apart, as the other Implementer tables do: the rows name their session and their job with
// composite keys `(session_id, workspace_id)` and `(job_id, workspace_id)` (the unique indexes `implementer_sessions_id_workspace_unique`
// of #751 and `jobs_id_workspace_unique` are their targets).
//
// Expand only, safe for the version that is still running (it never reads the tables) and for the live database:
//  - two tables and one index are added; no column, row or index of an existing table changes;
//  - the tables are created without their links, and the links are added last, so the migration waits for a writer on `workspaces`
//    first (holding nothing on `jobs` or `implementer_sessions`, so the queue goes on) and takes the short locks at the end. The wait
//    is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`, nothing half
//    applied) and the deployment can simply be run again;
//  - the tables are empty, so the index and the foreign keys scan nothing.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. Exported for the test that holds a writer open. */
export const LOCK_TIMEOUT = "5s";

export const migration: Migration = {
  async up(db) {
    // `set local` ends with the transaction, but the migrations after this one in the same batch run in it too: put back what was set.
    const { rows } = await sql<{
      value: string;
    }>`select current_setting('lock_timeout') as value`.execute(db);
    const before = rows[0]?.value ?? "0";
    await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

    await db.schema
      .createTable("implementer_session_snapshots")
      .addColumn("session_id", "text", (column) => column.primaryKey())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("turn_number", "integer", (column) => column.notNull())
      .addColumn("opencode_version", "text", (column) => column.notNull())
      .addColumn("bytes", "integer", (column) => column.notNull())
      .addColumn("raw_bytes", "integer", (column) => column.notNull())
      .addColumn("sha256", "text", (column) => column.notNull())
      .addColumn("data", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addCheckConstraint(
        "implementer_session_snapshots_turn_check",
        sql`turn_number >= 1`,
      )
      .addCheckConstraint(
        "implementer_session_snapshots_version_check",
        sql`opencode_version ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$'`,
      )
      .addCheckConstraint(
        "implementer_session_snapshots_bytes_check",
        sql`bytes >= 1 and raw_bytes >= 1`,
      )
      .addCheckConstraint(
        "implementer_session_snapshots_sha256_check",
        sql`sha256 ~ '^[0-9a-f]{64}$'`,
      )
      .execute();

    await db.schema
      .createTable("implementer_session_snapshot_parts")
      .addColumn("job_id", "text", (column) => column.notNull())
      .addColumn("part_index", "integer", (column) => column.notNull())
      .addColumn("workspace_id", "text", (column) =>
        column.notNull().references("workspaces.id"),
      )
      .addColumn("session_id", "text", (column) => column.notNull())
      .addColumn("part_count", "integer", (column) => column.notNull())
      .addColumn("opencode_version", "text", (column) => column.notNull())
      .addColumn("bytes", "integer", (column) => column.notNull())
      .addColumn("raw_bytes", "integer", (column) => column.notNull())
      .addColumn("sha256", "text", (column) => column.notNull())
      .addColumn("data", "text", (column) => column.notNull())
      .addColumn("created_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("implementer_session_snapshot_parts_pkey", [
        "job_id",
        "part_index",
      ])
      .addCheckConstraint(
        "implementer_session_snapshot_parts_index_check",
        sql`part_index >= 0 and part_count >= 1 and part_index < part_count`,
      )
      .execute();

    // The bytes are base64 of a gzip file: the database's own compression (pglz) would spend CPU for nothing, so they are kept
    // out of line and as they are (`external`), which also makes a read of a part's description never touch them.
    await sql`alter table implementer_session_snapshots alter column data set storage external`.execute(
      db,
    );
    await sql`alter table implementer_session_snapshot_parts alter column data set storage external`.execute(
      db,
    );

    // Deleting the parts of the other uploads of a session when a new one starts.
    await db.schema
      .createIndex("implementer_session_snapshot_parts_session_index")
      .on("implementer_session_snapshot_parts")
      .columns(["session_id", "job_id"])
      .execute();

    // The links, last because they need locks on the tables they point at. The tables are empty.
    await db.schema
      .alterTable("implementer_session_snapshots")
      .addForeignKeyConstraint(
        "implementer_session_snapshots_session_fk",
        ["session_id", "workspace_id"],
        "implementer_sessions",
        ["id", "workspace_id"],
      )
      .execute();
    await db.schema
      .alterTable("implementer_session_snapshots")
      .addForeignKeyConstraint(
        "implementer_session_snapshots_job_fk",
        ["job_id", "workspace_id"],
        "jobs",
        ["id", "workspace_id"],
      )
      .execute();
    await db.schema
      .alterTable("implementer_session_snapshot_parts")
      .addForeignKeyConstraint(
        "implementer_session_snapshot_parts_session_fk",
        ["session_id", "workspace_id"],
        "implementer_sessions",
        ["id", "workspace_id"],
      )
      .execute();
    await db.schema
      .alterTable("implementer_session_snapshot_parts")
      .addForeignKeyConstraint(
        "implementer_session_snapshot_parts_job_fk",
        ["job_id", "workspace_id"],
        "jobs",
        ["id", "workspace_id"],
      )
      .execute();

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("implementer_session_snapshot_parts").execute();
    await db.schema.dropTable("implementer_session_snapshots").execute();
  },
};
