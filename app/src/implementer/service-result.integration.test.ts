// SPDX-License-Identifier: LicenseRef-Proprietary

// The result schema of a task when it is sent (#843), with the real service, queue and a real Postgres: the task may bring its own,
// a profile may bring a default, the task's own wins, and what is in force when the task is sent is copied into the turn. A task with
// neither runs without a finish tool, exactly as before.
import { describe, expect, it } from "vitest";
import { ImplementerError } from "./errors.ts";
import {
  USER,
  startImplementerHarness,
} from "../test-support/implementer-harness.ts";

const OWN = {
  type: "object",
  required: ["summary"],
  properties: { summary: { type: "string" } },
};
const DEFAULT = {
  type: "object",
  required: ["findings"],
  properties: { findings: { type: "array", items: { type: "string" } } },
};
const CONTENT = {
  description: "Reads a branch.",
  model: { entryId: "entry-profile" },
  instructions: "",
  costLimitCents: 200,
  canPush: false,
  defaultResult: JSON.stringify(DEFAULT),
};

async function setup() {
  const app = await startImplementerHarness();
  const made = await app.profiles.create(
    { name: "reviewer", content: CONTENT, createdBy: USER.id },
    100,
  );
  if (!made.ok) throw new Error("seeding failed");
  return app;
}

function withProfile(
  app: Awaited<ReturnType<typeof setup>>,
  overrides: Record<string, unknown> = {},
) {
  const { model: _model, ...rest } = app.body(overrides);
  void _model;
  return { ...rest, profile: "reviewer" };
}

async function turnOf(
  app: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
) {
  return app.h.db
    .selectFrom("implementer_turns")
    .select(["result_schema", "result_value"])
    .where("session_id", "=", sessionId)
    .executeTakeFirstOrThrow();
}

describe("a task with a result schema", () => {
  // #843-T120
  it("copies the schema of the body into the turn", async () => {
    const app = await setup();

    const started = await app.service.startTask(
      USER,
      app.body({ result: OWN }),
    );

    const turn = await turnOf(app, started.sessionId);
    expect(JSON.parse(turn.result_schema ?? "null")).toEqual(OWN);
    expect(turn.result_value).toBeNull();
  });

  // #843-T121
  it("takes the default result schema of the profile's version when the body has none", async () => {
    const app = await setup();

    const started = await app.service.startTask(USER, withProfile(app));

    expect(
      JSON.parse(
        (await turnOf(app, started.sessionId)).result_schema ?? "null",
      ),
    ).toEqual(DEFAULT);
  });

  // #843-T122
  it("prefers the schema of the body to the default of the profile", async () => {
    const app = await setup();

    const started = await app.service.startTask(
      USER,
      withProfile(app, { result: OWN }),
    );

    expect(
      JSON.parse(
        (await turnOf(app, started.sessionId)).result_schema ?? "null",
      ),
    ).toEqual(OWN);
  });

  // #843-T123
  it("runs without a finish tool when neither the body nor the profile has a schema: the task of before", async () => {
    const app = await startImplementerHarness();

    const started = await app.service.startTask(USER, app.body());

    expect(await turnOf(app, started.sessionId)).toEqual({
      result_schema: null,
      result_value: null,
    });
  });

  // #843-T124
  it("copies the default as it was when the task was sent: a later version of the profile changes nothing", async () => {
    const app = await setup();
    const started = await app.service.startTask(USER, withProfile(app));
    const [listed] = await app.profiles.list();
    expect(listed).toBeDefined();
    await app.profiles.saveVersion(
      listed?.id ?? "",
      {
        content: { ...CONTENT, defaultResult: JSON.stringify(OWN) },
        createdBy: USER.id,
      },
      100,
    );

    expect(
      JSON.parse(
        (await turnOf(app, started.sessionId)).result_schema ?? "null",
      ),
    ).toEqual(DEFAULT);
  });

  // #843-T125
  it("refuses a schema the validator refuses and starts nothing", async () => {
    const app = await setup();

    const refused = await app.service
      .startTask(USER, app.body({ result: { type: "object", properties: {} } }))
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(refused).toBeInstanceOf(ImplementerError);
    expect(refused).toMatchObject({
      code: "IMPLEMENTER_REQUEST_INVALID",
      issues: [{ field: "result", code: "invalid" }],
    });
    expect(
      await app.h.db.selectFrom("implementer_turns").selectAll().execute(),
    ).toEqual([]);
  });

  // #843-T126
  it("gives a repeated request the first task back, and refuses the same request id with another schema", async () => {
    const app = await setup();
    const body = app.body({ result: OWN });
    const first = await app.service.startTask(USER, body);

    const again = await app.service.startTask(USER, body);
    const other = await app.service
      .startTask(USER, { ...body, result: DEFAULT })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(again).toMatchObject({ created: false, runId: first.runId });
    expect(other).toMatchObject({ code: "IMPLEMENTER_REQUEST_REUSED" });
  });
});
