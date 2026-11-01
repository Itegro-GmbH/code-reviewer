// SPDX-License-Identifier: LicenseRef-Proprietary

// The models a person can send an Implementer task to (#755): the picker's options and the check at submit are one rule, the one
// the claim applies (#753): a Dynamic model on the native path. On the workspace's own key that is a model of the models.dev
// catalog whose provider has a saved key; on the operator's key a released catalog entry that serves Dynamic Review, that the
// plan allows and whose model has a confirmed price. The registry's two providers are not on the native path.
import { describe, expect, it, vi } from "vitest";
import type { CatalogSelectionSource } from "../review-settings/catalog-selection.ts";
import type { MemberCatalogEntry } from "../model-catalog/member.ts";
import type { NativeModelView } from "../native-providers/catalog.ts";
import {
  createImplementerModels,
  type ImplementerModelsDependencies,
} from "./models.ts";

const model = (id: string): NativeModelView => ({
  id,
  name: id.toUpperCase(),
  contextTokens: 128_000,
  outputTokens: 8_000,
  reasoning: false,
  deprecated: false,
  alpha: false,
  price: null,
});

const entry = (
  id: string,
  over: Partial<MemberCatalogEntry> = {},
): MemberCatalogEntry => ({
  id,
  name: `Entry ${id}`,
  description: null,
  providerLabel: "Acme AI",
  kinds: ["dynamic"],
  status: "released",
  sortOrder: 1,
  ...over,
});

function deps(
  over: Partial<ImplementerModelsDependencies> & {
    entries?: MemberCatalogEntry[];
    allowed?: string[];
    usable?: string[];
    configured?: string[];
    listed?: Record<string, string[]>;
  } = {},
): ImplementerModelsDependencies {
  const entries = over.entries ?? [];
  const catalog: CatalogSelectionSource = {
    entries: async () => entries,
    find: async (id) => {
      const found = entries.find((candidate) => candidate.id === id);
      return found === undefined
        ? undefined
        : { status: found.status, kinds: found.kinds };
    },
    allowed: async (id) =>
      (over.allowed ?? entries.map((e) => e.id)).includes(id),
  };
  const listed = over.listed ?? {
    deepseek: ["deepseek-chat", "deepseek-coder"],
  };
  return {
    keyMode: async () => "own",
    configuredProviders: async () => new Set(over.configured ?? ["deepseek"]),
    nativeCatalog: {
      providers: async () =>
        Object.keys(listed).map((id) => ({
          id,
          label: id.toUpperCase(),
          modelCount: listed[id]?.length ?? 0,
        })),
      models: async (slug) => listed[slug]?.map(model),
      checkSelection: async (slug, modelId) =>
        listed[slug]?.includes(modelId)
          ? { ok: true, model: model(modelId) }
          : { ok: false, code: "model_not_in_catalog" },
    },
    catalog,
    entryUsable: async (id) =>
      (over.usable ?? entries.map((e) => e.id)).includes(id),
    ...over,
  };
}

describe("the options of the picker on the workspace's own key", () => {
  // #755-T07
  it("lists the providers that have a saved key, with the models the catalog lists", async () => {
    const models = createImplementerModels(
      deps({
        configured: ["deepseek"],
        listed: { deepseek: ["deepseek-chat"], mistral: ["mistral-large"] },
      }),
    );

    expect(await models.options()).toEqual({
      keyMode: "own",
      providers: [
        { id: "deepseek", label: "DEEPSEEK", models: [model("deepseek-chat")] },
      ],
    });
  });

  // #755-T07
  it("lists nothing for a workspace without a saved key, and never a provider of the registry", async () => {
    expect(
      await createImplementerModels(deps({ configured: [] })).options(),
    ).toEqual({ keyMode: "own", providers: [] });
    expect(
      await createImplementerModels(
        deps({ configured: ["anthropic", "openrouter"], listed: {} }),
      ).options(),
    ).toEqual({ keyMode: "own", providers: [] });
  });
});

describe("the options of the picker on the operator's key", () => {
  const managed = (over: Parameters<typeof deps>[0] = {}) =>
    createImplementerModels({ ...deps(over), keyMode: async () => "managed" });

  // #755-T07
  it("lists the released entries that serve Dynamic Review, that the plan allows and that can be priced, and nothing of the model behind them", async () => {
    const models = managed({
      entries: [
        entry("ok"),
        entry("diff-only", { kinds: ["diff"] }),
        entry("retired", { status: "retired" }),
        entry("draft", { status: "draft" }),
        entry("not-in-plan"),
        entry("unpriced"),
      ],
      allowed: ["ok", "diff-only", "retired", "draft", "unpriced"],
      usable: ["ok", "diff-only", "retired", "draft", "not-in-plan"],
    });

    expect(await models.options()).toEqual({
      keyMode: "managed",
      entries: [
        {
          id: "ok",
          name: "Entry ok",
          description: null,
          providerLabel: "Acme AI",
        },
      ],
    });
  });

  it("lists nothing when the entitlements cannot be read: it is not known whose key applies", async () => {
    const models = createImplementerModels({
      ...deps({ entries: [entry("ok")] }),
      keyMode: async () => "unreadable",
    });
    expect(await models.options()).toEqual({ keyMode: "unreadable" });
  });
});

describe("the check of a choice at submit", () => {
  const own = createImplementerModels(deps());
  const managedOf = (over: Parameters<typeof deps>[0] = {}) =>
    createImplementerModels({ ...deps(over), keyMode: async () => "managed" });

  // #755-T07
  it("passes a model of a provider with a key that the catalog lists", async () => {
    expect(
      await own.check({ provider: "deepseek", model: "deepseek-chat" }),
    ).toBeNull();
  });

  // #755-T07
  it.each([
    ["a provider without a key", { provider: "mistral", model: "m" }, "no_key"],
    [
      "a model the catalog does not list",
      { provider: "deepseek", model: "gone" },
      "model_not_in_catalog",
    ],
    [
      "a provider of the registry",
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      "provider_unsupported",
    ],
    [
      "an entry id on the workspace's own key",
      { entryId: "x" },
      "wrong_key_mode",
    ],
  ] as const)(
    "refuses %s on the workspace's own key",
    async (_name, choice, reason) => {
      expect(await own.check(choice)).toBe(reason);
    },
  );

  // #755-T07
  it.each([
    ["a retired entry", "retired", "entry_not_released"],
    ["a draft", "draft", "entry_not_released"],
    [
      "an entry that does not serve Dynamic Review",
      "diff-only",
      "entry_kind_mismatch",
    ],
    ["an entry the plan does not allow", "not-in-plan", "entry_not_allowed"],
    [
      "an entry whose model has no confirmed price",
      "unpriced",
      "entry_unavailable",
    ],
    ["an id that names no entry", "nothing", "entry_unknown"],
  ] as const)("refuses %s on the operator's key", async (_name, id, reason) => {
    const models = managedOf({
      entries: [
        entry("ok"),
        entry("retired", { status: "retired" }),
        entry("draft", { status: "draft" }),
        entry("diff-only", { kinds: ["diff"] }),
        entry("not-in-plan"),
        entry("unpriced"),
      ],
      allowed: ["ok", "retired", "draft", "diff-only", "unpriced"],
      usable: ["ok", "retired", "draft", "diff-only", "not-in-plan"],
    });
    expect(await models.check({ entryId: id })).toBe(reason);
    expect(await models.check({ entryId: "ok" })).toBeNull();
  });

  // #755-T07
  it("refuses a provider and model on the operator's key: the tenant does not choose the model there", async () => {
    expect(
      await managedOf({ entries: [entry("ok")] }).check({
        provider: "deepseek",
        model: "deepseek-chat",
      }),
    ).toBe("wrong_key_mode");
  });

  it("refuses everything when the entitlements cannot be read", async () => {
    const models = createImplementerModels({
      ...deps({ entries: [entry("ok")] }),
      keyMode: async () => "unreadable",
    });
    expect(await models.check({ entryId: "ok" })).toBe("key_mode_unreadable");
    expect(
      await models.check({ provider: "deepseek", model: "deepseek-chat" }),
    ).toBe("key_mode_unreadable");
  });

  it("asks the price of an entry only for an entry that passed the cheaper checks", async () => {
    const entryUsable = vi.fn(async () => true);
    const models = createImplementerModels({
      ...deps({ entries: [entry("retired", { status: "retired" })] }),
      keyMode: async () => "managed",
      entryUsable,
    });
    await models.check({ entryId: "retired" });
    expect(entryUsable).not.toHaveBeenCalled();
  });
});
