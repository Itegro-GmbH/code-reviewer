// SPDX-License-Identifier: LicenseRef-Proprietary

// A managed Dynamic run can never settle with an unknown cost (#553-T09): we pay for it, so a price must be known before it
// starts and a cost must be known when it ends. A runner that reports a success without one has not accounted for its run.
import { describe, expect, it } from "vitest";
import type { RunnerResult } from "./contract.ts";
import { withoutUnaccountedManagedSuccess } from "./managed-cost-guard.ts";

function resultOf(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    ok: true,
    durationMs: 10,
    commentUrl: "https://github.test/acme/widgets/pull/7#issuecomment-1",
    errorCode: null,
    errorMessage: null,
    logTail: "",
    logTruncated: false,
    usage: {
      model: null,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      aiCalls: 1,
      fallbackUsed: false,
      costUsd: null,
      stoppedEarly: null,
    },
    ...overrides,
  };
}

const MANAGED_DYNAMIC = {
  managed: true,
  native: true,
  reviewKind: "dynamic",
} as const;

describe("a managed Dynamic result without a known cost", () => {
  // #553-T09
  it("is not a success: it ends as dynamic_accounting_failed, which is our fault and free", () => {
    const guarded = withoutUnaccountedManagedSuccess(
      resultOf(),
      MANAGED_DYNAMIC,
    );

    expect(guarded).toMatchObject({
      ok: false,
      errorCode: "dynamic_accounting_failed",
    });
    expect(guarded.errorMessage).toMatch(/cost/);
    // The usage stays as the runner reported it: its cost is unknown, never zero.
    expect(guarded.usage).toEqual(resultOf().usage);
  });

  // #553-T09
  it("leaves a success that reports no usage at all as it is: that settles with an unknown cost as it always did", () => {
    const bare = resultOf({ usage: null });
    expect(withoutUnaccountedManagedSuccess(bare, MANAGED_DYNAMIC)).toBe(bare);
  });

  // #553-T09
  it("leaves a failure alone: its code is the runner's, and its cost may be unknown", () => {
    for (const errorCode of [
      "dynamic_accounting_failed",
      "timeout",
      "llm_unavailable",
    ]) {
      const failed = resultOf({
        ok: false,
        errorCode,
        errorMessage: "ended",
      });
      expect(withoutUnaccountedManagedSuccess(failed, MANAGED_DYNAMIC)).toBe(
        failed,
      );
    }
  });

  // #553-T09
  it("leaves a success with a known cost alone, a free model's zero included", () => {
    for (const costUsd of [0, 0.04]) {
      const known = resultOf({
        usage: { ...resultOf().usage!, costUsd },
      });
      expect(withoutUnaccountedManagedSuccess(known, MANAGED_DYNAMIC)).toBe(
        known,
      );
    }
  });

  // #577-L6
  it("leaves a job that is not native alone: its runner never promised a cost it could not read", () => {
    const unknown = resultOf();
    expect(
      withoutUnaccountedManagedSuccess(unknown, {
        managed: true,
        native: false,
        reviewKind: "dynamic",
      }),
    ).toBe(unknown);
  });

  // #553-T12
  it("leaves every other job alone: an own key, a Diff review", () => {
    const unknown = resultOf();
    expect(
      withoutUnaccountedManagedSuccess(unknown, {
        managed: false,
        native: true,
        reviewKind: "dynamic",
      }),
    ).toBe(unknown);
    expect(
      withoutUnaccountedManagedSuccess(unknown, {
        managed: true,
        native: true,
        reviewKind: "diff",
      }),
    ).toBe(unknown);
  });
});

describe("a managed Implementer turn without a known cost (#754)", () => {
  const MANAGED_IMPLEMENTER = {
    managed: true,
    native: true,
    reviewKind: "implementer",
  } as const;

  // #754-T05
  it("is not a success either: the turn ends as dynamic_accounting_failed, which is our fault and free", () => {
    expect(
      withoutUnaccountedManagedSuccess(resultOf(), MANAGED_IMPLEMENTER),
    ).toMatchObject({ ok: false, errorCode: "dynamic_accounting_failed" });
  });

  // #754: a managed turn that reports no usage at all would settle with no cost while the operator pays the model.
  it("is not a success when it reports no usage at all, which Dynamic's pinned behaviour still allows", () => {
    const bare = resultOf({ usage: null });

    expect(
      withoutUnaccountedManagedSuccess(bare, MANAGED_IMPLEMENTER),
    ).toMatchObject({ ok: false, errorCode: "dynamic_accounting_failed" });
    expect(withoutUnaccountedManagedSuccess(bare, MANAGED_DYNAMIC)).toBe(bare);
    expect(
      withoutUnaccountedManagedSuccess(bare, {
        ...MANAGED_IMPLEMENTER,
        managed: false,
      }),
    ).toBe(bare);
  });

  // #754-T05
  it("leaves a turn on the customer's own key, a failure and a known cost alone", () => {
    const own = resultOf();
    const failed = resultOf({ ok: false, errorCode: "agent_gave_up" });
    const priced = resultOf({
      usage: { ...resultOf().usage!, costUsd: 0.2 },
    });

    expect(
      withoutUnaccountedManagedSuccess(own, {
        ...MANAGED_IMPLEMENTER,
        managed: false,
      }),
    ).toBe(own);
    expect(withoutUnaccountedManagedSuccess(failed, MANAGED_IMPLEMENTER)).toBe(
      failed,
    );
    expect(withoutUnaccountedManagedSuccess(priced, MANAGED_IMPLEMENTER)).toBe(
      priced,
    );
  });

  // #754-T08
  it("does not reach a Diff Review, which was never held to the rule", () => {
    const diff = resultOf();
    expect(
      withoutUnaccountedManagedSuccess(diff, {
        ...MANAGED_IMPLEMENTER,
        reviewKind: "diff",
      }),
    ).toBe(diff);
  });
});
