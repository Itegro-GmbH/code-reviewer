// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The workflow pages with real data (#873): a workflow and a run made through the engine in a real Postgres database, read the way the
// pages read them. A workflow or run of another workspace is `not_found` through the other workspace's services (the page then shows
// the not-found page and nothing of the other), the list holds only the workspace's own workflows, and a run whose cost was not
// reported shows the basis it was charged on.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import {
  startEngineHarness,
  twoAgentSteps,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { createWorkflowService } from "../workflows/service.ts";
import { createWorkflowRunService } from "../workflow-runs/service.ts";
import type { WorkflowRunsApi } from "./api.ts";
import {
  loadRunPage,
  loadWorkflowPage,
  loadWorkflowsPage,
  RunPageContent,
  WorkflowPageContent,
  WorkflowsPageContent,
} from "./pages.tsx";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);

/** The services the pages of one workspace read through. */
function servicesOf(app: EngineHarness, workspaceId: string) {
  const { db } = app.h;
  return {
    workflows: createWorkflowService({
      workflows: createWorkflowsRepository(db, workspaceId),
      environments: createImplementerEnvironmentsRepository(db, workspaceId),
      profiles: createProfilesRepository(db, workspaceId),
    }),
    runs: createWorkflowRunService({
      runs: createWorkflowRunsRepository(db, workspaceId),
      workflows: createWorkflowsRepository(db, workspaceId),
      resolveRepository: async () => undefined,
      readTicket: async () => undefined,
      kick: () => {},
    }),
  };
}

/** A run with its first step started, for the pages to read. */
async function startedRun(app: EngineHarness) {
  const workflow = await app.saveWorkflow(twoAgentSteps());
  const { run } = await app.start(workflow.id);
  await app.engine.advance(run.id);
  return { workflow, runId: run.id };
}

const NO_POLL = {} as unknown as WorkflowRunsApi;

describe("a workflow or run of another workspace", () => {
  // #873-T70
  it("is not found through the other workspace, on every page, and found through its own", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await startedRun(app);
    const other = await addWorkspace(app.h.db, "other");
    const own = servicesOf(app, app.workspaceId);
    const foreign = servicesOf(app, other);

    expect(await loadWorkflowPage(workflow.id, foreign)).toEqual({
      kind: "not_found",
    });
    expect(await loadRunPage(workflow.id, runId, foreign)).toEqual({
      kind: "not_found",
    });
    expect((await loadWorkflowPage(workflow.id, own)).kind).toBe("ready");
    expect((await loadRunPage(workflow.id, runId, own)).kind).toBe("ready");
  });

  // #873-T70
  it("is not found when the run is asked for under another workflow of the same workspace", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await startedRun(app);
    const own = servicesOf(app, app.workspaceId);

    expect(await loadRunPage("no-such-workflow", runId, own)).toEqual({
      kind: "not_found",
    });
    expect(await loadRunPage(workflow.id, "no-such-run", own)).toEqual({
      kind: "not_found",
    });
  });

  // #873-T71
  it("is not in the list of workflows of the workspace asking", async () => {
    const app = await startEngineHarness();
    const { workflow } = await startedRun(app);
    const other = await addWorkspace(app.h.db, "other");

    const mine = await loadWorkflowsPage(servicesOf(app, app.workspaceId));
    const theirs = await loadWorkflowsPage(servicesOf(app, other));

    expect(mine.workflows.map((entry) => entry.id)).toEqual([workflow.id]);
    expect(theirs.workflows).toEqual([]);
  });
});

describe("the pages with real data", () => {
  // #873-T72
  it("lists the workflows, links to a workflow, shows its Start form and its runs", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await startedRun(app);
    const own = servicesOf(app, app.workspaceId);

    const list = render(
      <WorkflowsPageContent
        workspaceSlug="acme"
        data={await loadWorkflowsPage(own)}
      />,
    );
    expect(
      screen
        .getByRole("link", { name: String(workflow.name) })
        .getAttribute("href"),
    ).toBe(`/w/acme/workflows/${workflow.id}`);
    list.unmount();

    const page = await loadWorkflowPage(workflow.id, own);
    if (page.kind !== "ready") throw new Error("not ready");
    render(
      <WorkflowPageContent
        workspaceSlug="acme"
        data={page}
        mayStart
        api={NO_POLL}
      />,
    );
    // The manual trigger of the test workflow asks for the repository and a topic.
    expect(screen.getByLabelText("Repository")).toBeTruthy();
    expect(screen.getByLabelText("topic")).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: /Open the run/ })[0]
        ?.getAttribute("href"),
    ).toBe(`/w/acme/workflows/${workflow.id}/runs/${runId}`);
  });

  // #873-T73
  it("does not offer the form to a role that may not start", async () => {
    const app = await startEngineHarness();
    const { workflow } = await startedRun(app);
    const page = await loadWorkflowPage(
      workflow.id,
      servicesOf(app, app.workspaceId),
    );
    if (page.kind !== "ready") throw new Error("not ready");

    render(
      <WorkflowPageContent
        workspaceSlug="acme"
        data={page}
        mayStart={false}
        api={NO_POLL}
      />,
    );

    expect(screen.queryByLabelText("Repository")).toBeNull();
    expect(screen.getByText(/does not allow/)).toBeTruthy();
  });

  // #873-T74
  it("shows a step that was charged the whole limit with that basis, and links the agent's run", async () => {
    const app = await startEngineHarness({ operatorCostLimitCents: 10_000 });
    const { workflow, runId } = await startedRun(app);
    const jobId = await app.finishTurn({
      agentResult: { summary: "Plan." },
      costUsd: null,
    });
    await app.engine.jobEnded(jobId);

    const page = await loadRunPage(
      workflow.id,
      runId,
      servicesOf(app, app.workspaceId),
    );
    if (page.kind !== "ready") throw new Error("not ready");
    const { container } = render(
      <RunPageContent workspaceSlug="acme" data={page} api={NO_POLL} />,
    );

    const basis = container.querySelector("[data-slot=cost-basis]");
    expect(basis?.getAttribute("data-basis")).toBe("limit");
    expect(
      screen.getByRole("link", { name: /agent's run/ }).getAttribute("href"),
    ).toBe(`/w/acme/runs/${jobId}`);
  });
});
