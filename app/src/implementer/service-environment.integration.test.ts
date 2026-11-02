// SPDX-License-Identifier: LicenseRef-Proprietary

// Choosing an environment when a task is sent (#818), with the real service, queue and a real Postgres: the environment of the
// workspace is copied into the turn (size and script as they are at that moment), a task without one is exactly the task of
// before, and an environment that is not this workspace's, or not there, starts nothing.
import { describe, expect, it } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import {
  USER,
  startImplementerHarness,
} from "../test-support/implementer-harness.ts";

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

async function setup() {
  const app = await startImplementerHarness();
  const environments = createImplementerEnvironmentsRepository(
    app.h.db,
    app.h.workspaceId,
  );
  const made = await environments.create(
    {
      name: "Node 22",
      vcpus: 6,
      setupScript: "  pnpm install\r\n",
      createdBy: USER.id,
    },
    50,
  );
  if (!made.ok) throw new Error("seeding failed");
  return { ...app, environments, environment: made.environment };
}

describe("a task with an environment", () => {
  // #818-T21
  it("copies name, size and script of the chosen environment into the turn", async () => {
    const { service, body, environment, h } = await setup();

    const started = await service.startTask(
      USER,
      body({ environmentId: environment.id }),
    );

    const turn = await h.db
      .selectFrom("implementer_turns")
      .selectAll()
      .where("session_id", "=", started.sessionId)
      .executeTakeFirstOrThrow();
    expect(turn).toMatchObject({
      environment_id: environment.id,
      environment_name: "Node 22",
      environment_vcpus: 6,
      environment_setup_script: "  pnpm install\r\n",
    });
  });

  // #818-T21
  it("is the task of before without an environment: nothing is stored, the standard applies", async () => {
    const { service, body, h } = await setup();

    const started = await service.startTask(USER, body());
    const withNull = await service.startTask(
      USER,
      body({
        environmentId: null,
        branch: "implementer/other",
        clientRequestId: "request-2",
      }),
    );

    for (const sessionId of [started.sessionId, withNull.sessionId]) {
      const turn = await h.db
        .selectFrom("implementer_turns")
        .select([
          "environment_id",
          "environment_name",
          "environment_vcpus",
          "environment_setup_script",
        ])
        .where("session_id", "=", sessionId)
        .executeTakeFirstOrThrow();
      expect(turn).toEqual({
        environment_id: null,
        environment_name: null,
        environment_vcpus: null,
        environment_setup_script: null,
      });
    }
  });

  // #818-T21
  it("is not touched by a later edit or delete of the environment", async () => {
    const { service, body, environment, environments, h } = await setup();
    const started = await service.startTask(
      USER,
      body({ environmentId: environment.id }),
    );

    await environments.update(environment.id, {
      name: "Edited",
      vcpus: 1,
      setupScript: "echo changed",
    });
    await environments.remove(environment.id);

    const turn = await h.db
      .selectFrom("implementer_turns")
      .select([
        "environment_name",
        "environment_vcpus",
        "environment_setup_script",
      ])
      .where("session_id", "=", started.sessionId)
      .executeTakeFirstOrThrow();
    expect(turn).toEqual({
      environment_name: "Node 22",
      environment_vcpus: 6,
      environment_setup_script: "  pnpm install\r\n",
    });
  });

  // #818-T21
  it("refuses an environment that does not exist, and one of another workspace, with the same code and writes nothing", async () => {
    const { service, body, h, counts } = await setup();
    const otherId = await addWorkspace(h.db, "other");
    const foreign = await createImplementerEnvironmentsRepository(
      h.db,
      otherId,
    ).create(
      { name: "Foreign", vcpus: 8, setupScript: "x", createdBy: USER.id },
      50,
    );
    if (!foreign.ok) throw new Error("seeding failed");

    for (const environmentId of [
      "no-such-environment",
      foreign.environment.id,
    ]) {
      expect(
        await failureOf(service.startTask(USER, body({ environmentId }))),
      ).toMatchObject({ code: "IMPLEMENTER_ENVIRONMENT_NOT_FOUND" });
    }
    expect(await counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #818-T21
  it("refuses an environment id that is not text, is empty or has a NUL byte, as an invalid request", async () => {
    const { service, body } = await setup();

    for (const environmentId of [5, "", "a\u0000b", "x".repeat(300)])
      expect(
        await failureOf(service.startTask(USER, body({ environmentId }))),
      ).toMatchObject({
        code: "IMPLEMENTER_REQUEST_INVALID",
        issues: [{ field: "environmentId", code: expect.any(String) }],
      });
  });

  // #818-T21
  it("gives the first task back for the same request, and a conflict for the same id with another environment", async () => {
    const { service, body, environment, environments, counts } = await setup();
    const other = await environments.create(
      { name: "Other", vcpus: 2, setupScript: "", createdBy: USER.id },
      50,
    );
    if (!other.ok) throw new Error("seeding failed");
    const first = await service.startTask(
      USER,
      body({ environmentId: environment.id }),
    );

    const again = await service.startTask(
      USER,
      body({ environmentId: environment.id }),
    );
    const changed = await failureOf(
      service.startTask(USER, body({ environmentId: other.environment.id })),
    );
    const removed = await failureOf(service.startTask(USER, body()));

    expect(again).toEqual({ ...first, created: false });
    expect(changed).toMatchObject({
      code: "IMPLEMENTER_REQUEST_REUSED",
      runId: first.runId,
    });
    expect(removed).toMatchObject({ code: "IMPLEMENTER_REQUEST_REUSED" });
    expect((await counts()).turns).toBe(1);
  });

  // #818-T21
  it("answers the retry of a task whose environment was deleted since with the first task, not with 'not found'", async () => {
    const { service, body, environment, environments } = await setup();
    const first = await service.startTask(
      USER,
      body({ environmentId: environment.id }),
    );
    await environments.remove(environment.id);

    const again = await service.startTask(
      USER,
      body({ environmentId: environment.id }),
    );

    expect(again).toEqual({ ...first, created: false });
  });
});
