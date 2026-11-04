// SPDX-License-Identifier: LicenseRef-Proprietary

// Choosing a profile when a task is sent (#843), with the real service, queue and a real Postgres: the version's model and cost limit
// become the turn's own, its instructions and push right are copied into the turn (what the profile says at that moment is what the
// task runs with, whatever is done to it afterwards), a task without a profile is exactly the task of before, and a profile that is
// not this workspace's, is archived or has no such version starts nothing.
import { describe, expect, it } from "vitest";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import type { ImplementerModels } from "./models.ts";
import { ImplementerError } from "./errors.ts";
import {
  USER,
  startImplementerHarness,
} from "../test-support/implementer-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";

const CONTENT = {
  description: "Reads a branch.",
  model: { entryId: "entry-profile" },
  instructions: "Review only.\nDo not edit files.",
  costLimitCents: 200,
  canPush: false,
  defaultResult: null,
};

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

async function setup(
  options: Parameters<typeof startImplementerHarness>[0] = {},
) {
  const app = await startImplementerHarness(options);
  const made = await app.profiles.create(
    { name: "reviewer", content: CONTENT, createdBy: USER.id },
    100,
  );
  if (!made.ok) throw new Error("seeding failed");
  return { ...app, profile: made.profile };
}

/** The body of a task with a profile: it names no model and no cost limit. */
function withProfile(
  app: Awaited<ReturnType<typeof setup>>,
  profile: string,
  overrides: Record<string, unknown> = {},
) {
  const { model: _model, ...rest } = app.body(overrides);
  void _model;
  return { ...rest, profile };
}

async function turnOf(
  app: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
) {
  return app.h.db
    .selectFrom("implementer_turns")
    .selectAll()
    .where("session_id", "=", sessionId)
    .executeTakeFirstOrThrow();
}

describe("a task with a profile", () => {
  // #843-T170
  it("takes the model and the cost limit of the profile's newest version as the turn's own, and copies instructions and push right", async () => {
    const app = await setup();

    const started = await app.service.startTask(
      USER,
      withProfile(app, "reviewer"),
    );

    expect(await turnOf(app, started.sessionId)).toMatchObject({
      model_choice: JSON.stringify({ entryId: "entry-profile" }),
      cost_limit_cents: 200,
      profile_id: app.profile.id,
      profile_name: "reviewer",
      profile_version: 1,
      profile_instructions: "Review only.\nDo not edit files.",
      profile_can_push: 0,
    });
  });

  // #843-T171
  it("runs the version the body pins, and the newest without a version", async () => {
    const app = await setup();
    await app.profiles.saveVersion(
      app.profile.id,
      {
        content: {
          ...CONTENT,
          model: { provider: "anthropic", model: "m2" },
          instructions: "second",
          costLimitCents: null,
          canPush: true,
        },
        createdBy: USER.id,
      },
      100,
    );

    const pinned = await app.service.startTask(
      USER,
      withProfile(app, "reviewer@1"),
    );
    const newest = await app.service.startTask(
      USER,
      withProfile(app, "reviewer", {
        branch: "implementer/other",
        clientRequestId: "request-2",
      }),
    );

    expect(await turnOf(app, pinned.sessionId)).toMatchObject({
      profile_version: 1,
      profile_instructions: "Review only.\nDo not edit files.",
      cost_limit_cents: 200,
    });
    expect(await turnOf(app, newest.sessionId)).toMatchObject({
      profile_version: 2,
      profile_instructions: "second",
      profile_can_push: 1,
      cost_limit_cents: null,
      model_choice: JSON.stringify({ provider: "anthropic", model: "m2" }),
    });
  });

  // #843-T172
  it("is the task of before without a profile: nothing is stored, the platform's defaults apply", async () => {
    const app = await setup();

    const started = await app.service.startTask(USER, app.body());

    expect(await turnOf(app, started.sessionId)).toMatchObject({
      profile_id: null,
      profile_name: null,
      profile_version: null,
      profile_instructions: null,
      profile_can_push: null,
      model_choice: JSON.stringify({ entryId: "entry-1" }),
    });
  });

  // #843-T173
  it("gives the profile and the environment separately: both are in the turn, and the profile holds nothing of the environment", async () => {
    const app = await setup();
    const made = await createImplementerEnvironmentsRepository(
      app.h.db,
      app.h.workspaceId,
    ).create(
      { name: "Node 22", vcpus: 6, setupScript: "pnpm i", createdBy: USER.id },
      50,
    );
    if (!made.ok) throw new Error("seeding failed");

    const started = await app.service.startTask(
      USER,
      withProfile(app, "reviewer", { environmentId: made.environment.id }),
    );

    expect(await turnOf(app, started.sessionId)).toMatchObject({
      profile_name: "reviewer",
      environment_name: "Node 22",
      environment_vcpus: 6,
      environment_setup_script: "pnpm i",
    });
  });

  // #843-T174
  it("refuses a profile that is not there, belongs to another workspace, is archived or has no such version, and writes nothing", async () => {
    const app = await setup();
    const otherId = await addWorkspace(app.h.db, "other");
    await createProfilesRepository(app.h.db, otherId).create(
      { name: "theirs", content: CONTENT, createdBy: USER.id },
      100,
    );
    const archived = await app.profiles.create(
      { name: "old", content: CONTENT, createdBy: USER.id },
      100,
    );
    if (!archived.ok) throw new Error("seeding failed");
    await app.profiles.archive(archived.profile.id, 100);

    for (const ref of ["nobody", "theirs", "old", "reviewer@2", "reviewer@9"]) {
      const failure = await failureOf(
        app.service.startTask(USER, withProfile(app, ref)),
      );
      expect(failure).toBeInstanceOf(ImplementerError);
      expect(failure).toMatchObject({ code: "IMPLEMENTER_PROFILE_NOT_FOUND" });
    }
    expect(await app.counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #843-T175
  it("checks the profile's model again at the start: the world may have changed since the version was saved", async () => {
    const refusing: ImplementerModels = {
      options: async () => ({ keyMode: "managed", entries: [] }),
      check: async (choice) =>
        "entryId" in choice && choice.entryId === "entry-profile"
          ? "entry_not_released"
          : null,
    };
    const app = await setup({ models: refusing });

    const failure = await failureOf(
      app.service.startTask(USER, withProfile(app, "reviewer")),
    );

    expect(failure).toMatchObject({
      code: "IMPLEMENTER_MODEL_NOT_ALLOWED",
      reason: "entry_not_released",
    });
    expect(await app.counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #843-T176
  it("holds the profile's cost limit to the operator's maximum at the start, as it holds the form's", async () => {
    const app = await setup({ operatorCostLimitCents: 150 });

    const failure = await failureOf(
      app.service.startTask(USER, withProfile(app, "reviewer")),
    );

    expect(failure).toMatchObject({
      code: "EXCEEDS_OPERATOR_MAXIMUM",
      maximumCents: 150,
    });
    expect(await app.counts()).toEqual({ jobs: 0, sessions: 0, turns: 0 });
  });

  // #843-T177
  it("keeps the turn as it was when the profile gets a new version, is archived or the like", async () => {
    const app = await setup();
    const started = await app.service.startTask(
      USER,
      withProfile(app, "reviewer"),
    );

    await app.profiles.saveVersion(
      app.profile.id,
      {
        content: { ...CONTENT, instructions: "changed", canPush: true },
        createdBy: USER.id,
      },
      100,
    );
    await app.profiles.archive(app.profile.id, 100);

    expect(await turnOf(app, started.sessionId)).toMatchObject({
      profile_version: 1,
      profile_instructions: "Review only.\nDo not edit files.",
      profile_can_push: 0,
    });
  });

  // #843-T178
  it("answers a repeat of a request with the first task, also after the profile got a new version; another profile or version is another task", async () => {
    const app = await setup();
    const first = await app.service.startTask(
      USER,
      withProfile(app, "reviewer"),
    );
    await app.profiles.saveVersion(
      app.profile.id,
      { content: { ...CONTENT, instructions: "v2" }, createdBy: USER.id },
      100,
    );
    await app.profiles.create(
      { name: "writer", content: CONTENT, createdBy: USER.id },
      100,
    );

    const again = await app.service.startTask(
      USER,
      withProfile(app, "reviewer"),
    );
    const pinnedSame = await app.service.startTask(
      USER,
      withProfile(app, "reviewer@1"),
    );
    const pinnedOther = await failureOf(
      app.service.startTask(USER, withProfile(app, "reviewer@2")),
    );
    const otherProfile = await failureOf(
      app.service.startTask(USER, withProfile(app, "writer")),
    );
    const noProfile = await failureOf(app.service.startTask(USER, app.body()));

    expect(again).toEqual({ ...first, created: false });
    expect(pinnedSame).toEqual({ ...first, created: false });
    for (const failure of [pinnedOther, otherProfile, noProfile])
      expect(failure).toMatchObject({
        code: "IMPLEMENTER_REQUEST_REUSED",
        runId: first.runId,
      });
    expect((await app.counts()).turns).toBe(1);
  });

  // #843-T179
  it("refuses a task that names a profile and a model", async () => {
    const app = await setup();

    const failure = await failureOf(
      app.service.startTask(USER, { ...app.body(), profile: "reviewer" }),
    );

    expect(failure).toMatchObject({
      code: "IMPLEMENTER_REQUEST_INVALID",
      issues: [{ field: "model", code: "not_with_profile" }],
    });
  });
});
