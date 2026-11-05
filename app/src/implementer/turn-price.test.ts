// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the catalog price of the model of a turn, for a step whose cost the runner did not report.
import { describe, expect, it } from "vitest";
import { createTurnPricer } from "./turn-price.ts";

const PRICE = {
  inputPerMillion: 3,
  outputPerMillion: 15,
  contextTokens: 200_000,
  inputTokenFactor: 1,
};

const pricer = createTurnPricer({
  catalog: {
    get: async (id) =>
      id === "entry-1"
        ? { provider: "anthropic", modelId: "claude-sonnet-5-5" }
        : undefined,
  },
  providers: {
    find: (raw) =>
      raw === "anthropic"
        ? {
            priceOf: (model: string) =>
              model === "claude-sonnet-5-5" ? PRICE : null,
          }
        : undefined,
  },
});

describe("the price of the model of a turn", () => {
  // #844-T278
  it("is the price of the provider adapter for the model of a catalog entry and for a model of the workspace's own key", async () => {
    const expected = { inputPerMillion: 3, outputPerMillion: 15 };

    expect(await pricer({ entryId: "entry-1" })).toEqual(expected);
    expect(
      await pricer({ provider: "anthropic", model: "claude-sonnet-5-5" }),
    ).toEqual(expected);
  });

  // #844-T279
  it("is none for an entry that is gone, a provider or a model the tables do not know", async () => {
    expect(await pricer({ entryId: "entry-2" })).toBeUndefined();
    expect(
      await pricer({ provider: "deepseek", model: "deepseek-chat" }),
    ).toBeUndefined();
    expect(
      await pricer({ provider: "anthropic", model: "claude-unknown" }),
    ).toBeUndefined();
  });
});
