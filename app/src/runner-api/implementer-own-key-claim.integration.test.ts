// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim of a turn of the Implementer on the workspace's own Anthropic key: the agent is OpenCode, so the turn takes the native
// path (the entry from the catalog, the cost policy, the key through the passthrough proxy) although Anthropic is a provider of the
// registry. The rule is the Implementer's alone: a Dynamic and a Diff review on the same provider and the same key keep the claim
// they always had, with the wiring of the running server (the registry's providers are legacy unless the switch is on).
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
import { anthropicDescriptor } from "../llm/providers/anthropic/descriptor.ts";
import { openrouterDescriptor } from "../llm/providers/openrouter/descriptor.ts";
import { createWorkspaceEntitlementsRepository } from "../db/repositories/workspace-entitlements-repository.ts";
import { createImplementerSnapshotsRepository } from "../db/repositories/implementer-snapshots-repository.ts";
import {
  cloneFromTheFake,
  otherName,
  secondInstallation,
  sessionRepo,
  WRITE,
} from "../test-support/multi-repo-claim.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../test-support/runner-api-harness.ts";
import type { ClaimResponse } from "./contract.ts";

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

describe("the claim of a turn of the Implementer on the workspace's own Anthropic key", () => {
  it("builds the native job: the entry of the catalog at Anthropic's own address, the cost policy with the cache prices, and the workspace's key", async () => {
    const h = await start();
    await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    const response = await h.claim(claimOptions());

    expect(response.status).toBe(200);
    const { job } = (await response.json()) as ClaimResponse;
    expect(job.input).toMatchObject({
      reviewKind: "implementer",
      llm: { provider: "anthropic", model: SONNET, apiKey: KEY },
      implementer: {
        modelEntry: {
          providerId: "anthropic",
          npm: "@ai-sdk/anthropic",
          family: "anthropic-messages",
          authHeader: "x-api-key",
          upstreamBaseUrl: "https://api.anthropic.com/v1",
          modelId: SONNET,
        },
        cost: {
          keyMode: "own",
          priceBook: { cacheRead: "300000", cacheWrite5m: "3750000" },
        },
      },
    });
    // The key is the workspace's, and neither the log nor the entry carries it.
    expect(
      JSON.stringify((job.input as Record<string, unknown>).implementer),
    ).not.toContain(KEY);
    expect(h.logLines().join("\n")).not.toContain(KEY);
  });

  it("refuses a turn of a workspace that holds no Anthropic key, before any token exists", async () => {
    const h = await start({ key: null });
    const turn = await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
    });

    expect((await h.claim(claimOptions())).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_not_configured",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  it("refuses a model the catalog does not describe, with a code a member can act on", async () => {
    const h = await start();
    const turn = await h.enqueueTurn({
      modelChoice: {
        provider: "anthropic",
        model: "claude-not-in-the-catalog",
      },
    });

    expect((await h.claim(claimOptions())).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "llm_model_unavailable",
    });
  });
});

// #909: a turn with a start branch goes only to a Worker that reads it; one that did not would start from the base branch.
describe("the claim of a turn of the Implementer with a start branch", () => {
  // #909-T13
  it("hands a Worker with the feature the start branch", async () => {
    const h = await start();
    await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
      startBranch: "feature/start",
    });

    const { job } = await h.claimed({
      ...claimOptions(),
      features: [...FEATURES, "implementer_start_branch"],
    });

    expect(job.input).toMatchObject({
      implementer: { baseBranch: "main", startBranch: "feature/start" },
    });
  });

  // #909-T13
  it("ends the turn implementer_engine_unavailable, free, for a Worker without the feature, before a token exists", async () => {
    const h = await start();
    const turn = await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
      startBranch: "feature/start",
    });

    expect((await h.claim(claimOptions())).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #909-T13
  it("hands a Worker without the feature a turn that has no start branch, with no startBranch field", async () => {
    const h = await start();
    await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    const { job } = await h.claimed(claimOptions());

    expect(
      (job.input as { implementer: Record<string, unknown> }).implementer,
    ).not.toHaveProperty("startBranch");
  });

  // #918-T08
  it("hands the Worker the time limit of the turn, and 3600 seconds when the turn has none", async () => {
    const h = await start();
    await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
      timeLimitMinutes: 15,
    });
    await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });
    const limited = await h.claimed(claimOptions());
    const plain = await h.claimed(claimOptions());
    const limitOf = (job: { input: unknown }) =>
      (job.input as { implementer: { limits: { timeLimitSeconds: number } } })
        .implementer.limits.timeLimitSeconds;

    expect(limitOf(limited.job)).toBe(900);
    expect(limitOf(plain.job)).toBe(3600);
  });
});

describe("a turn that may ask a question (#920)", () => {
  const ASK_FEATURES = [...FEATURES, "implementer_result", "implementer_ask"];
  const SCHEMA = {
    type: "object" as const,
    required: ["summary"],
    properties: { summary: { type: "string" } },
  };

  // #920-T185
  it("does not tell a plain task that a crafted request id makes a workflow step: no run has such a step, so no canAsk", async () => {
    const h = await start();
    // The queue takes any id (the API's parser refuses the prefix, and this goes round it): the claim must not read the id alone.
    await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
      resultSchema: SCHEMA,
      clientRequestId: "wf-00000000-0000-4000-8000-000000000000-0",
    });

    const { job } = await h.claimed({
      engines: ["implementer", "opencode", "pr-agent"],
      features: ASK_FEATURES,
    });

    expect(job.input).toMatchObject({ implementer: { resultSchema: SCHEMA } });
    expect(
      (job.input as { implementer: Record<string, unknown> }).implementer,
    ).not.toHaveProperty("canAsk");
  });
});

describe("a turn of the Implementer on the operator's key", () => {
  // Managed mode is not part of this change: a stored entry on a provider of the registry still ends the turn before any key or token
  // exists, as it did, and is never built as a native job on the operator's key.
  it("ends a turn whose entry is a provider of the registry with implementer_config_invalid, before a token exists", async () => {
    const h = await start({ key: null });
    const saved = await h.llm
      .operatorKey()
      .save(
        { provider: "anthropic", apiKey: "dummy-operator-anthropic-key" },
        null,
      );
    expect(saved.ok).toBe(true);
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
    const turn = await h.enqueueTurn({ modelChoice: { entryId: entry.id } });

    // A runner that advertises the provider, as a real one does: only the claim's own rule can end the turn.
    expect(
      (
        await h.claim({
          ...claimOptions(),
          llmProviders: ["openrouter", "anthropic"],
        })
      ).status,
    ).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });
});

describe("a review on the same provider and key", () => {
  // The new rule must not leak: with the wiring of the running server these two keep the claim they had (no entry, no policy).
  it.each(["diff", "dynamic"] as const)(
    "keeps the registry path for a %s review: the Anthropic wire, no model entry, no cost policy",
    async (reviewKind) => {
      const h = await startRunnerApiHarness({
        nativeCost: nativeCostService(),
        llmKey: null,
        jobOptions: {
          optionsFor: async () => ({
            env: {},
            selection: {
              layers: { project: { provider: "anthropic", model: SONNET } },
              entryId: null,
            },
            ...(reviewKind === "dynamic"
              ? { dynamic: { model: SONNET, skill: "review", maxFindings: 5 } }
              : {}),
          }),
        },
      });
      await h.setLlmKey(KEY, "anthropic");
      await h.enqueueNew({ reviewKind });

      const response = await h.claim({
        engines: ["pr-agent", "opencode"],
        features: FEATURES,
        llmProviders: ["openrouter", "anthropic"],
      });

      expect(response.status).toBe(200);
      const { job } = (await response.json()) as ClaimResponse;
      expect(job.input).toMatchObject({
        llm: { provider: "anthropic", model: SONNET, apiKey: KEY },
      });
      const input = job.input as Record<string, unknown>;
      expect(input.reviewKind).not.toBe("implementer");
      expect(JSON.stringify(input)).not.toContain("modelEntry");
      expect(JSON.stringify(input)).not.toContain('"cost"');
    },
  );
});

describe("a review on a registry provider with no model set", () => {
  // The gate of the selection: only a turn of the Implementer names the registry's providers as catalog models. A review with no model
  // gets the registry's default model of the kind and never a catalog selection (which would need a model and refuse the job).
  const DEFAULTS = {
    anthropic: anthropicDescriptor.defaultModels,
    openrouter: openrouterDescriptor.defaultModels,
  } as const;
  it.each([
    ["anthropic", "dynamic"],
    ["openrouter", "dynamic"],
    ["anthropic", "diff"],
  ] as const)(
    "gives a %s %s review the registry's default model, with no model entry",
    async (provider, reviewKind) => {
      const h = await startRunnerApiHarness({
        nativeCost: nativeCostService(),
        llmKey: null,
        jobOptions: {
          optionsFor: async () => ({
            env: {},
            selection: {
              layers: { project: { provider } },
              entryId: null,
            },
            ...(reviewKind === "dynamic"
              ? {
                  dynamic: {
                    model: DEFAULTS[provider].dynamic,
                    skill: "review",
                    maxFindings: 5,
                  },
                }
              : {}),
          }),
        },
      });
      await h.setLlmKey(KEY, provider);
      await h.enqueueNew({ reviewKind });

      const response = await h.claim({
        engines: ["pr-agent", "opencode"],
        features: FEATURES,
        llmProviders: ["openrouter", "anthropic"],
      });

      expect(response.status).toBe(200);
      const { job } = (await response.json()) as ClaimResponse;
      expect(job.input).toMatchObject({
        llm: {
          provider,
          model: DEFAULTS[provider][reviewKind],
          apiKey: KEY,
        },
      });
      expect(JSON.stringify(job.input)).not.toContain("modelEntry");
    },
  );
});

// #841: a follow-up turn is told about the turns before it, and only a Worker that names `implementer_resume` can run one.
describe("the claim of a follow-up turn of the Implementer", () => {
  const HEAD = "b".repeat(40);
  const AUX = "c".repeat(40);
  const WITH_RESUME = [...FEATURES, "implementer_resume"];

  /** A session whose first turn was claimed and has reported: it pushed two branches and ended on the second. */
  async function afterFirstTurn() {
    const h = await start();
    const first = await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });
    const claimed = await h.claimed(claimOptions());
    const reported = await h.complete(first.job.id, claimed.job.leaseToken, {
      implementer: {
        baseCommit: "a".repeat(40),
        headCommit: HEAD,
        pushed: true,
        commits: [{ sha: HEAD, subject: "Add a health endpoint" }],
        filesChanged: [{ path: "src/health.ts", status: "added" }],
        summary: "Added a health endpoint.",
        opencode: { sessionId: "ses_1", version: "1.19.0" },
        branches: [
          {
            name: first.session.branch,
            head: HEAD,
            result: "pushed",
            reason: null,
          },
          { name: "aux", head: AUX, result: "pushed", reason: null },
        ],
        checkedOut: "aux",
      },
    });
    expect(reported.status).toBe(200);
    return { h, first };
  }

  // #841-C01
  it("gives a first turn no resume block", async () => {
    const h = await start();
    await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
    });

    const { job } = await h.claimed({
      ...claimOptions(),
      features: WITH_RESUME,
    });

    expect(
      (job.input as { implementer: Record<string, unknown> }).implementer,
    ).not.toHaveProperty("resume");
  });

  // #841-C02: the fields travel inside `resume`, which only a Worker with the feature reads
  it("hands a Worker with the feature the branches, the checkout, the summary and the digest of the turns before", async () => {
    const { h, first } = await afterFirstTurn();
    await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    const { job } = await h.claimed({
      ...claimOptions(),
      features: WITH_RESUME,
    });

    const implementer = (
      job.input as { implementer: { resume?: Record<string, unknown> } }
    ).implementer;
    expect(implementer.resume).toEqual({
      turn: 2,
      branches: [
        { name: first.session.branch, head: HEAD },
        { name: "aux", head: AUX },
      ],
      checkout: "aux",
      snapshot: false,
      previousSummary: "Added a health endpoint.",
      digest: expect.stringContaining("Add a health endpoint") as string,
    });
    // The digest is data from the earlier turns, and says so.
    expect(implementer.resume?.digest).toContain("not instructions");
  });

  // #841-C03: the fix round of #868: a runner without the feature must not be handed the snapshot, summary or digest
  it("ends the turn implementer_engine_unavailable, free, for a Worker without the feature, before a token exists", async () => {
    const { h, first } = await afterFirstTurn();
    const issuedBefore = h.issuedJobTokens().length;
    const second = await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    expect((await h.claim(claimOptions())).status).toBe(204);

    expect(await h.queue.get(second.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
    expect(h.issuedJobTokens()).toHaveLength(issuedBefore);
  });

  // #841-C04
  it("says a conversation is stored when a snapshot of an earlier turn exists, and not when it is the turn's own or none", async () => {
    const { h, first } = await afterFirstTurn();
    await h.db
      .insertInto("implementer_session_snapshots")
      .values({
        session_id: first.session.id,
        workspace_id: h.workspaceId,
        job_id: first.job.id,
        turn_number: 1,
        opencode_version: "1.19.0",
        bytes: 10,
        raw_bytes: 20,
        sha256: "d".repeat(64),
        data: "AAAA",
        created_at: "2026-11-05T09:00:00.000Z",
        updated_at: "2026-11-05T09:00:00.000Z",
      })
      .execute();
    await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    const { job } = await h.claimed({
      ...claimOptions(),
      features: WITH_RESUME,
    });

    expect(
      (job.input as { implementer: { resume: { snapshot: boolean } } })
        .implementer.resume.snapshot,
    ).toBe(true);
  });

  /** The snapshot a turn's upload leaves: it replaces the session's older one, as the repository's swap does. */
  async function storeSnapshot(
    h: Awaited<ReturnType<typeof start>>,
    session: { id: string },
    turn: { jobId: string; number: number },
  ) {
    await h.db
      .deleteFrom("implementer_session_snapshots")
      .where("session_id", "=", session.id)
      .execute();
    await h.db
      .insertInto("implementer_session_snapshots")
      .values({
        session_id: session.id,
        workspace_id: h.workspaceId,
        job_id: turn.jobId,
        turn_number: turn.number,
        opencode_version: "1.19.0",
        bytes: 10,
        raw_bytes: 20,
        sha256: "d".repeat(64),
        data: "AAAA",
        created_at: "2026-11-05T09:00:00.000Z",
        updated_at: "2026-11-05T09:00:00.000Z",
      })
      .execute();
  }

  /** The turn `claim` holds, reported as finished on the session's branch, so that the next one can be queued. */
  async function finishTurn(
    h: Awaited<ReturnType<typeof start>>,
    claim: ClaimResponse,
    branch: string,
  ) {
    const reported = await h.complete(claim.job.id, claim.job.leaseToken, {
      implementer: {
        baseCommit: "a".repeat(40),
        headCommit: HEAD,
        pushed: true,
        commits: [],
        filesChanged: [],
        summary: "Did more.",
        opencode: null,
        branches: [
          { name: branch, head: HEAD, result: "pushed", reason: null },
        ],
        checkedOut: branch,
      },
    });
    expect(reported.status).toBe(200);
  }

  const offered = (claim: ClaimResponse) =>
    (claim.job.input as { implementer: { resume: { snapshot: boolean } } })
      .implementer.resume.snapshot;

  // #885-C01: the claim and the download follow the same rule
  it("offers turn 3 no conversation when turn 2 uploaded none, and the download of turn 3 finds none: the snapshot of turn 1 stays stored", async () => {
    const { h, first } = await afterFirstTurn();
    await storeSnapshot(h, first.session, { jobId: first.job.id, number: 1 });
    const options = { ...claimOptions(), features: WITH_RESUME };
    await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });
    const second = await h.claimed(options);
    expect(offered(second)).toBe(true);
    await finishTurn(h, second, first.session.branch);
    await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    const third = await h.claimed(options);

    expect(offered(third)).toBe(false);
    const read = await createImplementerSnapshotsRepository(
      h.db,
      h.workspaceId,
    ).readForJob(third.job.id, third.job.leaseToken);
    expect(read).toStrictEqual({ status: "none" });
    const kept = await h.db
      .selectFrom("implementer_session_snapshots")
      .select(["job_id", "turn_number"])
      .where("session_id", "=", first.session.id)
      .execute();
    expect(kept).toEqual([{ job_id: first.job.id, turn_number: 1 }]);
  });

  // #885-C02
  it("offers turn 3 the conversation of turn 2 when turn 2 uploaded one, and the download of turn 3 serves it", async () => {
    const { h, first } = await afterFirstTurn();
    await storeSnapshot(h, first.session, { jobId: first.job.id, number: 1 });
    const options = { ...claimOptions(), features: WITH_RESUME };
    await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });
    const second = await h.claimed(options);
    await finishTurn(h, second, first.session.branch);
    await storeSnapshot(h, first.session, { jobId: second.job.id, number: 2 });
    await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    const third = await h.claimed(options);

    expect(offered(third)).toBe(true);
    const read = await createImplementerSnapshotsRepository(
      h.db,
      h.workspaceId,
    ).readForJob(third.job.id, third.job.leaseToken);
    expect(read).toMatchObject({
      status: "ok",
      snapshot: { jobId: second.job.id, turnNumber: 2 },
    });
  });

  // #841-C05: the branch the last turn ended on must be one the runner can check out
  it("checks out the session branch (null) when the last turn's checkedOut branch did not arrive", async () => {
    const h = await start();
    const first = await h.enqueueTurn({
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });
    const claimed = await h.claimed(claimOptions());
    await h.complete(first.job.id, claimed.job.leaseToken, {
      implementer: {
        baseCommit: "a".repeat(40),
        headCommit: HEAD,
        pushed: true,
        commits: [],
        filesChanged: [],
        summary: "x",
        opencode: null,
        branches: [
          {
            name: first.session.branch,
            head: HEAD,
            result: "pushed",
            reason: null,
          },
        ],
        checkedOut: "lost-branch",
      },
    });
    await h.enqueueFollowUp(first.session.id, {
      modelChoice: { provider: "anthropic", model: SONNET },
      costLimitCents: 500,
    });

    const { job } = await h.claimed({
      ...claimOptions(),
      features: WITH_RESUME,
    });

    expect(
      (job.input as { implementer: { resume: { checkout: string | null } } })
        .implementer.resume.checkout,
    ).toBeNull();
  });
});

// #1092 (epic #1090, ADR 0006; review finding 4): the claim of a turn on several repositories: what the job carries, the tokens it makes (one for each
// installation, each in the ledger with its connection), and what happens to them when the job cannot be handed out.
describe("the claim of a turn of the Implementer on several repositories", () => {
  const READ_ONLY = { ...WRITE, contents: "read" } as const;
  const MULTI = [...FEATURES, "implementer_multi_repo"];
  const hosted = { modelChoice: { provider: "anthropic", model: SONNET } };

  async function twoOnOneInstallation(h: RunnerApiHarness) {
    return h.enqueueTurn({
      ...hosted,
      costLimitCents: 500,
      repos: [
        sessionRepo(h.repositoryId, h.repository.fullName),
        sessionRepo(h.otherRepositoryId, await otherName(h)),
      ],
    });
  }

  // #1092-T100
  it("hands a Worker that names the feature the repositories, one token for the installation they share, and remembers it with its connection", async () => {
    const h = await start();
    await cloneFromTheFake(h);
    const turn = await twoOnOneInstallation(h);

    const { job } = await h.claimed({ ...claimOptions(), features: MULTI });

    expect(job.id).toBe(turn.job.id);
    const input = job.input as unknown as {
      git: { token: string; tokens: Array<{ id: string; token: string }> };
      implementer: {
        repos: Array<{ name: string; fullName: string; tokenId: string }>;
        branch?: unknown;
      };
    };
    expect(input.implementer.repos.map((repo) => repo.fullName)).toEqual([
      h.repository.fullName,
      await otherName(h),
    ]);
    expect(input.implementer).not.toHaveProperty("branch");
    expect(input.git.tokens).toHaveLength(1);
    expect(input.git.token).toBe(input.git.tokens[0]?.token);
    expect(input.implementer.repos.map((repo) => repo.tokenId)).toEqual([
      input.git.tokens[0]?.id,
      input.git.tokens[0]?.id,
    ]);
    // One request to the platform, for exactly the two repositories.
    expect(h.issuedJobTokens()).toHaveLength(1);
    expect(h.fake.tokenRequests().at(-1)?.repositoryIds?.sort()).toEqual([
      7001, 7002,
    ]);
    const ledger = await h.claimedKeys.gitTokensOf(job.id);
    expect(ledger.map((entry) => entry.token)).toEqual([input.git.token]);
    expect(ledger[0]?.integrationId).toBeDefined();
  });

  // #1092-T101
  it("makes one token for each installation, each for exactly its repositories, and every one is in the ledger with the connection that made it", async () => {
    const h = await start();
    const second = await secondInstallation(h);
    await cloneFromTheFake(h);
    const turn = await h.enqueueTurn({
      ...hosted,
      costLimitCents: 500,
      repos: [
        sessionRepo(h.repositoryId, h.repository.fullName),
        sessionRepo(second.repositoryId, "other/docs"),
        sessionRepo(h.otherRepositoryId, await otherName(h)),
      ],
    });

    const { job } = await h.claimed({ ...claimOptions(), features: MULTI });

    expect(job.id).toBe(turn.job.id);
    const input = job.input as unknown as {
      git: { token: string; tokens: Array<{ id: string; token: string }> };
      implementer: { repos: Array<{ name: string; tokenId: string }> };
    };
    expect(input.git.tokens).toHaveLength(2);
    // The first repository's installation comes first: its token is `git.token`.
    expect(input.git.token).toBe(input.git.tokens[0]?.token);
    const byName = new Map(
      input.implementer.repos.map((repo) => [repo.name, repo.tokenId]),
    );
    const first = h.repository.fullName.split("/")[1] as string;
    const other = (await otherName(h)).split("/")[1] as string;
    expect(byName.get(first)).toBe(byName.get(other));
    expect(byName.get("docs")).not.toBe(byName.get(first));
    expect(
      h.fake
        .tokenRequests()
        .map((request) => [
          request.installationId,
          request.repositoryIds?.length,
        ]),
    ).toEqual([
      [4242, 2],
      [4243, 1],
    ]);
    const ledger = await h.claimedKeys.gitTokensOf(job.id);
    expect(ledger.map((entry) => entry.token).sort()).toEqual(
      input.git.tokens.map((entry) => entry.token).sort(),
    );
    expect(new Set(ledger.map((entry) => entry.integrationId)).size).toBe(2);
    // The end of the turn switches every one of them off, whatever the first repository's state.
    await h.writeTokens.revokeAllOf({
      id: job.id,
      reviewKind: "implementer",
      workspaceId: h.workspaceId,
      repositoryId: h.repositoryId,
    });
    expect(h.fake.revokedInstallationTokens().sort()).toEqual(
      input.git.tokens.map((entry) => entry.token).sort(),
    );
    expect(await h.claimedKeys.gitTokensOf(job.id)).toEqual([]);
  });

  // #1092-T102
  it("switches off every token it made when the job breaks a rule of the contract after the tokens exist, and ends the turn with the app's own code", async () => {
    const h = await start();
    const second = await secondInstallation(h);
    // The clone addresses are on another host than the API: the job breaks `clone_url_host`, which is only seen when the job is built.
    const turn = await h.enqueueTurn({
      ...hosted,
      costLimitCents: 500,
      repos: [
        sessionRepo(h.repositoryId, h.repository.fullName),
        sessionRepo(second.repositoryId, "other/docs"),
      ],
    });

    expect((await h.claim({ ...claimOptions(), features: MULTI })).status).toBe(
      204,
    );

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
    expect(h.issuedJobTokens()).toHaveLength(2);
    expect(h.fake.revokedInstallationTokens().sort()).toEqual(
      h.issuedJobTokens().sort(),
    );
    expect(await h.claimedKeys.gitTokensOf(turn.job.id)).toEqual([]);
    expect(h.logLines().join("\n")).toContain("clone_url_host");
  });

  // #1092-T103
  it("leaves the turn queued for a Worker that does not name the feature: no token, nothing fails", async () => {
    const h = await start();
    await cloneFromTheFake(h);
    const turn = await twoOnOneInstallation(h);

    expect((await h.claim(claimOptions())).status).toBe(204);

    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect(h.issuedJobTokens()).toEqual([]);
  });

  // #1092-T104
  it("ends the turn implementer_engine_unavailable, free, when the Worker that fetches it does not name the feature, before a token exists", async () => {
    const h = await start();
    await cloneFromTheFake(h);
    const turn = await twoOnOneInstallation(h);

    const claim = await h.claimedSplit({
      engines: ["implementer"],
      features: MULTI,
    });
    const response = await h.worker.details(
      claim.job.id,
      claim.job.credential,
      FEATURES.join(","),
    );

    expect(claim.job.id).toBe(turn.job.id);
    expect(response.status).toBe(409);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_engine_unavailable",
    });
    expect(h.logLines().join("\n")).toContain("implementer_multi_repo");
  });

  // #1092-T105
  it("hands a Worker that names the feature the job of a Worker fetch, with the tokens remembered before they leave", async () => {
    const h = await start();
    await cloneFromTheFake(h);
    await twoOnOneInstallation(h);

    const claim = await h.claimedSplit({
      engines: ["implementer"],
      features: MULTI,
    });
    const response = await h.worker.details(
      claim.job.id,
      claim.job.credential,
      MULTI.join(","),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      job: {
        input: {
          git: { tokens: unknown[] };
          implementer: { repos: unknown[] };
        };
      };
    };
    expect(body.job.input.implementer.repos).toHaveLength(2);
    expect(body.job.input.git.tokens).toHaveLength(1);
    expect(await h.claimedKeys.gitTokensOf(claim.job.id)).toHaveLength(1);
  });

  // #1092-T106
  it("asks for no right to write when the profile may not push, and makes a token that cannot write; without that profile the same installation refuses the turn", async () => {
    const h = await start();
    await cloneFromTheFake(h);
    h.fake.setInstallationPermissions(4242, READ_ONLY);
    const profile = {
      id: "p-1",
      name: "reader",
      version: 1,
      instructions: "",
      canPush: false,
    };
    await h.enqueueTurn({
      ...hosted,
      costLimitCents: 500,
      profile,
      repos: [
        sessionRepo(h.repositoryId, h.repository.fullName),
        sessionRepo(h.otherRepositoryId, await otherName(h)),
      ],
    });

    const { job } = await h.claimed({
      ...claimOptions(),
      features: [...MULTI, "implementer_profile"],
    });

    expect(job.input).toMatchObject({
      implementer: { profile: { canPush: false } },
    });
    expect(h.fake.tokenRequests().at(-1)?.permissions).toMatchObject({
      contents: "read",
    });

    const refused = await start();
    await cloneFromTheFake(refused);
    refused.fake.setInstallationPermissions(4242, READ_ONLY);
    const writer = await twoOnOneInstallation(refused);
    expect(
      (await refused.claim({ ...claimOptions(), features: MULTI })).status,
    ).toBe(204);
    expect(await refused.queue.get(writer.job.id)).toMatchObject({
      status: "failed",
      errorCode: "git_write_not_granted",
    });
    expect(refused.issuedJobTokens()).toEqual([]);
  });

  // #1092-T107 (review finding 3)
  it("ends a turn whose stored repositories cannot be read, instead of running it on the first repository alone", async () => {
    const h = await start();
    await cloneFromTheFake(h);
    const turn = await twoOnOneInstallation(h);
    await h.db
      .updateTable("implementer_sessions")
      .set({ repos: "{broken" })
      .where("id", "=", turn.session.id)
      .execute();

    expect((await h.claim({ ...claimOptions(), features: MULTI })).status).toBe(
      204,
    );

    expect(await h.queue.get(turn.job.id)).toMatchObject({
      status: "failed",
      errorCode: "implementer_config_invalid",
    });
    expect(h.issuedJobTokens()).toEqual([]);
  });
});
