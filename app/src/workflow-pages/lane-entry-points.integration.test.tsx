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
import { sha } from "../test-support/jobs.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import type { AskChannel } from "../workflow-runs/engine.ts";
import { parseStepAsk } from "../workflow-runs/ask.ts";
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

/** A channel for the questions that posts nothing: the run waits, and an answer goes on. */
const SILENT_ASKS: AskChannel = {
  asked: async () => ({ commentId: "9001" }),
  answered: async () => {},
  superseded: async () => {},
  cancelled: async () => {},
  discarded: async () => {},
};

describe("the lane step of an agent run", () => {
  // #1080-T60
  it("finds the lane, the run and the step by the job of the agent run", async () => {
    const app = await startEngineHarness();
    const { workflow, runId } = await startedRun(app);
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
  });

  // #1080-T62
  it("still finds the step from the first job after an answer moved the step on to the follow-up turn of the same session", async () => {
    const app = await startEngineHarness({ asks: SILENT_ASKS });
    const { workflow, runId } = await startedRun(app);
    const { db } = app.h;
    app.h.fake.addBranch("acme/widgets", `workflow/${runId}/plan`, sha("c"));
    // The agent asks, the run waits, somebody answers: the engine starts the next turn of the session with a new job.
    const first = await app.finishTurn({
      agentAsk: { question: "Retry which failures?" },
      costUsd: 0.1,
    });
    await app.engine.jobEnded(first);
    const waiting = (await app.stateOf(runId)).steps.findLast(
      (step) => step.status === "waiting",
    );
    expect(waiting?.ask).not.toBeNull();
    await app.engine.answer(runId, {
      text: "Both.",
      by: "a",
      via: "ui",
      question: {
        stepRunId: waiting?.id ?? "none",
        n: parseStepAsk(waiting?.ask ?? null)?.n ?? 1,
      },
    });
    await app.engine.advance(runId);
    const row = await db
      .selectFrom("workflow_step_runs")
      .select(["job_id", "turn_id"])
      .where("run_id", "=", runId)
      .where("step_id", "=", "plan")
      .executeTakeFirstOrThrow();
    // The step now holds the follow-up job and turn, not the ones of the question.
    expect(row.job_id).not.toBeNull();
    expect(row.job_id).not.toBe(first);
    const own = servicesOf(app, app.workspaceId);
    const expected = {
      workflowId: workflow.id,
      runId,
      laneName: "Two agents",
      stepId: "plan",
    };

    expect(await own.runs.laneStepOfAgentRun(first)).toEqual(expected);
    expect(await own.runs.laneStepOfAgentRun(row.job_id as string)).toEqual(
      expected,
    );
    // Another workspace finds neither.
    const foreign = servicesOf(app, await addWorkspace(db, "other"));
    expect(await foreign.runs.laneStepOfAgentRun(first)).toBeUndefined();
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

describe("the active run of a ticket", () => {
  // #1080-T63
  it("is the run that waits for an answer, else the newest one, and of two equals the greater id", async () => {
    const app = await startEngineHarness();
    const { db } = app.h;
    const ref = "github:acme/widgets#7";
    const lanes = [];
    for (const name of ["First", "Second", "Third"]) {
      lanes.push(await app.saveWorkflow({ ...twoAgentSteps(), name }));
    }
    const runs = [];
    for (const [index, lane] of lanes.entries()) {
      const { run } = await app.start(lane.id, {
        clientRequestId: `run-${String(index)}`,
      });
      runs.push(run.id);
    }
    const [oldest, middle, newest] = runs as [string, string, string];
    const set = (id: string, values: Record<string, string>) =>
      db
        .updateTable("workflow_runs")
        .set({ ticket_ref: ref, ...values })
        .where("id", "=", id)
        .execute();
    const active = async () =>
      (
        await createWorkflowRunsRepository(
          db,
          app.workspaceId,
        ).summarizeTickets([ref])
      )[0]?.activeRun?.runId;
    await set(oldest, { created_at: "2026-11-18T10:00:00.000Z" });
    await set(middle, { created_at: "2026-11-18T11:00:00.000Z" });
    await set(newest, { created_at: "2026-11-18T12:00:00.000Z" });

    // all three run: the newest
    expect(await active()).toBe(newest);

    // the oldest waits for an answer: it needs somebody, so it is the one the ticket shows
    await set(oldest, { status: "waiting" });
    expect(await active()).toBe(oldest);

    // two that wait: the newest of them
    await set(middle, { status: "waiting" });
    expect(await active()).toBe(middle);

    // the same time: the greater id, whatever the order the rows are read in
    await set(oldest, { created_at: "2026-11-18T11:00:00.000Z" });
    expect(await active()).toBe([oldest, middle].sort().at(-1));
  });
});
