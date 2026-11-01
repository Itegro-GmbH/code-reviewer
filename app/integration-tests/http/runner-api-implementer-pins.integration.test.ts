// SPDX-License-Identifier: LicenseRef-Proprietary

// A turn of the Implementer on the workspace's own key with a model of the models.dev catalog (#790): the key goes only to the address
// the workspace's projects pinned for the provider, as it does for a Dynamic review (#588). A turn has no project of its own, so the
// pins are read from the workspace; a catalog that moved since refuses the turn before any key or token exists.
import { describe, expect, it } from "vitest";
import { createInstanceSettingsRepository } from "../../src/db/repositories/instance-settings-repository.ts";
import { createModelsDevRepository } from "../../src/db/repositories/models-dev-repository.ts";
import { llmProviderDescriptors } from "../../src/llm/providers/index.ts";
import type {
  StoredModel,
  StoredProvider,
} from "../../src/models-dev/catalog.ts";
import type { PriceBookJson } from "../../src/model-prices/price-book.ts";
import { registryAddressesOf } from "../../src/native-cost/registry-addresses.ts";
import { createNativeCostService } from "../../src/native-cost/service.ts";
import { createNativeCatalogReader } from "../../src/native-providers/catalog.ts";
import {
  startRunnerApiHarness,
  type RunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const DEEPSEEK_KEY = "plain-deepseek-key-0001-aaaaaaaaaaaa";
const OPENROUTER_KEY = "plain-openrouter-key-0003-ccccccccc";
const LEGACY = llmProviderDescriptors.ids;
const T1 = "2026-10-19T03:00:00.000Z";
const BOOK: PriceBookJson = {
  input: "660000",
  output: "1980000",
  cacheRead: null,
  cacheWrite5m: null,
  cacheWrite1h: null,
  reasoning: null,
  inputAudio: null,
  outputAudio: null,
  contextOver200k: null,
  tiers: [],
};

function provider(
  id: string,
  overrides: Partial<StoredProvider> = {},
): StoredProvider {
  return {
    id,
    name: id,
    url: {
      state: "trusted",
      trustedUrl: `https://api.${id}.example`,
      pendingUrl: null,
      problem: null,
    },
    urlChangedAt: null,
    firstSeenAt: T1,
    unlistedAt: null,
    updatedAt: T1,
    ...overrides,
  };
}
function model(
  providerId: string,
  id: string,
  overrides: Partial<StoredModel> = {},
): StoredModel {
  return {
    providerId,
    id,
    name: id,
    family: null,
    limit: { context: 128_000, output: 8_000 },
    reasoning: false,
    temperature: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    status: null,
    cost: { input: "0.66", output: "1.98" },
    lastUpdated: null,
    interleaved: null,
    firstSeenAt: T1,
    unlistedAt: null,
    updatedAt: T1,
    ...overrides,
  };
}

const FEATURES = [
  "dynamic_capabilities",
  "dynamic_cost_policy",
  "cost_limit",
  "operator_cost_limit",
];
const IMPLEMENTER = { engines: ["implementer"], features: FEATURES };
const MOVED = "https://api.deepseek-moved.example";
const PINNED = "https://api.deepseek.example";

async function start(
  options: {
    /** The project selects the provider and so pins its address (default); false: no project selects it. */
    pin?: boolean;
    /** The addresses the workspace's projects pinned, instead of what the projects hold. */
    pins?: string[];
    /** Rows of the catalog written after the project saved its selection (the address moves). */
    afterSave?: (
      repository: ReturnType<typeof createModelsDevRepository>,
    ) => Promise<void>;
  } = {},
) {
  let dbRef: RunnerApiHarness["db"] | null = null;
  const lazyRepository = () => {
    if (dbRef === null) throw new Error("database not ready");
    return createModelsDevRepository(dbRef);
  };
  const reader = createNativeCatalogReader({
    models: {
      listProviders: (o) => lazyRepository().listProviders(o),
      listedModelCounts: (id) => lazyRepository().listedModelCounts(id),
      getProvider: (id, o) => lazyRepository().getProvider(id, o),
      listModelsOf: (id) => lazyRepository().listModelsOf(id),
      getModel: (p, m) => lazyRepository().getModel(p, m),
    },
    legacyProviders: LEGACY,
  });
  const keyLoads = { count: 0 };
  const h = await startRunnerApiHarness({
    llmKey: OPENROUTER_KEY,
    projects: true,
    implementer: true,
    env: { LLM_MODEL: "vendor/instance-model", LLM_MAX_TOKENS: "64000" },
    nativeCost: createNativeCostService({
      prices: {
        availability: () =>
          Promise.reject(new Error("an own job asks no availability")),
        catalogPrice: () => Promise.resolve(BOOK),
      },
      settings: {
        get: (key) =>
          dbRef === null
            ? Promise.resolve(undefined)
            : createInstanceSettingsRepository(dbRef).get(key),
      },
      catalog: {
        getProvider: (id, o) => lazyRepository().getProvider(id, o),
        getModel: (p, m) => lazyRepository().getModel(p, m),
      },
      legacyProviders: LEGACY,
      registryAddresses: registryAddressesOf(llmProviderDescriptors.providers),
    }),
    nativeCatalog: reader,
    onKeyLoad: () => {
      keyLoads.count += 1;
    },
    ...(options.pins === undefined
      ? {}
      : { pinnedAddresses: async () => options.pins! }),
  });
  dbRef = h.db;
  const repository = createModelsDevRepository(h.db);
  await repository.apply({
    providers: [provider("deepseek")],
    models: [model("deepseek", "deepseek-v4-pro")],
  });
  await h.setLlmKey(DEEPSEEK_KEY, "deepseek");
  await h.projectService.activateProject(h.repositoryId);
  if (options.pin !== false)
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicProvider: "deepseek",
      dynamicModel: "deepseek-v4-pro",
    });
  await options.afterSave?.(repository);
  const turn = await h.enqueueTurn({
    modelChoice: { provider: "deepseek", model: "deepseek-v4-pro" },
  });
  return Object.assign(h, { keyLoads, turnJobId: turn.job.id });
}

/** The catalog trusts another address for deepseek: an admin confirmed a change (#548), or the catalog moved it. */
async function trustAddress(
  repository: ReturnType<typeof createModelsDevRepository>,
  address: string,
) {
  const [stored] = (await repository.listProviders()).filter(
    (p) => p.id === "deepseek",
  );
  await repository.apply({
    providers: [{ ...stored!, url: { ...stored!.url, trustedUrl: address } }],
    models: [],
  });
}

describe("the workspace's pinned address and a turn of the Implementer", () => {
  // #790
  it("serves a turn at the address the workspace's project pinned", async () => {
    const h = await start();

    const { job } = await h.claimed(IMPLEMENTER);

    expect(job.input).toMatchObject({
      reviewKind: "implementer",
      llm: { provider: "deepseek", apiKey: DEEPSEEK_KEY },
      implementer: { modelEntry: { upstreamBaseUrl: PINNED } },
    });
  });

  // #790: Dynamic refuses this with provider_address_changed; a turn did not hold to the pin at all.
  it("refuses a turn whose catalog address moved after the project pinned it: no key is loaded and the new address gets nothing", async () => {
    const h = await start({
      afterSave: (repository) => trustAddress(repository, MOVED),
    });

    const response = await h.claim(IMPLEMENTER);

    expect(response.status).toBe(204);
    expect(await h.queue.get(h.turnJobId)).toMatchObject({
      status: "failed",
      errorCode: "provider_address_changed",
    });
    expect(h.keyLoads.count).toBe(0);
    expect(h.issuedJobTokens()).toEqual([]);
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
    expect(
      await h.db.selectFrom("job_claimed_keys").selectAll().execute(),
    ).toEqual([]);
    const written = h.logLines().join("\n");
    expect(written).toContain("entry_provider_address_changed");
    expect(written).not.toContain(DEEPSEEK_KEY);
  });

  // #790
  it("refuses a turn when the projects of the workspace pinned different addresses for the provider, since no address is the one they all selected", async () => {
    const h = await start({ pins: [PINNED, MOVED] });

    expect((await h.claim(IMPLEMENTER)).status).toBe(204);

    expect(await h.queue.get(h.turnJobId)).toMatchObject({
      status: "failed",
      errorCode: "provider_address_changed",
    });
    expect(h.keyLoads.count).toBe(0);
    expect(h.fake.issuedInstallationTokens()).toEqual([]);
  });

  // #790
  it("serves a turn at the address the catalog trusts when no project of the workspace pinned the provider", async () => {
    const h = await start({
      pin: false,
      afterSave: (repository) => trustAddress(repository, MOVED),
    });

    const { job } = await h.claimed(IMPLEMENTER);

    expect(job.input).toMatchObject({
      implementer: { modelEntry: { upstreamBaseUrl: MOVED } },
    });
  });
});
