// SPDX-License-Identifier: LicenseRef-Proprietary

// #971: the migration of the labels a job requires is expand only: one nullable column, no existing row changes (every job written
// before reads null, which the claim derives), and it can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261110090000_add_job_required_labels";

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

async function columns(db: Kysely<Database>) {
  const { rows } = await sql<{
    name: string;
    nullable: string;
    default_value: string | null;
  }>`select column_name as name, is_nullable as nullable, column_default as default_value
    from information_schema.columns
    where table_name = 'jobs' and column_name = 'required_labels'`.execute(db);
  return rows;
}

describe("the job required labels migration", () => {
  it("is the newest migration that was there when it was written, so it runs after every one it builds on", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();
    expect(names.indexOf(THIS)).toBeGreaterThan(
      names.indexOf("20261107230000_add_tracker_items_write_index"),
    );
  });

  // #971-T02
  it("adds one nullable column without a default, so no existing row is rewritten and a job written before reads null", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    expect(await columns(db)).toEqual([]);
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );

    expect(await columns(db)).toEqual([
      { name: "required_labels", nullable: "YES", default_value: null },
    ]);
    await db.destroy();
  });

  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    expect(await columns(db)).toHaveLength(1);

    const down = await migrationProvider.getMigrations();
    await down[THIS]?.down?.(db);

    expect(await columns(db)).toEqual([]);
    await db.destroy();
  });

  it("keeps the lock timeout it sets to itself: a later migration of the same batch does not inherit it", async () => {
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
});
