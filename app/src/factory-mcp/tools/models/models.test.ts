// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { WorkspaceBillingView } from "../../../workspace-billing/view.ts";
import { contextWith, data, failure } from "../runs/test-support.ts";
import { costsService, modelsService } from "./services.ts";

const READ = { scopes: ["factory:read" as const], role: "member" as const };

describe("list_models", () => {
  // #1147-T17
  it("answers the model options of the workspace including the claudeCode entry", async () => {
    const options = vi.fn(async () => ({
      keyMode: "own" as const,
      providers: [{ id: "anthropic", label: "Anthropic", models: [] }],
      claudeCode: {
        harness: "claude-code" as const,
        models: ["sonnet", "opus", "haiku"],
        source: "workspace_token" as const,
      },
    }));
    const answer = await data(
      "list_models",
      contextWith([[modelsService as never, { options }]], READ),
      {},
    );
    expect(answer).toMatchObject({
      keyMode: "own",
      providers: [{ id: "anthropic" }],
      claudeCode: {
        harness: "claude-code",
        source: "workspace_token",
        models: ["sonnet", "opus", "haiku"],
      },
    });
  });

  // #1147-T18
  it("without a Claude Code login there is no claudeCode entry, and an unreadable plan offers nothing", async () => {
    const options = async () => ({ keyMode: "unreadable" as const });
    const answer = await data(
      "list_models",
      contextWith([[modelsService as never, { options }]], READ),
      {},
    );
    expect(answer).toEqual({ keyMode: "unreadable" });
  });
});

const billingView = (
  over: Partial<WorkspaceBillingView> = {},
): WorkspaceBillingView => ({
  canManage: true,
  balanceMicroUsd: 12_500_000,
  heldMicroUsd: 0,
  state: "ok",
  topUpAvailable: true,
  profileRequired: false,
  pendingTopUps: [],
  profile: null,
  monthlyLimitCents: 5000,
  chargedThisMonthMicroUsd: 3_000_000,
  keyMode: "managed",
  journal: { rows: [], next: null },
  ...over,
});
const plan = { kind: "unlimited" as const };

function costs(overrides: {
  on?: boolean;
  overview?: unknown;
  journal?: unknown;
}) {
  return {
    plan: async () => plan,
    billingOn: async () => overrides.on ?? true,
    billing: () => ({
      overview: vi.fn(
        async () => overrides.overview ?? { ok: true, view: billingView() },
      ),
      journal: vi.fn(
        async () =>
          overrides.journal ?? { ok: true, page: { rows: [], next: null } },
      ),
    }),
  };
}

describe("get_budget", () => {
  // #1147-T19
  it("answers the plan, the balance and, for an Admin, the monthly limit and this month's charges", async () => {
    const answer = await data(
      "get_budget",
      contextWith([[costsService as never, costs({})]], READ),
      {},
    );
    expect(answer).toMatchObject({
      billingEnabled: true,
      plan,
      balance: {
        state: "ok",
        balanceMicroUsd: 12_500_000,
        balanceUsd: 12.5,
        keyMode: "managed",
      },
      monthlyLimitCents: 5000,
      chargedThisMonthUsd: 3,
    });
  });

  // #1147-T20
  it("a Member gets no limit or monthly figures, and with billing off only the plan", async () => {
    const member = costs({
      overview: {
        ok: true,
        view: billingView({
          canManage: false,
          monthlyLimitCents: null,
          chargedThisMonthMicroUsd: null,
        }),
      },
    });
    const answer = await data(
      "get_budget",
      contextWith([[costsService as never, member]], READ),
      {},
    );
    expect(answer).not.toHaveProperty("monthlyLimitCents");
    expect(answer).not.toHaveProperty("chargedThisMonthUsd");
    const off = await data(
      "get_budget",
      contextWith([[costsService as never, costs({ on: false })]], READ),
      {},
    );
    expect(off).toEqual({ billingEnabled: false, plan });
  });
});

describe("get_costs", () => {
  // #1147-T21
  it("pages the journal with the cursor and limit given", async () => {
    const journal = vi.fn(async () => ({
      ok: true as const,
      page: {
        rows: [{ id: "j1", kind: "usage", amountMicroUsd: -200_000 }],
        next: "7",
      },
    }));
    const service = {
      ...costs({}),
      billing: () => ({ overview: async () => ({ ok: false }), journal }),
    };
    const answer = await data(
      "get_costs",
      contextWith([[costsService as never, service]], READ),
      { limit: 10, cursor: "9" },
    );
    expect(journal).toHaveBeenCalledWith(
      { workspaceId: "ws-acme", userId: "user-ada", role: "member" },
      { cursor: "9", limit: 10 },
    );
    expect(answer).toEqual({
      billingEnabled: true,
      rows: [{ id: "j1", kind: "usage", amountMicroUsd: -200_000 }],
      next: "7",
    });
  });

  // #1147-T22
  it("billing off is a normal answer and a bad cursor is invalid_input", async () => {
    const off = await data(
      "get_costs",
      contextWith([[costsService as never, costs({ on: false })]], READ),
      {},
    );
    expect(off).toEqual({ billingEnabled: false, rows: [], next: null });
    const bad = costs({
      journal: { ok: false, error: "journal_query_invalid" },
    });
    expect(
      await failure(
        "get_costs",
        contextWith([[costsService as never, bad]], READ),
        { cursor: "x" },
      ),
    ).toMatchObject({
      error: "invalid_input",
    });
  });
});
