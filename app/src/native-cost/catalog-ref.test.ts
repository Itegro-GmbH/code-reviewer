// SPDX-License-Identifier: LicenseRef-Proprietary

// The minimal map from what a job selected to the models.dev catalog (#553, the id mapping #549 left here): a registry slug
// (`^[a-z][a-z0-9_]{1,31}$`, a secret name per provider) and a model id name a catalog model by providerId and modelId.
import { describe, expect, it } from "vitest";
import {
  catalogProviderIdOf,
  catalogRefOf,
  implementerCatalogRefOf,
  implementerProviderIdOf,
  nativeProviderIdOf,
  providerSlugOf,
} from "./catalog-ref.ts";

const LEGACY = ["openrouter", "anthropic"] as const;

describe("the catalog model a selection names", () => {
  // #553-R10
  it("is none for a provider of the legacy registry: that path is unchanged until #556", () => {
    for (const provider of LEGACY)
      expect(
        catalogRefOf({ provider, model: "claude-sonnet-5-5" }, LEGACY),
      ).toBeNull();
  });

  // #553-R10
  it("is the provider and model ids of models.dev for a supported provider that is not a legacy one", () => {
    expect(
      catalogRefOf({ provider: "deepseek", model: "deepseek-v4-pro" }, LEGACY),
    ).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-pro" });
    expect(
      catalogRefOf({ provider: "openai", model: "gpt-5.1" }, LEGACY),
    ).toEqual({ providerId: "openai", modelId: "gpt-5.1" });
  });

  // #553-R10
  it("maps the underscore of a slug to the hyphen of the models.dev id, and back", () => {
    expect(catalogProviderIdOf("fireworks_ai")).toBe("fireworks-ai");
    expect(
      catalogRefOf({ provider: "fireworks_ai", model: "x.model" }, LEGACY),
    ).toEqual({ providerId: "fireworks-ai", modelId: "x.model" });
    expect(providerSlugOf("fireworks-ai")).toBe("fireworks_ai");
    expect(providerSlugOf("deepseek")).toBe("deepseek");
    // An id that already has an underscore has no slug: the map would not be one-to-one.
    expect(providerSlugOf("my_provider")).toBeNull();
  });

  // #553-R10
  it("is none for a provider the pinned engine cannot drive, an unknown one and one a slug cannot spell", () => {
    expect(
      catalogRefOf({ provider: "nosuchprovider", model: "m1" }, LEGACY),
    ).toBeNull();
    // `302ai` starts with a digit and `fireworks-ai` is fine, but a slug starts with a letter.
    expect(providerSlugOf("302ai")).toBeNull();
    // A provider id with a hyphen written as a hyphen is no slug.
    expect(
      catalogRefOf({ provider: "fireworks-ai", model: "m1" }, LEGACY),
    ).toBeNull();
    // Excluded by the pinned engine (cloud IAM): the file does not support it.
    expect(
      catalogRefOf({ provider: "google_vertex", model: "m1" }, LEGACY),
    ).toBeNull();
    // Upper case and other characters never reach the catalog.
    expect(
      catalogRefOf({ provider: "OpenAI", model: "m1" }, LEGACY),
    ).toBeNull();
  });

  // #577-L6
  it("tells a native provider from a legacy one by the slug alone", () => {
    expect(nativeProviderIdOf("deepseek", LEGACY)).toBe("deepseek");
    expect(nativeProviderIdOf("fireworks_ai", LEGACY)).toBe("fireworks-ai");
    expect(nativeProviderIdOf("openrouter", LEGACY)).toBeNull();
    expect(nativeProviderIdOf("nosuchprovider", LEGACY)).toBeNull();
  });

  // #553-R10
  it("is none for a model id the job entry would refuse", () => {
    // `..` is no part of a model id (#577): it would walk out of a path the id is put into.
    for (const model of [
      "",
      " ",
      "a b",
      "../x",
      "a..b",
      "x/../y",
      "x".repeat(201),
    ])
      expect(catalogRefOf({ provider: "openai", model }, LEGACY)).toBeNull();
  });
});

describe("the catalog model a task of the Implementer names", () => {
  // The Implementer's agent is OpenCode, so it has no legacy wire: the registry's two providers are catalog providers for it.
  it("is the catalog model of the registry's two providers too", () => {
    expect(
      implementerCatalogRefOf({
        provider: "anthropic",
        model: "claude-sonnet-5-5",
      }),
    ).toEqual({ providerId: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(
      implementerCatalogRefOf({
        provider: "openrouter",
        model: "mistralai/mistral-saba",
      }),
    ).toEqual({ providerId: "openrouter", modelId: "mistralai/mistral-saba" });
    expect(implementerProviderIdOf("anthropic")).toBe("anthropic");
    expect(implementerProviderIdOf("openrouter")).toBe("openrouter");
  });

  it("answers for any other provider as the rule of the reviews does, and refuses what the catalog cannot serve", () => {
    expect(
      implementerCatalogRefOf({
        provider: "deepseek",
        model: "deepseek-v4-pro",
      }),
    ).toEqual(
      catalogRefOf({ provider: "deepseek", model: "deepseek-v4-pro" }, LEGACY),
    );
    expect(implementerProviderIdOf("nosuchprovider")).toBeNull();
    expect(implementerProviderIdOf("Anthropic")).toBeNull();
    expect(
      implementerCatalogRefOf({ provider: "anthropic", model: "../x" }),
    ).toBeNull();
  });

  // The rule is the Implementer's alone: the reviews keep their rule, whatever this one says.
  it("leaves the rule of the reviews as it is", () => {
    expect(nativeProviderIdOf("anthropic", LEGACY)).toBeNull();
    expect(nativeProviderIdOf("openrouter", LEGACY)).toBeNull();
    expect(
      catalogRefOf(
        { provider: "anthropic", model: "claude-sonnet-5-5" },
        LEGACY,
      ),
    ).toBeNull();
  });
});
