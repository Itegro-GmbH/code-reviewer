// SPDX-License-Identifier: LicenseRef-Proprietary

// #972: the migration of the delivery of a dispatcher is expand only. Four columns on `runners` (every runner that exists polls and holds no
// address, key or secret) and one new, empty table; no existing row changes, and it can be taken back.
import { sql, type Kysely } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import type { Database } from "../schema.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261110120000_add_runner_delivery";

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
    where table_name = 'runners' and column_name like 'delivery_%' order by 1`.execute(
    db,
  );
  return rows;
}

async function ringTable(db: Kysely<Database>) {
  const { rows } = await sql<{
    name: string;
  }>`select table_name as name from information_schema.tables where table_schema = 'public' and table_name = 'job_rings'`.execute(
    db,
  );
  return rows;
}

describe("the runner delivery migration", () => {
  it("runs after every migration it builds on", async () => {
    const names = Object.keys(await migrationProvider.getMigrations()).sort();
    expect(names.indexOf(THIS)).toBeGreaterThan(
      names.indexOf("20261110090000_add_job_required_labels"),
    );
  });

  // #972-T04
  it("adds the delivery columns so that every runner that exists reads poll, with no address, key or secret, and changes no row", async () => {
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
      {
        name: "delivery_key_id",
        nullable: "YES",
        default_value: null,
      },
      {
        name: "delivery_mode",
        nullable: "NO",
        default_value: "'poll'::text",
      },
      { name: "delivery_secret", nullable: "YES", default_value: null },
      { name: "delivery_url", nullable: "YES", default_value: null },
    ]);
    expect(await ringTable(db)).toEqual([{ name: "job_rings" }]);
    await db.destroy();
  });

  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    expect(await columns(db)).toHaveLength(4);

    const down = await migrationProvider.getMigrations();
    await down[THIS]?.down?.(db);

    expect(await columns(db)).toEqual([]);
    expect(await ringTable(db)).toEqual([]);
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
