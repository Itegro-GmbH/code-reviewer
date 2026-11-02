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
import { startRunnerApiHarness } from "../test-support/runner-api-harness.ts";
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
      availability: async () => {
        throw new Error("the own key asks no availability");
      },
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
