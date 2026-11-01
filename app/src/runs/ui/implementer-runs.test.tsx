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
    expect(
      screen
        .getByRole("link", { name: "implementer/abc123" })
        .getAttribute("href"),
    ).toBe("https://github.com/acme/widgets/tree/implementer/abc123");
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
