// SPDX-License-Identifier: LicenseRef-Proprietary

// How a dispatcher learns of a job (#972, Runner v2): the delivery a runner announced (`runners.delivery_*`) and where the doorbell of
// each (job, dispatcher) pair stands (`runner_job_dispatches`). The platform's own dispatcher keeps `job_dispatches`, one row per job,
// and its address and key come from the app's settings (`RUNNER_WEBHOOK_URL` and the signing secret), which is the seed of its delivery.
//
// Expand only, safe for the version that is still running and for the live database: four columns on `runners` with a default (`poll`,
// what every runner that exists does) or without one (null), which Postgres adds without rewriting the table, and a new, empty table
// nothing of the previous release reads. The secret of a webhook delivery is the sealed JSON of `src/crypto/secret-box.ts`, never the
// secret itself.
//
// The wait for the lock is bounded: after `LOCK_TIMEOUT` the migration gives up, the whole batch is rolled back (`MIGRATION_FAILED`) and
// the deployment can simply be run again. `down` drops what `up` made.
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
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
      .alterTable("runners")
      .addColumn("delivery_mode", "text", (column) =>
        column.notNull().defaultTo("poll"),
      )
      .addColumn("delivery_url", "text")
      .addColumn("delivery_key_id", "text")
      .addColumn("delivery_secret", "text")
      .execute();

    await db.schema
      .createTable("runner_job_dispatches")
      .addColumn("job_id", "text", (column) =>
        column.notNull().references("jobs.id").onDelete("cascade"),
      )
      .addColumn("runner_id", "text", (column) =>
        column.notNull().references("runners.id").onDelete("cascade"),
      )
      .addColumn("state", "text", (column) =>
        column.notNull().defaultTo("pending"),
      )
      .addColumn("attempts", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("consecutive_failures", "integer", (column) =>
        column.notNull().defaultTo(0),
      )
      .addColumn("next_dispatch_at", "text", (column) => column.notNull())
      .addColumn("acked_at", "text")
      .addColumn("last_attempt_at", "text")
      .addColumn("last_status", "integer")
      .addColumn("last_code", "text")
      .addColumn("created_at", "text", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .addPrimaryKeyConstraint("runner_job_dispatches_pkey", [
        "job_id",
        "runner_id",
      ])
      .addCheckConstraint(
        "runner_job_dispatches_state_check",
        sql`state in ('pending', 'acked', 'stopped')`,
      )
      .addCheckConstraint(
        "runner_job_dispatches_counts_check",
        sql`attempts >= 0 and consecutive_failures >= 0`,
      )
      .execute();

    // The sweep looks for the rows that are due; a stopped row never is.
    await db.schema
      .createIndex("runner_job_dispatches_due")
      .on("runner_job_dispatches")
      .column("next_dispatch_at")
      .where(sql.ref("state"), "<>", "stopped")
      .execute();
    // The foreign key to the runner is looked at when a runner goes, and the doorbells of one dispatcher are listed by it.
    await db.schema
      .createIndex("runner_job_dispatches_runner")
      .on("runner_job_dispatches")
      .column("runner_id")
      .execute();

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await db.schema.dropTable("runner_job_dispatches").execute();
    await db.schema
      .alterTable("runners")
      .dropColumn("delivery_mode")
      .dropColumn("delivery_url")
      .dropColumn("delivery_key_id")
      .dropColumn("delivery_secret")
      .execute();
  },
};
