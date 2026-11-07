// SPDX-License-Identifier: LicenseRef-Proprietary

// #924: the migration adds the partial indexes the ToDo list reads through, and `down` takes them back. Expand only.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261107220000_todo_list_indexes.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261107220000_todo_list_indexes";
const NAMES = [
  "workflow_runs_waiting_index",
  "workflow_step_runs_answered_ask_index",
  "workflow_step_runs_pull_request_index",
];

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

describe("the indexes of the ToDo list", () => {
  // #924-T12
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

  // #924-T13
  it("cover the three queries of the list: the planner reads the partial index when a scan of the table is off the table", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(
      db,
      upTo((name) => name <= THIS),
    );
    const plan = async (query: ReturnType<typeof sql>) =>
      JSON.stringify(
        (
          await sql<{
            "QUERY PLAN": unknown;
          }>`explain (format json) ${query}`.execute(db)
        ).rows,
      );

    await sql`set enable_seqscan = off`.execute(db);
    const answered = await plan(
      sql`select * from workflow_step_runs where workspace_id = 'w-1'
        and ask is not null and (ask like '%"state":"answered"%' or ask like '%"state":"resumed"%')
        order by created_at desc, id limit 200`,
    );
    const pullRequests = await plan(
      sql`select * from workflow_step_runs where workspace_id = 'w-1'
        and kind = 'action' and status = 'succeeded' and output like '%/pull/%'
        order by created_at desc, id limit 200`,
    );

    // the runs that wait, as a prepared statement with a generic plan (a parameter for the workspace, the status written as a constant)
    await sql`set plan_cache_mode = force_generic_plan`.execute(db);
    await sql`prepare waiting_runs (text) as select * from workflow_runs
      where workspace_id = $1 and status = 'waiting' order by updated_at desc, id limit 200`.execute(
      db,
    );
    const waiting = await plan(sql`execute waiting_runs ('w-1')`);

    expect(waiting).toContain("workflow_runs_waiting_index");
    expect(answered).toContain("workflow_step_runs_answered_ask_index");
    expect(pullRequests).toContain("workflow_step_runs_pull_request_index");
    await db.destroy();
  });
});
