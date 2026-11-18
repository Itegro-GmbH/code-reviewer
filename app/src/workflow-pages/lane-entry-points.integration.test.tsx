// SPDX-License-Identifier: LicenseRef-Proprietary

// @vitest-environment jsdom
// The entry points to a lane run (#1080) against a real Postgres database, through the engine: the lane page lists only the runs of its own
// lane, with the track; the progress of an active run (what the ticket board draws its track from) is read for the workspace's own runs only;
// and the lane step an agent run belongs to is found by its job or its turn, in the workspace's own steps and nowhere else.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImplementerEnvironmentsRepository } from "../db/repositories/implementer-environments-repository.ts";
import { createProfilesRepository } from "../db/repositories/profiles-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
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
import { loadWorkflowPage, WorkflowPageContent } from "./pages.tsx";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

/** The services the pages of one workspace read through. */
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
  };
}

async function startedRun(app: EngineHarness) {
  const workflow = await app.saveWorkflow(twoAgentSteps());
  const { run } = await app.start(workflow.id);
  await app.engine.advance(run.id);
  return { workflow, runId: run.id };
}

const NO_POLL = {} as unknown as WorkflowRunsApi;

describe("the Runs section of a lane's page", () => {
  // #1080-T50
  it("lists the runs of this lane only, each with the track and a link to the run", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await startedRun(app);
    const own = servicesOf(app, app.workspaceId);

    const page = await loadWorkflowPage(workflow.id, own);
    if (page.kind !== "ready") throw new Error("not ready");
    // Another lane of the workspace with a run of its own: its run is not on this lane's page.
    const other = await app.saveWorkflow({
      ...twoAgentSteps(),
      name: "Another lane",
    });
    await app.start(other.id, { clientRequestId: "run-other" });
    const again = await loadWorkflowPage(workflow.id, own);
    if (again.kind !== "ready") throw new Error("not ready");
    expect(again.runs.runs.map((run) => run.id)).toEqual([runId]);

    render(
      <WorkflowPageContent
        workspaceSlug="acme"
        data={page}
        mayStart
        api={NO_POLL}
      />,
    );
    const section = screen
      .getByRole("heading", { name: "Runs" })
      .closest("section") as HTMLElement;
    const row = within(section).getAllByRole("row")[1] as HTMLElement;
    expect(row.getAttribute("data-run-id")).toBe(runId);
    expect(within(row).getByRole("img", { name: /^Step 1 of 2/ })).toBeTruthy();
    expect(
      within(row)
        .getByRole("link", { name: /^Open the run/ })
        .getAttribute("href"),
    ).toBe(`/w/acme/workflows/${workflow.id}/runs/${runId}`);
  });

  // #1080-T51
  it("lists no run of another workspace for a lane that is not this workspace's", async () => {
    const app = await startEngineHarness();
    const { workflow } = await startedRun(app);
    const foreign = servicesOf(app, await addWorkspace(app.h.db, "other"));

    expect(await loadWorkflowPage(workflow.id, foreign)).toEqual({
      kind: "not_found",
    });
    expect(
      (await foreign.runs.listWorkspace({ lane: workflow.id })).runs,
    ).toEqual([]);
  });
});

describe("the progress of an active run, for the ticket board", () => {
  // #1080-T52
  it("reads the steps and the lane version of the workspace's own runs, and nothing of another workspace's", async () => {
    const app = await startEngineHarness();
    const { runId } = await startedRun(app);
    const { db } = app.h;
    const own = createWorkflowRunsRepository(db, app.workspaceId);
    const foreign = createWorkflowRunsRepository(
      db,
      await addWorkspace(db, "other"),
    );

    const [progress] = await own.laneProgressOfRuns([runId, "no-such-run"]);

    expect(progress).toMatchObject({
      runId,
      steps: [{ stepId: "plan", kind: "agent", status: "running", round: 1 }],
    });
    expect(JSON.parse(progress?.document ?? "null")).toMatchObject({
      name: "Two agents",
    });
    expect(await foreign.laneProgressOfRuns([runId])).toEqual([]);
    expect(await own.laneProgressOfRuns([])).toEqual([]);
  });
});

describe("the lane step of an agent run", () => {
  // #1080-T60
  it("finds the lane, the run and the step by the job of the agent run, and by its turn when the step holds another job", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await startedRun(app);
    const { db } = app.h;
    const jobId = await app.finishTurn({
      agentResult: { summary: "Plan." },
      costUsd: 0.1,
    });
    const own = servicesOf(app, app.workspaceId);

    expect(await own.runs.laneStepOfAgentRun(jobId)).toEqual({
      workflowId: workflow.id,
      runId,
      laneName: "Two agents",
      stepId: "plan",
    });

    // The step holds no job any more (it went on with another one): the turn of the job still names the step.
    const turn = await db
      .selectFrom("implementer_turns")
      .select("id")
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow();
    await db
      .updateTable("workflow_step_runs")
      .set({ job_id: null, turn_id: turn.id })
      .where("run_id", "=", runId)
      .where("step_id", "=", "plan")
      .execute();
    expect(await own.runs.laneStepOfAgentRun(jobId)).toMatchObject({
      runId,
      stepId: "plan",
    });
  });

  // #1080-T61
  it("finds nothing for a job of another workspace, an unknown job, or an agent run no lane started", async () => {
    const app = await startEngineHarness();
    await startedRun(app);
    const jobId = await app.finishTurn({
      agentResult: { summary: "Plan." },
      costUsd: 0.1,
    });
    const foreign = servicesOf(app, await addWorkspace(app.h.db, "other"));
    const own = servicesOf(app, app.workspaceId);

    expect(await foreign.runs.laneStepOfAgentRun(jobId)).toBeUndefined();
    expect(await own.runs.laneStepOfAgentRun("no-such-job")).toBeUndefined();
    expect(await own.runs.laneStepOfAgentRun("")).toBeUndefined();
    expect(await own.runs.laneStepOfAgentRun("x".repeat(500))).toBeUndefined();
  });
});
