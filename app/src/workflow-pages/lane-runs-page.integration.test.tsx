// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The Lane runs tab of the Runs page with real data (#1078): a lane run made through the engine in a real Postgres database, read the way
// the page reads it: the row with its lane, step track and status, the filter from the address, a filter that is none, and nothing of
// another workspace.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { createProjectService } from "../projects/service.ts";
import {
  startEngineHarness,
  twoAgentSteps,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createWorkflowRunService } from "../workflow-runs/service.ts";
import { createWorkflowService } from "../workflows/service.ts";
import { LaneRunsPageContent, loadLaneRunsPage } from "./lane-runs-page.tsx";
import { LANE_RUNS_COPY } from "./messages.ts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/w/acme/runs",
}));

afterEach(cleanup);

function servicesOf(app: EngineHarness, workspaceId: string) {
  const { db } = app.h;
  return {
    workflows: createWorkflowService({
      workflows: createWorkflowsRepository(db, workspaceId),
      projects: createProjectsRepository(db, workspaceId),
      environments: createImplementerEnvironmentsRepository(db, workspaceId),
      profiles: createProfilesRepository(db, workspaceId),
    }),
    runs: createWorkflowRunService({
      runs: createWorkflowRunsRepository(db, workspaceId),
      workflows: createWorkflowsRepository(db, workspaceId),
      projects: createProjectsRepository(db, workspaceId),
      repositoryName: async () => undefined,
      resolveRepository: async () => undefined,
      readTicket: async () => undefined,
      kick: () => {},
    }),
    projects: createProjectService({
      projects: createProjectsRepository(db, workspaceId),
    }),
  };
}

async function startedRun(app: EngineHarness) {
  const workflow = await app.saveWorkflow(twoAgentSteps());
  const { run } = await app.start(workflow.id);
  await app.engine.advance(run.id);
  return { workflow, runId: run.id };
}

async function openPage(
  app: EngineHarness,
  workspaceId: string,
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  const data = await loadLaneRunsPage(
    searchParams,
    servicesOf(app, workspaceId),
  );
  render(<LaneRunsPageContent workspaceSlug="acme" data={data} />);
  return data;
}

describe("the Lane runs tab", () => {
  // #1078-T100
  it("lists a run of the workspace with its lane, its step track and its status, linked to the run page", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await startedRun(app);

    await openPage(app, app.workspaceId);

    const table = screen.getByRole("table", { name: LANE_RUNS_COPY.listLabel });
    const row = within(within(table).getAllByRole("row")[1] as HTMLElement);
    expect(row.getByText("Two agents")).toBeTruthy();
    expect(row.getByText("Running")).toBeTruthy();
    expect(
      row.getByRole("img", { name: "Step 1 of 2: Agent step, running" }),
    ).toBeTruthy();
    expect(
      row
        .getByRole("link", { name: new RegExp(LANE_RUNS_COPY.openRun) })
        .getAttribute("href"),
    ).toBe(`/w/acme/workflows/${workflow.id}/runs/${runId}`);
  });

  // #1078-T101
  it("keeps to the filter of the address and offers the lanes of the workspace", async () => {
    const app = await startEngineHarness();
    const { workflow } = await startedRun(app);

    const data = await openPage(app, app.workspaceId, {
      status: "active",
      lane: workflow.id,
    });

    expect(data.kind).toBe("ready");
    expect(screen.getByLabelText("Status").textContent).toContain("Active");
    expect(screen.getByLabelText("Lane").textContent).toContain("Two agents");
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  // #1078-T102
  it("shows the empty list for a filter that matches no run, and a notice for a filter that is none", async () => {
    const app = await startEngineHarness();
    await startedRun(app);

    await openPage(app, app.workspaceId, { status: "failed" });
    expect(screen.getByText(LANE_RUNS_COPY.emptyFiltered)).toBeTruthy();
    cleanup();

    const invalid = await openPage(app, app.workspaceId, {
      status: "everything",
    });
    expect(invalid.kind).toBe("invalid_filter");
    expect(screen.getByText(LANE_RUNS_COPY.invalidFilterTitle)).toBeTruthy();
  });

  // #1078-T103
  it("shows nothing of another workspace's runs", async () => {
    const app = await startEngineHarness();
    await startedRun(app);
    const other = await addWorkspace(app.h.db, "other");

    const data = await openPage(app, other);

    expect(data.kind === "ready" && data.snapshot.runs).toEqual([]);
    expect(screen.getByText(LANE_RUNS_COPY.emptyDescription)).toBeTruthy();
    expect(screen.queryByText("Two agents")).toBeNull();
  });
});
