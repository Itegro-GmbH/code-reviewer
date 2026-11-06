// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type { JsonValue } from "../integrations/types.ts";
import {
  costUsdToMicroUsd,
  keyModeOfAccessSource,
  settlementOfOutcome,
} from "./usage-records.ts";

/** A run that may have used the model and reported nothing: it counts, with everything unknown. */
const NO_RESULT = {
  state: "settled",
  costMicroUsd: null,
  promptTokens: null,
  completionTokens: null,
  reason: "no_result",
};

const USAGE = {
  model: "vendor/model",
  promptTokens: 12000,
  completionTokens: 900,
  totalTokens: 12900,
  aiCalls: 2,
  fallbackUsed: false,
  costUsd: 0.0123456,
};

describe("the measured cost of a run in micro-USD", () => {
  // #272-T02
  it.each([
    [0.0123456, 12346],
    [0, 0],
    [0.04, 40000],
    [1, 1_000_000],
    [0.000001, 1],
    [0.0000004, 0],
  ])("turns %s USD into %s micro-USD", (costUsd, expected) => {
    expect(costUsdToMicroUsd(costUsd)).toBe(expected);
  });

  // #272-T02
  it("rounds half up, also where the binary value sits just below the half", () => {
    expect(costUsdToMicroUsd(0.0000005)).toBe(1);
    expect(costUsdToMicroUsd(0.0000015)).toBe(2);
    expect(costUsdToMicroUsd(1.0000005)).toBe(1_000_001);
  });

  it("is unknown for a cost no record can hold", () => {
    expect(costUsdToMicroUsd(Number.MAX_VALUE)).toBeNull();
    expect(costUsdToMicroUsd(2147.483648)).toBeNull();
    expect(costUsdToMicroUsd(2147.483647)).toBe(2_147_483_647);
    expect(costUsdToMicroUsd(Number.NaN)).toBeNull();
    expect(costUsdToMicroUsd(-1)).toBeNull();
  });
});

describe("how a completed job settles its usage record", () => {
  // #272-T02
  it("settles a reported usage with its cost and tokens", () => {
    expect(
      settlementOfOutcome({ ok: true, result: { ok: true, usage: USAGE } }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: 12346,
      promptTokens: 12000,
      completionTokens: 900,
    });
  });

  // #272-T03
  it("settles a reported usage without a cost with an unknown cost, not as void", () => {
    expect(
      settlementOfOutcome({
        ok: true,
        result: { ok: true, usage: { ...USAGE, costUsd: null } },
      }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: null,
      promptTokens: 12000,
      completionTokens: 900,
    });
  });

  // #856-T75
  it("marks the settlement of a turn on a subscription, with no cost", () => {
    expect(
      settlementOfOutcome({
        ok: true,
        result: {
          ok: true,
          usage: {
            ...USAGE,
            costUsd: null,
            costBasis: "subscription",
            estimatedCostUsd: 0.42,
          },
        },
      }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: null,
      promptTokens: 12000,
      completionTokens: 900,
      costBasis: "subscription",
    });
  });

  // #856-T75
  it("does not take the estimate of a subscription turn for a cost, and takes no basis it does not know", () => {
    const settled = (usage: { [key: string]: JsonValue }) =>
      settlementOfOutcome({ ok: true, result: { ok: true, usage } });

    // A report with a cost beside the basis is a malformed one: a subscription turn has no cost, so the cost stays the cost and the
    // basis is not taken.
    const withCost = settled({
      ...USAGE,
      costBasis: "subscription",
      estimatedCostUsd: 0.42,
    });
    expect(withCost).toMatchObject({ costMicroUsd: 12346 });
    expect(withCost).not.toHaveProperty("costBasis");
    expect(
      settled({ ...USAGE, costUsd: null, costBasis: "subscription" }),
    ).toMatchObject({ costMicroUsd: null, costBasis: "subscription" });
    expect(
      settled({ ...USAGE, costUsd: null, costBasis: "metered" }),
    ).not.toHaveProperty("costBasis");
  });

  // #274-T07: the exact cost of a Diff Review (the decimal sum of the charges its provider stated,
  // printed as the shortest number) is stored as it is, in whole micro-USD, without a drift.
  it("stores the exact cost of a Diff Review that the runner reports", () => {
    const stored = (costUsd: number) =>
      settlementOfOutcome({
        ok: true,
        result: { ok: true, usage: { ...USAGE, aiCalls: 3, costUsd } },
      });

    expect(stored(0.6)).toMatchObject({ costMicroUsd: 600_000 });
    expect(stored(0.00037035)).toMatchObject({ costMicroUsd: 370 });
    expect(stored(0)).toMatchObject({ costMicroUsd: 0 });
  });

  it("settles a run that succeeded without a usage with everything unknown", () => {
    const results: JsonValue[] = [
      { ok: true, usage: null },
      { ok: true },
      null,
    ];
    for (const result of results)
      expect(settlementOfOutcome({ ok: true, result })).toStrictEqual({
        state: "settled",
        costMicroUsd: null,
        promptTokens: null,
        completionTokens: null,
      });
  });

  // #272-T04
  it("voids a failed job that reported no usage", () => {
    const results: JsonValue[] = [
      { ok: false, usage: null },
      { ok: false },
      null,
    ];
    for (const result of results)
      expect(
        settlementOfOutcome({
          ok: false,
          errorCode: "checkout_failed",
          result,
        }),
      ).toStrictEqual({ state: "void" });
    expect(
      settlementOfOutcome({ ok: false, errorCode: "checkout_failed" }),
    ).toStrictEqual({ state: "void" });
  });

  // #273-T05
  it("settles a failed job that reported the usage of its calls, with an unknown cost kept unknown", () => {
    const failed = (usage: JsonValue): JsonValue => ({ ok: false, usage });

    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "dynamic_budget_exceeded",
        result: failed({ ...USAGE, costUsd: 0.0035 }),
      }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: 3500,
      promptTokens: 12000,
      completionTokens: 900,
    });
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "dynamic_accounting_failed",
        result: failed({ ...USAGE, costUsd: null }),
      }),
    ).toStrictEqual({
      state: "settled",
      costMicroUsd: null,
      promptTokens: 12000,
      completionTokens: 900,
    });
  });

  // #273-T03: a runner of an earlier release reports the usage of a failed command that never reached
  // the model as zero calls; that is no run that used the model.
  it("voids a failed job whose usage shows no model call, but not a run that succeeded", () => {
    const noCall = {
      ...USAGE,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      aiCalls: 0,
      costUsd: null,
    };

    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "command_failed",
        result: { ok: false, usage: noCall },
      }),
    ).toStrictEqual({ state: "void" });
    expect(
      settlementOfOutcome({ ok: true, result: { ok: true, usage: noCall } }),
    ).toMatchObject({ state: "settled", promptTokens: 0 });
    // A call that was made but answered nothing is a call.
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "dynamic_engine_unavailable",
        result: { ok: false, usage: { ...noCall, aiCalls: 1 } },
      }),
    ).toMatchObject({ state: "settled", costMicroUsd: null });
  });

  it("settles a failed job that did report a usage", () => {
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "review_failed",
        result: { ok: false, usage: USAGE },
      }),
    ).toMatchObject({ state: "settled", costMicroUsd: 12346 });
  });

  // #273-T06: a usage that was sent and cannot be read is a run that reached the model.
  it.each([-1, 2_147_483_648, 1.5])(
    "settles a failed job whose usage with %s tokens cannot be read, with everything unknown",
    (promptTokens) => {
      const damaged = { ...USAGE, promptTokens };
      expect(
        settlementOfOutcome({
          ok: false,
          errorCode: "review_failed",
          result: { ok: false, usage: damaged },
        }),
      ).toStrictEqual(NO_RESULT);
    },
  );

  it("does not trust a damaged usage of a run that succeeded either", () => {
    expect(
      settlementOfOutcome({
        ok: true,
        result: { ok: true, usage: { ...USAGE, promptTokens: -1 } },
      }),
    ).toMatchObject({
      state: "settled",
      costMicroUsd: null,
      promptTokens: null,
    });
  });

  // #273-T06: the loop of the runner ended a job process that held the job and left no result.
  it.each(["no_result_from_process", "unreadable_usage"])(
    "settles a failed job without usage whose reason is %s as a run with no result",
    (errorReason) => {
      expect(
        settlementOfOutcome({
          ok: false,
          errorCode: "timeout",
          result: { ok: false, usage: null, errorReason },
        }),
      ).toStrictEqual(NO_RESULT);
    },
  );

  // #363-T05: the Diff runner names the reason next to the code of the failure it classified, and sends no
  // `usage` key at all.
  it.each([
    "timeout",
    "llm_timeout",
    "llm_unavailable",
    "command_failed",
    "unknown",
  ])(
    "settles a failed %s of a Diff run with the reason and no usage as a run with no result",
    (errorCode) => {
      expect(
        settlementOfOutcome({
          ok: false,
          errorCode,
          result: { ok: false, errorReason: "no_result_from_process" },
        }),
      ).toStrictEqual(NO_RESULT);
    },
  );

  // #273-T06
  it("voids a failed job without usage whose reason is any other", () => {
    for (const errorReason of [
      "budget_preparation",
      "launch_failed",
      undefined,
    ])
      expect(
        settlementOfOutcome({
          ok: false,
          errorCode: "checkout_incomplete",
          result: {
            ok: false,
            usage: null,
            ...(errorReason ? { errorReason } : {}),
          },
        }),
      ).toStrictEqual({ state: "void" });
  });

  // #273-T06: a usage that was read wins over the reason.
  it("settles a failed job that reported a usage with it, whatever its reason", () => {
    expect(
      settlementOfOutcome({
        ok: false,
        errorCode: "timeout",
        result: {
          ok: false,
          usage: USAGE,
          errorReason: "no_result_from_process",
        },
      }),
    ).toMatchObject({
      state: "settled",
      costMicroUsd: 12346,
      promptTokens: 12000,
    });
  });
});

describe("the key mode of a run", () => {
  // #272-T01
  it("is own for the workspace's key and managed for the operator's key", () => {
    expect(keyModeOfAccessSource("workspace")).toBe("own");
    expect(keyModeOfAccessSource("operator")).toBe("managed");
  });
});
