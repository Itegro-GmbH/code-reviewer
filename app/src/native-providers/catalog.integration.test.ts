// SPDX-License-Identifier: LicenseRef-Proprietary

// What a workspace on its own key may choose from the models.dev catalog (#555): the providers of the supported file that
// are not blocked, and the tool-calling models of one of them. Over a real database filled with rows directly; the fetch
// that fills it has its own tests (src/models-dev/).
import { describe, expect, it } from "vitest";
import { createModelsDevRepository } from "../db/repositories/models-dev-repository.ts";
import type { StoredModel, StoredProvider } from "../models-dev/catalog.ts";
import { MODELS_DEV_ENGINES } from "../test-support/models-dev-engines.ts";
import { createNativeCostService } from "../native-cost/service.ts";
import { createNativeCatalogReader } from "./catalog.ts";

const T1 = "2026-10-19T03:00:00.000Z";
const T2 = "2026-10-20T03:00:00.000Z";

function provider(
  id: string,
  overrides: Partial<StoredProvider> = {},
): StoredProvider {
  return {
    id,
    name: `Name of ${id}`,
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
    name: `Model ${id}`,
    family: null,
    limit: { context: 128_000, output: 8_000 },
    reasoning: false,
    temperature: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    status: null,
    cost: { input: "0.5", output: "1.5" },
    lastUpdated: null,
    interleaved: null,
    firstSeenAt: T1,
    unlistedAt: null,
    updatedAt: T1,
    ...overrides,
  };
}

const BLOCKED_URL: StoredProvider["url"] = {
  state: "url_changed",
  trustedUrl: "https://api.google.example",
  pendingUrl: "https://elsewhere.example",
  problem: null,
};

describe.each(MODELS_DEV_ENGINES)(
  "the catalog of a workspace on $name",
  (engine) => {
    async function setup(
      legacyProviders: readonly string[] = ["openrouter", "anthropic"],
    ) {
      const { db } = await engine.create();
      const repository = createModelsDevRepository(db);
      await repository.apply({
        providers: [
          provider("deepseek"),
          provider("openai"),
          provider("fireworks-ai"),
          // blocked: its address changed and waits for an admin
          provider("google", { url: BLOCKED_URL, urlChangedAt: T2 }),
          // excluded by the supported file (cloud IAM), a legacy provider of the registry, and an unknown one
          provider("amazon-bedrock"),
          provider("openrouter"),
          provider("anthropic"),
          provider("not-in-the-file"),
          // listed no more
          provider("xai", { unlistedAt: T2 }),
          // nothing to choose
          provider("opencode"),
        ],
        models: [
          model("deepseek", "deepseek-v4-pro", { reasoning: true }),
          model("deepseek", "free-model", {
            cost: { input: "0", output: "0" },
          }),
          model("deepseek", "unpriced", { cost: null }),
          model("deepseek", "odd-price", {
            cost: { input: "1", output: "2", unknown: ["cost.input_video"] },
          }),
          model("deepseek", "old-one", { status: "deprecated" }),
          model("deepseek", "gone", { unlistedAt: T2 }),
          model("openai", "gpt-5.5"),
          model("fireworks-ai", "accounts/fireworks/models/x"),
          model("google", "gemini-3.5-flash"),
          model("amazon-bedrock", "m"),
          model("openrouter", "mistralai/mistral-saba"),
          model("anthropic", "claude-sonnet-5-5"),
          model("not-in-the-file", "m"),
          model("xai", "grok-4.5", { unlistedAt: T2 }),
          model("opencode", "only-unlisted", { unlistedAt: T2 }),
        ],
      });
      return {
        db,
        reader: createNativeCatalogReader({
          models: repository,
          legacyProviders,
        }),
      };
    }

    // The Implementer's picker reads the same catalog with no provider legacy (its agent is OpenCode); the reviews' reader above is unchanged.
    describe("the catalog of the Implementer, for which no provider is legacy", () => {
      it("offers the registry's two providers with their models, and the others as before", async () => {
        const { reader } = await setup([]);

        expect((await reader.providers()).map((entry) => entry.id)).toEqual([
          "anthropic",
          "deepseek",
          "fireworks_ai",
          "openai",
          "openrouter",
        ]);
        expect((await reader.models("anthropic"))?.map((m) => m.id)).toEqual([
          "claude-sonnet-5-5",
        ]);
        expect(
          await reader.checkSelection("openrouter", "mistralai/mistral-saba"),
        ).toMatchObject({ ok: true });
        expect(await reader.providerAvailable("anthropic")).toBe(true);
      });
    });

    describe("the providers", () => {
      // #555-T01
      it("are the supported ones that are not blocked, with a model to choose, by their slug", async () => {
        const { reader } = await setup();

        const providers = await reader.providers();

        expect(providers).toEqual([
          { id: "deepseek", label: "Name of deepseek", modelCount: 5 },
          {
            id: "fireworks_ai",
            label: "Name of fireworks-ai",
            modelCount: 1,
          },
          { id: "openai", label: "Name of openai", modelCount: 1 },
        ]);
      });

      // #555-T01
      it("never include a blocked, an excluded, a legacy, an unknown or an unlisted provider", async () => {
        const { reader } = await setup();

        const ids = (await reader.providers()).map((entry) => entry.id);

        for (const absent of [
          "google",
          "amazon_bedrock",
          "openrouter",
          "anthropic",
          "not_in_the_file",
          "xai",
          "opencode",
        ])
          expect(ids).not.toContain(absent);
      });

      // #555-T01
      it("say whether one may carry a key", async () => {
        const { reader } = await setup();

        expect(await reader.providerAvailable("deepseek")).toBe(true);
        expect(await reader.providerAvailable("fireworks_ai")).toBe(true);
        for (const slug of [
          "google",
          "amazon_bedrock",
          "openrouter",
          "xai",
          "x",
        ])
          expect(await reader.providerAvailable(slug)).toBe(false);
      });
    });

    describe("a provider whose trusted address the claim would refuse", () => {
      // The claim (`entryFor`) refuses an address that is not a plain public https address in its canonical spelling; the
      // picker, the key and the choice must not offer what the claim then cannot serve.
      // #555-T16
      it.each([
        "https://10.0.0.5/v1",
        "https://93.184.216.34/v1",
        "https://[2606:4700:4700::1111]/v1",
        "https://API.deepseek.example",
        "https://api.deepseek.example/",
        "https://api.deepseek.example//v1",
        "https://models.internal/v1",
      ])(
        "is not offered, takes no key and no choice when its stored address is %s",
        async (address) => {
          const { db } = await engine.create();
          const repository = createModelsDevRepository(db);
          await repository.apply({
            providers: [
              provider("deepseek", {
                url: {
                  state: "trusted",
                  trustedUrl: address,
                  pendingUrl: null,
                  problem: null,
                },
              }),
              provider("openai"),
            ],
            models: [
              model("deepseek", "deepseek-v4-pro"),
              model("openai", "gpt-5.5"),
            ],
          });
          const reader = createNativeCatalogReader({
            models: repository,
            legacyProviders: ["openrouter", "anthropic"],
          });

          expect((await reader.providers()).map((entry) => entry.id)).toEqual([
            "openai",
          ]);
          expect(await reader.providerAvailable("deepseek")).toBe(false);
          expect(await reader.models("deepseek")).toBeUndefined();
          expect(
            await reader.checkSelection("deepseek", "deepseek-v4-pro"),
          ).toEqual({ ok: false, code: "model_not_in_catalog" });
          // The reader and the claim agree: the claim refuses the same provider.
          const native = createNativeCostService({
            prices: {
              availability: () => Promise.reject(new Error("not asked")),
              catalogPrice: () => Promise.reject(new Error("not asked")),
            },
            settings: { get: () => Promise.resolve(undefined) },
            catalog: repository,
            legacyProviders: ["openrouter", "anthropic"],
            registryAddresses: {},
          });
          expect(
            (
              await native.entryFor({
                providerId: "deepseek",
                modelId: "deepseek-v4-pro",
              })
            ).ok,
          ).toBe(false);
          // A provider with a plain address is offered still (the positive control).
          expect(await reader.providerAvailable("openai")).toBe(true);
        },
      );
    });

    describe("the models of a provider", () => {
      // #555-T03
      it("are its listed models with name, context and the price when it states one", async () => {
        const { reader } = await setup();

        const models = await reader.models("deepseek");

        expect(models?.map((entry) => entry.id)).toEqual([
          "deepseek-v4-pro",
          "free-model",
          "odd-price",
          "old-one",
          "unpriced",
        ]);
        expect(models?.[0]).toMatchObject({
          id: "deepseek-v4-pro",
          name: "Model deepseek-v4-pro",
          contextTokens: 128_000,
          outputTokens: 8_000,
          reasoning: true,
          deprecated: false,
          price: { inputPerMillion: "0.5", outputPerMillion: "1.5" },
        });
        // A free model has a price: zero. A model with no price, or one we cannot read, has none.
        expect(models?.find((m) => m.id === "free-model")?.price).toEqual({
          inputPerMillion: "0",
          outputPerMillion: "0",
        });
        expect(models?.find((m) => m.id === "unpriced")?.price).toBeNull();
        expect(models?.find((m) => m.id === "odd-price")?.price).toBeNull();
        expect(models?.find((m) => m.id === "old-one")?.deprecated).toBe(true);
      });

      // #555-T03
      it("are none for a provider that may not be offered", async () => {
        const { reader } = await setup();

        for (const slug of [
          "google",
          "amazon_bedrock",
          "openrouter",
          "xai",
          "nope",
        ])
          expect(await reader.models(slug)).toBeUndefined();
      });
    });

    describe("a selection of provider and model", () => {
      // #555-T04
      it("is accepted for a listed model of an offered provider", async () => {
        const { reader } = await setup();

        expect(
          await reader.checkSelection("deepseek", "free-model"),
        ).toMatchObject({ ok: true, model: { id: "free-model" } });
      });

      // #555-T04
      it("is refused with model_not_in_catalog for a model the catalog does not hold, one it no longer lists, and a provider that is not offered", async () => {
        const { reader } = await setup();

        for (const [slug, id] of [
          ["deepseek", "released-today"],
          ["deepseek", "gone"],
          ["deepseek", "gpt-5.5"],
          ["google", "gemini-3.5-flash"],
          ["xai", "grok-4.5"],
          ["amazon_bedrock", "m"],
          ["nope", "m"],
        ] as const)
          expect(await reader.checkSelection(slug, id)).toEqual({
            ok: false,
            code: "model_not_in_catalog",
          });
      });
    });

    describe("the address a selection is pinned to", () => {
      // #588-T01
      it("is the address the catalog trusts for an offered provider", async () => {
        const { reader } = await setup();

        expect(await reader.addressOf("deepseek")).toBe(
          "https://api.deepseek.example",
        );
        expect(await reader.addressOf("fireworks_ai")).toBe(
          "https://api.fireworks-ai.example",
        );
      });

      // #588-T02
      it("is none for a provider that is not offered", async () => {
        const { reader } = await setup();

        for (const slug of ["google", "amazon_bedrock", "openrouter", "nope"])
          expect(await reader.addressOf(slug)).toBeUndefined();
      });

      // #588-T55
      it("is the trusted address of a provider models.dev no longer lists, as the claim serves it: a pin of it can be confirmed", async () => {
        const { db, reader } = await setup();
        const claim = createNativeCostService({
          prices: {
            availability: () => Promise.reject(new Error("not asked")),
            catalogPrice: () => Promise.reject(new Error("not asked")),
          },
          settings: { get: () => Promise.resolve(undefined) },
          catalog: createModelsDevRepository(db),
          legacyProviders: ["openrouter", "anthropic"],
          registryAddresses: {},
        });
        const ref = { providerId: "xai", modelId: "grok-4.5" };

        // The claim serves it (a model that is gone stays usable) at the address the catalog trusts, and holds it to a pin.
        expect(await claim.entryFor(ref)).toMatchObject({
          ok: true,
          unlisted: true,
        });
        expect(
          await claim.entryFor(ref, "https://api.xai-old.example"),
        ).toEqual({ ok: false, code: "provider_address_changed" });
        // So the settings page and the confirmation know the address the claim would send the key to.
        expect(await reader.addressOf("xai")).toBe("https://api.xai.example");
        // It is still not offered for a new choice.
        expect(await reader.providerAvailable("xai")).toBe(false);
      });
    });

    describe("a model a claim has to serve", () => {
      function entries(db: Awaited<ReturnType<typeof setup>>["db"]) {
        return createNativeCostService({
          prices: {
            availability: () => Promise.reject(new Error("not asked")),
            catalogPrice: () => Promise.reject(new Error("not asked")),
          },
          settings: { get: () => Promise.resolve(undefined) },
          catalog: createModelsDevRepository(db),
          legacyProviders: ["openrouter", "anthropic"],
          registryAddresses: {},
        });
      }

      // #555-T09
      it("is served from the stored row even when models.dev no longer lists it, with a note for the settings", async () => {
        const { db } = await setup();
        const native = entries(db);

        expect(
          await native.entryFor({ providerId: "deepseek", modelId: "gone" }),
        ).toMatchObject({
          ok: true,
          unlisted: true,
          entry: { providerId: "deepseek", modelId: "gone" },
        });
        expect(
          await native.entryFor({
            providerId: "deepseek",
            modelId: "free-model",
          }),
        ).toMatchObject({ ok: true, unlisted: false });
      });

      // #555-T09
      it("is refused when the row is missing or the provider is blocked, excluded or unknown: no entry is built", async () => {
        const { db } = await setup();
        const native = entries(db);

        expect(
          await native.entryFor({
            providerId: "deepseek",
            modelId: "retired",
          }),
        ).toEqual({ ok: false, code: "model_not_in_catalog" });
        expect(
          await native.entryFor({
            providerId: "google",
            modelId: "gemini-3.5-flash",
          }),
        ).toEqual({ ok: false, code: "provider_url_blocked" });
        expect(
          await native.entryFor({
            providerId: "amazon-bedrock",
            modelId: "m",
          }),
        ).toEqual({ ok: false, code: "provider_unsupported" });
        expect(
          await native.entryFor({ providerId: "nope", modelId: "m" }),
        ).toEqual({ ok: false, code: "model_not_in_catalog" });
      });
    });
  },
);
