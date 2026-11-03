// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment a turn started with (#818): size and script are copied into the turn when it is written, so that nothing done to
// the environment later (an edit, a delete) reaches a running or a past turn. Against a real Postgres.
import { describe, expect, it } from "vitest";
import { createImplementerEnvironmentsRepository } from "./implementer-environments-repository.ts";
import { createImplementerRepository } from "./implementer-repository.ts";
import {
  seedImplementerRepository,
  startTask,
  taskOf,
} from "../../test-support/implementer.ts";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const seed = await seedImplementerRepository(db, workspaceId, "a");
  const environments = createImplementerEnvironmentsRepository(db, workspaceId);
  const made = await environments.create(
    {
      name: "Node 22",
      vcpus: 6,
      setupScript: "  pnpm install\r\n",
      createdBy: seed.userId,
    },
    50,
  );
  if (!made.ok) throw new Error("seeding failed");
  return { db, workspaceId, seed, environments, environment: made.environment };
}

describe("the environment snapshot of a turn", () => {
  // #818-T20
  it("stores name, size and script of the environment as they were, and reads them back", async () => {
    const { db, workspaceId, seed, environment } = await setup();

    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, {
        environment: {
          id: environment.id,
          name: environment.name,
          vcpus: environment.vcpus,
          setupScript: environment.setupScript,
        },
      }),
    );

    const expected = {
      id: environment.id,
      name: "Node 22",
      vcpus: 6,
      setupScript: "  pnpm install\r\n",
    };
    expect(turn.environment).toEqual(expected);
    const read = await createImplementerRepository(
      db,
      workspaceId,
    ).getTurnByJob(turn.jobId);
    expect(read?.turn.environment).toEqual(expected);
  });

  // #818-T20
  it("is empty for a turn without an environment: the standard, as before", async () => {
    const { db, workspaceId, seed } = await setup();

    const { turn } = await startTask(db, workspaceId, taskOf(seed));

    expect(turn.environment).toBeNull();
    const row = await db
      .selectFrom("implementer_turns")
      .select([
        "environment_id",
        "environment_name",
        "environment_vcpus",
        "environment_setup_script",
      ])
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      environment_id: null,
      environment_name: null,
      environment_vcpus: null,
      environment_setup_script: null,
    });
  });

  // #818-T20
  it("keeps the turn as it was when the environment is edited or deleted afterwards", async () => {
    const { db, workspaceId, seed, environments, environment } = await setup();
    const { turn } = await startTask(
      db,
      workspaceId,
      taskOf(seed, {
        environment: {
          id: environment.id,
          name: environment.name,
          vcpus: environment.vcpus,
          setupScript: environment.setupScript,
        },
      }),
    );
    const before = await db
      .selectFrom("implementer_turns")
      .selectAll()
      .where("id", "=", turn.id)
      .executeTakeFirstOrThrow();

    await environments.update(environment.id, {
      name: "Changed",
      vcpus: 1,
      setupScript: "rm -rf /",
    });
    const unchanged = await db
      .selectFrom("implementer_turns")
      .selectAll()
      .where("id", "=", turn.id)
      .executeTakeFirstOrThrow();
    expect(unchanged).toEqual(before);

    expect(await environments.remove(environment.id)).toBe(true);
    const afterDelete = await createImplementerRepository(
      db,
      workspaceId,
    ).getTurnByJob(turn.jobId);
    expect(afterDelete?.turn.environment).toEqual({
      id: environment.id,
      name: "Node 22",
      vcpus: 6,
      setupScript: "  pnpm install\r\n",
    });
  });

  // #818-T20
  it("refuses a snapshot the database cannot hold (a size below one, a script over 64 KB) and writes nothing", async () => {
    const { db, workspaceId, seed } = await setup();
    const snapshot = { id: "e", name: "x", vcpus: 2, setupScript: "" };

    await expect(
      startTask(
        db,
        workspaceId,
        taskOf(seed, { environment: { ...snapshot, vcpus: 0 } }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      startTask(
        db,
        workspaceId,
        taskOf(seed, {
          environment: { ...snapshot, setupScript: "x".repeat(65_537) },
        }),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      await db.selectFrom("implementer_turns").selectAll().execute(),
    ).toEqual([]);
  });
});
