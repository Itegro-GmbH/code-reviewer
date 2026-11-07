// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The page of one workflow run (#873): the status with a failure told in words, the budget and what was spent with where the cost
// figures come from, the steps with status, failure and duration, the link of an agent step to its Implementer run, what an action
// step returned (links only to the run's own repository on github.com), values from an agent rendered as text, and the polling that
// stops once the run has ended.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestResult } from "../ui/json-request.ts";
import type { RunView, StepView } from "../workflow-runs/service.ts";
import { WORKFLOW_RUN_POLL_MS, type WorkflowRunsApi } from "./api.ts";
import {
  COST_BASIS_COPY,
  COST_BASIS_UNKNOWN_COPY,
  COST_NOT_RUN_COPY,
  RUN_POLL_FAILED_TEXT,
} from "./messages.ts";
import { WorkflowRunDetail } from "./run-detail.tsx";
import { JOB_ID, run, step } from "./test-fixtures.ts";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ok = (value: RunView): RequestResult<{ run: RunView }> => ({
  ok: true,
  data: { run: value },
});
const failure = (code: string): RequestResult<{ run: RunView }> => ({
  ok: false,
  status: 500,
  code,
  issues: [],
});

function apiAnswering(answers: RequestResult<{ run: RunView }>[]) {
  const fake = {
    run: vi.fn(async () => answers.shift() ?? failure("UNEXPECTED_RESPONSE")),
  };
  return fake as unknown as WorkflowRunsApi & { run: typeof fake.run };
}

function renderRun<T extends WorkflowRunsApi>(
  value: RunView,
  api: T = apiAnswering([]) as unknown as T,
) {
  const view = render(
    <WorkflowRunDetail
      workspaceSlug="acme"
      workflowId="wf-1"
      initial={{ run: value }}
      api={api}
    />,
  );
  return { ...view, api };
}

describe("the status of a run", () => {
  // #873-T40
  it("tells a run that ran out of budget in words, not as its code", () => {
    const { container } = renderRun(
      run({
        status: "failed",
        errorCode: "budget_exhausted",
        finishedAt: "2026-11-05T10:05:00.000Z",
      }),
    );

    expect(screen.getByText("Failed")).toBeTruthy();
    const alert = container.querySelector("[data-slot=run-failure]");
    expect(alert?.textContent).toContain("budget of the run is used up");
    expect(container.textContent).not.toContain("budget_exhausted");
  });

  // #873-T40
  it("tells why a step failed in words, keeps the engine's message under it, and never shows the code", () => {
    const { container } = renderRun(
      run({
        status: "failed",
        errorCode: "step_failed",
        finishedAt: "2026-11-05T10:05:00.000Z",
        steps: [
          step({
            status: "failed",
            errorCode: "no_result",
            errorMessage: "The agent ended without a result.",
            output: null,
          }),
        ],
      }),
    );

    const failed = container.querySelector("[data-slot=step-failure]");
    expect(failed?.textContent).toContain("without a result that fits");
    expect(
      container.querySelector("[data-slot=step-error-message]")?.textContent,
    ).toBe("The agent ended without a result.");
    expect(container.textContent).not.toContain("no_result");
    expect(container.textContent).not.toContain("step_failed");
  });

  // #873-T40
  it("leaves out a stored message that carries a code, and keeps the sentence of the error code", () => {
    const { container } = renderRun(
      run({
        status: "failed",
        errorCode: "step_failed",
        finishedAt: "2026-11-05T10:05:00.000Z",
        steps: [
          step({
            status: "failed",
            errorCode: "agent_start_failed",
            errorMessage: "IMPLEMENTER_X: the thing broke",
            output: null,
          }),
          step({
            id: "second",
            status: "failed",
            errorCode: "action_failed",
            errorMessage: "agent_start_failed went wrong",
            output: null,
          }),
        ],
      }),
    );

    const failures = container.querySelectorAll("[data-slot=step-failure]");
    expect(failures[0]?.textContent).toBe("The agent could not be started.");
    expect(failures[1]?.textContent).toBe("The action failed.");
    expect(
      container.querySelector("[data-slot=step-error-message]"),
    ).toBeNull();
    expect(container.textContent).not.toContain("IMPLEMENTER_X");
    expect(container.textContent).not.toContain("agent_start_failed");
  });

  it("shows a run that is running without a failure", () => {
    const { container } = renderRun(run());

    expect(screen.getByText("Running")).toBeTruthy();
    expect(container.querySelector("[data-slot=run-failure]")).toBeNull();
    expect(container.textContent).toContain("Started by hand");
    expect(container.textContent).toContain("acme/widgets");
  });
});

describe("a run a label started (#845)", () => {
  // #845-T61
  it("shows the trigger and who put the label on, and asks for no starter", () => {
    const { container } = renderRun(
      run({
        trigger: "github.issueLabeled",
        actorLogin: "bob",
        input: {
          issue: { number: 12 },
          repo: { fullName: "acme/widgets", owner: "acme", name: "widgets" },
        },
      }),
    );

    expect(container.textContent).toContain("A label on an issue");
    expect(container.textContent).toContain("Label put on by");
    expect(container.textContent).toContain("bob");
    expect(container.textContent).not.toContain("Started by hand");
    expect(container.textContent).toContain("acme/widgets");
  });

  // #845-T62
  it("shows no actor row for a run started by hand", () => {
    const { container } = renderRun(run());

    expect(container.textContent).not.toContain("Label put on by");
  });
});

describe("the budget and the cost", () => {
  // #873-T41
  it("shows what was spent of the budget", () => {
    const { container } = renderRun(run({ budgetUsd: 20, spentUsd: 0.42 }));

    expect(container.querySelector("[data-slot=run-spent]")?.textContent).toBe(
      "$0.42 of $20.00 spent of the budget",
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "2",
    );
  });

  // #873-T42
  it.each([
    ["reported", COST_BASIS_COPY.reported],
    ["estimated", COST_BASIS_COPY.estimated],
    ["limit", COST_BASIS_COPY.limit],
    ["subscription", COST_BASIS_COPY.subscription],
  ] as const)(
    "names the basis %s of a step's cost and explains it for the run",
    (basis, copy) => {
      const { container } = renderRun(
        run({ steps: [step({ costBasis: basis, costUsd: 1 })] }),
      );

      const cost = container.querySelector("[data-slot=cost-basis]");
      expect(cost?.textContent).toBe(copy.label);
      expect(cost?.getAttribute("data-basis")).toBe(basis);
      const explained = container.querySelector("[data-slot=run-cost-bases]");
      expect(explained?.textContent).toContain(copy.explanation);
    },
  );

  // #856-T71
  it("says a subscription step is worth about its estimate, through a subscription, and not billed", () => {
    const { container } = renderRun(
      run({ steps: [step({ costBasis: "subscription", costUsd: 0.42 })] }),
    );

    const line = container.querySelector(
      "[data-slot=step-cost]",
    )?.parentElement;
    expect(line?.textContent).toContain("≈ $0.42 through a subscription");
    expect(line?.textContent).not.toContain("(");
    const explained = container.querySelector("[data-slot=run-cost-bases]");
    expect(explained?.textContent).toContain("not billed");
  });

  // #856-T71
  it("says a subscription step has no estimate when Claude Code gave none", () => {
    const { container } = renderRun(
      run({ steps: [step({ costBasis: "subscription", costUsd: 0 })] }),
    );

    const line = container.querySelector(
      "[data-slot=step-cost]",
    )?.parentElement;
    expect(line?.textContent).toContain("no estimate, through a subscription");
    expect(line?.textContent).not.toContain("≈");
  });

  // #856-T72
  it("falls back to a neutral label for a cost basis this page does not know", () => {
    const { container } = renderRun(
      run({
        steps: [
          step({
            // A value a newer version wrote and this one reads after a rollback.
            costBasis: "metered" as unknown as "reported",
            costUsd: 1,
          }),
        ],
      }),
    );

    expect(container.querySelector("[data-slot=cost-basis]")?.textContent).toBe(
      COST_BASIS_UNKNOWN_COPY.label,
    );
    expect(
      container.querySelector("[data-slot=run-cost-bases]")?.textContent,
    ).toContain(COST_BASIS_UNKNOWN_COPY.explanation);
    expect(container.textContent).toContain("$1.00");
  });

  // #873-T42
  it("shows no basis for a step that cost nothing", () => {
    const { container } = renderRun(
      run({
        steps: [
          step({
            kind: "action",
            jobId: null,
            profile: null,
            costUsd: null,
            costBasis: null,
            output: null,
          }),
        ],
      }),
    );

    expect(container.querySelector("[data-slot=cost-basis]")).toBeNull();
    expect(container.querySelector("[data-slot=run-cost-bases]")).toBeNull();
    expect(container.querySelector("[data-slot=step-cost]")).toBeNull();
  });
});

describe("a step that no runner took", () => {
  // #873-T42
  it("says the step never ran instead of explaining its zero cost as reported by the runner", () => {
    const { container } = renderRun(
      run({
        status: "failed",
        errorCode: "step_failed",
        finishedAt: "2026-11-05T10:05:00.000Z",
        spentUsd: 0,
        steps: [
          step({
            status: "failed",
            errorCode: "no_runner_available",
            errorMessage:
              "No runner of this workspace with the labels of the environment took the turn in time.",
            costUsd: 0,
            costBasis: "reported",
            output: null,
          }),
        ],
      }),
    );

    expect(container.querySelector("[data-slot=cost-basis]")?.textContent).toBe(
      COST_NOT_RUN_COPY.label,
    );
    expect(
      container
        .querySelector("[data-slot=cost-basis]")
        ?.getAttribute("data-basis"),
    ).toBe("not_run");
    // The explanation of "reported" is not given for it, nor is the basis listed for the run.
    expect(container.textContent).not.toContain(
      COST_BASIS_COPY.reported.explanation,
    );
    expect(container.querySelector("[data-slot=run-cost-bases]")).toBeNull();
  });
});

describe("the steps", () => {
  // #873-T43
  it("shows each step with its status and how long it took, in the order they ran", () => {
    const { container } = renderRun(
      run({
        steps: [
          step({ id: "plan" }),
          step({
            id: "build",
            position: 1,
            status: "running",
            finishedAt: null,
            costUsd: null,
            costBasis: null,
            output: null,
            jobId: null,
          }),
        ],
      }),
    );

    const rows = container.querySelectorAll("[data-slot=run-step]");
    expect([...rows].map((row) => row.getAttribute("data-step-id"))).toEqual([
      "plan",
      "build",
    ]);
    expect(rows[0]?.getAttribute("data-status")).toBe("succeeded");
    expect(
      rows[0]?.querySelector("[data-slot=step-duration]")?.textContent,
    ).toBe("2 min 05 s");
    expect(rows[1]?.getAttribute("data-status")).toBe("running");
    expect(rows[1]?.querySelector("[data-slot=step-duration]")).toBeNull();
  });

  // #873-T44
  it("links an agent step to its Implementer run, where the live view is", () => {
    renderRun(run());

    const link = screen.getByRole("link", { name: /agent's run/ });
    expect(link.getAttribute("href")).toBe(`/w/acme/runs/${JOB_ID}`);
  });

  it("has no link for an agent step that has no run yet", () => {
    renderRun(run({ steps: [step({ jobId: null, status: "running" })] }));

    expect(screen.queryByRole("link", { name: /agent's run/ })).toBeNull();
  });
});

describe("what an action returned", () => {
  const action = (output: unknown) =>
    step({
      id: "open-pr",
      kind: "action",
      jobId: null,
      profile: null,
      costUsd: null,
      costBasis: null,
      output,
    });

  // #873-T45
  it("links the pull request when it is in the run's repository on github.com, and shows number and existing", () => {
    const { container } = renderRun(
      run({
        status: "succeeded",
        steps: [
          action({
            url: "https://github.com/acme/widgets/pull/12",
            number: 12,
            existing: true,
          }),
        ],
      }),
    );

    const result = container.querySelector("[data-slot=step-action-result]");
    const link = within(result as HTMLElement).getByRole("link");
    expect(link.getAttribute("href")).toBe(
      "https://github.com/acme/widgets/pull/12",
    );
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(result?.textContent).toContain("Number: 12");
    expect(result?.textContent).toContain("already existed");
  });

  // #873-T45
  it.each([
    "javascript:alert(document.cookie)",
    "https://evil.example/acme/widgets/pull/12",
    "https://github.com/other/repo/pull/12",
    "https://github.com.evil.example/acme/widgets/pull/12",
  ])("shows the address %s as text and makes no link of it", (url) => {
    const { container } = renderRun(
      run({ steps: [action({ url, number: 12 })] }),
    );

    const result = container.querySelector("[data-slot=step-action-result]");
    expect(within(result as HTMLElement).queryByRole("link")).toBeNull();
    expect(result?.textContent).toContain(url);
  });
});

describe("what a failed GitHub action says", () => {
  const failedAction = (errorCode: string, errorMessage: string) =>
    step({
      id: "open-pr",
      kind: "action",
      jobId: null,
      profile: null,
      costUsd: null,
      costBasis: null,
      status: "failed",
      output: null,
      errorCode,
      errorMessage,
    });

  // #873-T49
  it("names the permission the App lacks, in words and not as the code", () => {
    const { container } = renderRun(
      run({
        status: "failed",
        errorCode: "step_failed",
        steps: [
          failedAction(
            "github_permission_missing",
            'The GitHub App of this workspace may not open pull requests: it needs the permission "Pull requests: Read and write". The owner has to grant it.',
          ),
        ],
      }),
    );

    const failure = container.querySelector("[data-slot=step-failure]");
    expect(failure?.textContent).toContain('"Pull requests: Read and write"');
    expect(container.textContent).not.toContain("github_permission_missing");
  });

  // #873-T49
  it("tells the rate limit and an action that may have happened", () => {
    const limited = renderRun(
      run({
        steps: [
          failedAction(
            "github_rate_limited",
            "GitHub's rate limit was reached. The action was not repeated.",
          ),
        ],
      }),
    );
    expect(
      limited.container.querySelector("[data-slot=step-failure]")?.textContent,
    ).toContain("rate limit was reached");
    expect(limited.container.textContent).not.toContain("github_rate_limited");
    limited.unmount();

    const lost = renderRun(
      run({
        steps: [
          failedAction(
            "github_unavailable",
            "GitHub could not be reached or did not answer in time. The action may have happened; check GitHub before starting again.",
          ),
        ],
      }),
    );
    expect(
      lost.container.querySelector("[data-slot=step-failure]")?.textContent,
    ).toContain("may have happened");
    expect(lost.container.textContent).not.toContain("github_unavailable");
  });
});

describe("rounds, conditions and skipped steps (#846)", () => {
  const rounds = (): RunView =>
    run({
      status: "succeeded",
      finishedAt: "2026-11-05T10:20:00.000Z",
      steps: [
        step({ id: "implement", position: 0, round: 1 }),
        step({ id: "review", position: 1, round: 1 }),
        step({ id: "implement", position: 2, round: 2 }),
        step({ id: "review", position: 3, round: 2 }),
        step({
          id: "fix",
          position: 4,
          kind: "loop",
          status: "succeeded",
          profile: null,
          jobId: null,
          turnId: null,
          costUsd: null,
          costBasis: null,
          output: { exit: "until", rounds: 2 },
        }),
        step({
          id: "done",
          position: 5,
          kind: "if",
          profile: null,
          jobId: null,
          turnId: null,
          costUsd: null,
          costBasis: null,
          output: { taken: "then" },
        }),
        step({
          id: "stuck",
          position: 6,
          kind: "action",
          status: "skipped",
          profile: null,
          jobId: null,
          turnId: null,
          costUsd: null,
          costBasis: null,
          output: null,
          startedAt: null,
          finishedAt: "2026-11-05T10:19:00.000Z",
        }),
      ],
    });

  // #846-T80
  it("lists every round of a step on its own, and tells the round of a step that ran more than once", () => {
    const { container } = renderRun(rounds());

    const listed = [...container.querySelectorAll("[data-slot=run-step]")];
    expect(listed.map((item) => item.getAttribute("data-step-id"))).toEqual([
      "implement",
      "review",
      "implement",
      "review",
      "fix",
      "done",
      "stuck",
    ]);
    expect(listed[0]?.textContent).toContain("round 1");
    expect(listed[2]?.textContent).toContain("round 2");
    // A step that ran once says nothing about rounds.
    expect(listed[5]?.textContent).not.toContain("round");
    expect(listed[6]?.textContent).not.toContain("round");
  });

  // #846-T81
  it("tells in words how a loop ended and which branch a condition took", () => {
    const { container } = renderRun(rounds());

    const results = [
      ...container.querySelectorAll("[data-slot=step-control-result]"),
    ].map((node) => node.textContent);
    expect(results[0]).toContain("The loop ended because its condition held");
    expect(results[0]).toContain("Rounds: 2");
    expect(results[1]).toContain("The condition held");
    expect(container.textContent).not.toContain("maxRounds");
  });

  // #846-T82
  it("shows a step in a branch that was not taken as skipped", () => {
    const { container } = renderRun(rounds());

    const skipped = container.querySelector(
      "[data-slot=run-step][data-step-id=stuck]",
    );
    expect(skipped?.getAttribute("data-status")).toBe("skipped");
    expect(within(skipped as HTMLElement).getByText("Skipped")).toBeTruthy();
  });

  // #846-T83
  it("tells a run that ended on a condition it could not evaluate in words", () => {
    const { container } = renderRun(
      run({
        status: "failed",
        errorCode: "condition_failed",
        finishedAt: "2026-11-05T10:05:00.000Z",
      }),
    );

    expect(
      container.querySelector("[data-slot=run-failure]")?.textContent,
    ).toContain("condition of the workflow could not be evaluated");
    expect(container.textContent).not.toContain("condition_failed");
  });
});

describe("values that come from outside", () => {
  // #873-T46
  it("renders what an agent returned as text, never as markup", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = renderRun(
      run({
        steps: [
          step({
            id: '<b id="hostile">plan</b>',
            output: {
              summary: hostile,
              costUsd: 0.1,
              branch: "workflow/run-1/<i>x</i>",
            },
            errorMessage: hostile,
            status: "failed",
            errorCode: "action_failed",
          }),
        ],
      }),
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("#hostile")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // The values are in the page as text.
    expect(container.textContent).toContain(hostile);
    expect(container.textContent).toContain('<b id="hostile">plan</b>');
  });
});

describe("while the run runs", () => {
  // #873-T47
  it("asks for newer data, shows it, and stops asking once the run has ended", async () => {
    const api = apiAnswering([
      ok(run({ spentUsd: 1.5 })),
      ok(
        run({
          status: "succeeded",
          spentUsd: 2,
          finishedAt: "2026-11-05T10:09:00.000Z",
        }),
      ),
    ]);
    const { container } = renderRun(run(), api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(api.run).toHaveBeenCalledTimes(1);
    expect(api.run).toHaveBeenCalledWith("wf-1", "run-1");
    expect(
      container.querySelector("[data-slot=run-spent]")?.textContent,
    ).toContain("$1.50");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.getAllByText("Succeeded")).toHaveLength(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 5);
    });
    expect(api.run).toHaveBeenCalledTimes(2);
  });

  // #873-T47
  it("does not ask at all for a run that has already ended", async () => {
    const api = apiAnswering([]);
    renderRun(
      run({ status: "succeeded", finishedAt: "2026-11-05T10:09:00.000Z" }),
      api,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 5);
    });
    expect(api.run).not.toHaveBeenCalled();
  });

  // #873-T48
  it("keeps the last data and says so when an update fails, and goes on asking", async () => {
    const api = apiAnswering([
      failure("NETWORK_ERROR"),
      ok(run({ spentUsd: 3 })),
    ]);
    const { container } = renderRun(run(), api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(
      screen.getByRole("status", { name: "Updating the run" }).textContent,
    ).toBe(RUN_POLL_FAILED_TEXT);
    expect(
      container.querySelector("[data-slot=run-spent]")?.textContent,
    ).toContain("$0.42");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 2);
    });
    expect(
      container.querySelector("[data-slot=run-spent]")?.textContent,
    ).toContain("$3.00");
  });

  // #873-T48
  it("stops for good, and says so, when the run is gone", async () => {
    const api = apiAnswering([failure("WORKFLOW_RUN_NOT_FOUND")]);
    renderRun(run(), api);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(
      screen.getByRole("status", { name: "Updating the run" }).textContent,
    ).toContain("no longer exists");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS * 10);
    });
    expect(api.run).toHaveBeenCalledTimes(1);
  });
});

describe("stopping a run", () => {
  const cancelling = (
    answers: RequestResult<{ run: RunView; outcome: string }>[],
  ) => {
    const cancel = vi.fn(
      async () =>
        answers.shift() ??
        ({
          ok: false,
          status: 500,
          code: "UNEXPECTED_RESPONSE",
          issues: [],
        } as RequestResult<{ run: RunView; outcome: string }>),
    );
    return {
      run: vi.fn(async () => failure("UNEXPECTED_RESPONSE")),
      cancel,
    } as unknown as WorkflowRunsApi & { cancel: typeof cancel };
  };

  // #891-T60
  it("offers to cancel a run that runs, asks the route and says the run is stopping", async () => {
    const api = cancelling([
      {
        ok: true,
        data: {
          run: run({ cancelRequestedAt: "2026-11-05T10:03:00.000Z" }),
          outcome: "requested",
        },
      },
    ]);
    const { container } = renderRun(run(), api);

    const button = screen.getByRole("button", { name: "Cancel run" });
    await act(async () => {
      button.click();
    });

    expect(api.cancel).toHaveBeenCalledWith("wf-1", "run-1");
    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(
      container.querySelector("[data-slot=run-cancel-requested]")?.textContent,
    ).toContain("stopping");
  });

  // #891-T60
  it("shows a run that is already stopping as stopping, without the button", () => {
    const { container } = renderRun(
      run({ cancelRequestedAt: "2026-11-05T10:03:00.000Z" }),
    );

    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(
      container.querySelector("[data-slot=run-cancel-requested]"),
    ).not.toBeNull();
  });

  // #891-T61
  it("has no button for a run that has ended, and shows a cancelled run in words", () => {
    const { container } = renderRun(
      run({
        status: "cancelled",
        cancelRequestedAt: "2026-11-05T10:03:00.000Z",
        finishedAt: "2026-11-05T10:04:00.000Z",
        steps: [
          step({
            status: "failed",
            errorCode: "cancelled",
            output: null,
            finishedAt: "2026-11-05T10:04:00.000Z",
          }),
        ],
      }),
    );

    expect(screen.queryByRole("button", { name: "Cancel run" })).toBeNull();
    expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
    expect(container.querySelector("[data-slot=run-failure]")).toBeNull();
    expect(
      container.querySelector("[data-slot=step-failure]")?.textContent,
    ).toContain("stopped the run");
    expect(container.textContent).not.toContain("cancelled");
  });

  // #891-T62
  it("says why when the stop could not be asked for, and keeps the button", async () => {
    const api = cancelling([
      { ok: false, status: 404, code: "WORKFLOW_RUN_NOT_FOUND", issues: [] },
    ]);
    const { container } = renderRun(run(), api);

    await act(async () => {
      screen.getByRole("button", { name: "Cancel run" }).click();
    });

    expect(
      container.querySelector("[data-slot=run-cancel-failure]")?.textContent,
    ).toContain("no longer exists");
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });
});

describe("a question of the agent (#920)", () => {
  const ASK = {
    n: 1,
    state: "open" as const,
    question: "Retry which failures? <b>now</b>",
    options: ["Network errors", "Network errors and 5xx answers"],
    context: "client.ts tells the two apart.",
  };
  const waiting = (ask: NonNullable<StepView["ask"]> = ASK) =>
    run({
      status: "waiting",
      steps: [
        step({
          status: "waiting",
          finishedAt: null,
          costUsd: 0.5,
          ask,
        }),
      ],
    });
  const answering = (answers: RequestResult<{ run: RunView }>[]) => {
    const answer = vi.fn(
      async () => answers.shift() ?? failure("UNEXPECTED_RESPONSE"),
    );
    return {
      run: vi.fn(async () => ok(waiting())),
      answer,
    } as unknown as WorkflowRunsApi & { answer: typeof answer };
  };

  // #920-T150
  it("shows a waiting run in words, the question as text with its numbered options and context, and keeps polling", async () => {
    const api = answering([]);
    const { container } = renderRun(waiting(), api);

    expect(
      screen.getByText("Waiting for an answer", {
        selector: "[data-status=waiting] *",
      }),
    ).toBeTruthy();
    const block = container.querySelector("[data-slot=step-ask]");
    expect(
      block?.querySelector("[data-slot=step-ask-question]")?.textContent,
    ).toBe("Retry which failures? <b>now</b>");
    // The question is the agent's text: markup in it is text, never an element.
    expect(block?.querySelector("b")).toBeNull();
    expect(
      [...container.querySelectorAll("[data-slot=step-ask-option]")].map(
        (li) => li.textContent,
      ),
    ).toEqual([
      "Network errorsAnswer 1",
      "Network errors and 5xx answersAnswer 2",
    ]);
    expect(block?.textContent).toContain("client.ts tells the two apart.");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });
    expect(api.run).toHaveBeenCalled();
  });

  // #920-T151
  it("sends the option with the note, and says the answer was sent", async () => {
    const api = answering([{ ok: true, data: { run: run() } }]);
    const { container } = renderRun(waiting(), api);
    const note = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(note, "and log it");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      screen.getByRole("button", { name: "Answer 2" }).click();
    });

    expect(api.answer).toHaveBeenCalledWith("wf-1", "run-1", {
      choice: 2,
      text: "and log it",
    });
    expect(container.querySelector("[data-slot=step-ask-sent]")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Answer 2" })).toBeNull();
  });

  // #920-T152
  it("sends a text of its own when it is not empty, and not before", async () => {
    const api = answering([{ ok: true, data: { run: run() } }]);
    renderRun(
      waiting({ n: 1, state: "open", question: "Which backoff?" }),
      api,
    );
    const send = screen.getByRole("button", { name: "Send answer" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    const note = screen.getByRole("textbox") as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(note, "Exponential.");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      screen.getByRole("button", { name: "Send answer" }).click();
    });

    expect(api.answer).toHaveBeenCalledWith("wf-1", "run-1", {
      text: "Exponential.",
    });
  });

  // #920-T153
  it("tells a refusal in words and keeps the form", async () => {
    const api = answering([
      {
        ok: false,
        status: 409,
        code: "WORKFLOW_RUN_NOT_WAITING",
        issues: [],
      },
    ]);
    const { container } = renderRun(waiting(), api);

    await act(async () => {
      screen.getByRole("button", { name: "Answer 1" }).click();
    });

    expect(
      container.querySelector("[data-slot=step-ask-failure]")?.textContent,
    ).toContain("does not wait for an answer any more");
    expect(screen.getByRole("button", { name: "Answer 1" })).toBeTruthy();
  });

  // #920-T154
  it("shows who answered what and from where once it is answered, without a form", () => {
    const { container } = renderRun(
      run({
        steps: [
          step({
            status: "running",
            ask: {
              ...ASK,
              state: "resumed",
              answer: {
                text: "Network errors and 5xx answers",
                choice: 2,
                by: "octocat",
                via: "comment",
                at: "2026-11-07T10:00:00.000Z",
              },
            },
          }),
        ],
      }),
    );

    expect(
      container.querySelector("[data-slot=step-ask-answer]")?.textContent,
    ).toBe(
      "Answered by octocat (in a comment): Network errors and 5xx answers",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Answer/ })).toBeNull();
  });

  // #920-T98
  it("shows the next question of the step as a new one to answer, not as sent", async () => {
    const second = { ...ASK, n: 2, question: "And the backoff?" };
    const api = {
      run: vi.fn(async () => ok(waiting(second))),
      answer: vi.fn(async () => ({ ok: true, data: { run: run() } })),
    } as unknown as WorkflowRunsApi;
    const { container } = renderRun(waiting(), api);
    await act(async () => {
      screen.getByRole("button", { name: "Answer 1" }).click();
    });
    expect(container.querySelector("[data-slot=step-ask-sent]")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_POLL_MS);
    });

    expect(container.querySelector("[data-slot=step-ask-sent]")).toBeNull();
    expect(
      container.querySelector("[data-slot=step-ask-question]")?.textContent,
    ).toBe("And the backoff?");
    expect(screen.getByRole("button", { name: "Answer 2" })).toBeTruthy();
  });

  // #920-T155
  it("has the button to cancel a run that waits", () => {
    renderRun(waiting());

    expect(screen.getByRole("button", { name: "Cancel run" })).toBeTruthy();
  });
});
