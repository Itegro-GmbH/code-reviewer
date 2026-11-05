// SPDX-License-Identifier: LicenseRef-Proprietary

// The session snapshot of a turn on a customer's runner (#879, follow-up turns): `PUT /api/runners/v1/jobs/:id/session` and `GET
// /api/runners/v1/jobs/:id/resume-session`. The two calls are the Worker API's (snapshot.integration.test.ts,
// resume-session.integration.test.ts) for a runner that holds a credential of its own and no per-job credential: the runner credential is
// in Authorization and the lease token in a header. The parts, the digest and the bounds are the handlers' and are shown here once through
// the runner's door; what is new is who may call: a live runner, for a job of its own workspace that it holds itself, with the lease of
// its claim. Against a real Postgres with the harness of the runner API.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createImplementerSnapshotsRepository } from "../db/repositories/implementer-snapshots-repository.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { createRunnerFleetService } from "../runner-fleet/service.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";
import { sha } from "../test-support/jobs.ts";
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
import { createContractValidator } from "../test-support/runner-contract.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import { SNAPSHOT_LIMITS, type ImplementerResult } from "./contract.ts";

const IMPLEMENTER = ["implementer"] as const;
const contract = createContractValidator();
const PART = SNAPSHOT_LIMITS.partBytes;
const LABELS = ["gpu", "linux"];
const RUNNER_ENV = { id: "env-runner", name: "GPU box", labels: LABELS };

const digest = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

/** The query of part `index` of a file of `whole`, as the runner describes it. */
function describeFile(
  whole: Uint8Array,
  index: number,
  over: Record<string, string | number> = {},
) {
  return {
    part: index,
    parts: Math.max(1, Math.ceil(whole.byteLength / PART)),
    bytes: whole.byteLength,
    rawBytes: whole.byteLength * 4,
    sha256: digest(whole),
    opencodeVersion: "1.19.0",
    ...over,
  };
}

const slice = (whole: Uint8Array, index: number) =>
  whole.subarray(index * PART, (index + 1) * PART);

async function bytesOf(response: Response) {
  return new Uint8Array(await response.arrayBuffer());
}

type Runner = { runnerId: string; credential: string };
type Held = {
  jobId: string;
  leaseToken: string;
  sessionId: string;
  runner: Runner;
};

async function start() {
  const h = await startRunnerApiHarness();
  await addUser(h.db, "user-1");
  let counter = 0;
  const snapshots = createImplementerSnapshotsRepository(
    h.db,
    h.workspaceId,
    h.clock.now,
  );
  const fleet = createRunnerFleetService({
    runners: createRunnersRepository(h.db, h.workspaceId, {
      now: h.clock.now,
    }),
    settings: () => ({ minBaseVersion: null, onlineWithinSeconds: 120 }),
    endClaimsOf: async (id) => {
      await h.queue.expireClaimsOf(id);
    },
    now: h.clock.now,
  });
  const enqueue = async (
    environment: { runner: boolean } = { runner: true },
  ) => {
    counter += 1;
    h.clock.advance(1);
    return h.queue.enqueueImplementerTurn({
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
      ...(environment.runner ? { runnerEnvironment: RUNNER_ENV } : {}),
    });
  };
  const sessionOf = async (jobId: string) =>
    (
      await h.db
        .selectFrom("implementer_turns")
        .select("session_id")
        .where("job_id", "=", jobId)
        .executeTakeFirstOrThrow()
    ).session_id;
  /** A turn of a runner environment that `runner` holds: claimed the way the claim of a customer's runner scopes it. */
  async function running(runner: Runner): Promise<Held> {
    const enqueued = await enqueue();
    const claimed = await h.queue.claimNext(
      customerRunnerId(runner.runnerId),
      IMPLEMENTER,
      { customerRunner: { workspaceId: h.workspaceId, labels: LABELS } },
    );
    if (claimed === null || claimed.job.id !== enqueued.job.id)
      throw new Error("the turn was not claimed");
    return {
      jobId: claimed.job.id,
      leaseToken: claimed.leaseToken,
      sessionId: await sessionOf(claimed.job.id),
      runner,
    };
  }
  /**
   * What the queue does with a claim it takes back (`runner-jobs-repository.ts`): the turn waits again with one more lost attempt, nobody holds
   * it and the lease token is gone.
   */
  async function requeue(jobId: string) {
    await h.db
      .updateTable("jobs")
      .set((eb) => ({
        status: "queued",
        attempts: eb("attempts", "+", 1),
        runner_id: null,
        lease_token: null,
        claimed_at: null,
        heartbeat_at: null,
        lease_expires_at: null,
      }))
      .where("id", "=", jobId)
      .execute();
  }
  /** The turn `held` once more, claimed by `runner` (the claim a customer's runner makes): a new lease token, and `runner` holds it. */
  async function claimAgain(held: Held, runner: Runner): Promise<Held> {
    const claimed = await h.queue.claimNext(
      customerRunnerId(runner.runnerId),
      IMPLEMENTER,
      { customerRunner: { workspaceId: h.workspaceId, labels: LABELS } },
    );
    if (claimed === null || claimed.job.id !== held.jobId)
      throw new Error("the turn was not claimed again");
    return { ...held, leaseToken: claimed.leaseToken, runner };
  }
  /** A hosted turn that a Dispatcher's Worker holds. */
  async function hosted() {
    const enqueued = await enqueue({ runner: false });
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
  /** The follow-up turn of `earlier`'s session, running on `runner`: the first turn has to be over, one turn runs at a time. */
  async function followUp(earlier: Held, runner: Runner = earlier.runner) {
    await h.db
      .updateTable("jobs")
      .set({ status: "failed" })
      .where("id", "=", earlier.jobId)
      .execute();
    const next = await running(runner);
    await h.db
      .updateTable("implementer_turns")
      .set({ session_id: earlier.sessionId, number: 2 })
      .where("job_id", "=", next.jobId)
      .execute();
    return { ...next, sessionId: earlier.sessionId };
  }
  /** The snapshot of the session of `turn`, as that turn's upload leaves it. */
  async function store(turn: Held, whole: Uint8Array) {
    await h.db
      .insertInto("implementer_session_snapshots")
      .values({
        session_id: turn.sessionId,
        workspace_id: h.workspaceId,
        job_id: turn.jobId,
        turn_number: 1,
        opencode_version: "1.19.0",
        bytes: whole.byteLength,
        raw_bytes: whole.byteLength * 4,
        sha256: digest(whole),
        data: Buffer.from(whole).toString("base64"),
        created_at: "2026-11-05T06:00:00.000Z",
        updated_at: "2026-11-05T06:00:00.000Z",
      })
      .execute();
  }
  const put = (
    turn: Held,
    whole: Uint8Array,
    index: number,
    over: Record<string, string | number> = {},
    body: Uint8Array = slice(whole, index),
  ) =>
    h.runnerSession(turn.jobId, describeFile(whole, index, over), body, {
      token: turn.runner.credential,
      leaseToken: turn.leaseToken,
    });
  const get = (turn: Held, part?: number | string) =>
    h.runnerResumeSession(turn.jobId, part, {
      token: turn.runner.credential,
      leaseToken: turn.leaseToken,
    });
  const stored = () =>
    h.db.selectFrom("implementer_session_snapshots").selectAll().execute();
  const parts = () =>
    h.db.selectFrom("implementer_session_snapshot_parts").selectAll().execute();
  return {
    h,
    fleet,
    snapshots,
    running,
    requeue,
    claimAgain,
    hosted,
    followUp,
    store,
    put,
    get,
    stored,
    parts,
  };
}

describe("the snapshot call of the runner API", () => {
  // #879-T01
  it("stores a small snapshot in one request for the runner that holds the turn, and the response is valid", async () => {
    const { h, snapshots, running, put, stored } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const turn = await running(runner);
    const whole = randomBytes(5_000);

    const answer = await put(turn, whole, 0);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const body = await answer.json();
    expect(body).toStrictEqual({
      version: 1,
      part: 0,
      parts: 1,
      complete: true,
    });
    expect(contract.check("RunnerSessionPartResponse", body).valid).toBe(true);
    const read = await snapshots.read(turn.sessionId);
    expect(Buffer.from(read?.data ?? []).equals(whole)).toBe(true);
    expect(read?.snapshot).toMatchObject({
      sessionId: turn.sessionId,
      jobId: turn.jobId,
      turnNumber: 1,
      opencodeVersion: "1.19.0",
      bytes: 5_000,
      sha256: digest(whole),
    });
    expect(await stored()).toHaveLength(1);
  });

  // #879-T02
  it("puts a file of three parts together, whatever the order, and keeps nothing of it until the last part is in", async () => {
    const { h, snapshots, running, put, parts } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const turn = await running(runner);
    const whole = randomBytes(PART * 2 + 1_000);

    const answers = [
      await put(turn, whole, 2),
      await put(turn, whole, 0),
      await put(turn, whole, 1),
    ];

    expect(answers.map((answer) => answer.status)).toStrictEqual([
      200, 200, 200,
    ]);
    expect(
      (await Promise.all(answers.map((answer) => answer.json()))).map(
        (body: { complete: boolean }) => body.complete,
      ),
    ).toStrictEqual([false, false, true]);
    const read = await snapshots.read(turn.sessionId);
    expect(Buffer.from(read?.data ?? []).equals(whole)).toBe(true);
    // The parts are gone once the file is whole.
    expect(await parts()).toHaveLength(0);
  });

  // #879-T03
  it("answers 200 again for a part it already has, and does not extend the lease", async () => {
    const { h, running, put } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const turn = await running(runner);
    const whole = randomBytes(PART + 10);
    const lease = () =>
      h.db
        .selectFrom("jobs")
        .select(["lease_expires_at", "heartbeat_at"])
        .where("id", "=", turn.jobId)
        .executeTakeFirstOrThrow();
    const before = await lease();
    h.clock.advance(60_000);

    expect((await put(turn, whole, 0)).status).toBe(200);
    expect((await put(turn, whole, 0)).status).toBe(200);

    expect(await lease()).toStrictEqual(before);
  });

  // #879-T04
  it("refuses the bounds as the Worker API does: a body of the wrong length, one over 3 MiB, a part past the count, a digest that is not the file's", async () => {
    const { h, running, put, stored, parts } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const turn = await running(runner);
    const whole = randomBytes(5_000);

    const short = await put(turn, whole, 0, {}, whole.subarray(0, 4_999));
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({
      error: {
        code: "RUNNER_REQUEST_INVALID",
        fields: [{ field: "body", code: "invalid" }],
      },
    });
    const huge = await put(turn, whole, 0, {}, new Uint8Array(PART + 1));
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({
      error: { code: "RUNNER_BODY_TOO_LARGE" },
    });
    expect((await put(turn, whole, 0, { part: 1 })).status).toBe(400);
    expect(
      (await put(turn, whole, 0, { bytes: SNAPSHOT_LIMITS.maxBytes + 1 }))
        .status,
    ).toBe(400);
    // The one part makes a file whose digest is not the announced one: nothing of it is kept.
    const lying = await put(turn, whole, 0, { sha256: "0".repeat(64) });
    expect(lying.status).toBe(400);
    expect(await lying.json()).toMatchObject({
      error: { fields: [{ field: "body", code: "invalid" }] },
    });
    expect(await stored()).toHaveLength(0);
    expect(await parts()).toHaveLength(0);
  });

  // #879-T05
  it("refuses a lease token that is missing or cannot be one, and one that is not the claim's (409), storing nothing", async () => {
    const { h, running, put, stored } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const turn = await running(runner);
    const whole = randomBytes(1_000);
    const send = (leaseToken: string | null) =>
      h.runnerSession(turn.jobId, describeFile(whole, 0), whole, {
        token: runner.credential,
        leaseToken,
      });

    const missing = await send(null);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({
      error: {
        code: "RUNNER_REQUEST_INVALID",
        fields: [{ field: "x-lease-token", code: "required" }],
      },
    });
    const short = await send("short");
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({
      error: { fields: [{ field: "x-lease-token", code: "invalid" }] },
    });
    const wrong = await send("not-the-lease-token");
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({
      error: { code: "RUNNER_LEASE_LOST" },
    });
    expect(await stored()).toHaveLength(0);
    expect((await put(turn, whole, 0)).status).toBe(200);
  });
});

describe("the resume-session call of the runner API", () => {
  // #879-T10
  it("serves the snapshot of the session to the runner of the follow-up turn, as stored, with the description of the whole file in the headers", async () => {
    const { h, running, store, followUp, get } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const first = await running(runner);
    const whole = randomBytes(5_000);
    await store(first, whole);
    const turn = await followUp(first);

    const answer = await get(turn);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
    expect(answer.headers.get("content-length")).toBe("5000");
    expect(Buffer.from(await bytesOf(answer)).equals(whole)).toBe(true);
    const headers = Object.fromEntries(
      [...answer.headers.entries()].filter(([name]) =>
        name.startsWith("x-snapshot-"),
      ),
    );
    expect(headers).toStrictEqual({
      "x-snapshot-parts": "1",
      "x-snapshot-bytes": "5000",
      "x-snapshot-raw-bytes": "20000",
      "x-snapshot-sha256": digest(whole),
      "x-snapshot-opencode-version": "1.19.0",
    });
    expect(contract.check("RunnerResumeSessionHeaders", headers).valid).toBe(
      true,
    );
  });

  // #879-T11
  it("serves a file of three parts in the parts the upload used, in any order and twice, and the parts make the file", async () => {
    const { h, running, store, followUp, get } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const first = await running(runner);
    const whole = randomBytes(PART * 2 + 1_000);
    await store(first, whole);
    const turn = await followUp(first);

    const answers = new Map<number, Uint8Array>();
    for (const index of [2, 0, 1, 1]) {
      const answer = await get(turn, index);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("x-snapshot-parts")).toBe("3");
      answers.set(index, await bytesOf(answer));
    }

    expect(answers.get(0)?.byteLength).toBe(PART);
    expect(answers.get(1)?.byteLength).toBe(PART);
    expect(answers.get(2)?.byteLength).toBe(1_000);
    expect(
      Buffer.concat(
        [0, 1, 2].map((index) => answers.get(index) ?? new Uint8Array()),
      ).equals(whole),
    ).toBe(true);
    // A part left out is the first.
    expect(
      Buffer.from(await bytesOf(await get(turn))).equals(slice(whole, 0)),
    ).toBe(true);
  });

  // #879-T12
  it("refuses a part that is not a number, has leading zeros or is past the last, and answers 204 for a session with no snapshot", async () => {
    const { h, running, store, followUp, get } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const first = await running(runner);
    const turn = await followUp(first);
    // No snapshot yet: a summary is what the turn continues from.
    const none = await get(turn);
    expect(none.status).toBe(204);
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await none.text()).toBe("");

    await store(first, randomBytes(5_000));
    for (const part of ["1", "3", "abc", "01", "-1"]) {
      const answer = await get(turn, part);
      expect(answer.status).toBe(400);
      expect(await answer.json()).toMatchObject({
        error: {
          code: "RUNNER_REQUEST_INVALID",
          fields: [{ field: "part", code: "invalid" }],
        },
      });
    }
  });

  // #879-T13
  it("reads the snapshot of the job's own session and of no other", async () => {
    const { h, running, store, followUp, get } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const first = await running(runner);
    await store(first, randomBytes(5_000));
    // Another session of the same workspace has a snapshot of its own; the follow-up turn of the first never sees it.
    await h.db
      .updateTable("jobs")
      .set({ status: "failed" })
      .where("id", "=", first.jobId)
      .execute();
    const unrelated = await running(runner);
    await store(unrelated, randomBytes(3_000));
    const turn = await followUp(first);

    const answer = await get(turn);

    expect(answer.status).toBe(200);
    expect(answer.headers.get("x-snapshot-bytes")).toBe("5000");
  });
});

describe("a snapshot through the runner's door, both ways (#879)", () => {
  // #879-T20
  it("is stored by the runner of one turn and read back, byte for byte, by the runner of the next", async () => {
    const { h, running, followUp, put, get } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const first = await running(runner);
    const whole = randomBytes(PART + 4_000);
    expect((await put(first, whole, 0)).status).toBe(200);
    expect((await put(first, whole, 1)).status).toBe(200);
    // The next turn may run on another runner of the workspace: the snapshot belongs to the session, not to the runner.
    const another = await h.registerRunner({ labels: LABELS });
    const turn = await followUp(first, another);

    const firstPart = await get(turn, 0);
    const secondPart = await get(turn, 1);

    expect(firstPart.status).toBe(200);
    expect(secondPart.status).toBe(200);
    expect(
      Buffer.concat([
        await bytesOf(firstPart),
        await bytesOf(secondPart),
      ]).equals(whole),
    ).toBe(true);
  });
});

describe("who may call the two routes (#879)", () => {
  type Call = "session" | "resume-session";
  const CALLS: Call[] = ["session", "resume-session"];

  /** One call as the runner of `held` would make it, with anything in it replaced by `over`. */
  function call(
    h: Awaited<ReturnType<typeof start>>["h"],
    kind: Call,
    jobId: string,
    over: { token?: string | null; leaseToken?: string | null },
  ) {
    const whole = randomBytes(2_000);
    return kind === "session"
      ? h.runnerSession(jobId, describeFile(whole, 0), whole, over)
      : h.runnerResumeSession(jobId, 0, over);
  }

  // #879-T30
  it.each(CALLS)(
    "answers 404 for a runner of another workspace, even with the credential and the lease token that are right (%s)",
    async (kind) => {
      const { h, running, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const turn = await running(runner);
      const otherWorkspace = await addWorkspace(h.db, "other");
      const stranger = await h.registerRunner({
        labels: LABELS,
        workspaceId: otherWorkspace,
      });

      const answer = await call(h, kind, turn.jobId, {
        token: stranger.credential,
        leaseToken: turn.leaseToken,
      });

      expect(answer.status).toBe(404);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_JOB_NOT_FOUND" },
      });
      expect(await stored()).toHaveLength(0);
    },
  );

  // #879-T31
  it.each(CALLS)(
    "answers 404 for another runner of the same workspace, even with the lease token of the claim (%s)",
    async (kind) => {
      const { h, running, stored } = await start();
      const holder = await h.registerRunner({ labels: LABELS });
      const turn = await running(holder);
      const other = await h.registerRunner({ labels: LABELS });

      const answer = await call(h, kind, turn.jobId, {
        token: other.credential,
        leaseToken: turn.leaseToken,
      });

      expect(answer.status).toBe(404);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_JOB_NOT_FOUND" },
      });
      expect(await stored()).toHaveLength(0);
    },
  );

  // #879-T32
  it.each(CALLS)(
    "answers 404 for a job that is not there and 400 for an id that is not one (%s)",
    async (kind) => {
      const { h } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const lease = { token: runner.credential, leaseToken: "x".repeat(20) };

      const missing = await call(
        h,
        kind,
        "5b7c1f2e-9d3a-4c68-8e0b-6a1d4f3e2c10",
        lease,
      );
      const malformed = await call(h, kind, "not-a-job-id", lease);

      expect(missing.status).toBe(404);
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        error: { fields: [{ field: "jobId", code: "invalid" }] },
      });
    },
  );

  // #879-T33
  it.each(CALLS)(
    "answers the 409 of the other runner routes for a lease that ran out, and stores nothing (%s)",
    async (kind) => {
      const { h, running, store, followUp, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const first = await running(runner);
      await store(first, randomBytes(2_000));
      const turn = await followUp(first);
      const before = (await stored()).length;
      // A turn has one attempt: the reaper ends it, and the lease token of its claim is no proof any more.
      h.clock.advance(10 * 60 * 1000);
      await h.queue.expireStaleJobs();
      // What the steps route says to the same runner for the same lease: the answer these two calls must give too.
      const steps = await h.steps(
        turn.jobId,
        {
          leaseToken: turn.leaseToken,
          records: [
            {
              kind: "text",
              partId: "prt_1",
              seq: 1,
              startedAt: 1_793_793_600_000,
              endedAt: 1_793_793_601_000,
              text: "late",
              bytes: 4,
            },
          ],
        },
        { token: runner.credential },
      );

      const answer = await call(h, kind, turn.jobId, {
        token: runner.credential,
        leaseToken: turn.leaseToken,
      });

      expect(steps.status).toBe(409);
      expect(answer.status).toBe(steps.status);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_LEASE_LOST" },
      });
      expect(answer.headers.get("x-snapshot-bytes")).toBeNull();
      expect(await stored()).toHaveLength(before);
    },
  );

  // #879-T34
  it.each(CALLS)(
    "answers 401 for a revoked runner, with the credential and the lease token it had (%s)",
    async (kind) => {
      const { h, fleet, running, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const turn = await running(runner);
      const live = await call(h, kind, turn.jobId, {
        token: runner.credential,
        leaseToken: turn.leaseToken,
      });
      expect(live.status).toBeLessThan(300);
      const before = (await stored()).length;
      await fleet.revoke(runner.runnerId);

      const answer = await call(h, kind, turn.jobId, {
        token: runner.credential,
        leaseToken: turn.leaseToken,
      });

      expect(answer.status).toBe(401);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_UNAUTHORIZED" },
      });
      expect(await stored()).toHaveLength(before);
    },
  );

  // #879-T35
  it.each(CALLS)(
    "answers 404 for a hosted job, whose lease token a runner of the workspace holds (%s)",
    async (kind) => {
      const { h, hosted, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const turn = await hosted();

      const answer = await call(h, kind, turn.jobId, {
        token: runner.credential,
        leaseToken: turn.leaseToken,
      });

      expect(answer.status).toBe(404);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_JOB_NOT_FOUND" },
      });
      expect(await stored()).toHaveLength(0);
    },
  );

  // #879-T36
  it.each(CALLS)(
    "takes the credential of a runner and nothing else: not the shared token, not the job's credential, not a bare header (%s)",
    async (kind) => {
      const { h, hosted, running, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const held = await running(runner);

      for (const over of [
        {}, // the shared token of the Dispatcher, the harness default
        { token: null },
        { token: "crc_" + "A".repeat(43) }, // shaped like a runner credential, known to nobody
        { token: "not-a-credential" },
      ])
        expect(
          (
            await call(h, kind, held.jobId, {
              ...over,
              leaseToken: held.leaseToken,
            })
          ).status,
        ).toBe(401);
      // The credential of a hosted claim is the Worker API's, and the lease token is no credential at all.
      const worker = await hosted();
      expect(
        (
          await call(h, kind, worker.jobId, {
            token: worker.credential,
            leaseToken: worker.leaseToken,
          })
        ).status,
      ).toBe(401);
      expect(await stored()).toHaveLength(0);
    },
  );

  // #879-T37
  it("keeps the Worker routes closed to a runner's credential and its lease token, as #870 tested for the snapshot (the read too)", async () => {
    const { h, running, store, followUp } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const first = await running(runner);
    await store(first, randomBytes(2_000));
    const turn = await followUp(first);
    const whole = randomBytes(2_000);

    for (const credential of [runner.credential, turn.leaseToken]) {
      const put = await h.worker.session(
        turn.jobId,
        credential,
        describeFile(whole, 0),
        whole,
      );
      expect(put.status).toBe(401);
      expect(await put.json()).toMatchObject({
        error: { code: "WORKER_CREDENTIAL_INVALID" },
      });
      const read = await h.worker.resumeSession(turn.jobId, credential);
      expect(read.status).toBe(401);
      expect(await read.json()).toMatchObject({
        error: { code: "WORKER_CREDENTIAL_INVALID" },
      });
    }
  });
});

const implementerResult = (): ImplementerResult => ({
  baseCommit: sha("a"),
  headCommit: sha("b"),
  pushed: true,
  commits: [{ sha: sha("b"), subject: "Add a health endpoint" }],
  filesChanged: [{ path: "src/health.ts", status: "added" }],
  summary: "Added a health endpoint.",
  opencode: { sessionId: "ses_1", version: "1.19.0" },
});

describe("a job that changes hands or ends under the calls of a runner (#879)", () => {
  type Call = "session" | "resume-session";
  const CALLS: Call[] = ["session", "resume-session"];

  /** One call as `runner` makes it with `leaseToken` for the job `jobId`. */
  function call(
    h: Awaited<ReturnType<typeof start>>["h"],
    kind: Call,
    jobId: string,
    runner: Runner,
    leaseToken: string,
  ) {
    const whole = randomBytes(2_000);
    const over = { token: runner.credential, leaseToken };
    return kind === "session"
      ? h.runnerSession(jobId, describeFile(whole, 0), whole, over)
      : h.runnerResumeSession(jobId, 0, over);
  }

  // #879-T60
  it.each(CALLS)(
    "answers 404 to the runner that lost a job another runner has claimed since, with the lease token it had, and still serves the new holder (%s)",
    async (kind) => {
      const { h, running, requeue, claimAgain, stored } = await start();
      const a = await h.registerRunner({ labels: LABELS });
      const b = await h.registerRunner({ labels: LABELS });
      const first = await running(a);
      await requeue(first.jobId);
      const second = await claimAgain(first, b);
      expect((await h.queue.get(first.jobId))?.runnerId).toBe(
        customerRunnerId(b.runnerId),
      );

      const lost = await call(h, kind, first.jobId, a, first.leaseToken);

      expect(lost.status).toBe(404);
      expect(await lost.json()).toMatchObject({
        error: { code: "RUNNER_JOB_NOT_FOUND" },
      });
      expect(await stored()).toHaveLength(0);
      const holder = await call(h, kind, second.jobId, b, second.leaseToken);
      expect(holder.status).toBeLessThan(300);
    },
  );

  // #879-T61
  it.each(CALLS)(
    "answers 409 to the same runner that holds the job again under a new claim, when it still sends the old lease token (%s)",
    async (kind) => {
      const { h, running, requeue, claimAgain, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const first = await running(runner);
      await requeue(first.jobId);
      const second = await claimAgain(first, runner);
      expect(second.leaseToken).not.toBe(first.leaseToken);

      const old = await call(h, kind, first.jobId, runner, first.leaseToken);

      expect(old.status).toBe(409);
      expect(await old.json()).toMatchObject({
        error: { code: "RUNNER_LEASE_LOST" },
      });
      expect(await stored()).toHaveLength(0);
      const fresh = await call(
        h,
        kind,
        second.jobId,
        runner,
        second.leaseToken,
      );
      expect(fresh.status).toBeLessThan(300);
    },
  );

  // #879-T62
  it.each(CALLS)(
    "answers 409 for a job that is back in the queue and held by nobody, not 404 (%s)",
    async (kind) => {
      const { h, running, requeue, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const held = await running(runner);
      await requeue(held.jobId);
      expect(await h.queue.get(held.jobId)).toMatchObject({
        status: "queued",
        runnerId: null,
      });

      const answer = await call(h, kind, held.jobId, runner, held.leaseToken);

      expect(answer.status).toBe(409);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_LEASE_LOST" },
      });
      expect(await stored()).toHaveLength(0);
    },
  );

  // #879-T63
  it.each(CALLS)(
    "answers 409 once the turn was ended with complete, though the runner still holds the credential and the token of that claim (%s)",
    async (kind) => {
      const { h, running, store, followUp, stored } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const first = await running(runner);
      await store(first, randomBytes(2_000));
      const turn = await followUp(first);
      const done = await h.complete(
        turn.jobId,
        turn.leaseToken,
        { implementer: implementerResult() },
        { token: runner.credential },
      );
      expect(done.status).toBe(200);
      expect(await h.queue.get(turn.jobId)).toMatchObject({
        status: "succeeded",
      });
      const before = await stored();

      const answer = await call(h, kind, turn.jobId, runner, turn.leaseToken);

      expect(answer.status).toBe(409);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_LEASE_LOST" },
      });
      expect(answer.headers.get("x-snapshot-bytes")).toBeNull();
      expect(await stored()).toStrictEqual(before);
    },
  );

  // #879-T64
  it.each(CALLS)(
    "answers 409 to an earlier turn of a session that has a newer turn running, and neither writes nor reads the session's snapshot (%s)",
    async (kind) => {
      const { h, running, store, followUp, stored, get } = await start();
      const runner = await h.registerRunner({ labels: LABELS });
      const first = await running(runner);
      const file = randomBytes(2_000);
      await store(first, file);
      const next = await followUp(first);
      expect(next.sessionId).toBe(first.sessionId);
      const before = await stored();

      const answer = await call(h, kind, first.jobId, runner, first.leaseToken);

      expect(answer.status).toBe(409);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_LEASE_LOST" },
      });
      expect(await stored()).toStrictEqual(before);
      // The turn that runs now reads the file the earlier one left, and nothing was changed under it.
      const read = await get(next, 0);
      expect(read.status).toBe(200);
      expect(Buffer.from(await bytesOf(read)).equals(file)).toBe(true);
    },
  );

  // #879-T65
  it("writes neither a lease token nor a credential to the log, whichever way the calls were answered", async () => {
    const { h, running, store, followUp, put, get } = await start();
    const runner = await h.registerRunner({ labels: LABELS });
    const stranger = await h.registerRunner({ labels: LABELS });
    const first = await running(runner);
    await store(first, randomBytes(2_000));
    const turn = await followUp(first);
    const whole = randomBytes(2_000);
    const wrongLease = "wrong-lease-token-0123456789";
    const unknownCredential = "crc_" + "C".repeat(43);

    const answers = [
      await get(turn, 0), // served: the file of the earlier turn
      await put(turn, whole, 0), // stored
      await h.runnerSession(turn.jobId, describeFile(whole, 0), whole, {
        token: runner.credential,
        leaseToken: wrongLease,
      }), // 409
      await put(first, whole, 0), // 409: an earlier turn
      await h.runnerResumeSession(turn.jobId, 0, {
        token: stranger.credential,
        leaseToken: turn.leaseToken,
      }), // 404
      await h.runnerSession(turn.jobId, describeFile(whole, 0), whole, {
        token: unknownCredential,
        leaseToken: turn.leaseToken,
      }), // 401
      await h.runnerResumeSession(turn.jobId, 0, {
        token: runner.credential,
        leaseToken: null,
      }), // 400
    ];
    expect(answers.map((answer) => answer.status)).toStrictEqual([
      200, 200, 409, 409, 404, 401, 400,
    ]);

    const log = h.logLines().join("\n");
    // The calls did leave lines, or the check below would prove nothing.
    expect(log).toContain("refused: lease lost");
    for (const secret of [
      runner.credential,
      stranger.credential,
      unknownCredential,
      turn.leaseToken,
      first.leaseToken,
      wrongLease,
    ])
      expect(log).not.toContain(secret);
  });
});

describe("the version call for a customer's runner (#879)", () => {
  // #879-T40
  it("lists the feature of the two routes for a live runner, and answers 401 to a revoked or an unknown credential", async () => {
    const { h, fleet } = await start();
    const runner = await h.registerRunner({ labels: LABELS });

    const live = await h.version({ token: runner.credential });
    expect(live.status).toBe(200);
    const body = (await live.json()) as { features: string[] };
    expect(contract.check("VersionResponse", body).valid).toBe(true);
    expect(body.features).toContain("runner_session_snapshot");

    expect((await h.version({ token: "crc_" + "B".repeat(43) })).status).toBe(
      401,
    );
    await fleet.revoke(runner.runnerId);
    expect((await h.version({ token: runner.credential })).status).toBe(401);
  });
});
