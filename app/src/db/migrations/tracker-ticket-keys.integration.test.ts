// SPDX-License-Identifier: LicenseRef-Proprietary

// #1035 (epic #1034): a mirror row is identified by `(repository, provider, key)` and a ticket by a text key. The migration adds the text key
// to `tracker_items` and the provider to `tracker_sync_state` and keeps everything that exists: every mirror row (and the key it is read
// by), the sync state, and the `ticket_ref` of every run. It is expand only: the old primary keys stay and a writer that does not know the
// key (the version that is still running during a deploy) keeps working, because a trigger gives its rows the key.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import type { Database } from "../schema.ts";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261114120000_tracker_ticket_keys.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261114120000_tracker_ticket_keys";
const T = "2026-11-14T08:00:00.000Z";

const beforeThisMigration: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

type Db = Kysely<Database>;

async function seed(db: Db) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/widgets', 'https://github.test/acme/widgets', 1, ${T}, ${T})`.execute(
    db,
  );
  for (const [number, kind] of [
    [1, "issue"],
    [12, "issue"],
    [13, "pull_request"],
  ] as const)
    await sql`insert into tracker_items (workspace_id, repository_id, provider, repo, number, node_id, kind, state, title, body_excerpt, labels, assignees, pull_requests, closes, updated_at, synced_at)
      values ('w-1', 'r-1', 'github', 'acme/widgets', ${number}, ${`N_${String(number)}`}, ${kind}, 'open', ${`Ticket ${String(number)}`}, '', '[]', '[]', '[]', '[]', ${T}, ${T})`.execute(
      db,
    );
  await sql`insert into tracker_sync_state (repository_id, workspace_id, cursor, last_full_sync_at, updated_at)
    values ('r-1', 'w-1', null, ${T}, ${T})`.execute(db);
  await sql`insert into workflows (id, workspace_id, name, current_version, created_by, created_at, updated_at)
    values ('wf-1', 'w-1', 'Implement', 1, 'u-1', ${T}, ${T})`.execute(db);
  await sql`insert into workflow_versions (workflow_id, version, workspace_id, document, created_by, created_at)
    values ('wf-1', 1, 'w-1', '{}', 'u-1', ${T})`.execute(db);
  await sql`insert into workflow_runs (id, workspace_id, workflow_id, workflow_version, repository_id, base_branch, trigger_input, status, budget_micro_usd, client_request_id, created_by, actor_login, trigger_kind, ticket_ref, created_at, updated_at)
    values ('run-1', 'w-1', 'wf-1', 1, 'r-1', 'main', '{}', 'running', 1000000, 'req-1', 'u-1', 'octocat', 'ticket.labeled', 'github:acme/widgets#12', ${T}, ${T})`.execute(
    db,
  );
}

describe("the text keys of the ticket mirror", () => {
  // #1035-T02
  it("keeps every mirror row, the sync state and every ticket_ref, and gives each row its number as key", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);

    await migrateToLatest(db);

    const { rows: items } = await sql<{
      number: number;
      key: string;
      provider: string;
      title: string;
    }>`select number, key, provider, title from tracker_items where repository_id = 'r-1' order by number`.execute(
      db,
    );
    expect(items).toEqual([
      { number: 1, key: "1", provider: "github", title: "Ticket 1" },
      { number: 12, key: "12", provider: "github", title: "Ticket 12" },
      { number: 13, key: "13", provider: "github", title: "Ticket 13" },
    ]);
    const { rows: state } = await sql<{
      provider: string;
      last_full_sync_at: string;
    }>`select provider, last_full_sync_at from tracker_sync_state where repository_id = 'r-1'`.execute(
      db,
    );
    expect(state).toEqual([{ provider: "github", last_full_sync_at: T }]);
    const { rows: runs } =
      await sql`select id, ticket_ref from workflow_runs`.execute(db);
    expect(runs).toEqual([
      { id: "run-1", ticket_ref: "github:acme/widgets#12" },
    ]);
  });

  // #1035-T02
  it("is expand only: the old primary keys stay, and a row written without a key gets one", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    await migrateToLatest(db);

    // What the version that is still running writes: by number, with no key and no provider on the state.
    await sql`insert into tracker_items (workspace_id, repository_id, provider, repo, number, node_id, kind, state, title, body_excerpt, labels, assignees, pull_requests, closes, updated_at, synced_at)
      values ('w-1', 'r-1', 'github', 'acme/widgets', 99, 'N_99', 'issue', 'open', 'Late', '', '[]', '[]', '[]', '[]', ${T}, ${T})
      on conflict (repository_id, number) do update set title = excluded.title`.execute(
      db,
    );
    await sql`insert into tracker_sync_state (repository_id, workspace_id, updated_at)
      values ('r-1', 'w-1', ${T})
      on conflict (repository_id) do update set updated_at = excluded.updated_at`.execute(
      db,
    );

    const { rows: late } =
      await sql`select key from tracker_items where number = 99`.execute(db);
    expect(late).toEqual([{ key: "99" }]);
    const { rows: state } =
      await sql`select provider from tracker_sync_state where repository_id = 'r-1'`.execute(
        db,
      );
    expect(state).toEqual([{ provider: "github" }]);
    const { rows: keys } = await sql<{
      conname: string;
    }>`select conname from pg_constraint where conrelid = 'tracker_items'::regclass and contype = 'p'`.execute(
      db,
    );
    expect(keys).toEqual([{ conname: "tracker_items_pkey" }]);
    // The new identity: the same key of the same provider in the same repository is the same row.
    await expect(
      sql`insert into tracker_items (workspace_id, repository_id, provider, repo, key, number, node_id, kind, state, title, body_excerpt, labels, assignees, pull_requests, closes, updated_at, synced_at)
        values ('w-1', 'r-1', 'github', 'acme/widgets', '12', 1200, 'N_x', 'issue', 'open', 'Twice', '', '[]', '[]', '[]', '[]', ${T}, ${T})`.execute(
        db,
      ),
    ).rejects.toThrow(/tracker_items_key_index/);
  });

  // #1035-T02
  it("is taken back by down, and applied again by up, with the rows as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    await migrateToLatest(db);

    await migration.down?.(db);
    const { rows: columns } = await sql<{
      table_name: string;
      column_name: string;
    }>`select table_name, column_name from information_schema.columns
      where (table_name = 'tracker_items' and column_name = 'key')
         or (table_name = 'tracker_sync_state' and column_name = 'provider')`.execute(
      db,
    );
    expect(columns).toEqual([]);
    const { rows: kept } =
      await sql`select number from tracker_items order by number`.execute(db);
    expect(kept).toEqual([{ number: 1 }, { number: 12 }, { number: 13 }]);

    await migration.up(db);
    const { rows: again } =
      await sql`select key from tracker_items order by number`.execute(db);
    expect(again).toEqual([{ key: "1" }, { key: "12" }, { key: "13" }]);
  });
});
