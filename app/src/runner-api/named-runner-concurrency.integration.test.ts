// SPDX-License-Identifier: LicenseRef-Proprietary

// The concurrency of a hosted runner and the wait of a job whose runner is unreachable (#1105, ADR 0007, decisions 5, 13 and 16) against a
// real Postgres (the self-hosted runner's own concurrency and the wait of a busy one go through the HTTP claim: `runner-routing.integration.test.ts`). A hosted runner (a type of the provided Vercel Sandbox, in one workspace) runs as many turns at the same time as its
// concurrency, and another type or another kind of environment is not held by it; a job whose hosted runner is full waits and is not
// given up as undispatched. A self-hosted runner is held by `parallelRuns` within the operator's maximum, and a job that waits for it keeps
// waiting while it is reachable: only a runner that is revoked or not heard from for the whole deadline ends the job (`no_runner_available`).
import { describe, expect, it } from "vitest";
import { sql } from "kysely";
import {
  createNamedRunnersRepository,
  ensureHostedRunners,
} from "../db/repositories/named-runners-repository.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
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
