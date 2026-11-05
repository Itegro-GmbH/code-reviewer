// SPDX-License-Identifier: LicenseRef-Proprietary

// #818: the snapshot columns are expand only. Five nullable columns are added to tables that hold rows (a task, a VM run), no
// existing row changes (every old row reads null), and the migration gives up loudly instead of making the queue wait when a
// writer holds one of the two tables.
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

const THIS = "20261102150000_add_implementer_turn_environment";
const T = "2026-11-02T08:00:00.000Z";

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
    // Tables of later migrations (#833) are empty and are no change to an existing row.
    if (
      table.name === "workflows" ||
      table.name === "workflow_versions" ||
      table.name === "profiles" ||
      table.name === "profile_versions"
    )
      continue;
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

/** A task and a VM run the way the live database has them: a workspace, a repository, a job, a session, a turn and a VM. */
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
  await sql`insert into job_vm_runs (job_id, vm_name, workspace_id, attempt, claimed_at, started_at, reported_at, vm_timeout_seconds, billable, created_at, updated_at)
    values ('j-1', 'cr-implementer-j-1-abcd', 'w-1', 1, ${T}, ${T}, ${T}, 3000, 1, ${T}, ${T})`.execute(
    db,
  );
}

let counter = 1;

async function insertTurn(
  db: Kysely<Database>,
  values: {
    id: string;
    environment?: {
      id: string | null;
      name: string | null;
      vcpus: number | null;
      script: string | null;
    };
  },
) {
  // A slot of its own for each call, and the job's placeholder pull request number is its negative.
  const slot = ++counter + 1;
  await sql`insert into jobs (id, workspace_id, repository_id, pr_number, pr_url, head_sha, command, args, trigger_kind, actor_login,
      status, run_after, attempts, created_at, updated_at)
    values (${`j-${values.id}`}, 'w-1', 'r-1', ${-slot}, 'https://github.test/acme/x/tree/b2', ${"a".repeat(40)}, 'review', '', 'manual', 'octocat',
      'queued', ${T}, 0, ${T}, ${T})`.execute(db);
  const env = values.environment ?? {
    id: null,
    name: null,
    vcpus: null,
    script: null,
  };
  await sql`insert into implementer_sessions (id, workspace_id, repository_id, slot, base_branch, branch, status, created_by, created_at, updated_at)
    values (${`s-${values.id}`}, 'w-1', 'r-1', ${slot}, 'main', ${`b-${values.id}`}, 'running', 'u-1', ${T}, ${T})`.execute(
    db,
  );
  await sql`insert into implementer_turns (id, session_id, workspace_id, number, instruction, model_choice, job_id, created_by, created_at,
      environment_id, environment_name, environment_vcpus, environment_setup_script)
    values (${values.id}, ${`s-${values.id}`}, 'w-1', 1, 'do it', '{"entryId":"e"}', ${`j-${values.id}`}, 'u-1', ${T},
      ${env.id}, ${env.name}, ${env.vcpus}, ${env.script})`.execute(db);
}

describe("the migration that adds the environment snapshot", () => {
  // #818-T24
  it("adds nullable columns to a database with data, changes no existing row, and every old row reads null", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, before);
    await seedPreviousRelease(db);
    const rows = await rowsOfEveryTable(db);

    const { executed } = await migrateToLatest(db, migrationProvider);

    expect(executed).toContain(THIS);
    expect(await rowsOfEveryTable(db)).toEqual(rows);
    const { rows: turns } = await sql<{
      environment_id: string | null;
      environment_name: string | null;
      environment_vcpus: number | null;
      environment_setup_script: string | null;
    }>`select environment_id, environment_name, environment_vcpus, environment_setup_script from implementer_turns`.execute(
      db,
    );
    expect(turns).toEqual([
      {
        environment_id: null,
        environment_name: null,
        environment_vcpus: null,
        environment_setup_script: null,
      },
    ]);
    const { rows: runs } = await sql<{
      vcpus: number | null;
    }>`select vcpus from job_vm_runs`.execute(db);
    expect(runs).toEqual([{ vcpus: null }]);
    await db.destroy();
  });

  // #818-T24
  it("is applied once, and adds no foreign key: nothing in the database points at an environment", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    const { rows } = await sql<{
      conname: string;
    }>`select conname from pg_constraint
      where conrelid = 'implementer_turns'::regclass and contype = 'f' order by conname`.execute(
      db,
    );
    expect(rows.map((row) => row.conname).join(",")).not.toContain(
      "environment",
    );
    await db.destroy();
  });

  // #818-T24
  it("lets a turn have the whole snapshot or none of it, with a size of at least one and a script of at most 64 KB", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seedPreviousRelease(db);
    const whole = { id: "e", name: "n", vcpus: 4, script: "" };

    await insertTurn(db, { id: "ok-none" });
    await insertTurn(db, { id: "ok-whole", environment: whole });
    for (const [id, environment] of [
      ["half-1", { ...whole, name: null }],
      ["half-2", { ...whole, script: null }],
      ["half-3", { ...whole, vcpus: null }],
      ["half-4", { ...whole, id: null }],
      ["zero", { ...whole, vcpus: 0 }],
      ["big", { ...whole, script: "x".repeat(65_537) }],
    ] as const)
      await expect(insertTurn(db, { id, environment })).rejects.toThrow(
        /implementer_turns_environment_check/,
      );
    await expect(
      sql`update job_vm_runs set vcpus = 0`.execute(db),
    ).rejects.toThrow(/job_vm_runs_vcpus_check/);
    await sql`update job_vm_runs set vcpus = 8`.execute(db);
    await db.destroy();
  });

  // #818-T24
  it("keeps the lock timeout it sets to itself", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
    const seen: string[] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          "99999999999999_probe_lock_timeout": {
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

  // #818-T24
  it.each(["implementer_turns", "job_vm_runs"])(
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
        else await sql`update job_vm_runs set attempt = 2`.execute(trx);
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
          where (table_name = 'implementer_turns' and column_name like 'environment_%') or (table_name = 'job_vm_runs' and column_name = 'vcpus')`.execute(
        db,
      );
      expect(rows).toEqual([{ count: 0 }]);
      release();
      await writerDone;
      await expect(
        migrateToLatest(db, migrationProvider),
      ).resolves.toMatchObject({ executed: expect.arrayContaining([THIS]) });
      await writer.destroy();
      await db.destroy();
    },
    40_000,
  );
});
