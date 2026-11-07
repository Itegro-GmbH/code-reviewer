// SPDX-License-Identifier: LicenseRef-Proprietary

// #918: the turn time limit migration is expand only. It adds one nullable column (`time_limit_minutes`) to `implementer_turns` with a
// check of 15 to 60, so every turn written before reads null, and it can be taken back.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const column = sql<{
  nullable: string;
  type: string;
}>`select is_nullable as nullable, data_type as type from information_schema.columns
   where table_name = 'implementer_turns' and column_name = 'time_limit_minutes'`;
const check = sql<{
  definition: string;
}>`select pg_get_constraintdef(oid) as definition from pg_constraint
   where conname = 'implementer_turns_time_limit_check'`;

describe("the implementer turn time limit migration", () => {
  // #918-M01
  it("adds a nullable integer column held to 15 to 60 minutes", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    expect((await column.execute(db)).rows).toEqual([
      { nullable: "YES", type: "integer" },
    ]);
    const definition = (await check.execute(db)).rows[0]?.definition ?? "";
    expect(definition).toContain("15");
    expect(definition).toContain("60");
    await db.destroy();
  });

  // #918-M01
  it("can be taken back", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const { migration } =
      await import("./20261107150000_add_implementer_turn_time_limit.ts");
    await migration.down?.(db);

    expect((await column.execute(db)).rows).toHaveLength(0);
    expect((await check.execute(db)).rows).toHaveLength(0);
    await db.destroy();
  });
});
