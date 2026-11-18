// SPDX-License-Identifier: LicenseRef-Proprietary

// #1078: the migration adds the two indexes the list of the lane runs of a workspace reads through, `down` takes them back, and the planner
// reads them for the two queries of the list. Expand only.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261118120000_workflow_runs_workspace_list_indexes.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261118120000_workflow_runs_workspace_list_indexes";
const NAMES = ["workflow_runs_active_index", "workflow_runs_workspace_index"];

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

const indexes = sql<{
  name: string;
}>`select indexname as name from pg_indexes
  where schemaname = 'public' and indexname in (${sql.join(NAMES.map((name) => sql.lit(name)))})
  order by indexname`;

describe("the indexes of the list of lane runs", () => {
  // #1078-T100
  it("are there after the migration, are undone by `down`, and come back by running it again", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name < THIS),
    );
    expect((await indexes.execute(db)).rows).toEqual([]);

    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    expect((await indexes.execute(db)).rows.map((row) => row.name)).toEqual(
      NAMES.toSorted(),
    );

    await migration.down?.(db);
    expect((await indexes.execute(db)).rows).toEqual([]);

    await migration.up(db);
    await migration.up(db);
    expect((await indexes.execute(db)).rows).toHaveLength(NAMES.length);
    await db.destroy();
  });

  // #1078-T101
  it("cover the two reads of the list: the planner follows the index, not a sort of the runs, when a scan of the table is off the table", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    const plan = async (query: ReturnType<typeof sql>) =>
      JSON.stringify(
        (
          await sql<{
            "QUERY PLAN": unknown;
          }>`explain (format json) ${query}`.execute(db)
        ).rows,
      );

    await sql`set enable_seqscan = off`.execute(db);
    // the shape and the constants the repository sends (`listWorkspaceRuns`)
    const active = await plan(
      sql`select * from workflow_runs where workspace_id = 'w-1' and status in ('running', 'waiting')
        order by created_at desc, id desc limit 26`,
    );
    const ended = await plan(
      sql`select * from workflow_runs where workspace_id = 'w-1' and status not in ('running', 'waiting')
        order by created_at desc, id desc limit 26`,
    );

    expect(active).toContain("workflow_runs_active_index");
    expect(active).not.toContain('"Node Type":"Sort"');
    expect(ended).toContain("workflow_runs_workspace_index");
    expect(ended).not.toContain('"Node Type":"Sort"');
    await db.destroy();
  });
});
