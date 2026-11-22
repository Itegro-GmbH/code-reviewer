// SPDX-License-Identifier: LicenseRef-Proprietary

// #1131: the migration for one webhook address per Jira connection is expand only. A row that exists stays what it was and reads as one
// under its own per-project address (`address = 'project'`, its secret hash kept), a connection starts at generation 1, a row under the
// shared address needs no secret, one under its own address still needs one, and the migration can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261122120000_jira_webhook_shared_address";
const T = "2026-11-22T08:00:00.000Z";

function upTo(include: (name: string) => boolean): MigrationProvider {
  return {
    async getMigrations() {
      return Object.fromEntries(
        Object.entries(await migrationProvider.getMigrations()).filter(
          ([name]) => include(name),
        ),
      );
    },
  };
}
const beforeThisMigration = upTo((name) => name < THIS);
const throughThisMigration = upTo((name) => name <= THIS);

async function seed(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into jira_connections (id, workspace_id, cloud_id, site_url, site_name, account_id, account_name, scopes, status,
      error_code, tokens_ciphertext, tokens_nonce, tokens_key_version, access_expires_at, created_at, updated_at)
    values ('jc-1', 'w-1', 'cloud-1', 'https://acme.atlassian.net', 'acme', 'a-1', 'Ada', 'read:jira-work', 'connected',
      null, 'c', 'n', 1, ${T}, ${T}, ${T})`.execute(db);
}

const webhook = (
  id: string,
  projectId: string,
  over: { address?: string; secretHash?: string | null } = {},
) =>
  sql`insert into jira_webhooks (id, workspace_id, project_id, connection_id, project_key, secret_hash, address, status, created_at, updated_at)
    values (${id}, 'w-1', ${projectId}, 'jc-1', 'PROJ', ${"secretHash" in over ? over.secretHash : "a".repeat(64)},
      ${over.address ?? "project"}, 'pending', ${T}, ${T})`;

describe("the migration for one webhook address per Jira connection", () => {
  // #1131-T11
  it("leaves the rows that exist as they were: under their own address with their secret hash, and the connection at generation 1", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    await sql`insert into jira_webhooks (id, workspace_id, project_id, connection_id, project_key, secret_hash, status, created_at, updated_at)
      values ('old-1', 'w-1', 'p-1', 'jc-1', 'LAT', ${"b".repeat(64)}, 'pending', ${T}, ${T})`.execute(
      db,
    );

    const { executed } = await migrateToLatest(db, throughThisMigration);

    expect(executed).toContain(THIS);
    const { rows } = await sql<Record<string, unknown>>`
      select w.id, w.secret_hash, w.address, w.registration_attempt, c.webhook_generation, c.webhook_address_at, c.webhook_bearer_seen_at, c.webhook_secret_fingerprint
      from jira_webhooks w join jira_connections c on c.id = w.connection_id`.execute(
      db,
    );
    expect(rows).toEqual([
      {
        id: "old-1",
        secret_hash: "b".repeat(64),
        address: "project",
        registration_attempt: null,
        webhook_generation: 1,
        webhook_address_at: null,
        webhook_bearer_seen_at: null,
        webhook_secret_fingerprint: null,
      },
    ]);
    await db.destroy();
  });

  // #1131-T11
  it("lets a row under the shared address have no secret and still requires one under its own address", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);

    await webhook("shared", "p-1", {
      address: "connection",
      secretHash: null,
    }).execute(db);
    await expect(
      webhook("bad-1", "p-2", { address: "project", secretHash: null }).execute(
        db,
      ),
    ).rejects.toThrow(/jira_webhooks_secret_check/);
    await expect(
      webhook("bad-2", "p-3", { address: "elsewhere" }).execute(db),
    ).rejects.toThrow(/jira_webhooks_address_check/);
    await db.destroy();
  });

  // #1131-T11
  it("can be taken back: the rows under the shared address are pending again with a secret hash that matches nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await webhook("shared", "p-1", {
      address: "connection",
      secretHash: null,
    }).execute(db);
    await sql`update jira_webhooks set status = 'active', jira_webhook_id = '77', expires_at = ${T} where id = 'shared'`.execute(
      db,
    );
    await webhook("own", "p-2").execute(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      id: string;
      secret_hash: string;
      status: string;
      jira_webhook_id: string | null;
    }>`select id, secret_hash, status, jira_webhook_id from jira_webhooks order by id`.execute(
      db,
    );
    expect(rows).toEqual([
      {
        id: "own",
        secret_hash: "a".repeat(64),
        status: "pending",
        jira_webhook_id: null,
      },
      {
        id: "shared",
        secret_hash: "0".repeat(64),
        status: "pending",
        jira_webhook_id: null,
      },
    ]);
    const { rows: columns } = await sql<{
      name: string;
    }>`select table_name || '.' || column_name as name from information_schema.columns
      where table_schema = 'public' and column_name in ('address', 'registration_attempt', 'webhook_generation', 'webhook_secret_fingerprint')`.execute(
      db,
    );
    expect(columns).toEqual([]);
    await db.destroy();
  });
});
