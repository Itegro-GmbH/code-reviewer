// SPDX-License-Identifier: LicenseRef-Proprietary

// Which providers the workspace holds a readable key for, as the Implementer's picker and check need it: the registry's two
// providers (Anthropic, OpenRouter) keep their key in their own slot, the catalog providers in a slot per slug.
import { describe, expect, it } from "vitest";
import type { ProviderKeyStatus } from "../llm/workspace-key.ts";
import { configuredKeyProviders } from "./key-providers.ts";

const configured = (provider: string): ProviderKeyStatus => ({
  provider,
  status: {
    state: "configured",
    provider,
    lastFour: "1234",
    updatedAt: "2026-11-02T10:00:00.000Z",
    updatedBy: null,
  },
});
const unreadable = (provider: string): ProviderKeyStatus => ({
  provider,
  status: {
    state: "unreadable",
    provider,
    updatedAt: "2026-11-02T10:00:00.000Z",
    updatedBy: null,
  },
});
const missing = (provider: string): ProviderKeyStatus => ({
  provider,
  status: { state: "not_configured" },
});

const keys = (registry: ProviderKeyStatus[], catalog: ProviderKeyStatus[]) => ({
  statusAll: async () => registry,
  nativeStatuses: async () => catalog,
});

describe("the providers with a readable key", () => {
  it("holds the registry's providers with a key and the catalog providers with a key", async () => {
    expect(
      await configuredKeyProviders(
        keys(
          [configured("anthropic"), missing("openrouter")],
          [configured("deepseek")],
        ),
      ),
    ).toEqual(new Set(["anthropic", "deepseek"]));
  });

  it("leaves out a key that cannot be read and a provider without one", async () => {
    expect(
      await configuredKeyProviders(
        keys(
          [unreadable("anthropic"), missing("openrouter")],
          [unreadable("deepseek"), missing("mistral")],
        ),
      ),
    ).toEqual(new Set());
  });

  it("is empty for a workspace without any key", async () => {
    expect(await configuredKeyProviders(keys([], []))).toEqual(new Set());
  });
});
