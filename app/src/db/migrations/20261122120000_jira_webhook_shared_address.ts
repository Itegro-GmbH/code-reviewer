// SPDX-License-Identifier: LicenseRef-Proprietary

// One webhook address per Jira connection (#1131). Jira allows ONE address per app and user for the dynamic webhooks of an OAuth 2.0 app, so the
// webhooks of the projects of one connection must share it; until now each carried its own (`?w=<registration>&s=<secret>`), and a second project
// on a connection was refused ("Only a single URL per user is allowed to be registered via REST API").
//
// The address of a connection carries a secret that is derived, not stored (`src/jira/webhook-verify.ts`, `deriveWebhookSecret`): from the app
// secret, the connection id and a number, `webhook_generation`. A rotation counts it up. The rows keep only what the nightly job needs:
//   - `jira_connections.webhook_generation`: the generation whose secret the address carries (1 until a rotation);
//   - `jira_connections.webhook_address_at`: when that address was put in place, that is when its generation began (what its rotation is measured
//     from); null until a webhook is first registered under it;
//   - `jira_connections.webhook_secret_fingerprint`: the SHA-256 of the derived secret the address was registered with (never the secret itself), so
//     that a change of the app secret, which changes every derived secret, is noticed and the address registered again; null until a webhook is
//     registered under it;
//   - `jira_connections.webhook_bearer_seen_at`: when a bearer token that verified was first seen on a delivery of the connection (trust on
//     first use, per connection now);
//   - `jira_webhooks.address`: `project` for a webhook registered under the old per-project address (every row that exists: it keeps working
//     until the next reconcile of its connection moves it), `connection` for one under the shared address;
//   - `jira_webhooks.registration_attempt`: the marker of a registration under way (it replaces the pending secret as the compare-and-set of
//     two reconciles at the same moment); null otherwise.
// `jira_webhooks.secret_hash` loses its not-null: a row under the shared address has no secret of its own.
//
// Expand only, safe for the version that is still running and for the live database: the new columns are nullable or have a constant default
// (no table rewrite), and the version that is still running reads and writes only the columns it knows, with the old address, which this
// version accepts too. Dropping a not-null only loosens. `alter table` takes a short exclusive lock; the wait is bounded by `LOCK_TIMEOUT` (after
// it the migration gives up, the batch rolls back, the deployment can be run again). `down` puts the old shape back: rows under the shared
// address get a secret hash that matches nothing (they are `pending` again and register under their own address once the old version runs).
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

    await sql`alter table jira_connections
      add column webhook_generation integer not null default 1,
      add column webhook_address_at text,
      add column webhook_bearer_seen_at text,
      add column webhook_secret_fingerprint text`.execute(db);
    await sql`alter table jira_webhooks
      add column address text not null default 'project',
      add column registration_attempt text`.execute(db);
    await sql`alter table jira_webhooks add constraint jira_webhooks_address_check
      check (address in ('project', 'connection'))`.execute(db);
    await sql`alter table jira_webhooks alter column secret_hash drop not null`.execute(
      db,
    );
    // A row under the old address needs its secret to be found; one under the shared address has none.
    await sql`alter table jira_webhooks add constraint jira_webhooks_secret_check
      check (address = 'connection' or secret_hash is not null)`.execute(db);

    await sql`select set_config('lock_timeout', ${before}, true)`.execute(db);
  },

  async down(db) {
    await sql`alter table jira_webhooks drop constraint jira_webhooks_secret_check`.execute(
      db,
    );
    await sql`update jira_webhooks set secret_hash = repeat('0', 64), pending_secret_hash = null,
      status = 'pending', jira_webhook_id = null, expires_at = null, registered_at = null
      where secret_hash is null`.execute(db);
    await sql`alter table jira_webhooks alter column secret_hash set not null`.execute(
      db,
    );
    await sql`alter table jira_webhooks drop constraint jira_webhooks_address_check`.execute(
      db,
    );
    await sql`alter table jira_webhooks
      drop column registration_attempt,
      drop column address`.execute(db);
    await sql`alter table jira_connections
      drop column webhook_secret_fingerprint,
      drop column webhook_bearer_seen_at,
      drop column webhook_address_at,
      drop column webhook_generation`.execute(db);
  },
};
