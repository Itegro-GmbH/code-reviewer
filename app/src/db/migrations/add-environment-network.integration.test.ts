// SPDX-License-Identifier: LicenseRef-Proprietary

// #745, step 7: the rule for the agent's network is expand only. Two columns with a constant default on the environments, two
// nullable ones on the turns; every environment that exists reads `off` and every turn that exists reads null (which reads `off`),
// no existing row changes, and the migration gives up loudly instead of making the queue wait.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import {
  connectPostgres,
  createEmptyTestDatabase,
} from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261103100000_add_environment_network";
const T = "2026-11-03T08:00:00.000Z";

const before: MigrationProvider = {
  async getMigrations() {
    return Object.fromEntries(
      Object.entries(await migrationProvider.getMigrations()).filter(
        ([name]) => name < THIS,
      ),
    );
  },
};

async function rowsOfEveryTable(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    // A later migration's table (#745): it does not exist before this migration is applied, and it is empty after.
    if (table.name === "implementer_turn_steps") continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

async function seedPreviousRelease(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at) values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into integrations (id, workspace_id, type, display_name, external_id, config, status, created_at, updated_at)
    values ('i-1', 'w-1', 'github_app', 'acme', 'ext-1', '{}', 'active', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into repositories (id, workspace_id, integration_id, external_id, full_name, url, active, created_at, updated_at)
    values ('r-1', 'w-1', 'i-1', 'repo-1', 'acme/x', 'https://github.test/acme/x', 1, ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login,
      status, run_after, attempts, created_at, updated_at)
    values ('j-1', 'w-1', 'r-1', -1, 'https://github.test/acme/x/tree/b', ${"a".repeat(40)}, 'review', '', 'manual', 'octocat',
      'queued', ${T}, 0, ${T}, ${T})`.execute(db);
  await sql`insert into implementer_sessions (id, workspace_id, repository_id, slot, base_branch, branch, status, created_by, created_at, updated_at)
    values ('s-1', 'w-1', 'r-1', 1, 'main', 'b', 'running', 'u-1', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into implementer_turns (id, session_id, workspace_id, number, instruction, model_choice, job_id, created_by, created_at)
    values ('t-1', 's-1', 'w-1', 1, 'do it', '{"entryId":"e"}', 'j-1', 'u-1', ${T})`.execute(
    db,
  );
  await sql`insert into implementer_environments (id, workspace_id, name, vcpus, setup_script, created_by, created_at, updated_at)
    values ('e-1', 'w-1', 'Node', 4, 'npm ci', 'u-1', ${T}, ${T})`.execute(db);
}

describe("the migration that adds the environment's network rule", () => {
  // #745-T37
  it("changes no existing row: every environment reads off and every turn reads null", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, before);
    await seedPreviousRelease(db);
    const rows = await rowsOfEveryTable(db);

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(THIS);
    expect(await rowsOfEveryTable(db)).toEqual(rows);
    const { rows: environments } = await sql<{
      network_mode: string;
      network_hosts: string;
    }>`select network_mode, network_hosts from implementer_environments`.execute(
      db,
    );
    expect(environments).toEqual([{ network_mode: "off", network_hosts: "" }]);
    const { rows: turns } = await sql<{
      environment_network_mode: string | null;
      environment_network_hosts: string | null;
    }>`select environment_network_mode, environment_network_hosts from implementer_turns`.execute(
      db,
    );
    expect(turns).toEqual([
      { environment_network_mode: null, environment_network_hosts: null },
    ]);
    await db.destroy();
  });

  // #745-T37
  it("is applied once and can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    const migration = (await migrationProvider.getMigrations())[THIS];
    await migration?.down?.(db);
    const { rows } = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns
      where table_name in ('implementer_environments', 'implementer_turns') and column_name like '%network%'`.execute(
      db,
    );
    expect(rows).toEqual([]);
    await db.destroy();
  });

  // #745-T37
  it("holds what the database can hold: the mode, a list with hosts, no hosts without a list, a bounded text", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);

    for (const [mode, hosts] of [
      ["list", "registry.npmjs.org"],
      ["open", ""],
      ["off", ""],
    ] as const)
      await sql`update implementer_environments set network_mode = ${mode}, network_hosts = ${hosts}`.execute(
        db,
      );
    for (const [mode, hosts] of [
      ["closed", ""],
      ["list", ""],
      ["open", "a.example.com"],
      ["off", "a.example.com"],
      ["list", "x".repeat(25_401)],
    ] as const)
      await expect(
        sql`update implementer_environments set network_mode = ${mode}, network_hosts = ${hosts}`.execute(
          db,
        ),
      ).rejects.toThrow(/implementer_environments_network_check/);

    // A turn has both columns or neither.
    await sql`update implementer_turns set environment_network_mode = 'list', environment_network_hosts = 'a.example.com'`.execute(
      db,
    );
    for (const set of [
      sql`environment_network_mode = 'list', environment_network_hosts = null`,
      sql`environment_network_mode = null, environment_network_hosts = 'a.example.com'`,
      sql`environment_network_mode = 'list', environment_network_hosts = ''`,
      sql`environment_network_mode = 'open', environment_network_hosts = 'a.example.com'`,
      sql`environment_network_mode = 'closed', environment_network_hosts = ''`,
    ])
      await expect(
        sql`update implementer_turns set ${set}`.execute(db),
      ).rejects.toThrow(/implementer_turns_environment_network_check/);
    await db.destroy();
  });

  // #745-T37
  it("keeps the lock timeout it sets to itself", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
    const seen: string[] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        const all = await migrationProvider.getMigrations();
        return {
          ...all,
          "99999999999999_probe": {
            async up(trx) {
              const { rows } = await sql<{
                value: string;
              }>`select current_setting('lock_timeout') as value`.execute(trx);
              seen.push(rows[0]?.value ?? "");
            },
          },
        };
      },
    };

    await migrateToLatest(db, withProbe);

    expect(seen).toEqual(["0"]);
    await db.destroy();
  });

  // #745-T37
  it.each(["implementer_turns", "implementer_environments"])(
    "gives up with MIGRATION_FAILED and leaves nothing half applied when a writer keeps %s locked, then succeeds once it is gone",
    async (table) => {
      const { db, url } = await createEmptyTestDatabase();
      await migrateToLatest(db, before);
      await seedPreviousRelease(db);
      const writer = connectPostgres(url, 1).db;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started: () => void = () => undefined;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      // A transaction that has written a row of the table and does not end: `add column` has to wait for it.
      const writerDone = writer.transaction().execute(async (trx) => {
        if (table === "implementer_turns")
          await sql`update implementer_turns set instruction = 'x'`.execute(
            trx,
          );
        else
          await sql`update implementer_environments set name = 'x'`.execute(
            trx,
          );
        started();
        await held;
      });
      await writing;

      const startedAt = Date.now();
      await expect(
        migrateToLatest(db, migrationProvider),
      ).rejects.toMatchObject({ code: "MIGRATION_FAILED" });

      expect(Date.now() - startedAt).toBeLessThan(20_000);
      const { rows } = await sql<{
        count: number;
      }>`select count(*)::int as count from information_schema.columns
          where table_name in ('implementer_environments', 'implementer_turns') and column_name like '%network%'`.execute(
        db,
      );
      expect(rows[0]?.count).toBe(0);

      release();
      await writerDone;
      await writer.destroy();
      expect((await migrateToLatest(db, migrationProvider)).executed).toContain(
        THIS,
      );
      await db.destroy();
    },
  );
});
