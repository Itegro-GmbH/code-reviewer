// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the plan and usage page of a workspace (#282): what it says for an unlimited, a limited, a paused
// and an unreadable workspace, that the cost limit is a percentage with a text equivalent and never an amount,
// that no state is told by colour alone, and that the numbers move on without a reload while a failed update
// keeps the last data.
import { getProductIdentity } from "../../product-identity/current.ts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planManagedUnbilled } from "../../copy/plan-usage.ts";
import type { RequestResult } from "../../ui/json-request.ts";
import type { PlanView } from "../plan-view.ts";
import type { PlanApi } from "./api.ts";
import { PlanPageContent } from "./plan-page.tsx";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Limited = Extract<PlanView, { kind: "limited" }>;

function limited(overrides: Partial<Limited> = {}): Limited {
  return {
    kind: "limited",
    planLabel: "Team",
    managed: false,
    suspended: false,
    billed: true,
    periodStart: "2026-10-01T00:00:00.000Z",
    runs: {
      diff: { used: 3, limit: 5 },
      dynamic: { used: 1, limit: 2 },
    },
    cost: null,
    ...overrides,
  };
}

function page(plan: PlanView, api?: PlanApi, showPlanLink = true) {
  return render(
    <PlanPageContent
      workspaceSlug="acme"
      plan={plan}
      showPlanLink={showPlanLink}
      {...(api === undefined ? {} : { api })}
    />,
  );
}

const MONEY = /[$€£¥]|\bUSD\b|\bEUR\b|\bcurrency\b|\bprice\b|\bcost of\b/i;

describe("the plan page of an unlimited workspace", () => {
  // #282-T01
  it("says that no limits apply and has no plan entry in the settings navigation", () => {
    page({ kind: "unlimited" }, undefined, false);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Plan and usage",
    );
    expect(screen.getByText("No limits apply to this workspace.")).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).queryByRole("link", { name: "Plan" })).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("the plan page while billing is on (#499)", () => {
  // #499-T10
  it("shows no quota rows when the view has no run counts, and still shows the plan and the usage limit", () => {
    page(
      limited({
        runs: null,
        managed: true,
        cost: { percentUsed: 62, unknownCostCount: 0 },
      }),
    );

    expect(
      screen.getAllByRole("heading").map((heading) => heading.textContent),
    ).toEqual(["Plan and usage", "Current plan", "Usage limit"]);
    expect(screen.queryByText("Diff Review")).toBeNull();
    expect(screen.queryByText("Dynamic Review")).toBeNull();
    expect(screen.queryByText(/\bof\b \d/)).toBeNull();
  });
});

describe("the plan page of a workspace with limits", () => {
  // #282-T02
  it("shows how many runs of each kind are used of the limit", () => {
    page(limited());

    const diff = screen.getByText("Diff Review").closest("div");
    const dynamic = screen.getByText("Dynamic Review").closest("div");
    expect(diff?.textContent).toContain("3 of 5");
    expect(dynamic?.textContent).toContain("1 of 2");
  });

  // #282-T03
  it("says no limit for a limit of null", () => {
    page(
      limited({
        runs: {
          diff: { used: 3, limit: null },
          dynamic: { used: 0, limit: 2 },
        },
      }),
    );

    const diff = screen.getByText("Diff Review").closest("div");
    expect(diff?.textContent).toContain("no limit");
    expect(diff?.textContent).not.toContain(" of ");
  });

  it("shows the plan label and the start of the period, and never when it ends", () => {
    const { container } = page(limited({ planLabel: "<b>Team</b>" }));

    expect(screen.getByText("<b>Team</b>")).toBeTruthy();
    const start = container.querySelector("time");
    expect(start?.getAttribute("datetime")).toBe("2026-10-01T00:00:00.000Z");
    expect(start?.textContent).toBe("2026-10-01 00:00 UTC");
    expect(container.textContent).not.toMatch(/\b(ends?|until|renews?)\b/i);
  });

  it("tells a workspace on the operator's key that the instance provides the models", () => {
    page(limited({ managed: true }));

    expect(
      screen.getByText(
        "The models for your reviews are provided and billed via code-review.com.",
      ),
    ).toBeTruthy();
  });

  // #675-F5
  it("does not say it is billed while billing is off", () => {
    page(limited({ managed: true, billed: false }));

    expect(screen.queryByText(/billed via code-review\.com/)).toBeNull();
    expect(
      screen.getByText(planManagedUnbilled(getProductIdentity())),
    ).toBeTruthy();
  });

  it("does not say that for a workspace on its own key", () => {
    page(limited());

    expect(screen.queryByText(/billed via code-review\.com/)).toBeNull();
  });

  // #282-T06
  it("shows a plain notice that reviews are paused, with no reason", () => {
    page(limited({ suspended: true }));

    const notice = screen.getByRole("status", { name: "Reviews are paused" });
    expect(notice.textContent).toContain(
      "Reviews are paused for this workspace.",
    );
  });

  it("shows no pause notice for a workspace that is not paused", () => {
    page(limited());

    expect(screen.queryByText(/paused/)).toBeNull();
  });
});

describe("the cost limit on the plan page", () => {
  // #282-T04
  it("is a percentage with a bar and the same words as text, and no amount or currency", () => {
    const { container } = page(
      limited({
        managed: true,
        cost: { percentUsed: 62, unknownCostCount: 0 },
      }),
    );

    const bar = screen.getByRole("progressbar", {
      name: "62 % of the usage limit used",
    });
    expect(bar.getAttribute("aria-valuenow")).toBe("62");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
    expect(bar.getAttribute("aria-valuetext")).toBe(
      "62 % of the usage limit used",
    );
    expect(screen.getAllByText("62 % of the usage limit used")).toHaveLength(1);
    expect(container.innerHTML).not.toMatch(MONEY);
    expect(container.textContent).not.toMatch(/\d+[.,]\d+/);
  });

  // #361 (plan page)
  it("shows the same bar, unknown runs and soft cap notice for a workspace on its own key", () => {
    const { container } = page(
      limited({
        managed: false,
        cost: { percentUsed: 100, unknownCostCount: 2 },
      }),
    );

    expect(
      screen.getByRole("progressbar", {
        name: "100 % of the usage limit used",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(/The limit is reached\. New reviews are not started/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "2 finished reviews could not be measured and are not in this percentage.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/not exact/i)).toBeTruthy();
    expect(screen.queryByText(/billed via code-review\.com/)).toBeNull();
    expect(container.innerHTML).not.toMatch(MONEY);
  });

  it("says the limit is reached at 100 % and that it is a soft cap", () => {
    page(
      limited({
        managed: true,
        cost: { percentUsed: 100, unknownCostCount: 0 },
      }),
    );

    expect(
      screen.getByText(/The limit is reached\. New reviews are not started/),
    ).toBeTruthy();
    expect(screen.getByText(/not exact/i)).toBeTruthy();
  });

  it("lists the runs whose cost is unknown apart and does not count them as nothing", () => {
    page(
      limited({
        managed: true,
        cost: { percentUsed: 10, unknownCostCount: 2 },
      }),
    );

    expect(
      screen.getByText(
        "2 finished reviews could not be measured and are not in this percentage.",
      ),
    ).toBeTruthy();
  });

  it("uses the singular for one such run and says nothing when there is none", () => {
    const { unmount } = page(
      limited({
        managed: true,
        cost: { percentUsed: 10, unknownCostCount: 1 },
      }),
    );
    expect(
      screen.getByText(
        "1 finished review could not be measured and is not in this percentage.",
      ),
    ).toBeTruthy();
    unmount();

    page(
      limited({
        managed: true,
        cost: { percentUsed: 10, unknownCostCount: 0 },
      }),
    );
    expect(screen.queryByText(/could not be measured/)).toBeNull();
  });

  it("shows no usage bar when there is no cost limit", () => {
    page(limited());

    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("the plan page, for people who do not see colours", () => {
  // #282-T09
  it("says in words when a run limit is reached and when reviews are paused", () => {
    page(
      limited({
        suspended: true,
        runs: {
          diff: { used: 5, limit: 5 },
          dynamic: { used: 1, limit: 2 },
        },
      }),
    );

    const diff = screen.getByText("Diff Review").closest("div");
    expect(diff?.textContent).toContain("5 of 5");
    expect(diff?.textContent).toContain("limit reached");
    const dynamic = screen.getByText("Dynamic Review").closest("div");
    expect(dynamic?.textContent).not.toContain("limit reached");
  });

  // #282-T09
  it("names every region and keeps a reading order of headings and no stray focus stops", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    page(
      limited({
        managed: true,
        cost: { percentUsed: 62, unknownCostCount: 0 },
      }),
    );

    const headings = screen
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Plan and usage",
      "Current plan",
      "Reviews in this period",
      "Usage limit",
    ]);
    for (const region of screen.getAllByRole("region"))
      expect(region.getAttribute("aria-labelledby")).toBeTruthy();

    // The only things a keyboard stops at are the links of the settings navigation (and the breadcrumb).
    const stops: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await user.tab();
      const active = document.activeElement;
      if (active === null || active === document.body) break;
      if (stops.includes(active.textContent ?? "")) break;
      stops.push(active.textContent ?? "");
    }
    expect(stops).toEqual([
      "Settings",
      "General",
      "Review defaults",
      "LLM",
      "Plan",
    ]);
  });
});

describe("the plan page when the entitlements cannot be read", () => {
  it("says that the limits cannot be read and that reviews are not started", () => {
    page({ kind: "unreadable" });

    expect(
      screen.getByText(/limits of this workspace cannot be read/i),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("the plan page links to the plan management page", () => {
  it("offers Manage plan to somebody who may use it", () => {
    render(
      <PlanPageContent
        workspaceSlug="acme"
        plan={limited()}
        showPlanLink
        canManagePlan
      />,
    );

    const card = screen.getByRole("region", { name: "Plan" });
    const form = card.querySelector("form");
    expect(form?.getAttribute("method")).toBe("post");
    expect(form?.getAttribute("action")).toBe("/api/w/acme/plan-handoff");
  });

  it("does not offer it otherwise", () => {
    page(limited());

    expect(screen.queryByRole("button", { name: "Manage plan" })).toBeNull();
  });
});

describe("the plan page keeps up to date", () => {
  /** Answers with the results in order, then with the last one for every further request. */
  function api(results: RequestResult<PlanView>[]) {
    const read = vi.fn<() => Promise<RequestResult<PlanView>>>();
    for (const result of results) read.mockResolvedValueOnce(result);
    const last = results.at(-1);
    if (last !== undefined) read.mockResolvedValue(last);
    return { read } satisfies PlanApi;
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it("shows new numbers that arrive while the page is open", async () => {
    const poll = api([
      {
        ok: true,
        data: limited({
          runs: {
            diff: { used: 4, limit: 5 },
            dynamic: { used: 1, limit: 2 },
          },
        }),
      },
    ]);
    page(limited(), poll);
    expect(
      screen.getByText("Diff Review").closest("div")?.textContent,
    ).toContain("3 of 5");

    await advance(10_000);

    expect(poll.read).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Diff Review").closest("div")?.textContent,
    ).toContain("4 of 5");
  });

  it("keeps the last data and says so when an update fails, then recovers", async () => {
    const poll = api([
      { ok: false, status: 500, code: "UNEXPECTED_RESPONSE", issues: [] },
      { ok: true, data: limited({ suspended: true }) },
    ]);
    page(limited(), poll);

    await advance(10_000);

    expect(
      screen.getByText("Diff Review").closest("div")?.textContent,
    ).toContain("3 of 5");
    expect(
      screen.getByRole("status", { name: "Updating the page" }).textContent,
    ).toContain("Updating failed");

    await advance(20_000);

    expect(
      screen.getByRole("status", { name: "Reviews are paused" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("status", { name: "Updating the page" }).textContent,
    ).toBe("");
  });

  it("stops asking when the session has ended", async () => {
    const poll = api([
      { ok: false, status: 401, code: "UNAUTHENTICATED", issues: [] },
    ]);
    page(limited(), poll);

    await advance(10_000);
    await advance(120_000);

    expect(poll.read).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("status", { name: "Updating the page" }).textContent,
    ).toContain("no longer updates");
  });

  // #282-review: a person who loses their membership while the page is open gets the answer of a path that does
  // not exist; asking again cannot fix that.
  it("stops asking when the workspace is no longer the person's", async () => {
    const poll = api([
      { ok: false, status: 404, code: "not_found", issues: [] },
    ]);
    page(limited(), poll);

    await advance(10_000);
    await advance(120_000);

    expect(poll.read).toHaveBeenCalledTimes(1);
    const status = screen.getByRole("status", { name: "Updating the page" });
    expect(status.textContent).toContain("That is not available to you.");
    expect(status.textContent).toContain("no longer updates");
  });
});
