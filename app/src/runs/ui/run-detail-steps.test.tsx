// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// "What the agent did" inside the detail page of a run (#745, live view): it is there for a run of the Implementer and for no other,
// it rides on the poll of the run (one request for the steps with each snapshot, one more when the run settles, none after), a
// settled run waits for the person to open it, and the page shows no cost where it shows none for the run.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../../ui/json-request.ts";
import type {
  CustomerRunDetailView,
  ImplementerDetailView,
  RunDetailSnapshot,
} from "../run-view.ts";
import type { StepsSnapshot, StepView } from "../steps-view.ts";
import { RUNS_POLL, type RunsApi } from "./api.ts";
import { RunDetail } from "./run-detail.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NONE_DROPPED = { invalid: 0, overflow: 0 };

function task(): ImplementerDetailView {
  return {
    branch: "implementer/abc123",
    branchUrl: null,
    baseBranch: "main",
    instruction: { preview: "Add a health endpoint.", full: null },
    summary: null,
    environment: null,
    commits: { shown: [], more: 0 },
    files: { count: 0, shown: [], more: 0 },
    branches: { shown: [], more: 0, dropped: NONE_DROPPED },
    head: null,
    pushedNote: null,
    reported: false,
  };
}

function run(
  overrides: Partial<CustomerRunDetailView> = {},
): CustomerRunDetailView {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    repositoryId: "repo-1",
    project: "acme/widgets",
    prNumber: -1,
    prUrl: null,
    command: "review",
    reviewKind: "implementer",
    triggerKind: "manual",
    trigger: "Started by octocat",
    status: "running",
    createdAt: "2026-10-10T12:00:00.000Z",
    startedAt: "2026-10-10T12:00:10.000Z",
    finishedAt: null,
    durationMs: 50_000,
    problem: null,
    headSha: "a".repeat(40),
    args: "",
    attempts: 0,
    errorCode: null,
    errorCodeKnown: false,
    errorReason: null,
    commentUrl: null,
    commentMissing: false,
    reviewText: null,
    supersededBy: null,
    usage: null,
    costHidden: false,
    implementer: task(),
    ...overrides,
  };
}

/** The snapshot of the n-th answer: the server stamps each one with its own time. */
const snap = (detail: CustomerRunDetailView, n: number): RunDetailSnapshot => ({
  generatedAt: `2026-10-10T12:10:0${String(n)}.000Z`,
  run: detail,
});

const step = (n: number, extra: Partial<StepView> = {}): StepView => ({
  partId: `prt_${String(n)}`,
  seq: n,
  ordinal: n,
  kind: "text",
  text: `Words ${String(n)}`,
  ...extra,
});
const page = (...steps: StepView[]): RequestResult<StepsSnapshot> => ({
  ok: true,
  data: {
    steps,
    cursor: Math.max(0, ...steps.map((s) => s.seq)),
    hasMore: false,
  },
});

function apiAnswering(
  details: RunDetailSnapshot[],
  steps: RequestResult<StepsSnapshot>[],
) {
  const api = {
    list: vi.fn(),
    detail: vi.fn(async () => {
      const next = details.shift();
      return next === undefined
        ? ({
            ok: false,
            status: 500,
            code: "NETWORK_ERROR",
            issues: [],
          } as const)
        : { ok: true, data: next };
    }),
    steps: vi.fn(async () => steps.shift() ?? page()),
  };
  return api as unknown as RunsApi & {
    detail: typeof api.detail;
    steps: typeof api.steps;
  };
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("What the agent did, on the detail page of a run", () => {
  // #745-T90
  it("asks for the steps once with each snapshot of a running run, once more when it settles, and then not at all", async () => {
    const running = run();
    const api = apiAnswering(
      [
        snap(running, 1),
        snap(
          run({ status: "succeeded", finishedAt: "2026-10-10T12:01:00.000Z" }),
          2,
        ),
      ],
      [page(step(1)), page(step(2)), page(step(3))],
    );
    render(
      <RunDetail workspaceSlug="acme" initial={snap(running, 0)} api={api} />,
    );
    await act(async () => {});
    expect(
      screen.getByRole("heading", { name: "What the agent did" }),
    ).toBeTruthy();
    expect(api.steps).toHaveBeenCalledTimes(1);

    await pass(RUNS_POLL.activeMs);
    expect(api.steps).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Running")).toBeTruthy();

    await pass(RUNS_POLL.activeMs);
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(api.steps).toHaveBeenCalledTimes(3);

    await pass(10 * RUNS_POLL.activeMs);
    expect(api.detail).toHaveBeenCalledTimes(2);
    expect(api.steps).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Words 1")).toBeTruthy();
    expect(screen.getByText("Words 3")).toBeTruthy();
  });

  // #745-T91
  it("waits for the person to open it on a run that is over, and then loads the steps once", async () => {
    const done = run({
      status: "succeeded",
      finishedAt: "2026-10-10T12:01:00.000Z",
    });
    const api = apiAnswering([], [page(step(1))]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(done, 0)} api={api} />,
    );
    await act(async () => {});
    expect(api.steps).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Show what the agent did" }),
    );
    await act(async () => {});

    expect(api.steps).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Words 1")).toBeTruthy();
    await pass(10 * RUNS_POLL.activeMs);
    expect(api.steps).toHaveBeenCalledTimes(1);
  });

  // #745-T92
  it("is not on the page of a run of another kind", async () => {
    const review = run({
      reviewKind: "diff",
      status: "succeeded",
      prNumber: 7,
    });
    delete (review as { implementer?: unknown }).implementer;
    const api = apiAnswering([], []);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(review, 0)} api={api} />,
    );
    await act(async () => {});

    expect(screen.queryByText("What the agent did")).toBeNull();
    expect(api.steps).not.toHaveBeenCalled();
  });

  // #745-T93
  it("shows the cost of a model call only where the run shows cost", async () => {
    const end = step(2, {
      kind: "step",
      cost: 0.42,
      tokens: {
        input: 5,
        output: 6,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
    const own = apiAnswering([], [page(step(1), end)]);
    render(
      <RunDetail workspaceSlug="acme" initial={snap(run(), 0)} api={own} />,
    );
    await act(async () => {});
    expect(screen.getByText(/5 in · 6 out.*\$0\.42/)).toBeTruthy();
    cleanup();

    const managed = apiAnswering([], [page(step(1), end)]);
    render(
      <RunDetail
        workspaceSlug="acme"
        initial={snap(run({ costHidden: true }), 0)}
        api={managed}
      />,
    );
    await act(async () => {});
    expect(screen.getByText(/5 in · 6 out/).textContent).not.toContain("$");
  });
});
