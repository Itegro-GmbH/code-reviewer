// SPDX-License-Identifier: LicenseRef-Proprietary

// #854: the runners migration is expand only. It adds two empty tables to a database made by the previous release's migrations (the
// live one has jobs and implementer rows), changes no existing row and no existing table, and can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";
import { withoutColumnsAddedLater } from "../../test-support/columns-added-later.ts";

const THIS = "20261105120000_create_runners";
const T = "2026-11-05T08:00:00.000Z";
const NEW_TABLES = ["runners", "runner_registration_tokens"];

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

async function snapshot(
  db: Kysely<Database>,
): Promise<Record<string, unknown[]>> {
  const result: Record<string, unknown[]> = {};
  for (const table of await db.introspection.getTables()) {
    if (NEW_TABLES.includes(table.name)) continue;
    const { rows } =
      await sql<unknown>`select * from ${sql.table(table.name)} order by 1`.execute(
        db,
      );
    result[table.name] = withoutColumnsAddedLater(table.name, rows);
  }
  return result;
}

async function columns(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`select table_name || '.' || column_name as name from information_schema.columns
    where table_schema = 'public' and table_name not in ('runners', 'runner_registration_tokens') order by 1`.execute(
    db,
  );
  return rows.map((row) => row.name);
}

async function seed(db: Kysely<Database>) {
  await sql`insert into users (id, name, email, email_verified, created_at, updated_at)
    values ('u-1', 'A', 'a@example.com', 1, ${T}, ${T})`.execute(db);
  await sql`insert into workspaces (id, name, slug, created_by, created_at) values ('w-1', 'acme', 'acme', 'u-1', ${T})`.execute(
    db,
  );
}

const runnerRow = (
  id: string,
  change: Partial<Record<string, string>> = {},
) => {
  const values: Record<string, string> = {
    id,
    name: "box",
    labels: "linux",
    base_version: "1.0.0",
    manifest: "{}",
    limits: "{}",
    credential_hash: `hash-${id}`,
    ...change,
  };
  return sql`insert into runners (id, workspace_id, name, labels, base_version, manifest, limits, credential_hash, created_at, last_seen_at)
    values (${values.id}, 'w-1', ${values.name}, ${values.labels}, ${values.base_version}, ${values.manifest}, ${values.limits}, ${values.credential_hash}, ${T}, ${T})`;
};

describe("the runners migration", () => {
  // #854-T90
  it("adds two empty tables to an existing database and changes no existing row or column", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, beforeThisMigration);
    await seed(db);
    const rows = await snapshot(db);
    const before = await columns(db);

    const { executed } = await migrateToLatest(db, throughThisMigration);

    expect(executed).toContain(THIS);
    expect(await snapshot(db)).toEqual(rows);
    expect(await columns(db)).toEqual(before);
    const { rows: counts } = await sql<{
      runners: number;
      tokens: number;
    }>`select (select count(*) from runners)::int as runners, (select count(*) from runner_registration_tokens)::int as tokens`.execute(
      db,
    );
    expect(counts).toEqual([{ runners: 0, tokens: 0 }]);
    await db.destroy();
  });

  // #854-T91
  it("is applied once: running it again applies nothing", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    expect((await migrateToLatest(db, migrationProvider)).executed).toEqual([]);
    await db.destroy();
  });

  // #854-T92
  it("can be taken back, leaving the other tables as they were", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const before = await columns(db);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      name: string;
    }>`select table_name as name from information_schema.tables
      where table_schema = 'public' and table_name like 'runner%'`.execute(db);
    expect(rows).toEqual([]);
    expect(await columns(db)).toEqual(before);
    await db.destroy();
  });

  // #854-T93
  it("keeps one credential for one runner, a name of 1 to 80 characters, and the bounds of what a runner announces", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    await runnerRow("r-1").execute(db);

    await expect(
      runnerRow("r-2", { credential_hash: "hash-r-1" }).execute(db),
    ).rejects.toThrow(/runners_credential_hash_key/);
    await expect(runnerRow("r-3", { name: "" }).execute(db)).rejects.toThrow(
      /runners_name_check/,
    );
    await expect(
      runnerRow("r-4", { name: "n".repeat(81) }).execute(db),
    ).rejects.toThrow(/runners_name_check/);
    await expect(
      runnerRow("r-5", { manifest: "m".repeat(16385) }).execute(db),
    ).rejects.toThrow(/runners_manifest_check/);
    await expect(
      runnerRow("r-6", { limits: "l".repeat(4097) }).execute(db),
    ).rejects.toThrow(/runners_limits_check/);
    await expect(
      runnerRow("r-7", { base_version: "" }).execute(db),
    ).rejects.toThrow(/runners_base_version_check/);
    await db.destroy();
  });

  // #854-T94
  it("keeps one hash for one token, and a token either unused or used by a runner", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await seed(db);
    const token = (id: string, hash: string, used: string, runner: string) =>
      sql`insert into runner_registration_tokens (id, workspace_id, token_hash, created_by, created_at, expires_at, used_at, runner_id)
        values (${id}, 'w-1', ${hash}, 'u-1', ${T}, ${T}, ${used === "" ? null : used}, ${runner === "" ? null : runner})`.execute(
        db,
      );
    await token("t-1", "h-1", "", "");

    await expect(token("t-2", "h-1", "", "")).rejects.toThrow(
      /runner_registration_tokens_token_hash_key/,
    );
    await expect(token("t-3", "h-3", T, "")).rejects.toThrow(
      /runner_registration_tokens_used_check/,
    );
    await expect(token("t-4", "h-4", "", "r-1")).rejects.toThrow(
      /runner_registration_tokens_used_check/,
    );
    await token("t-5", "h-5", T, "r-1");
    await db.destroy();
  });

  // #854-T95
  it("keeps the lock timeout it sets to itself: a later migration of the same batch does not inherit it", async () => {
    const { db } = await createEmptyTestDatabase({ poolMax: 1 });
    const seenByLaterMigration: string[] = [];
    const withProbe: MigrationProvider = {
      async getMigrations() {
        return {
          ...(await migrationProvider.getMigrations()),
          "99999999999999_probe_lock_timeout": {
            async up(trx) {
              const { rows } = await sql<{
                value: string;
              }>`select current_setting('lock_timeout') as value`.execute(trx);
              seenByLaterMigration.push(rows[0]?.value ?? "");
            },
          },
        };
      },
    };

    const { executed } = await migrateToLatest(db, withProbe);

    expect(
      executed.indexOf("99999999999999_probe_lock_timeout"),
    ).toBeGreaterThan(executed.indexOf(THIS));
    expect(seenByLaterMigration).toEqual(["0"]);
    await db.destroy();
  });
});
