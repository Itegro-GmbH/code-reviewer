// SPDX-License-Identifier: LicenseRef-Proprietary

// #1140: a lane with a `schedule` trigger starts a run at its cron time. The due occurrence, the request id that makes a start happen
// once, and the runner that walks the workspaces and lanes, against fakes.
import { describe, expect, it } from "vitest";
import type {
  NewWorkflowRun,
  StoredWorkflowRun,
  WorkflowRunsRepository,
} from "../db/repositories/workflow-runs-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
} from "../db/repositories/workflows-repository.ts";
import { CLIENT_REQUEST_ID } from "../jobs/job-input.ts";
import {
  SCHEDULE_CATCH_UP_MS,
  createScheduleRunner,
  dueOccurrence,
  scheduleRequestId,
  type ScheduleWorkspaceDependencies,
} from "./schedule-trigger.ts";

const at = (iso: string) => new Date(iso);
const SUNDAY_0600 = at("2026-11-29T06:00:00Z");

describe("dueOccurrence", () => {
  const saved = at("2026-11-01T00:00:00Z");

  // #1140-T02
  it("is the occurrence at the first tick at or after its time", () => {
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-29T06:00:00Z"), saved),
    ).toEqual(SUNDAY_0600);
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-29T06:00:07Z"), saved),
    ).toEqual(SUNDAY_0600);
  });

  // #1140-T02
  it("starts a lane whose time falls between two hourly ticks at the later tick", () => {
    // `30 6 * * 0` is due at 06:30; the hourly ticks are 06:00 (not yet) and 07:00.
    expect(
      dueOccurrence("30 6 * * 0", at("2026-11-29T06:00:00Z"), saved),
    ).toBeUndefined();
    expect(
      dueOccurrence("30 6 * * 0", at("2026-11-29T07:00:00Z"), saved),
    ).toEqual(at("2026-11-29T06:30:00Z"));
  });

  // #1140-T02
  it("catches up the most recent missed occurrence when ticks were missed", () => {
    // No tick at 06:00 and 07:00: the one at 09:00 still finds the 06:00 occurrence.
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-29T09:00:00Z"), saved),
    ).toEqual(SUNDAY_0600);
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-30T05:59:00Z"), saved),
    ).toEqual(SUNDAY_0600);
  });

  // #1140-T02
  it("catches up only ONE occurrence of a schedule that is due many times", () => {
    // Every hour, ticks missed for 5 hours: the 09:00 occurrence only, not 05:00 to 08:00.
    expect(
      dueOccurrence("0 * * * *", at("2026-11-29T09:00:00Z"), saved),
    ).toEqual(at("2026-11-29T09:00:00Z"));
  });

  // #1140-T02
  it("never back-fills past the window: an occurrence older than 24 hours is dropped", () => {
    expect(SCHEDULE_CATCH_UP_MS).toBe(24 * 60 * 60 * 1000);
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-30T06:01:00Z"), saved),
    ).toBeUndefined();
    // Two weeks of ticks lost: nothing is made up, the next occurrence is awaited.
    expect(
      dueOccurrence("0 6 * * 0", at("2026-12-13T05:00:00Z"), saved),
    ).toBeUndefined();
  });

  // #1140-T02
  it("treats the edge of the window: 24 hours back is not included, a minute later is", () => {
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-30T06:00:00Z"), saved),
    ).toBeUndefined();
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-30T05:59:00Z"), saved),
    ).toEqual(SUNDAY_0600);
  });

  // #1140-T02
  it("does not fire an occurrence before its minute: 05:59:59.999 is not 06:00", () => {
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-29T05:59:59.999Z"), saved),
    ).toBeUndefined();
    expect(
      dueOccurrence("0 6 * * 0", at("2026-11-29T06:00:00.000Z"), saved),
    ).toEqual(SUNDAY_0600);
  });

  // #1140-T02
  it("does not fire an occurrence from before the version was saved", () => {
    // A lane saved on Sunday 09:00 does not start the 06:00 run of that morning.
    expect(
      dueOccurrence(
        "0 6 * * 0",
        at("2026-11-29T10:00:00Z"),
        at("2026-11-29T09:00:00Z"),
      ),
    ).toBeUndefined();
    // Saved at 05:30: the 06:00 occurrence is after it.
    expect(
      dueOccurrence(
        "0 6 * * 0",
        at("2026-11-29T07:00:00Z"),
        at("2026-11-29T05:30:00Z"),
      ),
    ).toEqual(SUNDAY_0600);
  });

  // #1140-T02
  it("is undefined for an expression that does not parse", () => {
    expect(
      dueOccurrence("0 6 *", at("2026-11-29T07:00:00Z"), saved),
    ).toBeUndefined();
  });
});

describe("scheduleRequestId", () => {
  // #1140-T03
  it("is the same for the same lane, trigger and occurrence, and different otherwise", () => {
    const id = scheduleRequestId("wf-1", "weekly", SUNDAY_0600);
    expect(id).toBe(
      scheduleRequestId("wf-1", "weekly", at("2026-11-29T06:00:00Z")),
    );
    expect(id).not.toBe(scheduleRequestId("wf-2", "weekly", SUNDAY_0600));
    expect(id).not.toBe(scheduleRequestId("wf-1", "daily", SUNDAY_0600));
    expect(id).not.toBe(
      scheduleRequestId("wf-1", "weekly", at("2026-12-06T06:00:00Z")),
    );
  });

  // #1140-T03
  it("fits the request id rule of the start API and shows no seconds", () => {
    const id = scheduleRequestId(
      "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab",
      "t".repeat(64),
      at("2026-11-29T06:00:30.123Z"),
    );
    expect(CLIENT_REQUEST_ID.test(id)).toBe(true);
    expect(id).toContain("202611290600");
  });
});

type LaneSeed = {
  id: string;
  document: string;
  projectId?: string | null;
  savedAt?: string;
  version?: number;
};

const documentWith = (triggers: unknown[], steps: unknown[] = [AGENT]) =>
  JSON.stringify({
    version: 1,
    name: "Weekly SEO",
    triggers,
    steps,
  });
const AGENT = {
  id: "work",
  kind: "agent",
  profile: "worker",
  environment: "Python",
  instruction: "Do it.",
};
const WEEKLY = { id: "weekly", kind: "schedule", cron: "0 6 * * 0", steps: [] };
const SUNDAY_LANE: LaneSeed = {
  id: "wf-1",
  document: documentWith([WEEKLY]),
};

type Options = {
  workspaces?: string[];
  lanes?: Record<string, LaneSeed[]>;
  now?: Date;
  projects?: Record<
    string,
    { active: boolean; repositoryId: string } | undefined
  >;
  repository?: "none" | "ok";
  createRunFails?: string[];
  listFails?: string[];
};

function setup(options: Options = {}) {
  const created: NewWorkflowRun[] = [];
  const kicked: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const written = new Map<string, StoredWorkflowRun>();
  const keys = new Map<string, string | undefined>();
  const clock = { now: options.now ?? at("2026-11-29T07:00:00Z") };
  const lanes = options.lanes ?? { "ws-1": [SUNDAY_LANE] };

  const forWorkspace = (
    workspaceId: string,
  ): ScheduleWorkspaceDependencies => ({
    workflows: {
      async listWithScheduleTrigger() {
        asked.push(workspaceId);
        if (options.listFails?.includes(workspaceId))
          throw new Error("connection string postgres://secret");
        return (lanes[workspaceId] ?? []).map((seed) => ({
          workflow: {
            id: seed.id,
            name: seed.id,
            projectId:
              seed.projectId === undefined ? "project-1" : seed.projectId,
          } as StoredWorkflow,
          current: {
            workflowId: seed.id,
            version: seed.version ?? 1,
            document: seed.document,
            createdAt: seed.savedAt ?? "2026-11-01T00:00:00.000Z",
          } as StoredWorkflowVersion,
        }));
      },
    },
    runs: {
      async createRun(input) {
        if (options.createRunFails?.includes(input.workflowId))
          throw new Error("insert into workflow_runs ... password=hunter2");
        const earlier = written.get(`${workspaceId}/${input.clientRequestId}`);
        if (earlier !== undefined) return { status: "existing", run: earlier };
        const holder = [...written.values()].find(
          (run) =>
            run.status === "running" &&
            run.workflowId === input.workflowId &&
            keys.get(run.id) === input.triggerKey,
        );
        if (input.triggerKey !== undefined && holder !== undefined)
          return { status: "busy", run: holder };
        created.push(input);
        const run = {
          id: `run-${written.size + 1}`,
          workflowId: input.workflowId,
          status: "running",
          clientRequestId: input.clientRequestId,
        } as StoredWorkflowRun;
        written.set(`${workspaceId}/${input.clientRequestId}`, run);
        keys.set(run.id, input.triggerKey);
        return { status: "created", run };
      },
    } satisfies Pick<WorkflowRunsRepository, "createRun">,
    async projectOf(projectId) {
      if (options.projects !== undefined && projectId in options.projects)
        return options.projects[projectId];
      return { active: true, repositoryId: "repo-1" };
    },
    async repositoryOf(repositoryId) {
      return options.repository === "none"
        ? undefined
        : { id: repositoryId, fullName: "acme/widgets", defaultBranch: "main" };
    },
    kick: (runId) => void kicked.push(runId),
  });

  const runner = createScheduleRunner({
    workspaces: async () => options.workspaces ?? Object.keys(lanes),
    forWorkspace,
    now: () => clock.now,
    log: (line) => lines.push(line),
  });
  return { runner, created, kicked, lines, asked, clock, written };
}

describe("the schedule runner", () => {
  // #1140-T03
  it("starts the run of a lane that is due and records the schedule trigger", async () => {
    const { runner, created, kicked } = setup();

    const result = await runner.run();

    expect(result).toMatchObject({
      workspaces: 1,
      lanes: 1,
      started: 1,
      existing: 0,
      busy: 0,
      notDue: 0,
      skipped: 0,
      failed: 0,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      workflowId: "wf-1",
      workflowVersion: 1,
      repositoryId: "repo-1",
      baseBranch: "main",
      triggerKind: "schedule",
      triggerId: "weekly",
      triggerKey: "schedule:weekly",
      createdBy: null,
      actorLogin: "schedule",
      clientRequestId: scheduleRequestId("wf-1", "weekly", SUNDAY_0600),
    });
    expect(JSON.parse(created[0]?.triggerInput ?? "")).toEqual({});
    expect(created[0]?.budgetMicroUsd).toBeGreaterThan(0);
    expect(kicked).toEqual(["run-1"]);
  });

  // #1140-T03
  it("starts nothing before the time is reached", async () => {
    const { runner, created } = setup({ now: at("2026-11-29T05:00:00Z") });

    expect(await runner.run()).toMatchObject({
      lanes: 1,
      notDue: 1,
      started: 0,
    });
    expect(created).toEqual([]);
  });

  // #1140-T05
  it("starts ONE run when the tick is called twice (a retry or an overlap)", async () => {
    const { runner, created, kicked } = setup();

    const first = await runner.run();
    const second = await runner.run();

    expect(first.started).toBe(1);
    expect(second).toMatchObject({ started: 0, existing: 1 });
    expect(created).toHaveLength(1);
    // The run an earlier try wrote is still running: the second call pushes it once more, which the engine does nothing for when it moves.
    expect(kicked).toEqual(["run-1", "run-1"]);
  });

  // #1140-T05
  it("starts ONE run when the later ticks of the day find the same occurrence", async () => {
    const { runner, created, clock } = setup();

    await runner.run();
    clock.now = at("2026-11-29T08:00:00Z");
    const later = await runner.run();
    clock.now = at("2026-11-29T20:00:00Z");
    await runner.run();

    expect(later.existing).toBe(1);
    expect(created).toHaveLength(1);
  });

  // #1140-T02
  it("makes up a missed tick once, and the next week's occurrence is a new run", async () => {
    const { runner, created, clock, written } = setup({
      now: at("2026-11-29T09:00:00Z"),
    });

    await runner.run();
    // The next Sunday, the earlier run has ended.
    for (const run of written.values()) run.status = "succeeded" as never;
    clock.now = at("2026-12-06T06:00:00Z");
    await runner.run();

    expect(created.map((run) => run.clientRequestId)).toEqual([
      scheduleRequestId("wf-1", "weekly", SUNDAY_0600),
      scheduleRequestId("wf-1", "weekly", at("2026-12-06T06:00:00Z")),
    ]);
  });

  // #1140-T02
  it("does not back-fill weeks the app was down", async () => {
    const { runner, created } = setup({ now: at("2026-12-20T07:00:00Z") });

    // 2026-12-20 is a Sunday: this morning's occurrence is the one, not the three before it.
    const result = await runner.run();

    expect(created.map((run) => run.clientRequestId)).toEqual([
      scheduleRequestId("wf-1", "weekly", at("2026-12-20T06:00:00Z")),
    ]);
    expect(result.started).toBe(1);
  });

  // #1140-T03
  it("does nothing while the earlier scheduled run of the lane is still going", async () => {
    const { runner, created, kicked, clock } = setup();

    await runner.run();
    // A week later the run of the last Sunday has not ended (it may wait for an answer).
    clock.now = at("2026-12-06T07:00:00Z");
    const result = await runner.run();

    expect(result).toMatchObject({ started: 0, busy: 1 });
    expect(created).toHaveLength(1);
    expect(kicked).toEqual(["run-1"]);
  });

  // #1140-T03
  it("starts nothing for a lane saved after the occurrence", async () => {
    const { runner, created } = setup({
      lanes: {
        "ws-1": [{ ...SUNDAY_LANE, savedAt: "2026-11-29T06:30:00.000Z" }],
      },
    });

    expect(await runner.run()).toMatchObject({ notDue: 1, started: 0 });
    expect(created).toEqual([]);
  });

  // #1140-T03
  it("runs every schedule trigger of a lane on its own", async () => {
    const lane: LaneSeed = {
      id: "wf-1",
      document: documentWith([
        WEEKLY,
        { id: "hourly", kind: "schedule", cron: "0 * * * *", steps: [] },
        { id: "by-hand", kind: "manual", steps: [] },
      ]),
    };
    const { runner, created } = setup({ lanes: { "ws-1": [lane] } });

    const result = await runner.run();

    expect(result).toMatchObject({ lanes: 1, started: 2 });
    expect(created.map((run) => run.triggerId).toSorted()).toEqual([
      "hourly",
      "weekly",
    ]);
  });

  // #1140-T03
  it("walks every workspace, each through its own dependencies", async () => {
    const { runner, created, asked } = setup({
      workspaces: ["ws-1", "ws-2"],
      lanes: {
        "ws-1": [SUNDAY_LANE],
        "ws-2": [{ ...SUNDAY_LANE, id: "wf-2" }],
      },
    });

    const result = await runner.run();

    expect(asked).toEqual(["ws-1", "ws-2"]);
    expect(result).toMatchObject({ workspaces: 2, started: 2 });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-1", "wf-2"]);
  });

  // #1140-T03
  it("skips a lane that has no project, with a code", async () => {
    const { runner, created, lines } = setup({
      now: at("2026-11-29T06:00:00Z"),
      lanes: { "ws-1": [{ ...SUNDAY_LANE, projectId: null }] },
    });

    expect(await runner.run()).toMatchObject({ skipped: 1, started: 0 });
    expect(created).toEqual([]);
    expect(lines.join("\n")).toContain("SCHEDULE_PROJECT_UNAVAILABLE");
    expect(lines.join("\n")).toContain("workflow=wf-1");
  });

  // #1140-T03
  it("skips a lane whose project is switched off or gone", async () => {
    for (const project of [
      { active: false, repositoryId: "repo-1" },
      undefined,
    ]) {
      const { runner, created, lines } = setup({
        now: at("2026-11-29T06:00:00Z"),
        projects: { "project-1": project },
      });

      expect(await runner.run()).toMatchObject({ skipped: 1, started: 0 });
      expect(created).toEqual([]);
      expect(lines.join("\n")).toContain("SCHEDULE_PROJECT_UNAVAILABLE");
    }
  });

  // #1140-T03
  it("skips a lane whose repository is not available", async () => {
    const { runner, created, lines } = setup({
      now: at("2026-11-29T06:00:00Z"),
      repository: "none",
    });

    expect(await runner.run()).toMatchObject({ skipped: 1, started: 0 });
    expect(created).toEqual([]);
    expect(lines.join("\n")).toContain("SCHEDULE_REPOSITORY_UNAVAILABLE");
  });

  // #1140-T03
  it("skips a lane with a step the engine does not run", async () => {
    const lane: LaneSeed = {
      id: "wf-1",
      document: documentWith([WEEKLY], [{ id: "x", kind: "teleport" }]),
    };
    const { runner, created, lines } = setup({
      now: at("2026-11-29T06:00:00Z"),
      lanes: { "ws-1": [lane] },
    });

    expect(await runner.run()).toMatchObject({ skipped: 1, started: 0 });
    expect(created).toEqual([]);
    expect(lines.join("\n")).toContain("SCHEDULE_STEP_NOT_SUPPORTED");
  });

  // #1140-T03
  it("skips a lane whose saved document cannot be read", async () => {
    const { runner, lines } = setup({
      lanes: { "ws-1": [{ id: "wf-1", document: "{ not json" }] },
    });

    expect(await runner.run()).toMatchObject({ skipped: 1, started: 0 });
    expect(lines.join("\n")).toContain("SCHEDULE_DOCUMENT_UNUSABLE");
  });

  // #1140-T03
  it("goes on with the other lanes when one fails, and logs no detail of the failure", async () => {
    const { runner, created, lines } = setup({
      lanes: {
        "ws-1": [
          SUNDAY_LANE,
          { ...SUNDAY_LANE, id: "wf-2" },
          { ...SUNDAY_LANE, id: "wf-3" },
        ],
      },
      createRunFails: ["wf-2"],
    });

    const result = await runner.run();

    expect(result).toMatchObject({ lanes: 3, started: 2, failed: 1 });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-1", "wf-3"]);
    const log = lines.join("\n");
    expect(log).toContain("SCHEDULE_START_FAILED");
    expect(log).toContain("workflow=wf-2");
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain("insert into");
  });

  // #1140-T03
  it("goes on with the other workspaces when one cannot be read", async () => {
    const { runner, created, lines } = setup({
      workspaces: ["ws-1", "ws-2"],
      lanes: {
        "ws-1": [SUNDAY_LANE],
        "ws-2": [{ ...SUNDAY_LANE, id: "wf-2" }],
      },
      listFails: ["ws-1"],
    });

    const result = await runner.run();

    expect(result).toMatchObject({ workspaces: 2, started: 1, failed: 1 });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-2"]);
    const log = lines.join("\n");
    expect(log).toContain("SCHEDULE_WORKSPACE_FAILED");
    expect(log).not.toContain("postgres://");
  });

  // #1140-T07
  it("says so, every tick, when the stored cron does not parse, and counts the lane as skipped, never as not due", async () => {
    for (const cron of ["0 6 * * MON", "*/x * * * *", "61 6 * * *"]) {
      const lane: LaneSeed = {
        id: "wf-1",
        document: documentWith([
          { id: "weekly", kind: "schedule", cron, steps: [] },
        ]),
      };
      const { runner, created, lines, clock } = setup({
        lanes: { "ws-1": [lane] },
      });

      const first = await runner.run();
      clock.now = at("2026-11-29T08:00:00Z");
      const second = await runner.run();

      expect(first).toMatchObject({
        lanes: 1,
        skipped: 1,
        notDue: 0,
        started: 0,
      });
      expect(second).toMatchObject({ skipped: 1, notDue: 0, started: 0 });
      expect(created).toEqual([]);
      const logged = lines.filter((line) =>
        line.includes("SCHEDULE_CRON_INVALID"),
      );
      expect(logged).toHaveLength(2);
      expect(logged[0]).toContain("workflow=wf-1");
      // The cron text is the lane's data: not repeated in the log.
      expect(lines.join("\n")).not.toContain(cron);
    }
  });

  // #1140-T07
  it("still starts the valid schedule of a lane whose other schedule does not parse", async () => {
    const lane: LaneSeed = {
      id: "wf-1",
      document: documentWith([
        WEEKLY,
        { id: "broken", kind: "schedule", cron: "0 6 * * MON", steps: [] },
      ]),
    };
    const { runner, created, lines } = setup({ lanes: { "ws-1": [lane] } });

    const result = await runner.run();

    expect(result).toMatchObject({ started: 1, skipped: 1 });
    expect(created.map((run) => run.triggerId)).toEqual(["weekly"]);
    expect(lines.join("\n")).toContain("SCHEDULE_CRON_INVALID");
  });

  // #1140-T08
  it("logs a permanent skip once per occurrence, not on every tick of its 24 hours, and still counts it", async () => {
    const { runner, lines, clock } = setup({
      now: at("2026-11-29T06:00:03Z"),
      repository: "none",
    });

    const first = await runner.run();
    const afterFirst = lines.filter((line) =>
      line.includes("SCHEDULE_REPOSITORY_UNAVAILABLE"),
    );
    for (const hour of ["07", "08", "09", "20"]) {
      clock.now = at(`2026-11-29T${hour}:00:03Z`);
      expect(await runner.run()).toMatchObject({ skipped: 1 });
    }

    expect(first.skipped).toBe(1);
    expect(afterFirst).toHaveLength(1);
    expect(
      lines.filter((line) => line.includes("SCHEDULE_REPOSITORY_UNAVAILABLE")),
    ).toHaveLength(1);
  });

  // #1140-T03
  it("is a quiet no-op when no workspace has a scheduled lane", async () => {
    const { runner } = setup({ workspaces: [] });

    expect(await runner.run()).toMatchObject({
      workspaces: 0,
      lanes: 0,
      started: 0,
    });
  });
});
