// SPDX-License-Identifier: LicenseRef-Proprietary

// A hosted runner has a **placement** (#1158, epic #1157): where its VM runs, on the Vercel Sandbox as every hosted runner did, or on a Cloudflare
// Container. The row of a hosted runner (`implementer_environments` with a `concurrency`) gets the column `placement`, `vercel` for every row that
// exists, and the unique index that held one hosted runner for each type and workspace becomes one for each workspace, placement and size, so
// a Cloudflare runner of 4 vCPU can stand beside the Vercel one. The Cloudflare rows are made by the app (`ensureHostedRunners`) only for the
// sizes the operator enabled (`CLOUDFLARE_RUNNER_SIZES`); this migration makes none.
//
// Expand only, with one window that is accepted: the release that is still running while this one starts never reads the column. It writes a
// hosted row only when a type is missing (`ensureHostedRunners`, the self-repair, with `on conflict (workspace_id, vcpus) where concurrency is not
// null`); that statement needs the old index, which is dropped here, so for the minutes of a rollout such a repair fails (the reader gets an
// error, and the next read after the rollout repairs it). No Cloudflare row exists before the operator sets `CLOUDFLARE_RUNNER_SIZES`, which is after
// the rollout, so the old release never meets a second row of one size. `alter table` takes a short exclusive lock; the wait is bounded and
// the batch rolls back if it is not had (`MIGRATION_FAILED`), so the deployment can simply be run again. The column has a constant default
// (no table rewrite) and the new index is built on a small table (one row per environment).
import { sql } from "kysely";
import type { Migration } from "kysely/migration";

/** How long the migration waits for a lock before it gives up. */
export const LOCK_TIMEOUT = "5s";

export const migration: Migration = {
  async up(db) {
    const { rows } = await sql<{
      value: string;
    }>`select current_setting('lock_timeout') as value`.execute(db);
    const before = rows[0]?.value ?? "0";
    await sql`set local lock_timeout = ${sql.lit(LOCK_TIMEOUT)}`.execute(db);

    await sql`alter table implementer_environments
      add column placement text not null default 'vercel'`.execute(db);
    // Only a hosted runner is placed anywhere else than on Vercel: an environment of a person, and a runner environment, stay `vercel`.
    await sql`alter table implementer_environments add constraint implementer_environments_placement_check check (
        placement in ('vercel', 'cloudflare') and (placement = 'vercel' or concurrency is not null)
      )`.execute(db);
    await sql`create unique index implementer_environments_hosted_runner_placement_unique
      on implementer_environments (workspace_id, placement, vcpus) where concurrency is not null`.execute(
      db,
    );
    await sql`drop index implementer_environments_hosted_runner_unique`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    // The Cloudflare rows cannot stay: the old index holds one hosted runner for each size.
    await sql`delete from implementer_environments where placement <> 'vercel'`.execute(
      db,
    );
    await sql`create unique index implementer_environments_hosted_runner_unique
      on implementer_environments (workspace_id, vcpus) where concurrency is not null`.execute(
      db,
    );
    await sql`drop index implementer_environments_hosted_runner_placement_unique`.execute(
      db,
    );
    await sql`alter table implementer_environments drop constraint implementer_environments_placement_check`.execute(
      db,
    );
    await sql`alter table implementer_environments drop column placement`.execute(
      db,
    );
  },
};
