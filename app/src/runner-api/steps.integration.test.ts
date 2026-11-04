// SPDX-License-Identifier: LicenseRef-Proprietary

// The steps of a turn of the Implementer through the runner API and the Worker API (#745, live view): the records a running
// turn sends are stored one row for each part, the higher `seq` wins, the claim is proved on every call without extending the
// lease, only a turn of the Implementer takes steps, a turn is bounded on the app's side too, and what is stored is cleaned like
// the result of any job. The runner side (the transport) is a later step: the test sends what that transport will.
import { describe, expect, it } from "vitest";
import {
  MAX_STEP_BYTES_PER_TURN,
  MAX_STEPS_PER_TURN,
  createImplementerStepsRepository,
} from "../db/repositories/implementer-steps-repository.ts";
import { createUsageRecordsRepository } from "../db/repositories/usage-records-repository.ts";
import { sha } from "../test-support/jobs.ts";
import {
  TEST_LLM_API_KEY,
  TEST_RUNNER_TOKEN,
  startRunnerApiHarness,
} from "../test-support/runner-api-harness.ts";
import { createContractValidator } from "../test-support/runner-contract.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import type { StepRecord } from "./contract.ts";

const IMPLEMENTER = ["implementer"] as const;
const contract = createContractValidator();
const workerContract = createContractValidator("worker-api.v1.json");
const GHP = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");

const text = (partId: string, seq: number, body = `Thinking ${partId}`) =>
  ({
    kind: "text",
    partId,
    seq,
    startedAt: 1_793_793_600_000,
    endedAt: 1_793_793_601_000,
    text: body,
    bytes: body.length,
  }) satisfies StepRecord;

const tool = (
  partId: string,
  seq: number,
  status: "running" | "completed" | "error",
  extra: Partial<StepRecord> = {},
) =>
  ({
    kind: "tool",
    partId,
    seq,
    tool: "bash",
    status,
    title: "Run the tests",
    input: '{"command":"npm test"}',
    ...extra,
  }) satisfies StepRecord;

const step = (partId: string, seq: number, cost = 0.0123) =>
  ({
    kind: "step",
    partId,
    seq,
    reason: "tool-calls",
    tokens: {
      input: 100,
      output: 20,
      reasoning: 5,
      cacheRead: 80,
      cacheWrite: 0,
    },
    cost,
  }) satisfies StepRecord;

async function start() {
  const h = await startRunnerApiHarness();
  await addUser(h.db, "user-1");
  let counter = 0;
  const steps = createImplementerStepsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  );
  /** A turn that a runner holds: queued, claimed with the engine `implementer`, with the per-job credential of a Dispatcher's claim. */
  async function running() {
    counter += 1;
    h.clock.advance(1);
    const enqueued = await h.queue.enqueueImplementerTurn({
      repositoryId: h.repositoryId,
      baseBranch: "main",
      baseSha: sha("a"),
      branch: `implementer/s${String(counter)}`,
      instruction: "Add a health endpoint.",
      modelChoice: { entryId: "entry-1" },
      costLimitCents: null,
      createdBy: "user-1",
      actorLogin: "octocat",
      clientRequestId: `request-${String(counter)}`,
    });
    const claimed = await h.queue.claimNext("runner-a", IMPLEMENTER, {
      workerCredential: true,
    });
    if (claimed === null || claimed.job.id !== enqueued.job.id)
      throw new Error("the turn was not claimed");
    return {
      jobId: claimed.job.id,
      leaseToken: claimed.leaseToken,
      credential: claimed.credential ?? "",
    };
  }
  const send = (
    turn: { jobId: string; leaseToken: string },
    records: StepRecord[],
  ) => h.steps(turn.jobId, { leaseToken: turn.leaseToken, records });
  const rows = (jobId: string) =>
    h.db
      .selectFrom("implementer_turn_steps")
      .selectAll()
      .where("job_id", "=", jobId)
      .orderBy("ordinal")
      .execute();
  return { h, steps, running, send, rows };
}

describe("the steps call of the runner API", () => {
  // #745-T10
  it("stores the records of a running turn, one row for each part, and answers with the counts", async () => {
    const { h, running, send, rows, steps } = await start();
    const turn = await running();
    const records = [
      text("prt_1", 1),
      tool("prt_2", 2, "completed", { startedAt: 5, endedAt: 9 }),
      step("prt_3", 3),
    ];

    const response = await send(turn, records);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toStrictEqual({ version: 1, stored: 3, stale: 0, dropped: 0 });
    expect(contract.check("StepsResponse", body)).toStrictEqual({
      valid: true,
      errors: "",
    });
    const stored = await rows(turn.jobId);
    expect(
      stored.map((row) => [row.part_id, row.seq, row.ordinal, row.kind]),
    ).toStrictEqual([
      ["prt_1", 1, 1, "text"],
      ["prt_2", 2, 2, "tool"],
      ["prt_3", 3, 3, "step"],
    ]);
    expect(stored.every((row) => row.workspace_id === h.workspaceId)).toBe(
      true,
    );
    expect(JSON.parse(stored[1]?.payload ?? "")).toStrictEqual({
      startedAt: 5,
      endedAt: 9,
      tool: "bash",
      status: "completed",
      title: "Run the tests",
      input: '{"command":"npm test"}',
    });
    // The payload holds neither the kind, the part id nor the seq: the columns do.
    expect(stored[0]?.payload).not.toContain("partId");
    expect(stored[0]?.payload).not.toContain('"seq"');
    expect(
      (await steps.listAfter(turn.jobId, 1, 10)).map((row) => row.partId),
    ).toStrictEqual(["prt_2", "prt_3"]);
  });

  // #745-T11
  it("is idempotent: the same batch again changes nothing", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    const records = [text("prt_1", 1), tool("prt_2", 2, "running")];
    await send(turn, records);
    const before = await rows(turn.jobId);
    h.clock.advance(5_000);

    const again = await send(turn, records);

    expect(again.status).toBe(200);
    expect(await again.json()).toStrictEqual({
      version: 1,
      stored: 0,
      stale: 2,
      dropped: 0,
    });
    expect(await rows(turn.jobId)).toStrictEqual(before);
  });

  // #745-T12
  it("lets a part change: the higher seq replaces the record and keeps the place of the part", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    await send(turn, [tool("prt_2", 2, "running"), text("prt_3", 3)]);
    h.clock.advance(5_000);

    const response = await send(turn, [
      tool("prt_2", 7, "completed", { endedAt: 99 }),
    ]);

    expect(await response.json()).toMatchObject({ stored: 1, stale: 0 });
    const stored = await rows(turn.jobId);
    expect(
      stored.map((row) => [row.part_id, row.seq, row.ordinal]),
    ).toStrictEqual([
      ["prt_2", 7, 2],
      ["prt_3", 3, 3],
    ]);
    expect(JSON.parse(stored[0]?.payload ?? "")).toMatchObject({
      status: "completed",
      endedAt: 99,
    });
    expect(stored[0]?.updated_at).not.toBe(stored[0]?.created_at);
  });

  // #745-T12
  it("does not let an older seq overwrite a newer one, in a later batch or behind it in the same batch", async () => {
    const { running, send, rows } = await start();
    const turn = await running();
    await send(turn, [tool("prt_2", 9, "completed")]);

    const later = await send(turn, [tool("prt_2", 4, "running")]);
    const together = await send(turn, [
      tool("prt_5", 8, "completed"),
      tool("prt_5", 6, "running"),
    ]);

    expect(await later.json()).toMatchObject({ stored: 0, stale: 1 });
    expect(await together.json()).toMatchObject({ stored: 1, stale: 1 });
    const stored = await rows(turn.jobId);
    // Listed by the place of the part: the seq of its first record.
    expect(stored.map((row) => [row.part_id, row.seq])).toStrictEqual([
      ["prt_5", 8],
      ["prt_2", 9],
    ]);
    for (const row of stored)
      expect(JSON.parse(row.payload)).toMatchObject({ status: "completed" });
  });

  // #745-T12
  it("keeps the higher seq when two batches of the same part arrive at the same time", async () => {
    const { running, send, rows } = await start();
    const turn = await running();

    const [a, b] = await Promise.all([
      send(turn, [tool("prt_2", 2, "running")]),
      send(turn, [tool("prt_2", 6, "completed")]),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await rows(turn.jobId)).map((row) => row.seq)).toStrictEqual([6]);
  });

  // #745-T13
  it("answers 409 RUNNER_LEASE_LOST for a lease token that is not the claim's, and stores nothing", async () => {
    const { running, send, rows } = await start();
    const turn = await running();

    const response = await send(
      { ...turn, leaseToken: "not-the-lease-token" },
      [text("prt_1", 1)],
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "RUNNER_LEASE_LOST" },
    });
    expect(await rows(turn.jobId)).toEqual([]);
  });

  // #745-T13
  it("answers 409 for a turn whose lease ran out and was ended by the reaper (a turn has one attempt)", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    h.clock.advance(10 * 60 * 1000);
    await h.queue.expireStaleJobs();
    expect(await h.queue.get(turn.jobId)).toMatchObject({ status: "failed" });

    const stale = await send(turn, [text("prt_1", 1)]);

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "RUNNER_LEASE_LOST" },
    });
    expect(await rows(turn.jobId)).toEqual([]);
  });

  // #745-T13
  it("answers 409 once the turn has ended, and stores nothing", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    await h.complete(turn.jobId, turn.leaseToken, {
      ok: false,
      errorCode: "agent_gave_up",
      errorMessage: "gave up",
    });

    const response = await send(turn, [text("prt_1", 1)]);

    expect(response.status).toBe(409);
    expect(await rows(turn.jobId)).toEqual([]);
  });

  // #745-T13
  it("does not extend the lease", async () => {
    const { h, running, send } = await start();
    const turn = await running();
    const before = await h.db
      .selectFrom("jobs")
      .select(["lease_expires_at", "heartbeat_at", "updated_at"])
      .where("id", "=", turn.jobId)
      .executeTakeFirstOrThrow();
    h.clock.advance(60_000);

    const response = await send(turn, [text("prt_1", 1)]);

    expect(response.status).toBe(200);
    expect(
      await h.db
        .selectFrom("jobs")
        .select(["lease_expires_at", "heartbeat_at", "updated_at"])
        .where("id", "=", turn.jobId)
        .executeTakeFirstOrThrow(),
    ).toStrictEqual(before);
  });

  // #745-T14
  it("refuses a job that is not a turn of the Implementer, and stores nothing", async () => {
    const { h } = await start();
    const queued = await h.enqueueNew();
    const claimed = await h.claimed();
    expect(claimed.job.id).toBe(queued.id);

    const response = await h.steps(queued.id, {
      leaseToken: claimed.job.leaseToken,
      records: [text("prt_1", 1)],
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "RUNNER_REQUEST_INVALID",
        fields: [{ field: "jobId", code: "invalid" }],
      },
    });
    expect(
      await h.db.selectFrom("implementer_turn_steps").selectAll().execute(),
    ).toEqual([]);
  });

  // #745-T15
  it("keeps one turn's steps apart from another's, also with the other's lease token", async () => {
    const { running, send, rows } = await start();
    const first = await running();
    const second = await running();
    await send(second, [text("prt_1", 1, "second")]);

    const response = await send(
      { jobId: second.jobId, leaseToken: first.leaseToken },
      [text("prt_1", 5, "planted")],
    );

    expect(response.status).toBe(409);
    expect(
      JSON.parse((await rows(second.jobId))[0]?.payload ?? ""),
    ).toMatchObject({
      text: "second",
    });
    expect(await rows(first.jobId)).toEqual([]);
  });

  // #745-T16
  it("needs the runner token, a job id and a job that exists", async () => {
    const { h, running } = await start();
    const turn = await running();
    const body = { leaseToken: turn.leaseToken, records: [text("prt_1", 1)] };

    expect((await h.steps(turn.jobId, body, { token: null })).status).toBe(401);
    expect(
      (await h.steps(turn.jobId, body, { token: "wrong" + TEST_RUNNER_TOKEN }))
        .status,
    ).toBe(401);
    expect((await h.steps("not-a-uuid", body)).status).toBe(400);
    const missing = await h.steps("3f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33", body);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "RUNNER_JOB_NOT_FOUND" },
    });
  });

  // #745-T17
  it("refuses a body that is not JSON, one over the body limit, and a batch with a record that does not fit, naming fields and never values", async () => {
    const { h, running } = await start();
    const turn = await running();

    expect((await h.steps(turn.jobId, "{not json")).status).toBe(400);
    const huge = await h.steps(turn.jobId, {
      leaseToken: turn.leaseToken,
      records: [text("prt_1", 1, "x".repeat(70 * 1024))],
    });
    expect(huge.status).toBe(413);
    const bad = await h.steps(turn.jobId, {
      leaseToken: turn.leaseToken,
      records: [text("prt_1", 1), { ...text("prt_2", 0), secret: "kept-out" }],
    });
    expect(bad.status).toBe(400);
    const body = await bad.json();
    expect(body).toMatchObject({
      error: {
        code: "RUNNER_REQUEST_INVALID",
        fields: [{ field: "records[1].seq", code: "invalid" }],
      },
    });
    expect(JSON.stringify(body)).not.toContain("Thinking");
    // The good record beside the bad one was not stored: a batch is all or nothing.
    expect(
      await h.db.selectFrom("implementer_turn_steps").selectAll().execute(),
    ).toEqual([]);
  });

  // #745-T17
  it("counts a record of a kind it does not know as dropped and stores the others", async () => {
    const { running, send, rows } = await start();
    const turn = await running();

    const response = await send(turn, [
      text("prt_1", 1),
      { kind: "patch", partId: "prt_2", seq: 2 },
    ]);

    expect(await response.json()).toStrictEqual({
      version: 1,
      stored: 1,
      stale: 0,
      dropped: 1,
    });
    expect((await rows(turn.jobId)).map((row) => row.part_id)).toStrictEqual([
      "prt_1",
    ]);
  });
});

describe("the bounds of a turn on the app's side", () => {
  // #745-T18
  it("refuses a batch of more than 50 records", async () => {
    const { h, running } = await start();
    const turn = await running();

    const response = await h.steps(turn.jobId, {
      leaseToken: turn.leaseToken,
      records: Array.from({ length: 51 }, (_, index) =>
        text(`prt_${String(index)}`, index + 1),
      ),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { fields: [{ field: "records", code: "too_long" }] },
    });
  });

  // #745-T18
  it("keeps at most MAX_STEPS_PER_TURN parts: a new part past the cap is dropped, a part that is there still changes", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    // In slices: one statement may carry only so many parameters.
    for (let from = 0; from < MAX_STEPS_PER_TURN; from += 1000)
      await h.db
        .insertInto("implementer_turn_steps")
        .values(
          Array.from({ length: 1000 }, (_, index) => ({
            job_id: turn.jobId,
            part_id: `fill_${String(from + index)}`,
            workspace_id: h.workspaceId,
            seq: 1,
            ordinal: 1,
            kind: "text",
            payload: "{}",
            bytes: 2,
            created_at: "2026-11-04T08:00:00.000Z",
            updated_at: "2026-11-04T08:00:00.000Z",
          })),
        )
        .execute();

    const response = await send(turn, [
      text("prt_new", 5),
      text("fill_7", 9, "changed"),
    ]);

    expect(await response.json()).toStrictEqual({
      version: 1,
      stored: 1,
      stale: 0,
      dropped: 1,
    });
    const all = await rows(turn.jobId);
    expect(all).toHaveLength(MAX_STEPS_PER_TURN);
    expect(all.find((row) => row.part_id === "prt_new")).toBeUndefined();
    expect(all.find((row) => row.part_id === "fill_7")?.seq).toBe(9);
  });

  // #745-T18
  it("keeps at most MAX_STEP_BYTES_PER_TURN of payload: a record past the cap is dropped", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    await h.db
      .insertInto("implementer_turn_steps")
      .values({
        job_id: turn.jobId,
        part_id: "fill",
        workspace_id: h.workspaceId,
        seq: 1,
        ordinal: 1,
        kind: "text",
        payload: "{}",
        bytes: MAX_STEP_BYTES_PER_TURN - 300,
        created_at: "2026-11-04T08:00:00.000Z",
        updated_at: "2026-11-04T08:00:00.000Z",
      })
      .execute();

    const big = await send(turn, [text("prt_1", 1, "x".repeat(500))]);
    const small = await send(turn, [step("prt_2", 2)]);

    expect(await big.json()).toMatchObject({ stored: 0, dropped: 1 });
    expect(await small.json()).toMatchObject({ stored: 1, dropped: 0 });
    // The room that is left is used up by the small ones, and then everything is dropped.
    const sent = [];
    for (let seq = 3; seq < 8; seq += 1)
      sent.push(
        await (await send(turn, [step(`prt_${String(seq)}`, seq)])).json(),
      );
    expect(sent.at(-1)).toMatchObject({ stored: 0, dropped: 1 });
    const total = await h.db
      .selectFrom("implementer_turn_steps")
      .select((eb) => eb.fn.sum<string>("bytes").as("bytes"))
      .where("job_id", "=", turn.jobId)
      .executeTakeFirstOrThrow();
    expect(Number(total.bytes)).toBeLessThanOrEqual(MAX_STEP_BYTES_PER_TURN);
    expect((await rows(turn.jobId)).map((row) => row.part_id)).not.toContain(
      "prt_1",
    );
  });
});

describe("what is stored is cleaned", () => {
  // #745-T19
  it("takes the secrets the app knows out of every text, in the forms they appear in", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    const claimKey = "claim-key-0123456789-abcdefghij";
    await h.claimedKeys.remember(turn.jobId, claimKey);

    await send(turn, [
      text(
        "prt_1",
        1,
        `key ${TEST_LLM_API_KEY} and ${GHP} and Bearer abcdefghijklmnopqrstuvwxyz`,
      ),
      tool("prt_2", 2, "completed", {
        title: `token ${TEST_RUNNER_TOKEN}`,
        input: JSON.stringify({
          header: `Bearer ${claimKey}`,
          key: TEST_LLM_API_KEY,
        }),
        error: `denied for ${claimKey} / ${encodeURIComponent(TEST_LLM_API_KEY)}`,
      }),
    ]);

    const stored = JSON.stringify(await rows(turn.jobId));
    for (const secret of [
      TEST_LLM_API_KEY,
      TEST_RUNNER_TOKEN,
      claimKey,
      GHP,
      "abcdefghijklmnopqrstuvwxyz",
    ])
      expect(stored, secret).not.toContain(secret);
    expect(stored).toContain("[redacted]");
  });

  // #745-T19
  it("takes control characters and lone surrogates out, so that the text can be stored and shown", async () => {
    const { running, send, rows } = await start();
    const turn = await running();

    const response = await send(turn, [
      text(
        "prt_1",
        1,
        "line one\nline\ttwo\u0000\u001b[31m red\u007f \ud800 end",
      ),
    ]);

    expect(response.status).toBe(200);
    const payload = JSON.parse((await rows(turn.jobId))[0]?.payload ?? "") as {
      text: string;
    };
    expect(payload.text).toBe("line one\nline\ttwo[31m red � end");
  });

  // #745-T19
  it("finds a secret that is split by zero-width characters", async () => {
    const { running, send, rows } = await start();
    const turn = await running();
    const split = [...TEST_LLM_API_KEY].join("​");

    await send(turn, [text("prt_1", 1, `leaked: ${split}`)]);

    expect(JSON.stringify(await rows(turn.jobId))).not.toContain(
      TEST_LLM_API_KEY.slice(0, 8),
    );
  });

  // #745-T20
  it("on the workspace's own key keeps the cost of a model call", async () => {
    const { running, send, rows } = await start();
    const turn = await running();

    await send(turn, [step("prt_1", 1, 0.25)]);

    expect(
      JSON.parse((await rows(turn.jobId))[0]?.payload ?? ""),
    ).toMatchObject({
      cost: 0.25,
      tokens: { input: 100 },
    });
  });

  // #745-T20
  it("on the operator's key hides the model and provider names and stores no cost", async () => {
    const { h, running, send, rows } = await start();
    const turn = await running();
    const model = "vendor/secret-model";
    await createUsageRecordsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).setKeyMode(turn.jobId, "managed");
    await h.claimedKeys.rememberModel(turn.jobId, model);

    await send(turn, [
      text("prt_1", 1, `I am ${model}.`),
      tool("prt_2", 2, "completed", { title: `ask ${model}` }),
      step("prt_3", 3, 0.5),
    ]);

    const stored = await rows(turn.jobId);
    expect(JSON.stringify(stored)).not.toContain(model);
    expect(JSON.parse(stored[0]?.payload ?? "")).toMatchObject({
      text: "I am [model].",
    });
    const last = JSON.parse(stored[2]?.payload ?? "") as Record<
      string,
      unknown
    >;
    expect(last).not.toHaveProperty("cost");
    expect(last).toMatchObject({ tokens: { input: 100 } });
  });

  // #745-T20
  it("never stores the output of a tool: a field the contract does not know is not kept", async () => {
    const { running, send, rows } = await start();
    const turn = await running();

    await send(turn, [
      {
        ...tool("prt_1", 1, "completed"),
        output: "the contents of .env",
      } as StepRecord,
    ]);

    const stored = await rows(turn.jobId);
    expect(stored[0]?.payload).not.toContain("contents of .env");
    expect(stored[0]?.payload).not.toContain("output");
  });
});

describe("the steps call of the Worker API", () => {
  // #745-T21
  it("stores the records of the running turn the credential belongs to, and the response is valid", async () => {
    const { h, running, rows } = await start();
    const turn = await running();

    const response = await h.worker.steps(turn.jobId, turn.credential, {
      records: [text("prt_1", 1), tool("prt_2", 2, "running")],
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(workerContract.check("WorkerStepsResponse", body).valid).toBe(true);
    expect(body).toStrictEqual({ version: 1, stored: 2, stale: 0, dropped: 0 });
    expect(await rows(turn.jobId)).toHaveLength(2);
  });

  // #745-T21
  it("answers 401 for a credential that is not the job's, 409 once the job has ended, and stores nothing then", async () => {
    const { h, running, rows } = await start();
    const turn = await running();
    const other = await running();

    const wrong = await h.worker.steps(turn.jobId, other.credential, {
      records: [text("prt_1", 1)],
    });
    const none = await h.worker.steps(turn.jobId, null, {
      records: [text("prt_1", 1)],
    });
    await h.complete(turn.jobId, turn.leaseToken, {
      ok: false,
      errorCode: "agent_gave_up",
      errorMessage: "gave up",
    });
    const ended = await h.worker.steps(turn.jobId, turn.credential, {
      records: [text("prt_1", 1)],
    });

    expect(wrong.status).toBe(401);
    expect(none.status).toBe(401);
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({
      error: { code: "RUNNER_JOB_ENDED" },
    });
    expect(await rows(turn.jobId)).toEqual([]);
  });

  // #745-T21
  it("takes the credential of the Worker out of what it stores, and does not extend the lease", async () => {
    const { h, running, rows } = await start();
    const turn = await running();
    const before = await h.db
      .selectFrom("jobs")
      .select(["lease_expires_at", "heartbeat_at"])
      .where("id", "=", turn.jobId)
      .executeTakeFirstOrThrow();
    h.clock.advance(60_000);

    await h.worker.steps(turn.jobId, turn.credential, {
      records: [text("prt_1", 1, `my credential is ${turn.credential}`)],
    });

    expect(JSON.stringify(await rows(turn.jobId))).not.toContain(
      turn.credential,
    );
    expect(
      await h.db
        .selectFrom("jobs")
        .select(["lease_expires_at", "heartbeat_at"])
        .where("id", "=", turn.jobId)
        .executeTakeFirstOrThrow(),
    ).toStrictEqual(before);
  });

  // #745-T21
  it("refuses a job that is not a turn of the Implementer", async () => {
    const { h } = await start();
    await h.enqueueNew();
    const claim = await h.claimedSplit();

    const response = await h.worker.steps(claim.job.id, claim.job.credential, {
      records: [text("prt_1", 1)],
    });

    expect(response.status).toBe(400);
  });
});
