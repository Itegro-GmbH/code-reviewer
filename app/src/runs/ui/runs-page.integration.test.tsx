// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// Pins down the Runs page and the page of one run with real data: runs made through the job queue in
// a real Postgres database, the filter from the address (the toolbar follows it without a remount key), and
// the not-found case. Rendering is the real component tree.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectsRepository } from "../../db/repositories/projects-repository.ts";
import { createProjectService } from "../../projects/service.ts";
import { createLastRunSource } from "../runs-service.ts";
import { createRunsFixture } from "../../test-support/runs.ts";
import { loadRunDetailPage, RunDetailPageContent } from "./run-detail-page.tsx";
import { loadRunsPage, RunsPageContent } from "./runs-page.tsx";
import { defaultWorkspaceId } from "../../test-support/workspaces.ts";
import { getProductIdentity } from "../../product-identity/current.ts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w/acme/runs",
}));

afterEach(cleanup);

async function openRuns() {
  const f = await createRunsFixture();
  const projects = createProjectService({
    projects: createProjectsRepository(f.db, await defaultWorkspaceId(f.db)),
  });
  await projects.activateProject(f.repositoryId);
  await projects.activateProject(f.otherRepositoryId);
  const gadgetsFailed = await f.finished({ ok: false, errorCode: "timeout" });
  const gadgetsDone = await f.finished({
    ok: true,
    result: { ok: true, commentUrl: null },
  });
  const widgetsFailed = await f.finished(
    { ok: false, errorCode: "llm_quota" },
    { repositoryId: f.otherRepositoryId },
  );
  const widgetsWaiting = await f.waiting({
    repositoryId: f.otherRepositoryId,
  });
  const lastRuns = createLastRunSource({ runs: f.runsRepository });
  async function page(
    searchParams: Record<string, string | string[] | undefined> = {},
  ) {
    const data = await loadRunsPage(searchParams, {
      runs: f.runs,
      projects,
      lastRuns,
    });
    return render(
      <RunsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={data}
      />,
    );
  }
  return {
    f,
    projects,
    page,
    gadgetsFailed,
    gadgetsDone,
    widgetsFailed,
    widgetsWaiting,
  };
}

/** The data rows of the runs table, without its header row. */
function rowTexts(): string[] {
  return within(screen.getByRole("table", { name: "Runs" }))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent ?? "");
}

async function optionLabels(name: string): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(name));
  const options = await screen.findAllByRole("option");
  const labels = options.map((option) => option.textContent ?? "");
  await user.keyboard("{Escape}");
  return labels;
}

describe("the Runs page", () => {
  // CR-35-T01
  it("lists the runs of both projects, the newest first", async () => {
    const app = await openRuns();

    await app.page();

    const rows = rowTexts();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("acme/widgets");
    expect(rows[0]).toContain(`#${String(app.widgetsWaiting.prNumber)}`);
    expect(rows[0]).toContain("Waiting");
    expect(rows[1]).toContain("acme/widgets");
    expect(rows[1]).toContain(`#${String(app.widgetsFailed.prNumber)}`);
    expect(rows[1]).toContain("Failed");
    expect(rows[2]).toContain("acme/gadgets");
    expect(rows[2]).toContain(`#${String(app.gadgetsDone.prNumber)}`);
    expect(rows[2]).toContain("Succeeded");
    expect(rows[3]).toContain("acme/gadgets");
    expect(rows[3]).toContain(`#${String(app.gadgetsFailed.prNumber)}`);
  });

  // CR-35-T02
  it("shows only the runs that match the project and then also the status from the address", async () => {
    const app = await openRuns();

    await app.page({ repository: app.f.repositoryId });
    expect(rowTexts()).toHaveLength(2);
    expect(rowTexts().every((row) => row.includes("acme/gadgets"))).toBe(true);
    cleanup();

    await app.page({ repository: app.f.repositoryId, status: "failed" });
    expect(rowTexts()).toHaveLength(1);
    expect(rowTexts()[0]).toContain("acme/gadgets");
    expect(rowTexts()[0]).toContain("Failed");
  });

  it("offers the projects and statuses in the filter and shows the chosen ones", async () => {
    const app = await openRuns();

    await app.page({ repository: app.f.otherRepositoryId, status: "failed" });

    expect(screen.getByLabelText("Project").textContent).toContain(
      "acme/widgets",
    );
    expect(screen.getByLabelText("Status").textContent).toContain("Failed");
    expect(await optionLabels("Project")).toEqual([
      "All projects",
      "acme/gadgets",
      "acme/widgets",
    ]);
    expect(await optionLabels("Status")).toEqual([
      "All statuses",
      "Waiting",
      "Running",
      "Succeeded",
      "Failed",
      "Cancelled",
      "Superseded",
    ]);
    expect(
      screen.getByRole("link", { name: "Reset filter" }).getAttribute("href"),
    ).toBe("/w/acme/runs?view=agents");
  });

  // #175-T01
  it("moves the controls with the address when the filter is reset or the person goes back", async () => {
    const app = await openRuns();
    const data = (
      searchParams: Record<string, string | string[] | undefined>,
    ) =>
      loadRunsPage(searchParams, {
        runs: app.f.runs,
        projects: createProjectService({
          projects: createProjectsRepository(app.f.db, app.f.workspaceId),
        }),
      });
    const { rerender } = render(
      <RunsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={await data({
          repository: app.f.repositoryId,
          status: "failed",
        })}
      />,
    );
    const values = () => [
      screen.getByLabelText("Project").textContent,
      screen.getByLabelText("Status").textContent,
    ];
    expect(values()).toEqual(["acme/gadgets", "Failed"]);

    // "Reset filter" is a link to /runs: the page renders again with no filter, without a remount key.
    rerender(
      <RunsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={await data({})}
      />,
    );
    expect(values()).toEqual(["All projects", "All statuses"]);

    // Back brings the filter back.
    rerender(
      <RunsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={await data({ status: "succeeded" })}
      />,
    );
    expect(values()).toEqual(["All projects", "Succeeded"]);
  });

  // #80
  it("does not offer a repository that only holds saved settings, as it can never have runs", async () => {
    const f = await createRunsFixture();
    const projects = createProjectService({
      projects: createProjectsRepository(f.db, f.workspaceId),
    });
    await createProjectsRepository(f.db, f.workspaceId).updateSettings(
      f.repositoryId,
      {
        maxFindings: 2,
      },
    );
    const data = await loadRunsPage(
      {},
      {
        runs: f.runs,
        projects,
        lastRuns: createLastRunSource({ runs: f.runsRepository }),
      },
    );

    render(
      <RunsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={data}
      />,
    );

    expect(await optionLabels("Project")).toEqual(["All projects"]);
  });

  // #80
  it("still offers a project that was switched off after it had runs", async () => {
    const app = await openRuns();
    await app.projects.deactivateProject(app.f.repositoryId);

    await app.page();

    expect(await optionLabels("Project")).toEqual([
      "All projects",
      "acme/gadgets",
      "acme/widgets",
    ]);
  });

  // CR-35-T03
  it("explains an empty result and offers to reset the filter", async () => {
    const app = await openRuns();

    await app.page({ status: "running" });

    expect(
      screen.getByRole("heading", { name: "No runs for this filter" }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("link", { name: "Reset filter" }).length,
    ).toBeGreaterThan(0);
  });

  // CR-35-T03
  it("says there are no runs yet before the first one", async () => {
    const f = await createRunsFixture();
    const projects = createProjectService({
      projects: createProjectsRepository(f.db, await defaultWorkspaceId(f.db)),
    });
    const data = await loadRunsPage({}, { runs: f.runs, projects });

    render(
      <RunsPageContent
        product={getProductIdentity()}
        workspaceSlug="acme"
        data={data}
      />,
    );

    expect(screen.getByRole("heading", { name: "No runs yet" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open projects" }).getAttribute("href"),
    ).toBe("/w/acme/projects");
  });

  it("does not take a filter it does not know for no filter", async () => {
    const app = await openRuns();

    await app.page({ status: "exploded" });

    expect(
      screen.getByRole("heading", { name: "This filter is not valid" }),
    ).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Runs" })).toBeNull();
  });
});

describe("the page of one run", () => {
  // CR-35-T04
  it("shows the run with its error sentence and code, and not its log", async () => {
    const app = await openRuns();
    const job = await app.f.finished(
      {
        ok: false,
        errorCode: "git_rate_limit",
        result: { ok: false, logTail: "429 from GitHub", logTruncated: false },
      },
      { triggerKind: "manual", actorLogin: "alice" },
    );
    const data = await loadRunDetailPage(job.id, { runs: app.f.runs });
    if (data.kind !== "ready") throw new Error("the run was not found");

    render(<RunDetailPageContent workspaceSlug="acme" data={data} />);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      `acme/gadgets #${String(job.prNumber)}`,
    );
    // #165 breadcrumb rule: the detail starts at the Runs list (the area root) and ends at the run.
    const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(
      within(crumbs).getByRole("link", { name: "Runs" }).getAttribute("href"),
    ).toBe("/w/acme/runs?view=agents");
    expect(
      within(crumbs)
        .getByText(`acme/gadgets #${String(job.prNumber)}`)
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByText(
        "GitHub is limiting requests right now. Try again later.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("git_rate_limit")).toBeTruthy();
    expect(screen.getByText("Started by alice")).toBeTruthy();
    expect(screen.queryByText("429 from GitHub")).toBeNull();
  });

  // CR-35-T05
  it("finds nothing for an unknown or invalid id", async () => {
    const app = await openRuns();

    for (const id of ["00000000-0000-4000-8000-000000000000", "7", "x'--"]) {
      expect(await loadRunDetailPage(id, { runs: app.f.runs })).toEqual({
        kind: "not_found",
      });
    }
  });
});
