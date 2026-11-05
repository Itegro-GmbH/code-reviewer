// SPDX-License-Identifier: LicenseRef-Proprietary

// The result schema a task ran with and the result the agent handed in (#843): the schema is copied into the turn when it is written, the
// result is kept once and only for a turn that has a schema, and the database holds the bound of both. Against a real Postgres.
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { createImplementerRepository } from "./implementer-repository.ts";
import {
  seedImplementerRepository,
  startTask,
  taskOf,
} from "../../test-support/implementer.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { ResultSchema } from "../../workflows/result-schema.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const seed = await seedImplementerRepository(db, workspaceId, "a");
  return { db, workspaceId, seed };
}

const SCHEMA: ResultSchema = {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
};

describe("the result of a turn", () => {
  // #843-T100
  it("copies the result schema of the task into the turn and reads it back", async () => {
    const { db, workspaceId, seed } = await setup();

    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, { resultSchema: SCHEMA }),
    );

    expect(turn.resultSchema).toEqual(SCHEMA);
    expect(turn.resultValue).toBeNull();
    const read = await createImplementerRepository(
      db,
      workspaceId,
    ).getTurnByJob(turn.jobId);
    expect(read?.turn.resultSchema).toEqual(SCHEMA);
  });

  // #843-T101
  it("has none for a task without a schema: no finish tool, as before", async () => {
    const { db, workspaceId, seed } = await setup();

    const { turn } = await startTask(db, workspaceId, taskOf(seed));

    expect(turn.resultSchema).toBeNull();
    expect(turn.resultValue).toBeNull();
    const row = await db
      .selectFrom("implementer_turns")
      .select(["result_schema", "result_value"])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ result_schema: null, result_value: null });
  });

  // #843-T102
  it("keeps the result of the agent once, for a turn that has a schema", async () => {
    const { db, workspaceId, seed } = await setup();
    const sessions = createImplementerRepository(db, workspaceId);
    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, { resultSchema: SCHEMA }),
    );

    expect(await sessions.recordTurnAgentResult(turn.id, { summary: "Done." })).toBe(
      true,
    );
    expect(await sessions.recordTurnAgentResult(turn.id, { summary: "Other" })).toBe(
      false,
    );

    const read = await sessions.getTurnByJob(turn.jobId);
    expect(read?.turn.resultValue).toEqual({ summary: "Done." });
  });

  // #843-T103
  it("keeps no result for a turn without a schema", async () => {
    const { db, workspaceId, seed } = await setup();
    const sessions = createImplementerRepository(db, workspaceId);
    const { turn } = await startTask(db, workspaceId, taskOf(seed));

    expect(await sessions.recordTurnAgentResult(turn.id, { summary: "x" })).toBe(
      false,
    );
    expect((await sessions.getTurnByJob(turn.jobId))?.turn.resultValue).toBeNull();
  });

  // #843-T104
  it("holds the bounds in the database: a result needs a schema, and both are bounded", async () => {
    const { db, workspaceId, seed } = await setup();
    const { turn } = await startTask(db, workspaceId, taskOf(seed));

    await expect(
      sql`update implementer_turns set result_value = '{}' where id = ${turn.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_turns_result_check/);
    await expect(
      sql`update implementer_turns set result_schema = ${"x".repeat(131073)} where id = ${turn.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_turns_result_check/);
    await expect(
      sql`update implementer_turns set result_schema = '{}', result_value = ${"x".repeat(262145)} where id = ${turn.id}`.execute(
        db,
      ),
    ).rejects.toThrow(/implementer_turns_result_check/);
  });

  // #843-T105
  it("does not let another workspace keep a result with this workspace's turn", async () => {
    const { db, workspaceId, seed } = await setup();
    const other = await addWorkspace(db, "other");
    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, { resultSchema: SCHEMA }),
    );

    const kept = await createImplementerRepository(
      db,
      other,
    ).recordTurnAgentResult(turn.id, { summary: "hijacked" });

    expect(kept).toBe(false);
    const read = await createImplementerRepository(
      db,
      workspaceId,
    ).getTurnByJob(turn.jobId);
    expect(read?.turn.resultValue).toBeNull();
  });
});
