// SPDX-License-Identifier: LicenseRef-Proprietary

// #1140: a lane with a schedule trigger starts a run at its cron time, exactly once. A real Postgres database, the real repositories
// (scoped to the workspace) and the real directory of workspaces; the platform is not asked in a test: the repository's default branch is
// a constant, and the kick is a list.
import { describe, expect, it } from "vitest";
import { USER } from "../test-support/implementer-harness.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createScheduleDirectory } from "../db/repositories/schedule-directory-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import {
  SUMMARY_RESULT,
  startEngineHarness,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { createScheduleRunner, scheduleRequestId } from "./schedule-trigger.ts";

const SUNDAY_0600 = new Date("2026-11-29T06:00:00.000Z");

function scheduledLane(
  cron = "0 6 * * 0",
  name = "Weekly SEO",
): Record<string, unknown> {
  return {
    version: 1,
    name,
    triggers: [{ id: "weekly", kind: "schedule", cron, steps: [] }],
    steps: [
      {
        id: "work",
        kind: "agent",
        profile: "worker",
        environment: "Python",
        instruction: "Look at the site.",
        result: SUMMARY_RESULT,
      },
    ],
  };
}

async function startHarness() {
  const app = await startEngineHarness({});
  const kicked: string[] = [];
  const lines: string[] = [];
  const clock = { now: new Date("2026-11-29T07:00:00.000Z") };
  const { db, workspaceId } = app.h;
  const runner = createScheduleRunner({
    workspaces: () => createScheduleDirectory(db).listWorkspaces(),
    forWorkspace: (id) => ({
      workflows: createWorkflowsRepository(db, id),
      runs: createWorkflowRunsRepository(db, id),
      async projectOf(projectId) {
        const project = await createProjectsRepository(db, id).getById(
          projectId,
        );
        return project === undefined
          ? undefined
          : { active: project.active, repositoryId: project.repositoryId };
      },
      async repositoryOf(repositoryId) {
        const repository = await app.h.repositories.get(repositoryId);
        return repository === undefined
          ? undefined
          : {
              id: repository.id,
              fullName: repository.fullName,
              defaultBranch: "main",
            };
      },
      kick: (runId) => void kicked.push(runId),
    }),
    now: () => clock.now,
    log: (line) => lines.push(line),
  });
  /**
   * Saves a lane with the clock of its repository at `savedAt` (versions are immutable, and a test must not depend on the real date):
   * before the occurrence, as a lane that has been in use is, unless a test says otherwise.
   */
  async function saveOld(
    document: Record<string, unknown>,
    savedAt = new Date("2026-11-01T00:00:00.000Z"),
  ) {
    const saved = await createWorkflowsRepository(db, workspaceId, {
      now: () => savedAt,
    }).create(
      {
        name: String(document.name),
        document: JSON.stringify(document),
        createdBy: USER.id,
        projectId: app.project.id,
      },
      100,
    );
    if (!saved.ok) throw new Error("seeding failed");
    return saved.workflow;
  }
  return { app, runner, kicked, lines, clock, saveOld, db, workspaceId };
}

const runsOf = (app: EngineHarness, workflowId: string) =>
  app.runs.listRuns(workflowId, 50);

describe("a lane with a schedule trigger starts a run at its cron time", () => {
  // #1140-T05
  it("starts one run that shows the schedule trigger, with no person behind it", async () => {
    const { app, runner, saveOld, kicked } = await startHarness();
    const lane = await saveOld(scheduledLane());

    const result = await runner.run();

    expect(result).toMatchObject({ workspaces: 1, lanes: 1, started: 1 });
    const runs = await runsOf(app, lane.id);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({
      workflowId: lane.id,
      workflowVersion: 1,
      status: "running",
      triggerKind: "schedule",
      triggerId: "weekly",
      createdBy: null,
      actorLogin: "schedule",
      baseBranch: "main",
      ticketRef: null,
      clientRequestId: scheduleRequestId(lane.id, "weekly", SUNDAY_0600),
    });
    expect(kicked).toEqual([run?.id]);
    // The page of the run shows the real trigger.
    expect(await app.service.get(lane.id, run?.id ?? "")).toMatchObject({
      trigger: "schedule",
      triggerId: "weekly",
      actorLogin: "schedule",
    });
  });

  // #1140-T05
  it("starts ONE run when the tick is called twice, one after the other", async () => {
    const { app, runner, saveOld } = await startHarness();
    const lane = await saveOld(scheduledLane());

    const first = await runner.run();
    const second = await runner.run();

    expect(first.started).toBe(1);
    expect(second).toMatchObject({ started: 0, existing: 1 });
    expect(await runsOf(app, lane.id)).toHaveLength(1);
  });

  // #1140-T05
  it("starts ONE run when two ticks overlap (called at the same time)", async () => {
    const { app, runner, saveOld } = await startHarness();
    const lane = await saveOld(scheduledLane());

    const [a, b] = await Promise.all([runner.run(), runner.run()]);

    expect(a.started + b.started).toBe(1);
    expect(a.failed + b.failed).toBe(0);
    expect(await runsOf(app, lane.id)).toHaveLength(1);
  });

  // #1140-T05
  it("starts no second run for the same occurrence when the first one has already ended", async () => {
    const { app, runner, saveOld, clock, db } = await startHarness();
    const lane = await saveOld(scheduledLane());
    await runner.run();
    await db
      .updateTable("workflow_runs")
      .set({ status: "succeeded", finished_at: "2026-11-29T06:30:00.000Z" })
      .where("workflow_id", "=", lane.id)
      .execute();

    clock.now = new Date("2026-11-29T09:00:00.000Z");
    const later = await runner.run();

    expect(later).toMatchObject({ started: 0, existing: 1 });
    expect(await runsOf(app, lane.id)).toHaveLength(1);
  });

  // #1140-T05
  it("does nothing while the run of the last occurrence still goes on, and starts the next one when it has ended", async () => {
    const { app, runner, saveOld, clock, db } = await startHarness();
    const lane = await saveOld(scheduledLane());
    await runner.run();

    clock.now = new Date("2026-12-06T06:00:00.000Z");
    const busy = await runner.run();
    expect(busy).toMatchObject({ started: 0, busy: 1 });
    expect(await runsOf(app, lane.id)).toHaveLength(1);

    await db
      .updateTable("workflow_runs")
      .set({ status: "succeeded", finished_at: "2026-12-06T06:10:00.000Z" })
      .where("workflow_id", "=", lane.id)
      .execute();
    clock.now = new Date("2026-12-06T07:00:00.000Z");
    const next = await runner.run();
    expect(next.started).toBe(1);
    expect(await runsOf(app, lane.id)).toHaveLength(2);
  });

  // #1140-T05
  it("makes up a missed tick once and starts nothing when the app was down for weeks", async () => {
    const { app, runner, saveOld, clock } = await startHarness();
    const lane = await saveOld(scheduledLane());

    // The tick at 07:00 was lost; 09:00 makes up the 06:00 occurrence.
    clock.now = new Date("2026-11-29T09:00:00.000Z");
    expect((await runner.run()).started).toBe(1);
    // Weeks later (Wednesday): the window is long gone, nothing is made up.
    clock.now = new Date("2026-12-16T10:00:00.000Z");
    const much = await runner.run();
    expect(much).toMatchObject({ started: 0, notDue: 1 });
    expect(await runsOf(app, lane.id)).toHaveLength(1);
  });

  // #1140-T05
  it("starts nothing for a lane that is archived, in a project that is switched off, or saved after the occurrence", async () => {
    const { app, runner, saveOld } = await startHarness();
    const archived = await saveOld(scheduledLane("0 6 * * 0", "Archived lane"));
    await app.workflows.archive(archived.id, 1000);
    const fresh = await saveOld(
      scheduledLane("0 6 * * 0", "Fresh lane"),
      new Date("2026-11-29T06:30:00.000Z"),
    );

    // The fresh lane was saved at 06:30, after the 06:00 occurrence: it does not start for it.
    const result = await runner.run();

    expect(result.started).toBe(0);
    expect(await runsOf(app, archived.id)).toHaveLength(0);
    expect(await runsOf(app, fresh.id)).toHaveLength(0);

    const off = await saveOld(scheduledLane("0 6 * * 0", "Off lane"));
    await app.h.projects.deactivateProject(app.repository.id);
    expect((await runner.run()).started).toBe(0);
    expect(await runsOf(app, off.id)).toHaveLength(0);
  });

  // #1140-T05
  it("lists the workspaces that have a scheduled lane, and only those", async () => {
    const { app, saveOld, db, workspaceId } = await startHarness();
    const directory = createScheduleDirectory(db);

    expect(await directory.listWorkspaces()).toEqual([]);
    await app.saveWorkflow({
      version: 1,
      name: "By hand",
      triggers: [{ id: "by-hand", kind: "manual", steps: [] }],
      steps: [
        {
          id: "work",
          kind: "agent",
          profile: "worker",
          environment: "Python",
          instruction: "Do it.",
          result: SUMMARY_RESULT,
        },
      ],
    });
    expect(await directory.listWorkspaces()).toEqual([]);

    await saveOld(scheduledLane());
    expect(await directory.listWorkspaces()).toEqual([workspaceId]);
  });
});
