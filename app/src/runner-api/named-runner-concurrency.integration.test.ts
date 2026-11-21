// SPDX-License-Identifier: LicenseRef-Proprietary

// The concurrency of a hosted runner and the wait of a job whose runner is unreachable (#1105, ADR 0007, decisions 5, 13 and 16) against a
// real Postgres (the self-hosted runner's own concurrency and the wait of a busy one go through the HTTP claim: `runner-routing.integration.test.ts`). A hosted runner (a type of the provided Vercel Sandbox, in one workspace) runs as many turns at the same time as its
// concurrency, and another type or another kind of environment is not held by it; a job whose hosted runner is full waits and is not
// given up as undispatched. A self-hosted runner is held by `parallelRuns` within the operator's maximum, and a job that waits for it keeps
// waiting while it is reachable: only a runner that is revoked or not heard from for the whole deadline ends the job (`no_runner_available`).
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import {
  createNamedRunnersRepository,
  ensureHostedRunners,
} from "../db/repositories/named-runners-repository.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import { createRunsRepository } from "../db/repositories/runs-repository.ts";
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
import { runnerLabel } from "../runner-identity/labels.ts";

const OWN = { provider: "anthropic", model: "claude-sonnet-5-5" } as const;
const MINUTE = 60 * 1000;

async function start() {
  return startRunnerApiHarness({ implementer: true, llmKey: null });
}
type Harness = Awaited<ReturnType<typeof start>>;

/** The copy a step that names a hosted runner writes into its turn. */
const hostedTurn = (
  h: Harness,
  runner: { id: string; name: string; vcpus: number },
) =>
  h.enqueueTurn({
    environment: {
      id: runner.id,
      name: runner.name,
      vcpus: runner.vcpus,
      setupScript: "",
    },
  });

async function hostedRunners(h: Harness, concurrency: Record<number, number>) {
  await ensureHostedRunners(h.db, h.workspaceId);
  const named = createNamedRunnersRepository(h.db, h.workspaceId);
  const list = await named.list();
  const byVcpus = new Map<
    number,
    { id: string; name: string; vcpus: number }
  >();
  for (const runner of list)
    if (runner.kind === "hosted") {
      byVcpus.set(runner.vcpus, runner);
      await named.setHostedConcurrency(
        runner.id,
        concurrency[runner.vcpus] ?? 1,
      );
    }
  return byVcpus;
}

/** The platform identity's claim, as the Dispatcher's by-poll claim: the oldest due hosted job it matches, or null. */
async function platformClaim(h: Harness) {
  const claimed = await h.queue.claimNext("dispatcher", ["implementer"]);
  return claimed === null ? null : claimed.job.id;
}

async function endJob(h: Harness, jobId: string) {
  await sql`update jobs set status = 'succeeded', finished_at = ${h.clock.now().toISOString()} where id = ${jobId}`.execute(
    h.db,
  );
}

describe("the concurrency of a hosted runner", () => {
  // #1105-R110
  it("holds a type to its concurrency, per type: a full 4 vCPU runner leaves the 2 vCPU one and an environment of a person alone", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 2: 1, 4: 1 });
    const four = runners.get(4);
    const two = runners.get(2);
    if (four === undefined || two === undefined) throw new Error("no runner");
    const first = await hostedTurn(h, four);
    const second = await hostedTurn(h, four);
    const small = await hostedTurn(h, two);
    const own = await h.enqueueTurn({
      environment: { id: "env-own", name: "own", vcpus: 4, setupScript: "" },
    });

    // The oldest first: the first 4 vCPU turn; the second one is held back, so the next jobs are the others.
    expect(await platformClaim(h)).toBe(first.job.id);
    expect(await platformClaim(h)).toBe(small.job.id);
    expect(await platformClaim(h)).toBe(own.job.id);
    expect(await platformClaim(h)).toBeNull();
    expect(await h.queue.get(second.job.id)).toMatchObject({
      status: "queued",
    });

    // A turn that ended frees its place.
    await endJob(h, first.job.id);
    expect(await platformClaim(h)).toBe(second.job.id);
  });

  // #1105-R111
  it("counts a runner of one workspace apart from the same type of another", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 4: 1 });
    const four = runners.get(4);
    if (four === undefined) throw new Error("no runner");
    await hostedTurn(h, four);
    // The concurrency is the row's: the rows of other workspaces are other rows, so they do not share the count.
    const count = await sql<{
      count: string;
    }>`select count(*) as count from implementer_environments where concurrency is not null and vcpus = 4`.execute(
      h.db,
    );
    expect(Number(count.rows[0]?.count)).toBe(1);
    expect(await platformClaim(h)).not.toBeNull();
  });

  // #1105-R112
  it("keeps a job that waits only because its hosted runner is full: it is not given up as undispatched, and a job that waits for no other reason still is", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 4: 1 });
    const four = runners.get(4);
    if (four === undefined) throw new Error("no runner");
    const running = await hostedTurn(h, four);
    const waiting = await hostedTurn(h, four);
    expect(await platformClaim(h)).toBe(running.job.id);
    const stuck = await h.enqueueTurn({
      environment: { id: "env-own", name: "own", vcpus: 2, setupScript: "" },
    });

    h.clock.advance(61 * MINUTE);
    await sql`update jobs set heartbeat_at = ${h.clock.now().toISOString()}, lease_expires_at = ${new Date(h.clock.now().getTime() + 10 * MINUTE).toISOString()} where id = ${running.job.id}`.execute(
      h.db,
    );
    const failed = await h.queue.failUndispatched(30 * MINUTE);

    expect(failed).toBe(1);
    expect(await h.queue.get(stuck.job.id)).toMatchObject({
      status: "failed",
      errorCode: "dispatch_unavailable",
    });
    expect(await h.queue.get(waiting.job.id)).toMatchObject({
      status: "queued",
    });
  });
});

describe("the wait of a job for a self-hosted runner", () => {
  const FEATURES = [
    "cost_limit",
    "operator_cost_limit",
    "dynamic_cost_policy",
    "implementer_profile",
    "implementer_environment",
  ];
  const turnOn = (h: Harness, runner: { runnerId: string }) =>
    h.enqueueTurn({
      modelChoice: OWN,
      runnerEnvironment: {
        id: runner.runnerId,
        name: "DevBox",
        labels: [runnerLabel(runner.runnerId)],
      },
    });

  // #1105-R131
  it("ends the job of a runner that was not heard from for the whole deadline, no_runner_available and free, and not before", async () => {
    const h = await start();
    const devbox = await h.registerRunner();
    const turn = await turnOn(h, devbox);

    h.clock.advance(29 * MINUTE);
    expect(
      (
        await h.claim({
          engines: ["implementer", "opencode", "pr-agent"],
          features: FEATURES,
        })
      ).status,
    ).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });

    h.clock.advance(2 * MINUTE);
    expect(
      (
        await h.claim({
          engines: ["implementer", "opencode", "pr-agent"],
          features: FEATURES,
        })
      ).status,
    ).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
  });

  // #1105-R132
  it("ends the job of a runner that was revoked at the deadline", async () => {
    const h = await start();
    const devbox = await h.registerRunner();
    const turn = await turnOn(h, devbox);
    // Heard from lately, so only the revoke makes it unreachable.
    await createRunnersRepository(h.db, h.workspaceId).revoke(devbox.runnerId);

    h.clock.advance(31 * MINUTE);
    await h.claim({
      engines: ["implementer", "opencode", "pr-agent"],
      features: FEATURES,
    });

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
  });
});

/** A dispatch row of a job the Dispatcher turned away with "not now", old enough to be sent again. */
async function waitingRow(h: Harness, jobId: string) {
  const at = new Date(h.clock.now().getTime() - 60_000).toISOString();
  await sql`insert into job_dispatches (job_id, state, attempts, consecutive_failures, next_dispatch_at, last_attempt_at, last_status, last_code, created_at, updated_at)
    values (${jobId}, 'pending', 1, 0, ${at}, ${at}, 200, 'ignored_not_claimable', ${at}, ${at})`.execute(
    h.db,
  );
}

describe("the Dispatcher rings of jobs behind a full hosted runner (#1105, review of part 2, finding 1)", () => {
  // #1105-R150
  it("never fill a batch with the jobs of a full runner: a job of a free runner behind more of them than the batch holds is still sent, and the full runner's jobs are candidates again once a place is free", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 2: 2, 4: 1 });
    const four = runners.get(4);
    const two = runners.get(2);
    if (four === undefined || two === undefined) throw new Error("no runner");
    const running = await hostedTurn(h, four);
    expect(await platformClaim(h)).toBe(running.job.id);
    // More blocked jobs than one batch holds, all older than the one job of the free runner.
    const blocked: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const job = await hostedTurn(h, four);
      blocked.push(job.job.id);
      await waitingRow(h, job.job.id);
    }
    const free = await hostedTurn(h, two);
    await waitingRow(h, free.job.id);
    const dispatches = createJobDispatchesRepository(h.db, h.clock.now);
    h.clock.advance(MINUTE);

    const waiting = await dispatches.listWaiting(h.clock.now(), 20);
    const due = await dispatches.listDue(h.clock.now(), 20);

    expect(waiting.map((job) => job.jobId)).toEqual([free.job.id]);
    expect(due.map((job) => job.jobId)).toEqual([free.job.id]);
    // A place frees: the full runner's jobs are in the batch again, oldest first.
    await endJob(h, running.job.id);
    const after = await dispatches.listWaiting(h.clock.now(), 20);
    expect(after).toHaveLength(20);
    expect(after.slice(0, 3).map((job) => job.jobId)).toEqual(
      blocked.slice(0, 3),
    );
  });
});

describe("the give-up of a job that waited long behind a full hosted runner (#1105, review of part 2, finding 4)", () => {
  // #1105-R151
  it("does not fail a job that waited hours when a place frees before its claim, only when it then waits the give-up time unclaimed", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 4: 1 });
    const four = runners.get(4);
    if (four === undefined) throw new Error("no runner");
    const running = await hostedTurn(h, four);
    const waiting = await hostedTurn(h, four);
    expect(await platformClaim(h)).toBe(running.job.id);

    h.clock.advance(3 * 60 * MINUTE);
    const beat = async () =>
      sql`update jobs set heartbeat_at = ${h.clock.now().toISOString()}, lease_expires_at = ${new Date(h.clock.now().getTime() + 10 * MINUTE).toISOString()} where id = ${running.job.id}`.execute(
        h.db,
      );
    await beat();
    expect(await h.queue.failUndispatched(30 * MINUTE)).toBe(0);

    // The place frees; the sweep's give-up runs before the Dispatcher's claim.
    await endJob(h, running.job.id);
    expect(await h.queue.failUndispatched(30 * MINUTE)).toBe(0);
    expect(await h.queue.get(waiting.job.id)).toMatchObject({
      status: "queued",
    });

    // Unclaimed for the give-up time after the place freed: now it is the old rule.
    h.clock.advance(31 * MINUTE);
    expect(await h.queue.failUndispatched(30 * MINUTE)).toBe(1);
    expect(await h.queue.get(waiting.job.id)).toMatchObject({
      status: "failed",
      errorCode: "dispatch_unavailable",
    });
  });
});

describe("races and lapsed leases at the limit of a runner (#1105, review of part 2, finding 6)", () => {
  // #1105-R152
  it("let exactly one of two claims started together take the last place of a hosted runner", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 4: 1 });
    const four = runners.get(4);
    if (four === undefined) throw new Error("no runner");
    await hostedTurn(h, four);
    await hostedTurn(h, four);

    const claims = await Promise.all([platformClaim(h), platformClaim(h)]);

    expect(claims.filter((id) => id !== null)).toHaveLength(1);
  });

  // #1105-R154
  it("free the place of a hosted job whose lease lapsed, before the next claim counts", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 4: 1 });
    const four = runners.get(4);
    if (four === undefined) throw new Error("no runner");
    const crashed = await hostedTurn(h, four);
    await hostedTurn(h, four);
    expect(await platformClaim(h)).toBe(crashed.job.id);
    // Full: nothing more to take.
    expect(await platformClaim(h)).toBeNull();

    // The holder dies: no heartbeat for longer than the lease.
    h.clock.advance(3 * MINUTE);

    expect(await platformClaim(h)).not.toBeNull();
    expect(await h.queue.get(crashed.job.id)).not.toMatchObject({
      status: "running",
    });
  });

  // #1105-R155
  it("claims a hosted job by its id (the Dispatcher's path) only while its runner has a place", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 4: 1 });
    const four = runners.get(4);
    if (four === undefined) throw new Error("no runner");
    const first = await hostedTurn(h, four);
    const second = await hostedTurn(h, four);
    const by = (jobId: string) =>
      h.queue.claimNext("dispatcher", ["implementer"], { jobId });

    expect(await by(second.job.id)).not.toBeNull();
    expect(await by(first.job.id)).toBeNull();
    expect(await h.queue.get(first.job.id)).toMatchObject({ status: "queued" });
    await endJob(h, second.job.id);
    expect(await by(first.job.id)).not.toBeNull();
  });
});

describe("a runner that is heard from but can never serve the step (#1105, review of part 2, finding 3)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const turnOn = (h: Harness, runner: { runnerId: string }) =>
    h.enqueueTurn({
      modelChoice: OWN,
      runnerEnvironment: {
        id: runner.runnerId,
        name: "DevBox",
        labels: [runnerLabel(runner.runnerId)],
      },
    });
  /** The runner was heard from a minute ago; the job is 31 minutes old. */
  async function aged(h: Harness, runner: { runnerId: string }) {
    const turn = await turnOn(h, runner);
    h.clock.advance(31 * MINUTE);
    await sql`update runners set last_seen_at = ${new Date(h.clock.now().getTime() - MINUTE).toISOString()} where id = ${runner.runnerId}`.execute(
      h.db,
    );
    return turn;
  }

  // #1105-R160
  it("keeps the job of a runner that can serve it, however busy", async () => {
    const h = await start();
    const devbox = await h.registerRunner();
    const turn = await aged(h, devbox);

    await h.queue.expireStaleJobs();

    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
  });

  // #1105-R161
  it("ends the job of a runner whose manifest has no entry for the auth the step asks for, like an offline one", async () => {
    const h = await start();
    // The step uses the workspace's key (`app-key`); the runner announces only a subscription for another harness.
    const devbox = await h.registerRunner({
      manifest: {
        harnesses: [
          { harness: "opencode", version: "1.19.0", auth: "local-key" },
        ],
        capabilities: [],
      },
    });
    const turn = await aged(h, devbox);

    await h.queue.expireStaleJobs();

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
  });

  // #1105-R162
  it("ends the job of a runner that announces no OpenCode (the claim answers 204 to it for ever)", async () => {
    const h = await start();
    const devbox = await h.registerRunner({
      manifest: { harnesses: [], capabilities: [] },
    });
    const turn = await aged(h, devbox);

    await h.queue.expireStaleJobs();

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
  });

  // #1105-R163
  it("ends the job of a runner below the minimum base version (426 at every claim), and keeps it once the runner is updated", async () => {
    const h = await start();
    vi.stubEnv("RUNNER_MIN_BASE_VERSION", "2.0.0");
    const old = await h.registerRunner({ baseVersion: "1.0.0" });
    const stuck = await aged(h, old);
    const current = await h.registerRunner({ baseVersion: "2.1.0" });
    const fine = await aged(h, current);

    await h.queue.expireStaleJobs();

    expect(await h.queue.get(stuck.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
    expect(await h.queue.get(fine.job.id)).toMatchObject({ status: "queued" });
  });

  // #1105-R164
  it("counts a runner last heard from exactly the deadline ago as offline, and one a millisecond later as reachable", async () => {
    const h = await start();
    const at = new Date(h.clock.now().getTime());
    const edge = await h.registerRunner();
    const inside = await h.registerRunner();
    const a = await turnOn(h, edge);
    const b = await turnOn(h, inside);
    h.clock.advance(40 * MINUTE);
    const deadline = new Date(h.clock.now().getTime() - 30 * MINUTE);
    expect(deadline.getTime()).toBeGreaterThan(at.getTime());
    await sql`update runners set last_seen_at = ${deadline.toISOString()} where id = ${edge.runnerId}`.execute(
      h.db,
    );
    await sql`update runners set last_seen_at = ${new Date(deadline.getTime() + 1).toISOString()} where id = ${inside.runnerId}`.execute(
      h.db,
    );

    await h.queue.expireStaleJobs();

    expect(await h.queue.get(a.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
    expect(await h.queue.get(b.job.id)).toMatchObject({ status: "queued" });
  });
});

describe("what the run page says of a waiting turn, from the database (#1105, review of part 2, findings 2 and 3)", () => {
  afterEach(() => vi.unstubAllEnvs());

  // #1105-R170
  it("counts the places of a full hosted runner, and says nothing while it has one", async () => {
    const h = await start();
    const runners = await hostedRunners(h, { 4: 1 });
    const four = runners.get(4);
    if (four === undefined) throw new Error("no runner");
    const running = await hostedTurn(h, four);
    const waiting = await hostedTurn(h, four);
    const runs = createRunsRepository(h.db, h.workspaceId, h.clock.now);

    expect((await runs.get(waiting.job.id))?.implementer?.wait).toBeNull();
    expect(await platformClaim(h)).toBe(running.job.id);

    expect((await runs.get(waiting.job.id))?.implementer?.wait).toEqual({
      kind: "hosted",
      name: four.name,
      running: 1,
      limit: 1,
    });
  });

  // #1105-R171
  it("tells busy from offline from unable for a self-hosted runner", async () => {
    const h = await start();
    const runs = createRunsRepository(h.db, h.workspaceId, h.clock.now);
    const turnOn = (runner: { runnerId: string }) =>
      h.enqueueTurn({
        modelChoice: OWN,
        runnerEnvironment: {
          id: runner.runnerId,
          name: "DevBox",
          labels: [runnerLabel(runner.runnerId)],
        },
      });
    const waitOf = async (jobId: string) =>
      (await runs.get(jobId))?.implementer?.wait;
    const seen = (runnerId: string, at: Date) =>
      sql`update runners set last_seen_at = ${at.toISOString()} where id = ${runnerId}`.execute(
        h.db,
      );

    const busy = await h.registerRunner({ limits: { parallelRuns: 1 } });
    const firstBusy = await turnOn(busy);
    const waitingBusy = await turnOn(busy);
    await seen(busy.runnerId, h.clock.now());
    // The first turn is running on it (as a claim made it).
    await sql`update jobs set status = 'running', runner_id = ${`runner:${busy.runnerId}`}, claimed_at = ${h.clock.now().toISOString()} where id = ${firstBusy.job.id}`.execute(
      h.db,
    );
    expect(await waitOf(waitingBusy.job.id)).toMatchObject({
      kind: "self_hosted",
      state: "busy",
      running: 1,
      limit: 1,
    });

    const away = await h.registerRunner();
    const waitingAway = await turnOn(away);
    await seen(away.runnerId, new Date(h.clock.now().getTime() - 31 * MINUTE));
    expect(await waitOf(waitingAway.job.id)).toMatchObject({
      state: "offline",
      deadlineMinutes: 30,
    });

    const unable = await h.registerRunner({
      manifest: { harnesses: [], capabilities: [] },
    });
    const waitingUnable = await turnOn(unable);
    expect(await waitOf(waitingUnable.job.id)).toMatchObject({
      state: "cannot_serve",
    });
  });
});
