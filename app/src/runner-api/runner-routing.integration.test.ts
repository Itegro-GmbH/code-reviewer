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
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
import type { ClaimResponse } from "./contract.ts";
import { addWorkspace } from "../test-support/workspaces.ts";

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
  it("hands a runner whose OpenCode is not ready, or not announced, nothing", async () => {
    const h = await start();
    const notReady = await h.registerRunner({
      labels: ["gpu", "linux"],
      manifest: {
        harnesses: { opencode: { version: "1.19.0", ready: false } },
        capabilities: [],
      },
    });
    const otherOnly = await h.registerRunner({
      labels: ["gpu", "linux"],
      manifest: {
        harnesses: { "custom/tool": { version: "1", ready: true } },
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
  it("does not end a turn of a runner environment with no_capable_runner while other runners are busy", async () => {
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

  // #854-T159
  it("ends a runner turn on the operator's key at the claim, before a key or a token exists", async () => {
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
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "runner_needs_own_key",
    });
    expect(h.issuedJobTokens()).toEqual([]);
    expect(h.logLines().join("\n")).not.toContain("dummy-operator");
  });
});
