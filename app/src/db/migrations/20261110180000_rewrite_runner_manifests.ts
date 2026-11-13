// SPDX-License-Identifier: LicenseRef-Proprietary

// The harness entries of a runner's manifest (#973, Runner v2): `runners.manifest` (JSON text) held `harnesses` as a map
// `{ "<harness>": { version, ready } }`; it holds a list `[{ harness, version, auth, models? }]` now, which the claim and the pairing of the
// rings read in the database (`accessRule`). A runner that announced the old form is rewritten once, as the app reads it: an entry that was
// ready is OpenCode (or any harness but Claude Code) on a key of the app (`app-key`) or Claude Code on a subscription, one that was not ready is
// dropped, the capabilities stay. The column, its type and its check do not change; only the text of rows that still hold a map.
//
// Not expand-only in the strict sense: an instance of the previous release that still runs during the deployment reads a list as "no harness"
// and hands that runner nothing until its next announcement. Tolerated here because no runner image is published yet (the table holds the
// development runners of the team) and the runner announces at every start. The table is small, so the update holds its lock only briefly; the
// wait for the lock is bounded like in the migrations before. `down` writes the map form again. A row whose text is no JSON is left as it is
// (`json_or_null`, the migration before this one): it must not stop the others from being rewritten.
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

    await sql`
      update runners
      set manifest = jsonb_build_object(
        'harnesses', coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'harness', announced.key,
              'version', announced.value ->> 'version',
              'auth', case when announced.key = 'claude-code' then 'subscription' else 'app-key' end)
            order by announced.key)
          from jsonb_each(json_or_null(manifest) -> 'harnesses') as announced
          where announced.value ->> 'ready' = 'true'), '[]'::jsonb),
        'capabilities', coalesce(json_or_null(manifest) -> 'capabilities', '[]'::jsonb))::text
      where jsonb_typeof(json_or_null(manifest) -> 'harnesses') = 'object'`.execute(
      db,
    );

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`
      update runners
      set manifest = jsonb_build_object(
        'harnesses', coalesce((
          select jsonb_object_agg(
            announced ->> 'harness',
            jsonb_build_object('version', announced ->> 'version', 'ready', true))
          from jsonb_array_elements(json_or_null(manifest) -> 'harnesses') as announced), '{}'::jsonb),
        'capabilities', coalesce(json_or_null(manifest) -> 'capabilities', '[]'::jsonb))::text
      where jsonb_typeof(json_or_null(manifest) -> 'harnesses') = 'array'`.execute(
      db,
    );
  },
};
