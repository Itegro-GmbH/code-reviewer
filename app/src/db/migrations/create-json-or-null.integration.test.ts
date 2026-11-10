// SPDX-License-Identifier: LicenseRef-Proprietary

// #973: `json_or_null(text)` answers the text as jsonb, or null for text that is none, instead of failing the statement; and `down` takes it away.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261110170000_create_json_or_null";

describe("the json_or_null migration", () => {
  // #973-T01
  it("reads JSON text, and answers null for text that is none, row by row", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    const { rows } = await sql<{ text: string; value: unknown }>`
      select t.text as text, json_or_null(t.text) as value
      from (values ('{"a":1}'), ('not json {'), (''), ('[1,2]'), ('5')) as t(text)`.execute(
      db,
    );

    expect(rows.map((row) => [row.text, row.value])).toEqual([
      ['{"a":1}', { a: 1 }],
      ["not json {", null],
      ["", null],
      ["[1,2]", [1, 2]],
      ["5", 5],
    ]);
    await db.destroy();
  });

  it("is dropped by `down`", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);

    await (await migrationProvider.getMigrations())[THIS]?.down?.(db);

    const { rows } = await sql<{
      n: number;
    }>`select count(*)::int as n from pg_proc where proname = 'json_or_null'`.execute(
      db,
    );
    expect(rows[0]?.n).toBe(0);
    await db.destroy();
  });
});
