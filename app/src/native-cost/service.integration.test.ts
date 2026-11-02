// SPDX-License-Identifier: LicenseRef-Proprietary

// What the claim asks about the cost of a native job (#553), end to end over a real database, with the
// catalog filled by the real fetch against the models.dev fake and the real price service: the managed key (we pay) gets a
// policy only for a model that is enabled and has a confirmed price; the own key (the user pays the provider) is never
// blocked by a price and is bound by the instance's token cap, which the admin changes.
import { afterEach, describe, expect, it } from "vitest";
import {
  modelsDevFixture,
  startModelsDevFake,
  type ModelsDevFake,
} from "../../../fakes/models-dev/server.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import { GUARD_REASONS } from "../models-dev/errors.ts";
import { createModelsDevService } from "../models-dev/service.ts";
import { createModelPriceService } from "../model-prices/service.ts";
import { MODELS_DEV_ENGINES } from "../test-support/models-dev-engines.ts";
import { createNativeCostService } from "./service.ts";

const T1 = new Date("2026-10-19T03:00:00.000Z");
const ADMIN = "admin-1";
const SONNET = { providerId: "anthropic", modelId: "claude-sonnet-5-5" };
const OPENROUTER = {
  providerId: "openrouter",
  modelId: "mistralai/mistral-saba",
};
const DEEPSEEK = { providerId: "deepseek", modelId: "deepseek-v4-pro" };
// The model-prices tests keep the price rules; here the legacy registry is the only thing the service needs to be told.
const LEGACY = ["openrouter", "anthropic"] as const;
// The registry's addresses (#578): the key of these two providers goes nowhere else.
const REGISTRY_ADDRESSES = {
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
} as const;

const fakes: ModelsDevFake[] = [];
afterEach(async () => {
  for (const fake of fakes.splice(0)) await fake.stop();
});

describe.each(MODELS_DEV_ENGINES)(
  "the cost policy of a claim on $name",
  (engine) => {
    async function setup(catalog?: unknown) {
      const fake = await startModelsDevFake();
      fakes.push(fake);
      if (catalog !== undefined) fake.respondWith(catalog);
      const { db } = await engine.create();
      const modelsDev = createModelsDevService({
        db,
        settings: () => ({ enabled: true, url: fake.url, warnings: [] }),
        resolveHost: async () => ["93.184.216.34"],
        now: () => T1,
        log: { info: () => undefined, error: () => undefined },
      });
      await modelsDev.refresh();
      const prices = createModelPriceService({
        db,
        now: () => T1,
        log: { info: () => undefined, error: () => undefined },
        overrideOf: () => undefined,
      });
      const settings = createInstanceSettingsRepository(db);
      const native = createNativeCostService({
        prices,
        settings,
        catalog: createModelsDevRepository(db),
        legacyProviders: LEGACY,
        registryAddresses: REGISTRY_ADDRESSES,
      });
      const confirm = async (ids: typeof SONNET) => {
        await prices.setEnabled(ADMIN, { ...ids, enabled: true });
        const view = await prices.get(ids.providerId, ids.modelId);
        if (!view.ok) throw new Error("no view");
        await prices.confirmPrice(ADMIN, {
          ...ids,
          referenceHash: view.model.price.reference.hash,
        });
      };
      return { db, fake, modelsDev, prices, settings, native, confirm };
    }

    describe("the managed key", () => {
      // #553-T01
      it("refuses a model that is enabled and has never been confirmed", async () => {
        const t = await setup();
        await t.prices.setEnabled(ADMIN, { ...DEEPSEEK, enabled: true });

        expect(
          await t.native.policyFor("managed", {
            providerId: "deepseek",
            modelId: "deepseek-v4-pro",
          }),
        ).toEqual({
          ok: false,
          code: "catalog_price_unconfirmed",
          reason: "price_unconfirmed",
        });
      });

      // #553-T01
      it("refuses a model nobody enabled, however its price stands", async () => {
        const t = await setup();

        expect(await t.native.policyFor("managed", DEEPSEEK)).toEqual({
          ok: false,
          code: "catalog_model_unavailable",
          reason: "model_not_enabled",
        });
      });

      // #553-T01
      it("refuses a model whose confirmed price went stale", async () => {
        const t = await setup();
        await t.confirm(DEEPSEEK);
        expect((await t.native.policyFor("managed", DEEPSEEK)).ok).toBe(true);

        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, { cost: { output: number } }> }
        >;
        body.deepseek!.models["deepseek-v4-pro"]!.cost.output = 3;
        t.fake.respondWith(body);
        await t.modelsDev.refresh({
          acceptReasons: GUARD_REASONS,
        });

        expect(await t.native.policyFor("managed", DEEPSEEK)).toMatchObject({
          ok: false,
          code: "catalog_price_unconfirmed",
        });
      });

      // #553-T01
      it("refuses a model nobody priced", async () => {
        const t = await setup();
        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, { cost?: unknown }> }
        >;
        delete body.deepseek!.models["deepseek-v4-pro"]!.cost;
        t.fake.respondWith(body);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        await t.prices.setEnabled(ADMIN, { ...DEEPSEEK, enabled: true });

        expect(await t.native.policyFor("managed", DEEPSEEK)).toMatchObject({
          ok: false,
          code: "catalog_price_unconfirmed",
        });
      });

      // #553-T02
      it("carries the confirmed book as the only price source, and no token cap", async () => {
        const t = await setup();
        await t.confirm(DEEPSEEK);

        const outcome = await t.native.policyFor("managed", DEEPSEEK);

        expect(outcome).toMatchObject({
          ok: true,
          policy: {
            keyMode: "managed",
            maxTotalTokens: null,
            priceBook: {
              input: "660000",
              output: "1980000",
              cacheRead: "22000",
            },
          },
        });
      });

      // #553-R04
      it("refuses a confirmed book that sells a cache write and no cache read", async () => {
        const t = await setup();
        await t.prices.setEnabled(ADMIN, { ...SONNET, enabled: true });
        const view = await t.prices.get(SONNET.providerId, SONNET.modelId);
        if (!view.ok) throw new Error("no view");
        const book = { ...view.model.price.reference.book!, cacheRead: null };
        await t.prices.correctPrice(ADMIN, {
          ...SONNET,
          referenceHash: view.model.price.reference.hash,
          price: book,
          reason: "test",
        });

        expect(await t.native.policyFor("managed", SONNET)).toEqual({
          ok: false,
          code: "catalog_price_unconfirmed",
          reason: "cache_read_unpriced",
        });
      });
    });

    describe("the cache prices of the managed key", () => {
      // #577-L4
      it("refuses a confirmed model that states no cache read, until the admin states it in a correction", async () => {
        const t = await setup();
        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, { cost: Record<string, unknown> }> }
        >;
        delete body.deepseek!.models["deepseek-v4-pro"]!.cost.cache_read;
        t.fake.respondWith(body);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        await t.confirm(DEEPSEEK);

        expect(await t.native.policyFor("managed", DEEPSEEK)).toEqual({
          ok: false,
          code: "catalog_price_unconfirmed",
          reason: "cache_read_unpriced",
        });
        const view = await t.prices.get(DEEPSEEK.providerId, DEEPSEEK.modelId);
        if (!view.ok) throw new Error("no view");
        // The input price is the upper bound the admin may state.
        const price = {
          ...view.model.price.reference.book!,
          cacheRead: view.model.price.reference.book!.input,
        };
        const corrected = await t.prices.correctPrice(ADMIN, {
          ...DEEPSEEK,
          referenceHash: view.model.price.reference.hash,
          price,
          reason: "no cache price stated: the input price as the upper bound",
        });
        expect(corrected.ok).toBe(true);

        expect(await t.native.policyFor("managed", DEEPSEEK)).toMatchObject({
          ok: true,
          policy: { priceBook: { cacheRead: "660000" } },
        });
      });
    });

    describe("the own key", () => {
      // #553-T04
      it("is never blocked by a price: the catalog's price is used even unconfirmed, with the cap", async () => {
        const t = await setup();

        const outcome = await t.native.policyFor("own", DEEPSEEK);

        expect(outcome).toMatchObject({
          ok: true,
          policy: {
            keyMode: "own",
            maxTotalTokens: 4_000_000,
            priceBook: { input: "660000", output: "1980000" },
          },
        });
      });

      // #553-T05
      it("has no book for a model nobody priced and is still bound by the cap", async () => {
        const t = await setup();
        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, { cost?: unknown }> }
        >;
        delete body.deepseek!.models["deepseek-v4-pro"]!.cost;
        t.fake.respondWith(body);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });

        expect(await t.native.policyFor("own", DEEPSEEK)).toEqual({
          ok: true,
          policy: {
            keyMode: "own",
            priceBook: null,
            maxTotalTokens: 4_000_000,
          },
          confirmation: null,
        });
      });

      // #553-T11
      it("takes the cap from the instance setting at every claim", async () => {
        const t = await setup();
        expect(await t.native.policyFor("own", DEEPSEEK)).toMatchObject({
          policy: { maxTotalTokens: 4_000_000 },
        });

        await t.settings.set("own_key_max_total_tokens", 1_500_000, null);
        expect(await t.native.policyFor("own", DEEPSEEK)).toMatchObject({
          policy: { maxTotalTokens: 1_500_000 },
        });

        // A damaged value reads as the default, never as no cap.
        await t.settings.set("own_key_max_total_tokens", 7, null);
        expect(await t.native.policyFor("own", DEEPSEEK)).toMatchObject({
          policy: { maxTotalTokens: 4_000_000 },
        });
      });
    });

    describe("a task of the Implementer on the registry's providers", () => {
      // The agent is OpenCode: the key of Anthropic or OpenRouter goes through the passthrough proxy with an entry and a policy.
      it("names the catalog model of Anthropic and of OpenRouter, and the reviews still do not", async () => {
        const t = await setup();

        expect(
          t.native.implementerRefOf({
            provider: "anthropic",
            model: "claude-sonnet-5-5",
          }),
        ).toEqual(SONNET);
        expect(
          t.native.implementerRefOf({
            provider: "openrouter",
            model: "mistralai/mistral-saba",
          }),
        ).toEqual(OPENROUTER);
        expect(
          t.native.refOf({ provider: "anthropic", model: "claude-sonnet-5-5" }),
        ).toBeNull();
        expect(
          t.native.refOf({
            provider: "openrouter",
            model: "mistralai/mistral-saba",
          }),
        ).toBeNull();
      });

      // Prompt caching is on for Anthropic: the cache prices reach the runner, which prices cache reads and writes with them.
      it("prices an Anthropic model on the own key with the cache read and cache write prices of the catalog, bound by the cap", async () => {
        const t = await setup();

        expect(await t.native.policyFor("own", SONNET)).toEqual({
          ok: true,
          policy: {
            keyMode: "own",
            maxTotalTokens: 4_000_000,
            priceBook: expect.objectContaining({
              input: "2000000",
              output: "10000000",
              cacheRead: "100000",
              cacheWrite5m: "2500000",
            }),
          },
          confirmation: null,
        });
      });

      it("builds the entry of the registry's address, whatever pin a project holds for the provider", async () => {
        const t = await setup();

        expect(await t.native.entryFor(SONNET, undefined)).toMatchObject({
          ok: true,
          entry: {
            providerId: "anthropic",
            family: "anthropic-messages",
            upstreamBaseUrl: "https://api.anthropic.com/v1",
          },
        });
        expect(await t.native.entryFor(OPENROUTER, undefined)).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://openrouter.ai/api/v1" },
        });
      });
    });

    describe("the address a selection is pinned to (#588)", () => {
      const MOVED = "https://api.attacker.example/v1";

      async function movedAndConfirmed() {
        const t = await setup();
        const moved = modelsDevFixture() as Record<string, { api?: string }>;
        moved.deepseek!.api = MOVED;
        t.fake.respondWith(moved);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        await createModelsDevRepository(t.db).confirmPendingUrl(
          "deepseek",
          MOVED,
        );
        return t;
      }

      // #588-T15
      it("serves the entry when the pin is the address the catalog trusts, and names exactly the pin", async () => {
        const t = await setup();

        expect(
          await t.native.entryFor(DEEPSEEK, "https://api.deepseek.com"),
        ).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://api.deepseek.com" },
        });
      });

      // #588-T16
      it("is refused as provider_address_changed when the catalog trusts another address than the pin, an admin's confirmation included", async () => {
        const t = await movedAndConfirmed();

        const outcome = await t.native.entryFor(
          DEEPSEEK,
          "https://api.deepseek.com",
        );

        expect(outcome).toEqual({
          ok: false,
          code: "provider_address_changed",
        });
        expect(JSON.stringify(outcome)).not.toContain("attacker");
        // The same selection pinned anew is served, at the new address.
        expect(await t.native.entryFor(DEEPSEEK, MOVED)).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: MOVED },
        });
      });

      // #588-T17
      it("serves a selection without a pin at the trusted address and says it is unpinned", async () => {
        const t = await setup();

        expect(await t.native.entryFor(DEEPSEEK)).toMatchObject({
          ok: true,
          unpinned: true,
          entry: { upstreamBaseUrl: "https://api.deepseek.com" },
        });
        expect(
          await t.native.entryFor(DEEPSEEK, "https://api.deepseek.com"),
        ).not.toHaveProperty("unpinned");
      });

      // #588-T18
      it("keeps the registry's own address for a registry provider and ignores a pin there", async () => {
        const t = await setup();

        expect(
          await t.native.entryFor(SONNET, "https://api.deepseek.com"),
        ).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://api.anthropic.com/v1" },
        });
      });
    });

    describe("the model entry", () => {
      // #578-T03
      it("is the entry of the chosen model, with the address of its provider and no key and no price", async () => {
        const t = await setup();

        const outcome = await t.native.entryFor(DEEPSEEK);

        expect(outcome).toMatchObject({
          ok: true,
          entry: {
            version: 1,
            providerId: "deepseek",
            npm: "@ai-sdk/openai-compatible",
            family: "openai-chat",
            authHeader: "Authorization",
            upstreamBaseUrl: "https://api.deepseek.com",
            modelId: "deepseek-v4-pro",
          },
        });
        const text = JSON.stringify(outcome);
        expect(text).not.toContain("cost");
        expect(text).not.toContain("apiKey");
      });

      // #578-T03
      it("is the entry of an Anthropic model too", async () => {
        const t = await setup();

        expect(await t.native.entryFor(SONNET)).toMatchObject({
          ok: true,
          entry: {
            providerId: "anthropic",
            npm: "@ai-sdk/anthropic",
            family: "anthropic-messages",
            authHeader: "x-api-key",
            modelId: "claude-sonnet-5-5",
          },
        });
      });

      // #578-T28
      it("is refused for a registry provider whose address, trusted on first sight, is not the registry's, before any key", async () => {
        const first = modelsDevFixture() as Record<string, { api?: string }>;
        first.openrouter!.api = "https://openrouter-proxy.evilcorp.net/api/v1";
        const t = await setup(first);

        const outcome = await t.native.entryFor(OPENROUTER);

        expect(outcome).toEqual({ ok: false, code: "upstream_not_registry" });
        expect(JSON.stringify(outcome)).not.toContain("evilcorp");
      });

      // #578-T28
      it("is refused for a registry provider whose changed address an admin confirmed, and the catalog alone would serve it", async () => {
        const t = await setup();
        const moved = modelsDevFixture() as Record<string, { api?: string }>;
        moved.anthropic!.api = "https://anthropic-proxy.evilcorp.net/v1";
        t.fake.respondWith(moved);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        expect(await t.native.entryFor(SONNET)).toEqual({
          ok: false,
          code: "provider_url_blocked",
        });

        const catalog = createModelsDevRepository(t.db);
        await catalog.confirmPendingUrl(
          "anthropic",
          "https://anthropic-proxy.evilcorp.net/v1",
        );

        expect(await t.native.entryFor(SONNET)).toEqual({
          ok: false,
          code: "upstream_not_registry",
        });
      });

      // #578-T28
      it("is the entry of the registry's address for both registry providers", async () => {
        const t = await setup();

        expect(await t.native.entryFor(SONNET)).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://api.anthropic.com/v1" },
        });
        expect(await t.native.entryFor(OPENROUTER)).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://openrouter.ai/api/v1" },
        });
      });

      // #578-T28
      it("keeps the rules of the catalog for a provider the registry has no address for", async () => {
        const moved = modelsDevFixture() as Record<string, { api?: string }>;
        moved.deepseek!.api = "https://api.deepseek-other.example/v1";
        const t = await setup(moved);

        expect(await t.native.entryFor(DEEPSEEK)).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://api.deepseek-other.example/v1" },
        });
      });

      // #555-T13
      it("is refused for a provider whose address the catalog never trusted: nothing the workspace could make the key go to", async () => {
        const first = modelsDevFixture() as Record<string, { api?: string }>;
        first.deepseek!.api = "https://10.0.0.5/v1";
        const t = await setup(first);

        const outcome = await t.native.entryFor(DEEPSEEK);

        expect(outcome).toEqual({ ok: false, code: "provider_url_blocked" });
        expect(JSON.stringify(outcome)).not.toContain("10.0.0.5");
      });

      // #555-T13
      it("is refused for a provider whose address changed to another one and waits for an admin, and served once an admin confirmed it", async () => {
        const t = await setup();
        const moved = modelsDevFixture() as Record<string, { api?: string }>;
        moved.deepseek!.api = "https://api.attacker.example/v1";
        t.fake.respondWith(moved);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        expect(await t.native.entryFor(DEEPSEEK)).toEqual({
          ok: false,
          code: "provider_url_blocked",
        });

        await createModelsDevRepository(t.db).confirmPendingUrl(
          "deepseek",
          "https://api.attacker.example/v1",
        );

        // The admin's decision is the catalog's trust: the entry names exactly that address.
        expect(await t.native.entryFor(DEEPSEEK)).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://api.attacker.example/v1" },
        });
      });

      // The ten providers the committed file (`contracts/opencode-providers.v1.json`) has an SDK address for: that address is
      // the one expected, whatever models.dev states.
      // #555-T15
      it("is refused, on the first fetch and on every one after, for a provider with a committed address whose models.dev address differs", async () => {
        const first = modelsDevFixture() as Record<string, { api?: string }>;
        first.openai!.api = "https://api.attacker.example/v1";
        const t = await setup(first);
        const OPENAI = { providerId: "openai", modelId: "gpt-5.5" };

        expect(await t.native.entryFor(OPENAI)).toEqual({
          ok: false,
          code: "provider_url_blocked",
        });
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });
        expect(await t.native.entryFor(OPENAI)).toEqual({
          ok: false,
          code: "provider_url_blocked",
        });
      });

      // #555-T15
      it("is served at the committed address for a provider whose models.dev address is the same one or states none", async () => {
        const same = modelsDevFixture() as Record<string, { api?: string }>;
        same.openai!.api = "https://API.openai.com/v1/";
        const stated = await setup(same);
        const none = await setup();

        for (const t of [stated, none])
          expect(
            await t.native.entryFor({
              providerId: "openai",
              modelId: "gpt-5.5",
            }),
          ).toMatchObject({
            ok: true,
            entry: { upstreamBaseUrl: "https://api.openai.com/v1" },
          });
      });

      // #555-T15
      it("is served at the address an admin confirmed for such a provider, and stays so on the next fetch", async () => {
        const moved = modelsDevFixture() as Record<string, { api?: string }>;
        moved.openai!.api = "https://gateway.example/v1";
        const t = await setup(moved);
        const OPENAI = { providerId: "openai", modelId: "gpt-5.5" };
        expect((await t.native.entryFor(OPENAI)).ok).toBe(false);

        await createModelsDevRepository(t.db).confirmPendingUrl(
          "openai",
          "https://gateway.example/v1",
        );
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });

        expect(await t.native.entryFor(OPENAI)).toMatchObject({
          ok: true,
          entry: { upstreamBaseUrl: "https://gateway.example/v1" },
        });
      });

      // #555-T13
      it.each([
        "https://API.deepseek.com",
        "https://api.deepseek.com/",
        "https://api.deepseek.com:443",
        "https://api.deepseek.com//v1",
        "https://api.deepseek.com/v1/../v2",
        "https://10.0.0.5/v1",
        "https://localhost/v1",
        "https://models.internal/v1",
      ])(
        "is refused for a provider whose stored trusted address %s is not a plain public https address in its canonical spelling",
        async (address) => {
          const t = await setup();
          const catalog = createModelsDevRepository(t.db);
          const [stored] = (await catalog.listProviders()).filter(
            (provider) => provider.id === "deepseek",
          );
          await catalog.apply({
            providers: [
              { ...stored!, url: { ...stored!.url, trustedUrl: address } },
            ],
            models: [],
          });

          const outcome = await t.native.entryFor(DEEPSEEK);

          expect(outcome).toEqual({ ok: false, code: "upstream_invalid" });
          expect(JSON.stringify(outcome)).not.toContain("10.0.0.5");
        },
      );

      // #555-T09
      it("says whether the model is still listed by the catalog", async () => {
        const t = await setup();
        expect(await t.native.entryFor(DEEPSEEK)).toMatchObject({
          ok: true,
          unlisted: false,
        });
        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, unknown> }
        >;
        delete body.deepseek!.models["deepseek-v4-pro"];
        t.fake.respondWith(body);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });

        expect(await t.native.entryFor(DEEPSEEK)).toMatchObject({
          ok: true,
          unlisted: true,
        });
      });

      // #578-T04
      it("is refused for a model the catalog does not have", async () => {
        const t = await setup();

        expect(
          await t.native.entryFor({
            providerId: "deepseek",
            modelId: "deepseek-v9",
          }),
        ).toEqual({ ok: false, code: "model_not_in_catalog" });
        expect(
          await t.native.entryFor({ providerId: "nobody", modelId: "x" }),
        ).toEqual({ ok: false, code: "model_not_in_catalog" });
      });

      // #578-T05
      it("is refused while the provider's address changed and waits for an admin", async () => {
        const t = await setup();
        const moved = modelsDevFixture() as Record<string, { api?: string }>;
        moved.deepseek!.api = "https://api.deepseek-proxy.example/v1";
        t.fake.respondWith(moved);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });

        expect(await t.native.entryFor(DEEPSEEK)).toEqual({
          ok: false,
          code: "provider_url_blocked",
        });
      });

      // #578-T03
      it("is still served for a model models.dev no longer lists: the last known entry is the entry", async () => {
        const t = await setup();
        const body = modelsDevFixture() as Record<
          string,
          { models: Record<string, unknown> }
        >;
        delete body.deepseek!.models["deepseek-v4-pro"];
        t.fake.respondWith(body);
        await t.modelsDev.refresh({ acceptReasons: GUARD_REASONS });

        expect(await t.native.entryFor(DEEPSEEK)).toMatchObject({ ok: true });
      });
    });

    describe("the selection", () => {
      // #553-R10
      it("names a catalog model only for a provider that is not a legacy one", async () => {
        const t = await setup();

        expect(
          t.native.refOf({ provider: "deepseek", model: "deepseek-v4-pro" }),
        ).toEqual(DEEPSEEK);
        expect(
          t.native.refOf({
            provider: "anthropic",
            model: "claude-sonnet-5-5",
          }),
        ).toBeNull();
        expect(
          t.native.refOf({ provider: "openrouter", model: "vendor/model" }),
        ).toBeNull();
      });
    });
  },
);
