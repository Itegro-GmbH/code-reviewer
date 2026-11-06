// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the detail page of a run for a member (#657): the Summary with its cost and duration, the Findings (the review that
// was posted), the sections that are gone (Diagnostics, Call trace, Timings), the error sentence with its code, text from
// outside rendered as text, and the polling that stops at the last state or goes on after a failed update.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import { RUN_STATUS_PRESENTATION } from "../run-status.ts";
import type { CustomerRunDetailView, RunDetailSnapshot } from "../run-view.ts";
import { RUNS_POLL, type RunsApi } from "./api.ts";
import { DETAIL_POLL_FAILED_TEXT } from "./poll-messages.ts";
import {
  FINDINGS_NONE_TEXT,
  FINDINGS_NOT_AVAILABLE_TEXT,
  FINDINGS_NOT_POSTED_TEXT,
  FINDINGS_WAITING_TEXT,
} from "./findings-messages.ts";
import { RunDetail } from "./run-detail.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function detail(
  overrides: Partial<CustomerRunDetailView> = {},
): CustomerRunDetailView {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    repositoryId: "repo-1",
    project: "acme/widgets",
    prNumber: 7,
    prUrl: "https://github.com/acme/widgets/pull/7",
    command: "review",
    reviewKind: "diff",
    triggerKind: "webhook",
    trigger: "Automatic",
    status: "succeeded",
    createdAt: "2026-10-10T12:00:00.000Z",
    startedAt: "2026-10-10T12:00:10.000Z",
    finishedAt: "2026-10-10T12:03:15.000Z",
    durationMs: 185_000,
    problem: null,
    costHidden: false,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    args: "",
    attempts: 0,
    errorCode: null,
    errorCodeKnown: false,
    errorReason: null,
    commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
    commentMissing: false,
    reviewText: null,
    supersededBy: null,
    usage: null,
    ...overrides,
  };
}

const snap = (run: CustomerRunDetailView): RunDetailSnapshot => ({
  generatedAt: "2026-10-10T12:10:00.000Z",
  run,
});

const failure: RequestResult<RunDetailSnapshot> = {
  ok: false,
  status: 500,
  code: "UNEXPECTED_RESPONSE",
  issues: [],
};

function apiAnswering(answers: RequestResult<RunDetailSnapshot>[]) {
  const api = {
    list: vi.fn(),
    detail: vi.fn(async () => answers.shift() ?? failure),
  };
  return api as unknown as RunsApi & { detail: typeof api.detail };
}

const text = (container: HTMLElement) => container.textContent;

describe("the usage of a run", () => {
  const usage = {
    model: "vendor/dynamic-model",
    totalTokens: 12_900,
    aiCalls: 7,
    costUsd: 0.04,
    stoppedEarly: null,
  };

  // #201-T27
  it("names the review kind with the model that answered and the cost, without the tokens and calls", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ reviewKind: "dynamic", usage }))}
        api={apiAnswering([])}
      />,
    );

    const content = text(container);
    expect(content).toContain("Dynamic Review");
    expect(content).toContain("vendor/dynamic-model");
    expect(content).not.toContain("tokens");
    expect(content).toContain("$0.04");
  });

  // #293-T08
  it.each([
    ["cost_limit", /cost limit/],
    // #666-T01
    ["project_cost_limit", /cost limit set for this project/],
    ["time_limit", /time limit/],
    // #553-R07
    ["token_limit", /token limit/],
  ] as const)(
    "says in neutral words that a review stopped early at its %s and may be incomplete",
    (stoppedEarly, limit) => {
      const { container } = render(
        <RunDetail
          workspaceSlug="acme"
          initial={snap(detail({ usage: { ...usage, stoppedEarly } }))}
          api={apiAnswering([])}
        />,
      );

      const content = text(container);
      expect(
        screen.getByRole("region", { name: "Findings" }).textContent,
      ).toMatch(limit);
      expect(content).toMatch(limit);
      expect(content).toContain("may be incomplete");
    },
  );

  // #689: a Diff Review that reached the cost limit fails and posts nothing; the failure text names the limit, so the
  // wrap-up sentences of a review that was delivered must not appear next to "No review was posted".
  it.each(["cost_limit", "project_cost_limit"] as const)(
    "does not say a failed run was wrapped up at its %s",
    (stoppedEarly) => {
      const { container } = render(
        <RunDetail
          workspaceSlug="acme"
          initial={snap(
            detail({
              status: "failed",
              errorCode: "cost_limit_reached",
              errorCodeKnown: true,
              commentUrl: null,
              usage: { ...usage, stoppedEarly },
            }),
          )}
          api={apiAnswering([])}
        />,
      );

      const content = text(container);
      expect(content).not.toContain("wrapped up");
      expect(content).not.toContain("may be incomplete");
      expect(content).not.toContain("Stopped early");
    },
  );

  // #293-T08
  it("shows nothing about stopping early for a complete run", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ usage }))}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).not.toContain("Stopped early");
  });

  // #201-T28: a Dynamic Review never guesses a price.
  it("says the cost is unknown instead of showing zero", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ usage: { ...usage, costUsd: null } }))}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("Not available");
    expect(text(container)).not.toContain("$0");
  });

  // #856-T74
  it("shows a subscription turn as an estimate through a subscription, not as its cost", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            usage: {
              ...usage,
              costUsd: null,
              costBasis: "subscription",
              estimatedCostUsd: 0.4231,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(screen.getByText("Cost")).toBeTruthy();
    const shown = container.querySelector(
      '[data-slot="run-cost-subscription"]',
    );
    expect(shown?.textContent).toBe("≈ $0.4231 through a subscription");
    expect(text(container)).toContain("Estimate at API prices, not billed");
    expect(text(container)).not.toContain("Not available");
  });

  // #856-T74
  it("never reads a billed cost as 'not billed': a cost beside the basis shows the cost", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            usage: {
              ...usage,
              costUsd: 0.04,
              costBasis: "subscription",
              estimatedCostUsd: 0.4231,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(
      container.querySelector('[data-slot="run-cost-subscription"]'),
    ).toBeNull();
    expect(text(container)).not.toContain("not billed");
    expect(text(container)).toContain("$0.04");
  });

  // #856-T74
  it("says a subscription turn has no estimate when Claude Code gave none", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            usage: {
              ...usage,
              costUsd: null,
              costBasis: "subscription",
              estimatedCostUsd: null,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    const shown = container.querySelector(
      '[data-slot="run-cost-subscription"]',
    );
    expect(shown?.textContent).toBe("No estimate, through a subscription");
    expect(text(container)).not.toContain("Not available");
    expect(text(container)).not.toContain("≈");
  });

  // #267-T08
  it("shows the cost of a run to four decimals and never rounds a real cost to zero", () => {
    function shown(costUsd: number): string | null {
      const { container } = render(
        <RunDetail
          workspaceSlug="acme"
          initial={snap(detail({ usage: { ...usage, costUsd } }))}
          api={apiAnswering([])}
        />,
      );
      const content = text(container);
      cleanup();
      return content;
    }

    expect(shown(0.0123)).toContain("$0.0123");
    // The boundary: $0.0001 is the smallest cost shown as a number, anything below it is named.
    expect(shown(0.0001)).toContain("$0.0001");
    expect(shown(0.0001)).not.toContain("Less than");
    expect(shown(0.00009999)).toContain("Less than $0.0001");
    expect(shown(0.00004)).toContain("Less than $0.0001");
    expect(shown(0.00004)).not.toContain("$0.0000");
    // A free call is a known cost of zero, not an unknown one.
    expect(shown(0)).toContain("$0.00");
    expect(shown(0)).not.toContain("Not available");
  });

  // #283-T07
  it("shows no model and no cost for a run on a managed tier", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            usage: { ...usage, model: null, costUsd: null },
            costHidden: true,
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(screen.queryByText("Model")).toBeNull();
    expect(screen.queryByText("Cost")).toBeNull();
    expect(container.querySelector('[data-slot="run-model"]')).toBeNull();
    expect(text(container)).not.toContain("Not available");
  });

  // #201-T29
  it("shows no model and no usage for a run that never reached a model", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ status: "failed", usage: null }))}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).not.toContain("tokens in");
    expect(screen.queryByText("Model")).toBeNull();
  });

  // #201-T30
  it("renders a model name from outside as text", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            usage: { ...usage, model: "<img src=x onerror=alert(1)>" },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
    expect(text(container)).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("the detail page", () => {
  // CR-35-T04
  it("shows pull request, command, trigger, status, duration and the link to the review", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail())}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("Succeeded");
    expect(text(container)).toContain("acme/widgets");
    expect(text(container)).toContain("#7 on GitHub");
    expect(text(container)).toContain("/review");
    expect(text(container)).toContain("Automatic");
    expect(text(container)).toContain("0123456789ab");
    expect(text(container)).toContain("3 min 05 s");
    const link = screen.getByRole("link", {
      name: "Open the review on GitHub",
    });
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/7#issuecomment-9",
    );
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  // #200
  it("names the review kind of the run in the summary, for both kinds", () => {
    const { rerender } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail())}
        api={apiAnswering([])}
      />,
    );
    const kind = () =>
      screen.getByText("Review kind").nextElementSibling?.textContent;

    expect(kind()).toBe("Diff Review");

    rerender(
      <RunDetail
        key="dynamic"
        workspaceSlug="acme"
        initial={snap(detail({ reviewKind: "dynamic" }))}
        api={apiAnswering([])}
      />,
    );
    expect(kind()).toBe("Dynamic Review");
  });

  // #175-T03
  // #657-T02
  it("has a Summary and the Findings, and no Diagnostics, Call trace, Timings or log for a member", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            reviewKind: "dynamic",
            usage: {
              model: "vendor/dynamic-model",
              totalTokens: 12_900,
              aiCalls: 7,
              costUsd: 0.04,
              stoppedEarly: null,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["Summary", "Findings"]);
    for (const gone of ["Diagnostics", "Call trace", "Timings", "Log"])
      expect(screen.queryByRole("heading", { name: gone })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy log" })).toBeNull();
    for (const term of ["Created", "Started", "Finished", "Lost attempts"])
      expect(screen.queryByText(term)).toBeNull();
  });

  // #657-T03
  it("shows the cost and the duration in the Summary", () => {
    render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            durationMs: 125_000,
            usage: {
              model: null,
              totalTokens: 100,
              aiCalls: 1,
              costUsd: 0.42,
              stoppedEarly: null,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    const summary = screen.getByRole("region", { name: "Summary" });
    expect(summary.textContent).toContain("Cost");
    expect(summary.textContent).toContain("$0.42");
    expect(summary.textContent).toContain("Duration");
    expect(summary.textContent).toContain("2 min 05 s");
  });

  // #657-T03
  it("counts a running run's duration as so far, and has none for a run that never started", () => {
    const running = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ status: "running", durationMs: 30_000 }))}
        api={apiAnswering([])}
      />,
    );
    expect(text(running.container)).toContain("so far");
    running.unmount();

    const waiting = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ status: "queued", durationMs: null }))}
        api={apiAnswering([])}
      />,
    );
    expect(screen.getByText("Duration").nextElementSibling?.textContent).toBe(
      "Not available",
    );
    waiting.unmount();
  });

  it("groups the facts and keeps the status description behind the badge", async () => {
    render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail())}
        api={apiAnswering([])}
      />,
    );

    expect(screen.getByRole("heading", { name: "Summary" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Findings" })).toBeTruthy();
    expect(
      screen.queryByText(RUN_STATUS_PRESENTATION.succeeded.description),
    ).toBeNull();

    const hint = screen.getByRole("button", {
      name: "About the status Succeeded",
    });
    fireEvent.focus(hint);

    const describedBy = hint.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy ?? "")?.textContent).toContain(
      RUN_STATUS_PRESENTATION.succeeded.description,
    );
  });

  // CR-35-T04
  it("names who started a run by comment or by hand", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({ triggerKind: "comment", trigger: "Comment by alice" }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("Comment by alice");
  });

  // CR-35-T04
  it("shows the translated error and the error code of a failed run", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            commentUrl: null,
            errorCode: "git_unavailable",
            errorCodeKnown: true,
            problem: "GitHub could not be reached.",
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("GitHub could not be reached.");
    expect(screen.getByText("git_unavailable").tagName).toBe("CODE");
    expect(screen.queryByRole("link", { name: /comment/i })).toBeNull();
  });

  // #296-T11
  it("shows the reason of a failed checkout in words, next to its code", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            commentUrl: null,
            reviewKind: "dynamic",
            errorCode: "checkout_incomplete",
            errorCodeKnown: true,
            errorReason: {
              code: "budget_preparation",
              text: "The repository is larger to prepare than a Dynamic Review allows.",
              known: true,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain(
      "The repository is larger to prepare than a Dynamic Review allows.",
    );
    expect(screen.getByText("budget_preparation").tagName).toBe("CODE");
  });

  // #296-T11
  it("shows no reason line for a run without one", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            errorCode: "timeout",
            errorCodeKnown: true,
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).not.toContain("Reason:");
  });

  // CR-35-T09
  it("shows an unknown error code with the general sentence and does not fail", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            errorCode: "flux_capacitor",
            errorCodeKnown: false,
            problem: "The run ended with an error this version does not know.",
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("does not know");
    expect(screen.getByText("flux_capacitor")).toBeTruthy();
  });

  // CR-35-T13
  it("renders names and questions with HTML as plain text and runs no script", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            project: "<script>alert(2)</script>",
            args: "<img src=y onerror=alert(3)>",
            command: "ask",
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(text(container)).toContain("<script>alert(2)</script>");
    expect(text(container)).toContain("<img src=y onerror=alert(3)>");
  });

  // CR-53-T01
  it("shows the sentence for a review that outgrew the comment limit together with the link to the review", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "failed",
            problem:
              "The review was posted, but it grew past GitHub's comment size limit, so earlier findings are no longer tracked.",
            errorCode: "review_state_truncated",
            errorCodeKnown: true,
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("grew past GitHub's comment size limit");
    expect(text(container)).toContain("review_state_truncated");
    expect(
      screen
        .getByRole("link", { name: "Open the review on GitHub" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/pull/7#issuecomment-9");
  });

  // #657-T04
  it("shows what was posted for the run, readably", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            reviewText:
              "## PR Reviewer Guide\n\n#### P1 - Missing check\n\n- The `null` case is not handled.",
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    const findings = screen.getByRole("region", { name: "Findings" });
    expect(
      within(findings).getByRole("heading", { name: "PR Reviewer Guide" }),
    ).toBeTruthy();
    expect(
      within(findings).getByRole("heading", { name: "P1 - Missing check" }),
    ).toBeTruthy();
    expect(within(findings).getByRole("listitem").textContent).toContain(
      "The null case is not handled.",
    );
    expect(container.querySelector("script")).toBeNull();
    expect(
      within(findings).getByRole("link", { name: "Open the review on GitHub" }),
    ).toBeTruthy();
  });

  // #657-T04
  it("says so for a run that posted no findings, and when the text is not available", () => {
    const none = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ commentUrl: null }))}
        api={apiAnswering([])}
      />,
    );
    expect(text(none.container)).toContain(FINDINGS_NONE_TEXT);
    expect(screen.queryByRole("link", { name: /review on GitHub/ })).toBeNull();
    none.unmount();

    const unavailable = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail())}
        api={apiAnswering([])}
      />,
    );
    expect(text(unavailable.container)).toContain(FINDINGS_NOT_AVAILABLE_TEXT);
    unavailable.unmount();

    const failed = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ status: "failed", commentUrl: null }))}
        api={apiAnswering([])}
      />,
    );
    expect(text(failed.container)).toContain(FINDINGS_NOT_POSTED_TEXT);
    failed.unmount();

    const waiting = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({ status: "queued", commentUrl: null, durationMs: null }),
        )}
        api={apiAnswering([])}
      />,
    );
    expect(text(waiting.container)).toContain(FINDINGS_WAITING_TEXT);
  });

  it("shows a pull request address that is no web address as plain text", () => {
    render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ prUrl: null }))}
        api={apiAnswering([])}
      />,
    );

    expect(screen.queryByRole("link", { name: "#7 on GitHub" })).toBeNull();
    expect(screen.getByText("#7")).toBeTruthy();
  });

  it("links a replaced run to the newer one", () => {
    render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            status: "superseded",
            supersededBy: "newer-run",
            attempts: 2,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            commentUrl: null,
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(
      screen
        .getByRole("link", { name: "Replaced by a newer run" })
        .getAttribute("href"),
    ).toBe("/w/acme/runs/newer-run");
    expect(screen.getByText("Superseded")).toBeTruthy();
  });
});

describe("polling the detail page", () => {
  async function pass(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  // CR-35-T11
  it("follows the run from waiting to running to succeeded and then stops asking", async () => {
    const waiting = detail({
      status: "queued",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      commentUrl: null,
    });
    const api = apiAnswering([
      {
        ok: true,
        data: snap({
          ...waiting,
          status: "running",
          startedAt: waiting.createdAt,
          durationMs: 4000,
        }),
      },
      { ok: true, data: snap(detail()) },
    ]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(waiting)} api={api} />,
    );
    expect(screen.getByText("Waiting")).toBeTruthy();

    await pass(3000);
    expect(screen.getByText("Running")).toBeTruthy();

    await pass(3000);
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open the review on GitHub" }),
    ).toBeTruthy();

    await pass(60_000);
    expect(api.detail).toHaveBeenCalledTimes(2);
  });

  // CR-35-T12
  it("keeps the last data on a failed update, says so and tries again", async () => {
    const running = detail({
      status: "running",
      finishedAt: null,
      commentUrl: null,
    });
    const api = apiAnswering([failure, { ok: true, data: snap(detail()) }]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(running)} api={api} />,
    );

    await pass(3000);
    expect(
      screen.getByRole("status", { name: "Updating the run" }).textContent,
    ).toBe(DETAIL_POLL_FAILED_TEXT);
    expect(screen.getByText("Running")).toBeTruthy();

    await pass(3000);
    expect(
      screen.getByRole("status", { name: "Updating the run" }).textContent,
    ).toBe("");
    expect(screen.getByText("Succeeded")).toBeTruthy();
  });

  // #657-T04
  it("keeps asking for a minute or two after a run ended until the text of its review arrives, then stops", async () => {
    const justEnded = {
      ...snap(detail()),
      generatedAt: "2026-10-10T12:03:20.000Z",
    };
    const api = apiAnswering([
      { ok: true, data: justEnded },
      {
        ok: true,
        data: {
          ...justEnded,
          run: { ...justEnded.run, reviewText: "## Review\n\nA finding." },
        },
      },
    ]);
    render(<RunDetail workspaceSlug="acme" initial={justEnded} api={api} />);
    expect(screen.queryByText("A finding.")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNS_POLL.activeMs * 2);
    });

    expect(screen.getByText("A finding.")).toBeTruthy();
    const asked = api.detail.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUNS_POLL.activeMs * 10);
    });
    expect(api.detail.mock.calls.length).toBe(asked);
  });

  it("does not ask at all for a run that is settled", async () => {
    const api = apiAnswering([]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(detail())} api={api} />,
    );

    await pass(60_000);

    expect(api.detail).not.toHaveBeenCalled();
  });

  // CR-35-T12
  it("says the session ended and stops asking when the answer is a refusal that asking again cannot fix", async () => {
    const running = detail({ status: "running", finishedAt: null });
    const api = apiAnswering([
      { ok: false, status: 401, code: "UNAUTHENTICATED", issues: [] },
    ]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(running)} api={api} />,
    );

    await pass(3000);

    const status = screen.getByRole("status", { name: "Updating the run" });
    expect(status.textContent).toContain(
      "Your session has ended. Sign in again.",
    );
    expect(status.textContent).toContain("no longer updates");
    await pass(600_000);
    expect(api.detail).toHaveBeenCalledTimes(1);
  });

  it("says the run is gone and stops asking when it was not found", async () => {
    const running = detail({ status: "running", finishedAt: null });
    const api = apiAnswering([
      { ok: false, status: 404, code: "RUN_NOT_FOUND", issues: [] },
    ]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(running)} api={api} />,
    );

    await pass(3000);

    expect(
      screen.getByRole("status", { name: "Updating the run" }).textContent,
    ).toContain("This run no longer exists.");
    await pass(600_000);
    expect(api.detail).toHaveBeenCalledTimes(1);
  });
});

describe("the price of a review on the detail page (#505)", () => {
  // #505-T05
  it("shows the AI price and the infrastructure price of a charged review", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            price: {
              state: "charged",
              aiMicroUsd: 1_500_000,
              infraMicroUsd: 130_000,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("Cost");
    expect(text(container)).toContain("AI");
    expect(text(container)).toContain("$1.50");
    expect(text(container)).toContain("Infrastructure");
    expect(text(container)).toContain("$0.13");
  });

  // #505-T07
  it("shows the infrastructure price alone for a review on the workspace's own key", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(
          detail({
            price: {
              state: "charged",
              aiMicroUsd: null,
              infraMicroUsd: 260_000,
            },
          }),
        )}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("$0.26");
    expect(text(container)).not.toMatch(/\bAI\b/);
  });

  // #505-T05
  it("says Not charged for a free review", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail({ price: { state: "not_charged" } }))}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).toContain("Not charged");
  });

  // #505-T11
  it("has no Cost line without a price and without a reported cost", () => {
    const { container } = render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(detail())}
        api={apiAnswering([])}
      />,
    );

    expect(text(container)).not.toContain("Cost");
  });
});
