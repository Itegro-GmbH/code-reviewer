// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim of a customer's runner (#854): the turn of a runner environment goes to a runner of its workspace that has every label of
// the environment and announces a ready OpenCode, and to nobody else; a hosted turn never goes to a runner; the Dispatcher and the
// shared token never take a runner turn; a base below the minimum gets "update needed"; a turn nobody takes ends with
// no_runner_available, free; and the operator's key never leaves for a runner. Against a real Postgres with the harness of the runner API.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import { parseModelsDev } from "../models-dev/parse.ts";
import { planCatalog } from "../models-dev/plan.ts";
import { supportedProvider } from "../models-dev/opencode-providers.ts";
import { nativeCostRegistryFor } from "../native-cost/registry-addresses.ts";
import {
  createNativeCostService,
  type NativeCostService,
} from "../native-cost/service.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import {
  startRunnerApiHarness,
  TEST_LLM_API_KEY,
} from "../test-support/runner-api-harness.ts";
import type { ClaimResponse, SplitClaimResponse } from "./contract.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createRunnersRepository } from "../db/repositories/runners-repository.ts";
import { createRunnerFleetService } from "../runner-fleet/service.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";
import { createDispatchSweep } from "../dispatch/sweep.ts";
import { createAppMetaRepository } from "../db/repositories/app-meta-repository.ts";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const KEY = "dummy-anthropic-key-0123456789-implementer";
const SONNET = "claude-sonnet-5-5";
const PRICE_BOOK = {
  input: "3000000",
  output: "15000000",
  cacheRead: "300000",
  cacheWrite5m: "3750000",
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
  contextOver200k: null,
  tiers: [],
};
const FEATURES = ["cost_limit", "operator_cost_limit", "dynamic_cost_policy"];

const body = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "fakes",
      "fixtures",
      "models-dev",
      "api.json",
    ),
    "utf8",
  ),
) as unknown;

/** The catalog the running server would hold after a fetch of the fixture: the rows of Anthropic, with its default address trusted. */
function catalogRows() {
  const parsed = parseModelsDev(body);
  if (!parsed.ok) throw new Error("fixture");
  const plan = planCatalog({
    parsed,
    stored: { providers: [], models: [] },
    urlChecks: new Map(
      parsed.providers.map((provider) => [
        provider.id,
        {
          ok: true as const,
          url:
            supportedProvider(provider.id)?.defaultBaseUrl ??
            `https://api.${provider.id}.example/v1`,
        },
      ]),
    ),
    now: NOW,
  });
  return plan.write;
}

/** The cost service as the running server builds it (`getNativeCost`), over the fixture instead of a database. */
function nativeCostService(): NativeCostService {
  const rows = catalogRows();
  return createNativeCostService({
    prices: {
      // A confirmed price: a managed turn that reached the policy would be built, so only the claim's own rule can refuse it.
      availability: async () => ({
        selectable: true,
        book: PRICE_BOOK,
        confirmationId: 3,
        hashVersion: 2,
      }),
      // The catalog's price of the fixture's Anthropic model in micro-USD per million tokens (the price service is the admin portal's).
      catalogPrice: async (providerId, modelId) =>
        providerId === "anthropic" && modelId === SONNET ? PRICE_BOOK : null,
    },
    settings: { get: async () => undefined },
    catalog: {
      getProvider: async (id) =>
        rows.providers.find((row) => row.id === id) as
          StoredProvider | undefined,
      getModel: async (providerId, id) =>
        rows.models.find(
          (row) => row.providerId === providerId && row.id === id,
        ) as StoredModel | undefined,
    },
    ...nativeCostRegistryFor({}),
  });
}

async function start(options: { key?: string | null } = {}) {
  const h = await startRunnerApiHarness({
    implementer: true,
    llmKey: null,
    nativeCost: nativeCostService(),
  });
  if (options.key !== null) await h.setLlmKey(options.key ?? KEY, "anthropic");
  return h;
}

function claimOptions() {
  return {
    engines: ["implementer", "opencode", "pr-agent"],
    features: FEATURES,
  };
}

const FEATURES_OF_A_RUNNER = [
  ...FEATURES,
  "implementer_profile",
  "implementer_environment",
];

/** The claim of a customer's runner: its credential is the bearer token, and it names the engine of the turns. */
function claimOf(credential: string, extra: { llmProviders?: string[] } = {}) {
  return {
    token: credential,
    engines: ["implementer"],
    features: FEATURES_OF_A_RUNNER,
    llmProviders: ["openrouter", "anthropic"],
    ...extra,
  };
}

const OWN_MODEL = { provider: "anthropic", model: SONNET } as const;
const RUNNER_ENV = {
  id: "env-runner",
  name: "GPU box",
  labels: ["gpu", "linux"],
};

describe("the claim of a customer's runner", () => {
  // #854-T150
  it("hands a runner that has every label and announces a ready OpenCode the turn of a runner environment, with its own key", async () => {
    const h = await start();
    const { runnerId, credential } = await h.registerRunner({
      labels: ["gpu", "linux", "extra"],
    });
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    const response = await h.claim(claimOf(credential));

    expect(response.status).toBe(200);
    const { job } = (await response.json()) as ClaimResponse;
    expect(job.id).toBe(turn.job.id);
    expect(job.input).toMatchObject({
      reviewKind: "implementer",
      llm: { provider: "anthropic", apiKey: KEY },
    });
    // A turn of a runner environment has no size, script or network rule of its own: the runner decides how it works.
    expect(
      (job.input as { implementer: { environment?: unknown } }).implementer
        .environment,
    ).toBeUndefined();
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "running",
      runnerId: `runner:${runnerId}`,
    });
  });

  // #854-T150
  it("hands a runner that announced its labels in mixed case the turn: the labels are stored in lower case", async () => {
    const h = await start();
    const { credential } = await h.registerRunner({
      labels: ["GPU", " Linux "],
    });
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    const response = await h.claim(claimOf(credential));

    expect(response.status).toBe(200);
    expect(((await response.json()) as ClaimResponse).job.id).toBe(turn.job.id);
  });

  // #854-T151
  it("hands a runner that lacks one label nothing, and the turn stays queued for one that has them all", async () => {
    const h = await start();
    const partial = await h.registerRunner({ labels: ["linux"] });
    const none = await h.registerRunner({ labels: [] });
    const full = await h.registerRunner({ labels: ["linux", "gpu"] });
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    expect((await h.claim(claimOf(partial.credential))).status).toBe(204);
    expect((await h.claim(claimOf(none.credential))).status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect((await h.claim(claimOf(full.credential))).status).toBe(200);
  });

  // #854-T152
  it("hands a runner whose OpenCode is not announced, or only another harness, nothing", async () => {
    const h = await start();
    const notReady = await h.registerRunner({
      labels: ["gpu", "linux"],
      manifest: { harnesses: [], capabilities: [] },
    });
    const otherOnly = await h.registerRunner({
      labels: ["gpu", "linux"],
      manifest: {
        harnesses: [
          { harness: "custom/tool", version: "1", auth: "app-key" },
        ],
        capabilities: [],
      },
    });
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    expect((await h.claim(claimOf(notReady.credential))).status).toBe(204);
    expect((await h.claim(claimOf(otherOnly.credential))).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
  });

  // #854-T153
  it("hands a runner of another workspace nothing, whatever its labels", async () => {
    const h = await start();
    const otherWorkspace = await addWorkspace(h.db, "other");
    const foreign = await h.registerRunner({
      labels: ["gpu", "linux"],
      workspaceId: otherWorkspace,
    });
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    expect((await h.claim(claimOf(foreign.credential))).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
  });

  // #854-T154
  it("never hands a runner a hosted turn, and never hands the Dispatcher or the shared token a runner turn", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const hosted = await h.enqueueTurn({ modelChoice: OWN_MODEL });
    const runnerTurn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    // The runner may take only its own kind of turn.
    const taken = await h.claim(claimOf(runner.credential));
    expect(((await taken.json()) as ClaimResponse).job.id).toBe(
      runnerTurn.job.id,
    );
    expect(await h.queue.get(hosted.job.id)).toMatchObject({
      status: "queued",
    });
    // And the shared token (the Dispatcher's claim by id, a poll) takes the hosted one and never the other.
    const another = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: { ...RUNNER_ENV, id: "env-2" },
    });
    const byId = await h.claim({
      ...claimOptions(),
      jobId: another.job.id,
    });
    expect(byId.status).toBe(204);
    expect(await h.queue.get(another.job.id)).toMatchObject({
      status: "queued",
    });
    const poll = await h.claim(claimOptions());
    expect(((await poll.json()) as ClaimResponse).job.id).toBe(hosted.job.id);
    expect((await h.claim(claimOptions())).status).toBe(204);
    expect(await h.queue.get(another.job.id)).toMatchObject({
      status: "queued",
    });
  });

  // #854-T155
  it("hands a runner nothing but the reason 'update needed' while its base is below the minimum", async () => {
    const h = await start();
    h.setMinBaseVersion("2.0.0");
    const runner = await h.registerRunner({
      labels: ["gpu", "linux"],
      baseVersion: "1.9.9",
    });
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    const refused = await h.claim(claimOf(runner.credential));

    expect(refused.status).toBe(426);
    expect(await refused.json()).toMatchObject({
      error: { code: "RUNNER_UPDATE_NEEDED", minBaseVersion: "2.0.0" },
    });
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    h.setMinBaseVersion("1.9.9");
    expect((await h.claim(claimOf(runner.credential))).status).toBe(200);
  });

  // #854-T156
  it("ends a turn nobody took within the deadline with no_runner_available, free, and not before", async () => {
    const h = await start();
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    h.clock.advance(29 * 60 * 1000);
    expect((await h.claim(claimOptions())).status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });

    h.clock.advance(2 * 60 * 1000);
    expect((await h.claim(claimOptions())).status).toBe(204);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
      attempts: 0,
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #854-T157
  it("does not end a turn of a runner environment with no_capable_runner while another runner is running a job of the same kind", async () => {
    const h = await start();
    const busy = await h.registerRunner({ labels: ["cpu"] });
    const busyTurn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: { id: "env-cpu", name: "CPU box", labels: ["cpu"] },
    });
    const { job: busyJob } = (await (
      await h.claim(claimOf(busy.credential))
    ).json()) as ClaimResponse;
    expect(busyJob.id).toBe(busyTurn.job.id);
    const waiting = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    // The runner of the busy job keeps its lease alive for the whole wait; nobody has the labels of the waiting turn.
    for (let minute = 0; minute < 29; minute += 1) {
      h.clock.advance(60 * 1000);
      expect(
        (
          await h.heartbeat(busyJob.id, busyJob.leaseToken, {
            token: busy.credential,
          })
        ).status,
      ).toBe(200);
    }
    expect((await h.claim(claimOptions())).status).toBe(204);
    expect(await h.queue.get(waiting.job.id)).toMatchObject({
      status: "queued",
    });

    // At its own deadline it ends as no_runner_available while the other runner still works.
    h.clock.advance(2 * 60 * 1000);
    await h.heartbeat(busyJob.id, busyJob.leaseToken, {
      token: busy.credential,
    });
    expect((await h.claim(claimOptions())).status).toBe(204);
    expect(await h.queue.get(waiting.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
    expect(await h.queue.get(busyJob.id)).toMatchObject({ status: "running" });
  });

  // #854-T157
  it("does not end a turn of a runner environment with no_capable_runner when no runner works either", async () => {
    const h = await start();
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    // Past the deadline of no_capable_runner (30 minutes) the turn has its own deadline (also 30): it ends as no_runner_available.
    h.clock.advance(31 * 60 * 1000);

    await h.claim(claimOptions());

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      errorCode: "no_runner_available",
    });
  });

  // #854-T159
  it("lets a hosted deployment's give-up step spare a turn that waits for a runner, which then ends as no_runner_available", async () => {
    const h = await start();
    const sweep = createDispatchSweep({
      now: h.clock.now,
      queue: h.queue,
      dispatches: createJobDispatchesRepository(h.db, h.clock.now),
      meta: createAppMetaRepository(h.db, h.clock.now),
      cleanup: async () => ({
        rateLimits: 0,
        unverifiedAccounts: 0,
        verificationTokens: 0,
        passwordResetTokens: 0,
        jobClaimedKeys: 0,
        jobDispatches: 0,
      }),
      // The give-up time is shorter than the wait for a runner (30 minutes).
      settings: { giveUpMs: 5 * 60 * 1000, maxRunning: null },
      log: { info: () => undefined, error: () => undefined },
    });
    const waiting = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    const hosted = await h.enqueueNew({});

    h.clock.advance(10 * 60 * 1000);
    const report = await sweep.run();

    // The step ran: the hosted job nobody dispatched is given up. The turn for a runner is not a job for a VM.
    expect(report.failedSteps).toEqual([]);
    expect(report.givenUp).toBe(1);
    expect(await h.queue.get(hosted.id)).toMatchObject({
      status: "failed",
      errorCode: "dispatch_unavailable",
    });
    expect(await h.queue.get(waiting.job.id)).toMatchObject({
      status: "queued",
    });

    h.clock.advance(21 * 60 * 1000);
    await sweep.run();
    expect(await h.queue.get(waiting.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_runner_available",
    });
  });

  // #854-T160
  it("does not hold a hosted Implementer turn in the queue because a customer's runner is running a turn", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    const { job: runnerJob } = (await (
      await h.claim(claimOf(runner.credential))
    ).json()) as ClaimResponse;
    // A hosted turn that no Dispatcher claims (no hosted pool is alive): the running turn of the customer's runner is no sign of one.
    const hosted = await h.enqueueTurn({ modelChoice: OWN_MODEL });

    for (let minute = 0; minute < 31; minute += 1) {
      h.clock.advance(60 * 1000);
      await h.heartbeat(runnerJob.id, runnerJob.leaseToken, {
        token: runner.credential,
      });
    }
    expect((await h.queue.expireStaleJobs()).noCapableRunner).toBe(1);

    expect(await h.queue.get(hosted.job.id)).toMatchObject({
      status: "cancelled",
      errorCode: "no_capable_runner",
    });
    expect(await h.queue.get(runnerJob.id)).toMatchObject({
      status: "running",
    });
  });

  // #854-T158
  it("lets the runner that holds a turn report on it, and no runner of another workspace", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const otherWorkspace = await addWorkspace(h.db, "other");
    const foreign = await h.registerRunner({
      labels: ["gpu", "linux"],
      workspaceId: otherWorkspace,
    });
    await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    const { job } = (await (
      await h.claim(claimOf(runner.credential))
    ).json()) as ClaimResponse;

    const own = await h.heartbeat(job.id, job.leaseToken, {
      token: runner.credential,
    });
    const strange = await h.heartbeat(job.id, job.leaseToken, {
      token: foreign.credential,
    });

    expect(own.status).toBe(200);
    expect(strange.status).toBe(404);
    expect(await strange.json()).toMatchObject({
      error: { code: "RUNNER_JOB_NOT_FOUND" },
    });
  });

  // #854-T159, #973-T02
  it("never hands a runner a turn on the operator's key: no runner announces managed, so the claim finds nothing and no key or token exists", async () => {
    const h = await start({ key: null });
    await h.llm
      .operatorKey()
      .save(
        { provider: "anthropic", apiKey: "dummy-operator-anthropic-key" },
        null,
      );
    await createWorkspaceEntitlementsRepository(
      h.db,
      h.workspaceId,
      h.clock.now,
    ).put(
      {
        planLabel: "plan",
        keyMode: "managed",
        limits: {
          diffRunsPerPeriod: null,
          dynamicRunsPerPeriod: null,
          managedCostLimitMicroUsd: null,
          ownKeyCostLimitMicroUsd: null,
        },
        periodStart: "2026-10-01T00:00:00.000Z",
        suspended: false,
        suspensionCode: null,
      },
      null,
    );
    const entry = await h.catalogEntryFor("anthropic", {
      name: "Thorough",
      modelId: SONNET,
      kinds: ["diff", "dynamic"],
      status: "released",
    });
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const turn = await h.enqueueTurn({
      modelChoice: { entryId: entry.id },
      runnerEnvironment: RUNNER_ENV,
    });

    const response = await h.claim(claimOf(runner.credential));

    expect(response.status).toBe(204);
    // The rule that was here (a managed selection on a runner ends the job) is the manifest now: the turn asks for `managed` and only the
    // platform identity announces it. The start of a task and the validator still refuse the combination with `runner_needs_own_key`.
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect(h.issuedJobTokens()).toEqual([]);
    expect(h.logLines().join("\n")).not.toContain("dummy-operator");
  });
});

describe("revoking a runner that is running a turn (#854)", () => {
  async function runningTurn() {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const turn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    const { job } = (await (
      await h.claim(claimOf(runner.credential))
    ).json()) as ClaimResponse;
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
    return { h, runner, turn, job, fleet };
  }

  // #854-T240
  it("refuses it every report about the job it was running, and ends the job at once as failed", async () => {
    const { h, runner, turn, job, fleet } = await runningTurn();
    const issued = h.issuedJobTokens();
    expect(
      (await h.heartbeat(job.id, job.leaseToken, { token: runner.credential }))
        .status,
    ).toBe(200);

    await fleet.revoke(runner.runnerId);

    for (const answer of [
      await h.heartbeat(job.id, job.leaseToken, { token: runner.credential }),
      await h.complete(
        job.id,
        job.leaseToken,
        {},
        { token: runner.credential },
      ),
      await h.steps(
        job.id,
        { leaseToken: job.leaseToken, records: [] },
        { token: runner.credential },
      ),
      await h.release(
        job.id,
        { leaseToken: job.leaseToken, reason: "shutdown" },
        { token: runner.credential },
      ),
    ]) {
      expect(answer.status).toBe(401);
      expect(await answer.json()).toMatchObject({
        error: { code: "RUNNER_UNAUTHORIZED" },
      });
    }
    // The job is over now, not when its lease would have run out: one attempt, so it failed, and it was not put back in the queue.
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "runner_revoked",
    });
    expect(job.id).toBe(turn.job.id);
    // The GitHub token the turn was given is switched off with the claim.
    await h.writeTokensSettled();
    expect(issued.length).toBeGreaterThan(0);
    expect(h.fake.revokedInstallationTokens()).toEqual(
      expect.arrayContaining(issued),
    );
  });

  // #854-T241
  it("cannot reach the session snapshot of the job either: the Worker API takes the per-job credential alone", async () => {
    const { h, runner, job, fleet } = await runningTurn();
    await fleet.revoke(runner.runnerId);

    for (const credential of [runner.credential, job.leaseToken]) {
      const answer = await h.worker.session(
        job.id,
        credential,
        { index: 0, count: 1, size: 1, rawBytes: 1, sha256: "0".repeat(64) },
        new Uint8Array([1]),
      );
      expect(answer.status).toBe(401);
    }
  });

  // #854-T242
  it("leaves the jobs of other runners as they were", async () => {
    const { h, runner, fleet } = await runningTurn();
    const other = await h.registerRunner({ labels: ["gpu", "linux"] });
    await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: { ...RUNNER_ENV, id: "env-2" },
    });
    const { job } = (await (
      await h.claim(claimOf(other.credential))
    ).json()) as ClaimResponse;

    await fleet.revoke(runner.runnerId);

    expect(await h.queue.get(job.id)).toMatchObject({
      status: "running",
      runnerId: customerRunnerId(other.runnerId),
    });
    expect(
      (await h.heartbeat(job.id, job.leaseToken, { token: other.credential }))
        .status,
    ).toBe(200);
  });
});

describe("what a customer's runner never gets (#854)", () => {
  // #854-T243
  it("takes no job of another workspace: not a runner turn with its labels, not a hosted turn, not a review", async () => {
    const h = await start();
    const otherWorkspace = await addWorkspace(h.db, "other");
    const mine = await h.registerRunner({
      labels: ["gpu", "linux"],
      workspaceId: otherWorkspace,
    });
    // Every kind of job the harness workspace has, with the labels the runner has.
    const runnerTurn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    const hostedTurn = await h.enqueueTurn({ modelChoice: OWN_MODEL });
    const review = await h.enqueue({ prNumber: 7 });

    // Asked as a runner, with every engine it could name and with the id of each job.
    for (const jobId of [undefined, runnerTurn.job.id, hostedTurn.job.id])
      expect(
        (
          await h.claim({
            ...claimOf(mine.credential),
            engines: ["implementer", "opencode", "pr-agent"],
            ...(jobId === undefined ? {} : { jobId }),
          })
        ).status,
      ).toBe(204);

    for (const id of [runnerTurn.job.id, hostedTurn.job.id, review.job.id])
      expect(await h.queue.get(id)).toMatchObject({
        status: "queued",
        attempts: 0,
      });
  });

  // #854-T244
  it("takes no hosted turn and no review of its own workspace, whatever it asks for", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const hostedTurn = await h.enqueueTurn({ modelChoice: OWN_MODEL });
    const review = await h.enqueue({ prNumber: 8 });

    expect((await h.claim(claimOf(runner.credential))).status).toBe(204);
    expect(
      (
        await h.claim({
          ...claimOf(runner.credential),
          engines: ["pr-agent", "opencode", "implementer"],
          features: ["worker_credential"],
          jobId: hostedTurn.job.id,
        })
      ).status,
    ).toBe(204);

    for (const id of [hostedTurn.job.id, review.job.id])
      expect(await h.queue.get(id)).toMatchObject({ status: "queued" });
  });

  // #854-T245
  it("takes no turn that was queued for the operator's key, even with labels it has", async () => {
    const h = await start();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const operatorTurn = await h.enqueueTurn({
      modelChoice: { entryId: "entry-1" },
    });

    expect((await h.claim(claimOf(runner.credential))).status).toBe(204);

    expect(await h.queue.get(operatorTurn.job.id)).toMatchObject({
      status: "queued",
    });
  });
});

// #971: one rule for every Dispatcher. A job requires labels (`jobs.required_labels`) and a caller takes it only when it has all of them: the
// platform identity (the shared token) has the reserved labels `cr:managed` and `cr:size-<vCPUs>`, a customer's runner its own. The two
// special rules of #854 above are this rule: their tests are unchanged and still hold.
describe("the labels a job requires (#971)", () => {
  /** The harness of the tests above, with the key of the default provider as well, so a hosted review can be claimed. */
  async function startWithReviews() {
    const h = await start();
    await h.setLlmKey(TEST_LLM_API_KEY);
    return h;
  }

  const requiredOf = async (
    h: Awaited<ReturnType<typeof start>>,
    jobId: string,
  ) =>
    (
      await h.db
        .selectFrom("jobs")
        .select("required_labels")
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow()
    ).required_labels;

  // #971-T02
  it("enqueues a hosted review with cr:managed and its size, and a turn with the size of its environment, or the labels of a runner environment", async () => {
    const h = await startWithReviews();
    const review = await h.enqueue({ prNumber: 7 });
    const standard = await h.enqueueTurn({ modelChoice: OWN_MODEL });
    const sized = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      environment: {
        id: "env-big",
        name: "Big",
        vcpus: 4,
        setupScript: "",
      },
    });
    const runnerTurn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    expect(await requiredOf(h, review.job.id)).toBe("cr:managed\ncr:size-1");
    expect(await requiredOf(h, standard.job.id)).toBe("cr:managed\ncr:size-2");
    expect(await requiredOf(h, sized.job.id)).toBe("cr:managed\ncr:size-4");
    expect(await requiredOf(h, runnerTurn.job.id)).toBe("gpu\nlinux");
    expect(await h.queue.get(review.job.id)).toMatchObject({
      requiredLabels: ["cr:managed", "cr:size-1"],
    });
  });

  // #971-T03
  it("hands the platform identity a hosted job without a job id, and a customer's runner never gets it, even with every label that is not cr:", async () => {
    const h = await startWithReviews();
    const runner = await h.registerRunner({
      labels: ["gpu", "linux", "extra"],
    });
    const review = await h.enqueue({ prNumber: 7 });
    const hostedTurn = await h.enqueueTurn({ modelChoice: OWN_MODEL });

    for (const jobId of [undefined, review.job.id, hostedTurn.job.id])
      expect(
        (
          await h.claim({
            ...claimOf(runner.credential),
            engines: ["pr-agent", "opencode", "implementer"],
            ...(jobId === undefined ? {} : { jobId }),
          })
        ).status,
      ).toBe(204);
    expect(await h.queue.get(review.job.id)).toMatchObject({
      status: "queued",
    });

    const byPlatform = await h.claim({ engines: ["pr-agent"] });
    expect(byPlatform.status).toBe(200);
    expect(((await byPlatform.json()) as ClaimResponse).job.id).toBe(
      review.job.id,
    );
    const turnByPlatform = await h.claim(claimOptions());
    expect(((await turnByPlatform.json()) as ClaimResponse).job.id).toBe(
      hostedTurn.job.id,
    );
  });

  // #971-T03
  it("keeps the reserved labels out of a customer's runner that stored one before the namespace was reserved", async () => {
    const h = await startWithReviews();
    // Registered through the repository, as a runner of the release before was: the door of today would refuse these labels.
    const old = await h.registerRunner({
      labels: ["cr:managed", "cr:size-2", "gpu", "linux"],
    });
    const hostedTurn = await h.enqueueTurn({ modelChoice: OWN_MODEL });

    expect((await h.claim(claimOf(old.credential))).status).toBe(204);

    expect(await h.queue.get(hostedTurn.job.id)).toMatchObject({
      status: "queued",
    });
  });

  // #971-T04
  it("hands a runner with gpu and linux a turn that requires linux, and a runner with linux only no turn that requires linux and gpu", async () => {
    const h = await startWithReviews();
    const both = await h.registerRunner({ labels: ["linux", "gpu"] });
    const linuxOnly = await h.registerRunner({ labels: ["linux"] });
    const needsLinux = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: { id: "env-l", name: "Linux", labels: ["linux"] },
    });
    const needsBoth = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    // The one with linux only gets the first turn, not the second.
    const first = await h.claim(claimOf(linuxOnly.credential));
    expect(((await first.json()) as ClaimResponse).job.id).toBe(
      needsLinux.job.id,
    );
    expect((await h.claim(claimOf(linuxOnly.credential))).status).toBe(204);
    expect(await h.queue.get(needsBoth.job.id)).toMatchObject({
      status: "queued",
    });
    // The one with both takes the second, without naming it.
    const second = await h.claim(claimOf(both.credential));
    expect(((await second.json()) as ClaimResponse).job.id).toBe(
      needsBoth.job.id,
    );
  });

  // #971-T03, #971-T04
  it("routes a job written before the labels as it was: a runner turn by its environment's labels, any other job to the platform", async () => {
    const h = await startWithReviews();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const hostedTurn = await h.enqueueTurn({ modelChoice: OWN_MODEL });
    const runnerTurn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    await h.db
      .updateTable("jobs")
      .set({ required_labels: null })
      .where("id", "in", [hostedTurn.job.id, runnerTurn.job.id])
      .execute();

    expect((await h.claim(claimOptions())).status).toBe(200);
    expect((await h.claim(claimOptions())).status).toBe(204);
    const taken = await h.claim(claimOf(runner.credential));
    expect(((await taken.json()) as ClaimResponse).job.id).toBe(
      runnerTurn.job.id,
    );
    expect(await h.queue.get(hostedTurn.job.id)).toMatchObject({
      status: "running",
      runnerId: "runner-a",
    });
  });

  // #971-T05
  it("claims by job id as before: the platform gets the hosted job it names, and one that is not its to take stays", async () => {
    const h = await startWithReviews();
    const older = await h.enqueue({ prNumber: 7 });
    const wanted = await h.enqueue({ prNumber: 8 });
    const runnerTurn = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });

    const byId = await h.claimSplit({ jobId: wanted.job.id });
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as SplitClaimResponse).job.id).toBe(
      wanted.job.id,
    );
    expect(await h.queue.get(older.job.id)).toMatchObject({ status: "queued" });
    expect(
      (
        await h.claimSplit({
          engines: ["implementer"],
          jobId: runnerTurn.job.id,
        })
      ).status,
    ).toBe(204);
    // Without an id the next claim takes the oldest hosted job.
    const next = await h.claimSplit();
    expect(((await next.json()) as SplitClaimResponse).job.id).toBe(
      older.job.id,
    );
  });

  // #971-T06
  it("names the size label of the job in the claim answer, and the vcpus of an environment as before", async () => {
    const h = await startWithReviews();
    const review = await h.enqueue({ prNumber: 7 });
    const standard = await h.enqueueTurn({ modelChoice: OWN_MODEL });
    const sized = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      environment: { id: "env-big", name: "Big", vcpus: 6, setupScript: "" },
    });
    const split = async (jobId: string, engines: string[]) =>
      (await (
        await h.claimSplit({
          engines,
          features: FEATURES_OF_A_RUNNER,
          jobId,
        })
      ).json()) as SplitClaimResponse;

    const reviewAnswer = await split(review.job.id, ["pr-agent"]);
    const standardAnswer = await split(standard.job.id, ["implementer"]);
    const sizedAnswer = await split(sized.job.id, ["implementer"]);

    expect(reviewAnswer.job.sizeLabel).toBe("cr:size-1");
    expect(reviewAnswer.job).not.toHaveProperty("vcpus");
    expect(standardAnswer.job.sizeLabel).toBe("cr:size-2");
    expect(standardAnswer.job).not.toHaveProperty("vcpus");
    expect(sizedAnswer.job).toMatchObject({
      sizeLabel: "cr:size-6",
      vcpus: 6,
    });
  });

  // #971-T07
  it("never hands the platform a runner turn stored with a cr: label, and still hands it to the customer's runner", async () => {
    const h = await startWithReviews();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    // An environment written before the namespace was reserved: its labels hold `cr:` ones.
    const stored = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: {
        id: "env-old",
        name: "Old",
        labels: ["cr:managed", "cr:size-8", "gpu", "linux"],
      },
    });
    // The same turn as a row of the release before: no required labels, the environment's labels as stored.
    const legacy = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: RUNNER_ENV,
    });
    await h.db
      .updateTable("jobs")
      .set({ required_labels: null })
      .where("id", "=", legacy.job.id)
      .execute();
    await h.db
      .updateTable("implementer_turns")
      .set({ environment_labels: "cr:managed\ncr:size-8\ngpu\nlinux" })
      .where("job_id", "=", legacy.job.id)
      .execute();
    // Defence in depth: even a required list that is only the platform's labels never reaches the platform for a runner turn.
    const reserved = await h.enqueueTurn({
      modelChoice: OWN_MODEL,
      runnerEnvironment: { id: "env-r", name: "R", labels: ["linux"] },
    });
    await h.db
      .updateTable("jobs")
      .set({ required_labels: "cr:managed\ncr:size-8" })
      .where("id", "=", reserved.job.id)
      .execute();

    expect(await requiredOf(h, stored.job.id)).toBe("gpu\nlinux");
    expect((await h.claim(claimOptions())).status).toBe(204);
    expect(
      (await h.claimSplit({ engines: ["implementer"], jobId: legacy.job.id }))
        .status,
    ).toBe(204);
    expect(
      (await h.claimSplit({ engines: ["implementer"], jobId: reserved.job.id }))
        .status,
    ).toBe(204);
    for (const turn of [stored, legacy, reserved])
      expect(await h.queue.get(turn.job.id)).toMatchObject({
        status: "queued",
      });

    const first = await h.claim(claimOf(runner.credential));
    expect(((await first.json()) as ClaimResponse).job.id).toBe(stored.job.id);
    const second = await h.claim(claimOf(runner.credential));
    expect(((await second.json()) as ClaimResponse).job.id).toBe(legacy.job.id);
  });

  // #971-T08
  it("hands a job that requires no label to nobody", async () => {
    const h = await startWithReviews();
    const runner = await h.registerRunner({ labels: ["gpu", "linux"] });
    const review = await h.enqueue({ prNumber: 7 });
    await h.db
      .updateTable("jobs")
      .set({ required_labels: "" })
      .where("id", "=", review.job.id)
      .execute();

    expect((await h.claim({ engines: ["pr-agent"] })).status).toBe(204);
    expect((await h.claimSplit({ jobId: review.job.id })).status).toBe(204);
    expect(
      (
        await h.claim({
          ...claimOf(runner.credential),
          engines: ["pr-agent", "opencode", "implementer"],
        })
      ).status,
    ).toBe(204);
    expect(await h.queue.get(review.job.id)).toMatchObject({
      status: "queued",
    });
  });

  // #971-T06
  it("names the size label of a job written before the labels from its kind: 1 for a review, 2 for a turn without an environment", async () => {
    const h = await startWithReviews();
    const review = await h.enqueue({ prNumber: 7 });
    const turn = await h.enqueueTurn({ modelChoice: OWN_MODEL });
    await h.db
      .updateTable("jobs")
      .set({ required_labels: null })
      .where("id", "in", [review.job.id, turn.job.id])
      .execute();
    const split = async (jobId: string, engines: string[]) =>
      (await (
        await h.claimSplit({ engines, features: FEATURES_OF_A_RUNNER, jobId })
      ).json()) as SplitClaimResponse;

    expect((await split(review.job.id, ["pr-agent"])).job.sizeLabel).toBe(
      "cr:size-1",
    );
    expect((await split(turn.job.id, ["implementer"])).job.sizeLabel).toBe(
      "cr:size-2",
    );
  });
});
