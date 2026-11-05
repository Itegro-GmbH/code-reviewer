// SPDX-License-Identifier: LicenseRef-Proprietary

// Choosing an environment that runs on a runner when a task is sent (#854), with the real service, queue and a real Postgres: the
// labels are copied into the turn (and nothing of a size, script or network rule), a managed model is refused with a clear code before
// anything is written, a model of the workspace's own key is accepted, the same request twice is one task, and the job is queued
// for a runner and not for the Dispatcher.
import { describe, expect, it } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createImplementerRepository } from "../db/repositories/implementer-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import {
  USER,
  startImplementerHarness,
} from "../test-support/implementer-harness.ts";

const OWN_MODEL = { provider: "anthropic", model: "claude-sonnet-5-5" };

async function setup() {
  const app = await startImplementerHarness();
  const environments = createImplementerEnvironmentsRepository(
    app.h.db,
    app.h.workspaceId,
  );
  const made = await environments.create(
    {
      kind: "runner",
      name: "GPU box",
      labels: ["linux", "gpu"],
      createdBy: USER.id,
    },
    50,
  );
  if (!made.ok) throw new Error("seeding failed");
  return { ...app, environments, environment: made.environment };
}

describe("a task with an environment that runs on a runner", () => {
  // #854-T210
  it("copies the labels into the turn, with no size, script or network rule", async () => {
    const { service, body, environment, h } = await setup();

    const started = await service.startTask(
      USER,
      body({ environmentId: environment.id, model: OWN_MODEL }),
    );

    const turn = await h.db
      .selectFrom("implementer_turns")
      .selectAll()
      .where("session_id", "=", started.sessionId)
      .executeTakeFirstOrThrow();
    expect(turn).toMatchObject({
      environment_id: environment.id,
      environment_name: "GPU box",
      environment_kind: "runner",
      environment_labels: "gpu\nlinux",
      environment_vcpus: null,
      environment_setup_script: "",
      environment_network_mode: "off",
      environment_network_hosts: "",
    });
    const read = await createImplementerRepository(
      h.db,
      h.workspaceId,
    ).getTurnByJob(started.runId);
    expect(read?.turn.runnerEnvironment).toEqual({
      id: environment.id,
      name: "GPU box",
      labels: ["gpu", "linux"],
    });
    // It is not a hosted environment: the Dispatcher launches no VM for it.
    expect(read?.turn.environment).toBeNull();
  });

  // #854-T211
  it("is refused for a managed model with its own code, before a session, a turn or a job exists", async () => {
    const { service, body, environment, h } = await setup();

    const refusal = await service
      .startTask(
        USER,
        body({ environmentId: environment.id, model: { entryId: "entry-1" } }),
      )
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(refusal).toMatchObject({ code: "IMPLEMENTER_RUNNER_NEEDS_OWN_KEY" });
    expect(
      await h.db.selectFrom("implementer_sessions").select("id").execute(),
    ).toEqual([]);
    expect(await h.db.selectFrom("jobs").select("id").execute()).toEqual([]);
  });

  // #854-T212
  it("is one task when the same request is sent twice", async () => {
    const { service, body, environment } = await setup();
    const request = body({
      environmentId: environment.id,
      model: OWN_MODEL,
      clientRequestId: "request-9",
    });

    const first = await service.startTask(USER, request);
    const again = await service.startTask(USER, request);

    expect(again).toMatchObject({ runId: first.runId, created: false });
  });

  // #854-T213
  it("is queued for a runner: the Dispatcher is never told of it and no listing of the sender holds it", async () => {
    const { service, body, environment, h } = await setup();
    const dispatches = createJobDispatchesRepository(h.db);
    const hosted = await service.startTask(
      USER,
      body({
        model: OWN_MODEL,
        branch: "implementer/hosted",
        clientRequestId: "r-h",
      }),
    );
    const runner = await service.startTask(
      USER,
      body({
        environmentId: environment.id,
        model: OWN_MODEL,
        branch: "implementer/runner",
        clientRequestId: "r-r",
      }),
    );
    const at = new Date(Date.now() + 60_000);

    expect(await dispatches.create(runner.runId, at)).toBe(false);
    expect(await dispatches.create(hosted.runId, at)).toBe(true);
    expect((await dispatches.listDue(at, 10)).map((job) => job.jobId)).toEqual([
      hosted.runId,
    ]);
    expect(await dispatches.dueJob(runner.runId, at)).toBeUndefined();
    expect(await dispatches.dueJob(hosted.runId, at)).toMatchObject({
      jobId: hosted.runId,
    });
    expect(await dispatches.listWaiting(at, 10)).toEqual([]);
    expect(await dispatches.get(runner.runId)).toBeUndefined();
  });
});
