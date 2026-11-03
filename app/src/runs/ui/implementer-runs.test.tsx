// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The Runs pages for a run of the Implementer (#758): the list row names the repository and the branch and has no pull request;
// the detail page shows the facts of the task, the instruction (cut, with the whole text one click away), the commits, the files
// and the summary of the agent, all as text, and says what a failed task pushed. Runs of the other kinds look as they did.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CustomerRunDetailView,
  ImplementerDetailView,
  RunRowView,
} from "../run-view.ts";
import type { RunsApi } from "./api.ts";
import { RunDetail } from "./run-detail.tsx";
import { RunsList } from "./runs-list.tsx";

afterEach(cleanup);

const api = { list: vi.fn(), detail: vi.fn() } as unknown as RunsApi;
const NONE_DROPPED = { invalid: 0, overflow: 0 };
const SHA = "b".repeat(40);

function row(overrides: Partial<RunRowView> = {}): RunRowView {
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
    status: "succeeded",
    createdAt: "2026-10-10T12:00:00.000Z",
    startedAt: "2026-10-10T12:00:10.000Z",
    finishedAt: "2026-10-10T12:01:00.000Z",
    durationMs: 50_000,
    problem: null,
    implementer: {
      branch: "implementer/abc123",
      branchUrl: "https://github.com/acme/widgets/tree/implementer/abc123",
    },
    ...overrides,
  };
}

function task(
  overrides: Partial<ImplementerDetailView> = {},
): ImplementerDetailView {
  return {
    branch: "implementer/abc123",
    branchUrl: "https://github.com/acme/widgets/tree/implementer/abc123",
    baseBranch: "main",
    instruction: { preview: "Add a health endpoint.", full: null },
    summary: "Added a health endpoint.",
    environment: null,
    commits: {
      shown: [
        {
          shortSha: SHA.slice(0, 7),
          subject: "Add a health endpoint",
          url: `https://github.com/acme/widgets/commit/${SHA}`,
        },
      ],
      more: 0,
    },
    files: {
      count: 1,
      shown: [{ path: "src/health.ts", status: "added" }],
      more: 0,
    },
    branches: {
      shown: [
        {
          name: "implementer/abc123",
          url: "https://github.com/acme/widgets/tree/implementer/abc123",
          shortSha: SHA.slice(0, 7),
          pushed: true,
          reason: null,
          isTaskBranch: true,
        },
      ],
      more: 0,
      dropped: NONE_DROPPED,
    },
    head: {
      shortSha: SHA.slice(0, 7),
      url: `https://github.com/acme/widgets/commit/${SHA}`,
    },
    pushedNote: null,
    reported: true,
    ...overrides,
  };
}

function detail(
  overrides: Partial<CustomerRunDetailView> = {},
): CustomerRunDetailView {
  return {
    ...row(),
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

const snap = (run: CustomerRunDetailView) => ({
  generatedAt: "2026-10-10T12:10:00.000Z",
  run,
});

const renderDetail = (run: CustomerRunDetailView) =>
  render(<RunDetail workspaceSlug="acme" initial={snap(run)} api={api} />);

describe("the list row of an implementer run", () => {
  // #758-T01
  it("shows the repository, the branch as a link, an Implementer badge and no pull request number or link", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={{
          generatedAt: "2026-10-10T12:10:00.000Z",
          runs: [row()],
          limited: false,
        }}
        filter={{}}
        api={api}
      />,
    );

    const cells = within(
      within(screen.getByRole("table", { name: "Runs" })).getAllByRole(
        "row",
      )[1] as HTMLElement,
    );
    expect(cells.getByText("acme/widgets")).toBeTruthy();
    expect(
      cells
        .getByRole("link", { name: "implementer/abc123" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/tree/implementer/abc123");
    expect(cells.getByText("Implementer")).toBeTruthy();
    expect(cells.queryByText("#-1")).toBeNull();
    expect(cells.queryByText("/review")).toBeNull();
    expect(
      cells.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).not.toContain(null);
    // The name of the row's link tells the runs of one repository apart by the branch.
    expect(
      cells.getByRole("link", { name: "acme/widgets implementer/abc123" }),
    ).toBeTruthy();
  });

  // #758-T01
  it("shows the branch as plain text when there is no link for it", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={{
          generatedAt: "2026-10-10T12:10:00.000Z",
          runs: [
            row({
              implementer: { branch: "<b>x</b>", branchUrl: null },
            }),
          ],
          limited: false,
        }}
        filter={{}}
        api={api}
      />,
    );

    expect(screen.getByText("<b>x</b>").closest("a")).toBeNull();
  });

  // #758-T09
  it("leaves a Diff row as it was: the pull request number and the command", () => {
    render(
      <RunsList
        workspaceSlug="acme"
        initial={{
          generatedAt: "2026-10-10T12:10:00.000Z",
          runs: [
            row({
              reviewKind: "diff",
              prNumber: 7,
              prUrl: "https://github.com/acme/widgets/pull/7",
              triggerKind: "webhook",
              trigger: "Automatic",
              implementer: undefined,
            }),
          ],
          limited: false,
        }}
        filter={{}}
        api={api}
      />,
    );

    expect(screen.getByText("#7")).toBeTruthy();
    expect(screen.getByText("/review")).toBeTruthy();
    expect(screen.queryByText("Implementer")).toBeNull();
  });
});

describe("the detail page of an implementer run", () => {
  // #758-T02
  it("shows the repository, the base branch, the branch link, the kind, the duration, the commits, the files and the summary — and no pull request", () => {
    const { container } = renderDetail(detail());
    const text = container.textContent;

    expect(text).toContain("acme/widgets");
    expect(text).toContain("Base branch");
    expect(text).toContain("main");
    // The facts and the list of branches both link to the task's branch.
    expect(
      screen
        .getAllByRole("link", { name: "implementer/abc123" })
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      "https://github.com/acme/widgets/tree/implementer/abc123",
      "https://github.com/acme/widgets/tree/implementer/abc123",
    ]);
    expect(text).toContain("Implementer");
    expect(text).not.toContain("Pull request");
    expect(text).not.toContain("#-1");
    expect(text).not.toContain("/review");
    expect(text).toContain("Add a health endpoint.");
    // The commit in the list and the pushed head in the facts: both link to the commit.
    expect(
      screen
        .getAllByRole("link", { name: SHA.slice(0, 7) })
        .map((link) => link.getAttribute("href")),
    ).toEqual([
      `https://github.com/acme/widgets/commit/${SHA}`,
      `https://github.com/acme/widgets/commit/${SHA}`,
    ]);
    expect(text).toContain("src/health.ts");
    expect(text).toContain("Added a health endpoint.");
    expect(screen.queryByText(/Findings/)).toBeNull();
  });

  // The git model: the runner pushes all local branches, and the page shows every one with a link or a reason.
  it("lists every branch of the task: a pushed one with a link, a rejected one with the sentence for its reason", () => {
    const { container } = renderDetail(
      detail({
        implementer: task({
          branches: {
            shown: [
              {
                name: "implementer/abc123",
                url: "https://github.com/acme/widgets/tree/implementer/abc123",
                shortSha: SHA.slice(0, 7),
                pushed: true,
                reason: null,
                isTaskBranch: true,
              },
              {
                name: "experiment/two",
                url: "https://github.com/acme/widgets/tree/experiment/two",
                shortSha: "ccccccc",
                pushed: true,
                reason: null,
                isTaskBranch: false,
              },
              {
                name: "main",
                url: null,
                shortSha: "ddddddd",
                pushed: false,
                reason:
                  "The branch already exists on GitHub with other history. The Implementer never overwrites a branch.",
                isTaskBranch: false,
              },
            ],
            more: 0,
            dropped: NONE_DROPPED,
          },
        }),
      }),
    );

    const list = container.querySelector('[data-slot="run-branches"]');
    expect(list?.querySelectorAll("li")).toHaveLength(3);
    expect(
      screen.getByRole("link", { name: "experiment/two" }).getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/tree/experiment/two");
    const rejected = container.querySelector('[data-branch-result="rejected"]');
    expect(rejected?.textContent).toContain("main");
    expect(rejected?.textContent).toContain("not pushed");
    expect(rejected?.textContent).toContain("never overwrites a branch");
    expect(rejected?.querySelector("a")).toBeNull();
    expect(list?.textContent).toContain("the task's branch");
  });

  it("shows no list of branches for a task that pushed none", () => {
    const { container } = renderDetail(
      detail({
        implementer: task({
          branches: { shown: [], more: 0, dropped: NONE_DROPPED },
          head: null,
        }),
      }),
    );

    expect(container.querySelector('[data-slot="run-branches"]')).toBeNull();
    expect(screen.queryByText("Branches")).toBeNull();
  });

  it("says how many branches were left out, because of their name and because of the limit, even when none was pushed", () => {
    const { container } = renderDetail(
      detail({
        implementer: task({
          branches: {
            shown: [],
            more: 0,
            dropped: { invalid: 2, overflow: 1 },
          },
          head: null,
        }),
      }),
    );

    expect(screen.getByText("Branches")).toBeTruthy();
    expect(
      container.querySelector('[data-slot="run-branches-invalid"]')
        ?.textContent,
    ).toBe("2 branches were not pushed because their names cannot be pushed.");
    expect(
      container.querySelector('[data-slot="run-branches-overflow"]')
        ?.textContent,
    ).toBe(
      "1 further branch was not pushed because only 50 branches are pushed.",
    );
  });

  it("says nothing about left-out branches when there are none", () => {
    const { container } = renderDetail(detail({ implementer: task({}) }));

    expect(
      container.querySelector('[data-slot="run-branches-invalid"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-slot="run-branches-overflow"]'),
    ).toBeNull();
  });

  it("renders a hostile branch name as text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { container } = renderDetail(
      detail({
        implementer: task({
          branches: {
            shown: [
              {
                name: hostile,
                url: null,
                shortSha: null,
                pushed: false,
                reason: "The branch was not pushed.",
                isTaskBranch: false,
              },
            ],
            more: 0,
            dropped: NONE_DROPPED,
          },
        }),
      }),
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain(hostile);
  });

  // #758-T02
  it("says 'and N more' for commits and files beyond the first 20", () => {
    const { container } = renderDetail(
      detail({
        implementer: task({
          commits: { shown: task().commits.shown, more: 7 },
          files: { count: 25, shown: task().files.shown, more: 24 },
        }),
      }),
    );

    expect(container.textContent).toContain("and 7 more");
    expect(container.textContent).toContain("and 24 more");
    expect(container.textContent).toContain("25 files");
  });

  // #758-T02
  it("shows a cut instruction with the whole text behind an expander", () => {
    const full = `${"Refactor. ".repeat(80)}END`;
    const { container } = renderDetail(
      detail({
        implementer: task({
          instruction: { preview: full.slice(0, 500), full },
        }),
      }),
    );

    const expander = container.querySelector("details");
    expect(expander).not.toBeNull();
    expect(expander?.textContent).toContain("END");
    expect(expander?.querySelector("summary")?.textContent).toMatch(
      /Show the whole instruction/,
    );
    expect(
      container.querySelector('[data-slot="run-instruction"]')?.textContent,
    ).toBe(full.slice(0, 500));
  });

  // #758-T03
  it("shows the pushed-work sentence next to the error sentence of a failed task, with the pushed head linked", () => {
    const { container } = renderDetail(
      detail({
        status: "failed",
        problem: "The task stopped at its cost limit.",
        errorCode: "cost_limit_reached",
        errorCodeKnown: true,
        implementer: task({
          pushedNote: "1 commit was pushed to implementer/abc123.",
        }),
      }),
    );

    expect(container.textContent).toContain(
      "The task stopped at its cost limit.",
    );
    expect(container.textContent).toContain(
      "1 commit was pushed to implementer/abc123.",
    );
    expect(
      screen
        .getAllByRole("link", { name: SHA.slice(0, 7) })
        .map((link) => link.getAttribute("href")),
    ).toContain(`https://github.com/acme/widgets/commit/${SHA}`);
  });

  // #758-T03
  it("shows only the error sentence of a failed task that pushed nothing", () => {
    const { container } = renderDetail(
      detail({
        status: "failed",
        problem: "The agent stopped without a result.",
        errorCode: "agent_gave_up",
        implementer: task({
          commits: { shown: [], more: 0 },
          files: { count: 0, shown: [], more: 0 },
          head: null,
          summary: null,
        }),
      }),
    );

    expect(container.textContent).toContain(
      "The agent stopped without a result.",
    );
    expect(container.textContent).not.toMatch(/were pushed|was pushed/);
  });

  // #758-T04
  it("renders hostile text as text: no element, no link and no image from the instruction, the summary or the subjects", () => {
    const hostile =
      '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a> [click](javascript:alert(1))';
    const { container } = renderDetail(
      detail({
        implementer: task({
          instruction: { preview: hostile, full: null },
          summary: hostile,
          commits: {
            shown: [{ shortSha: "bbbbbbb", subject: hostile, url: null }],
            more: 0,
          },
          files: {
            count: 1,
            shown: [{ path: hostile, status: "added" }],
            more: 0,
          },
        }),
      }),
    );

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelectorAll('a[href^="javascript"]')).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-slot="run-detail"] a[href*="alert"]'),
    ).toHaveLength(0);
    expect(container.textContent).toContain(hostile);
  });

  // #758-T02
  it("shows a task that has no result yet without failing", () => {
    const { container } = renderDetail(
      detail({
        status: "running",
        finishedAt: null,
        implementer: task({
          summary: null,
          commits: { shown: [], more: 0 },
          files: { count: 0, shown: [], more: 0 },
          head: null,
        }),
      }),
    );

    expect(container.querySelector('[data-slot="run-detail"]')).not.toBeNull();
  });

  // #758-T02 (review of #792, 1)
  it("says that the result was not reported, and points at the branch, instead of 'No commits were made' when the task has no block", () => {
    const { container } = renderDetail(
      detail({
        status: "failed",
        problem: "The worker no longer held this task.",
        errorCode: "lease_lost",
        implementer: task({
          reported: false,
          summary: null,
          commits: { shown: [], more: 0 },
          files: { count: 0, shown: [], more: 0 },
          head: null,
        }),
      }),
    );
    const text = container.textContent;

    expect(text).toContain("The result of this task was not reported");
    expect(text).not.toContain("No commits were made.");
    expect(text).not.toContain("No files changed.");
    expect(text).not.toContain("The agent left no summary.");
    const links = screen
      .getAllByRole("link", { name: /implementer\/abc123/ })
      .map((link) => link.getAttribute("href"));
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(new Set(links)).toEqual(
      new Set(["https://github.com/acme/widgets/tree/implementer/abc123"]),
    );
  });

  // #758-T02
  it("still says 'No commits were made' when the agent reported a result with none", () => {
    const { container } = renderDetail(
      detail({
        implementer: task({
          summary: null,
          commits: { shown: [], more: 0 },
          files: { count: 0, shown: [], more: 0 },
          head: null,
        }),
      }),
    );

    expect(container.textContent).toContain("No commits were made.");
    expect(container.textContent).not.toContain("was not reported");
  });

  // #758-T09
  it("leaves the detail of a Diff run as it was: pull request, command and Findings", () => {
    const { container } = renderDetail(
      detail({
        reviewKind: "diff",
        prNumber: 7,
        prUrl: "https://github.com/acme/widgets/pull/7",
        command: "review",
        implementer: undefined,
      }),
    );

    expect(container.textContent).toContain("Pull request");
    expect(container.textContent).toContain("/review");
    expect(container.textContent).not.toContain("Base branch");
  });
});

// #818: which environment and size a task used, and the output of a setup script that failed.
describe("the environment on the detail page of an implementer run (#818)", () => {
  const environment = (
    overrides: Partial<NonNullable<ImplementerDetailView["environment"]>> = {},
  ): NonNullable<ImplementerDetailView["environment"]> => ({
    name: "Node 22",
    vcpus: 6,
    memoryGb: 12,
    setup: null,
    network: { mode: "off", hosts: [], report: null },
    ...overrides,
  });

  // #818-T30
  it("names the environment and its size among the facts of the run", () => {
    renderDetail(detail({ implementer: task({ environment: environment() }) }));

    const term = screen.getByText("Environment");
    const description = term.nextElementSibling;
    expect(description?.textContent).toContain("Node 22");
    expect(description?.textContent).toContain("6 vCPU, 12 GB");
  });

  // #818-T30
  it("shows no environment line for a task that started without one", () => {
    renderDetail(detail());

    expect(screen.queryByText("Environment")).toBeNull();
  });

  // #818-T30
  it("shows the end of the output of a failed script, with its exit status and time, as text", () => {
    renderDetail(
      detail({
        status: "failed",
        errorCode: "environment_setup_failed",
        errorCodeKnown: true,
        implementer: task({
          reported: true,
          environment: environment({
            setup: {
              outcome: "failed",
              exitCode: 1,
              durationSeconds: 42,
              output: "ERR_PNPM_OUTDATED_LOCKFILE <b>not bold</b>",
            },
          }),
        }),
      }),
    );

    const section = screen
      .getByRole("heading", { name: "Setup script" })
      .closest("[role=region]") as HTMLElement;
    expect(section.textContent).toContain("exit status 1");
    expect(section.textContent).toContain("42 s");
    const output = section.querySelector("[data-slot=run-setup-output]");
    expect(output?.textContent).toBe(
      "ERR_PNPM_OUTDATED_LOCKFILE <b>not bold</b>",
    );
    expect(output?.querySelector("b")).toBeNull();
  });

  // #818-T30
  it("says a script that ran out of time ran out of time, and one that worked worked", () => {
    const timedOut = renderDetail(
      detail({
        status: "failed",
        implementer: task({
          environment: environment({
            setup: {
              outcome: "timed_out",
              exitCode: null,
              durationSeconds: 900,
              output: "",
            },
          }),
        }),
      }),
    );
    expect(timedOut.container.textContent).toContain("ran out of time");
    cleanup();

    const fine = renderDetail(
      detail({
        implementer: task({
          environment: environment({
            setup: {
              outcome: "ok",
              exitCode: 0,
              durationSeconds: 12,
              output: "",
            },
          }),
        }),
      }),
    );
    expect(fine.container.textContent).toContain("finished");
    expect(fine.container.textContent).not.toContain("ran out of time");
  });

  // #818-T30b
  it("says a script that exited 0 but whose result could not be kept finished, and shows why from the end of the output", () => {
    renderDetail(
      detail({
        status: "failed",
        errorCode: "environment_setup_failed",
        errorCodeKnown: true,
        implementer: task({
          reported: true,
          environment: environment({
            setup: {
              outcome: "failed",
              exitCode: 0,
              durationSeconds: 31,
              output:
                "installing\n[setup] the VM had no room to save the setup result: the VM's disk has 100 MB left and the result of the script needs about 1280 MB",
            },
          }),
        }),
      }),
    );

    const section = screen
      .getByRole("heading", { name: "Setup script" })
      .closest("[role=region]") as HTMLElement;
    expect(section.textContent).toContain(
      "The script finished, but its result could not be kept after 31 s",
    );
    expect(section.textContent).not.toContain("failed with exit status");
    expect(
      section.querySelector("[data-slot=run-setup-output]")?.textContent,
    ).toContain("[setup] the VM had no room to save the setup result");
  });

  // #818-T30
  it("shows an empty output as such instead of an empty box", () => {
    renderDetail(
      detail({
        status: "failed",
        implementer: task({
          environment: environment({
            setup: {
              outcome: "failed",
              exitCode: 2,
              durationSeconds: 1,
              output: "",
            },
          }),
        }),
      }),
    );

    expect(screen.getByText("The script wrote no output.")).toBeTruthy();
  });
});

// #745, step 7: what the page says of the network of a task.
describe("the network on the detail page of an implementer run (#745)", () => {
  const withReport = (
    overrides: Partial<
      NonNullable<ImplementerDetailView["environment"]>["network"]
    > = {},
  ): NonNullable<ImplementerDetailView["environment"]> => ({
    name: "Node 22",
    vcpus: 4,
    memoryGb: 5.7,
    setup: null,
    network: {
      mode: "list",
      hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
      report: {
        vmPolicy: "narrowed",
        allowed: 3,
        refused: 1,
        bytesIn: 4096,
        bytesOut: 512,
        dropped: 0,
        connections: [
          {
            host: "example.com <b>x</b>",
            port: 443,
            outcome: "refused",
            reason: "not_listed",
            count: 1,
            bytesIn: 0,
            bytesOut: 0,
          },
          {
            host: "registry.npmjs.org",
            port: 443,
            outcome: "allowed",
            reason: null,
            count: 3,
            bytesIn: 4096,
            bytesOut: 512,
          },
        ],
      },
      ...overrides,
    },
  });

  // #745-T44
  it("shows the rule, the totals and each connection with its result, as text", () => {
    renderDetail(
      detail({
        implementer: task({ reported: true, environment: withReport() }),
      }),
    );

    const section = screen
      .getByRole("heading", { name: "Network" })
      .closest("[role=region]") as HTMLElement;
    expect(section.textContent).toContain(
      "Only the hosts of the environment's list.",
    );
    expect(section.textContent).toContain("registry.npmjs.org");
    expect(section.textContent).toContain("*.pythonhosted.org");
    expect(section.textContent).toContain("3 allowed, 1 refused");
    expect(section.textContent).toContain("4.0 KB received");
    expect(section.textContent).toContain("narrowed to GitHub");
    const table = section.querySelector("[data-slot=run-network-connections]");
    expect(table?.textContent).toContain("refused (not_listed)");
    expect(table?.textContent).toContain("example.com <b>x</b>");
    expect(table?.querySelector("b")).toBeNull();
  });

  // #745-T44
  it("says nothing about the network of a task whose rule was off and which reported none", () => {
    renderDetail(
      detail({
        implementer: task({
          reported: true,
          environment: withReport({ mode: "off", hosts: [], report: null }),
        }),
      }),
    );

    expect(screen.queryByRole("heading", { name: "Network" })).toBeNull();
  });

  // #745-T44
  it("says the runner reported nothing for a rule that was on", () => {
    renderDetail(
      detail({
        implementer: task({
          reported: true,
          environment: withReport({ mode: "open", hosts: [], report: null }),
        }),
      }),
    );

    expect(screen.getByText("Any public host.")).toBeTruthy();
    expect(
      screen.getByText("The runner reported no connections."),
    ).toBeTruthy();
  });
});
