// SPDX-License-Identifier: LicenseRef-Proprietary

// #1080: the migration adds the index of the turn of a lane step, `down` takes it back, and the planner reads it for the lookup of the lane
// step of an agent run through its Implementer session. Expand only.
import { sql } from "kysely";
import type { MigrationProvider } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { migrateToLatest } from "../migrate.ts";
import { migrationProvider } from "./index.ts";
import { migration } from "./20261118140000_workflow_step_runs_turn_index.ts";
import { createEmptyTestDatabase } from "../../test-support/test-database.ts";

const THIS = "20261118140000_workflow_step_runs_turn_index";
const NAME = "workflow_step_runs_turn_index";

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
  where schemaname = 'public' and indexname = ${sql.lit(NAME)}`;

describe("the index of the turn of a lane step", () => {
  // #1080-T100
  it("is there after the migration, is undone by `down`, and comes back by running it again", async () => {
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
    expect((await indexes.execute(db)).rows.map((row) => row.name)).toEqual([
      NAME,
    ]);

    await migration.down?.(db);
    expect((await indexes.execute(db)).rows).toEqual([]);

    await migration.up(db);
    await migration.up(db);
    expect((await indexes.execute(db)).rows).toHaveLength(1);
    await db.destroy();
  });

  // #1080-T101
  it("serves the read of the steps that hold a turn of the session of a job: the planner follows the index when a scan of the table is off the table", async () => {
    const { db } = await createEmptyTestDatabase();
    await migrateToLatest(db, migrationProvider);
    await sql`set enable_seqscan = off`.execute(db);

    // the shape the repository sends (`findLaneStepOfJob`)
    const plan = JSON.stringify(
      (
        await sql<{ "QUERY PLAN": unknown }>`explain (format json)
          select step.run_id from workflow_step_runs step
          where step.workspace_id = 'w-1'
            and step.turn_id in (
              select session_turn.id from implementer_turns session_turn
              where session_turn.workspace_id = 'w-1'
                and session_turn.session_id = (
                  select job_turn.session_id from implementer_turns job_turn
                  where job_turn.workspace_id = 'w-1' and job_turn.job_id = 'job-1'))`.execute(
          db,
        )
      ).rows,
    );

    expect(plan).toContain(NAME);
    await db.destroy();
  });
});
