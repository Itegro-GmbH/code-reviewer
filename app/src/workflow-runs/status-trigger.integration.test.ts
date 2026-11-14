// SPDX-License-Identifier: LicenseRef-Proprietary

// #1036: a ticket moved into a board status starts the workflows that wait for it. A real Postgres database, the route's handler with a
// signed `projects_v2_item` delivery as GitHub sends it, the real ticket mirror and status trigger. The ticket the board item names is
// read from the platform only when a workflow matched; here that read is a map. What the run does after it started is the engine's, and
// is covered by the label trigger's tests (the run is the same).
import { describe, expect, it } from "vitest";
import { webhookFixture } from "../../../fakes/github/webhooks.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createProjectService } from "../projects/service.ts";
import {
  SUMMARY_RESULT,
  startEngineHarness,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { createTrackerMirror } from "../tracker/mirror.ts";
import { createStatusTrigger } from "./status-trigger.ts";

const READY = "In Progress";

function statusLane(to = READY, name = "Status lane"): Record<string, unknown> {
  return {
    version: 1,
    name,
    triggers: [{ id: "ready", kind: "ticket.statusChanged", to, steps: [] }],
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "worker",
        environment: "Python",
        instruction:
          "{{trigger.ticket.title}} ({{trigger.status.from}} to {{trigger.status.to}})",
        result: SUMMARY_RESULT,
      },
    ],
  };
}

async function startHarness() {
  const app = await startEngineHarness({});
  const kicked: string[] = [];
  const projects = createProjectService({
    projects: createProjectsRepository(app.h.db, app.h.workspaceId),
  });
  const tracker = createTrackerRepository(app.h.db, app.h.workspaceId);
  // Only the board the project chose starts a run: the one the fixtures' deliveries name.
  await createProjectsRepository(app.h.db, app.h.workspaceId).setTicketBoard(
    app.project.id,
    {
      projectV2Id: "PVT_1",
      statusFieldId: "PVTSSF_1",
    },
  );
  app.h.setTracker(
    createTrackerMirror({
      repositories: app.h.repositories,
      projects,
      tracker,
      async boardOf(repositoryId) {
        return (await projects.getActiveProjectForRepository(repositoryId))
          ?.ticketSource.board?.projectV2Id;
      },
      async boardStatusOf() {
        return { available: false, status: null };
      },
      async checksStateOf() {
        return null;
      },
    }),
  );
  app.h.setStatusTrigger(
    createStatusTrigger({
      runs: app.runs,
      workflows: app.workflows,
      async ticketOfNode(nodeId) {
        const item = await tracker.findItemByNode(nodeId);
        return item === undefined || item.kind !== "issue"
          ? undefined
          : {
              provider: item.provider,
              repositoryId: item.repositoryId,
              integrationId:
                (await app.h.repositories.get(item.repositoryId))
                  ?.integrationId ?? "",
              key: item.key,
            };
      },
      // The platform is not asked in a test: the item has the status the mirror took from the delivery.
      async currentStatusOf(_repositoryId, nodeId) {
        const row = await app.h.db
          .selectFrom("tracker_items")
          .select("board_status")
          .where("node_id", "=", nodeId)
          .executeTakeFirst();
        return { available: true, status: row?.board_status ?? null };
      },
      async boardOf(repositoryId) {
        return (await projects.getActiveProjectForRepository(repositoryId))
          ?.ticketSource.board?.projectV2Id;
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
      async readTicket(_repositoryId, key) {
        return {
          key,
          number: Number(key),
          title: "Cache the widget list",
          body: "Rebuilt on every request.",
          url: "https://github.com/acme/widgets/issues/12",
          labels: ["enhancement"],
          assignees: [],
          type: "",
        };
      },
      kick: (runId) => void kicked.push(runId),
    }),
  );
  // The issue the board item names, in the mirror: the delivery of the issue writes it.
  await app.h.deliver("issues.edited.mirror", { deliveryId: "seed-issue" });
  return { app, kicked };
}

/** A delivery of `projects_v2_item.edited` that moves the item into `to`. */
function moveInto(to: string, from = "Todo") {
  const payload = webhookFixture("projects_v2_item.edited") as {
    changes: { field_value: Record<string, unknown> };
  };
  return {
    ...payload,
    changes: {
      field_value: {
        ...payload.changes.field_value,
        from: { id: "a1", name: from },
        to: { id: "b2", name: to },
      },
    },
  };
}

async function outcomeOf(response: Response): Promise<unknown> {
  expect(response.status).toBe(202);
  return ((await response.json()) as { outcome: string }).outcome;
}

const runsOf = (app: EngineHarness, workflowId: string) =>
  app.runs.listRuns(workflowId, 50);

describe("a board move starts the workflows that wait for the status", () => {
  // #1036-T01
  it("starts exactly one run with the ticket fields and the statuses when a person moves the item into the trigger status", async () => {
    const { app, kicked } = await startHarness();
    const lane = await app.saveWorkflow(statusLane());

    const response = await app.h.deliver("projects_v2_item.edited", {
      deliveryId: "move-1",
    });

    expect(await outcomeOf(response)).toBe("workflow_runs_started");
    const runs = await runsOf(app, lane.id);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({
      workflowId: lane.id,
      workflowVersion: 1,
      status: "running",
      triggerKind: "ticket.statusChanged",
      triggerId: "ready",
      createdBy: null,
      actorLogin: "bob",
      baseBranch: "main",
      ticketRef: "github:acme/widgets#12",
      clientRequestId: `gh-move-1-${lane.id}`,
    });
    expect(JSON.parse(run?.triggerInput ?? "null")).toMatchObject({
      ticket: {
        key: "12",
        number: 12,
        title: "Cache the widget list",
        repo: { fullName: "acme/widgets", defaultBranch: "main" },
      },
      status: { from: "Todo", to: READY },
    });
    expect(kicked).toEqual([run?.id]);
    // The page of the run shows the real trigger and who moved the ticket.
    expect(await app.service.get(lane.id, run?.id ?? "")).toMatchObject({
      trigger: "ticket.statusChanged",
      triggerId: "ready",
      actorLogin: "bob",
    });
    // The mirror holds the new status as well, and the delivery stays a duplicate.
    expect(
      await app.h.db
        .selectFrom("tracker_items")
        .select("board_status")
        .where("node_id", "=", "I_kwDOAAA12")
        .executeTakeFirst(),
    ).toEqual({ board_status: READY });
    expect(
      await app.h.db
        .selectFrom("webhook_deliveries")
        .select("outcome")
        .where("delivery_id", "=", "move-1")
        .executeTakeFirst(),
    ).toEqual({ outcome: "workflow_runs_started" });
  });

  // #1036-T02
  it("starts nothing for a move into another status", async () => {
    const { app } = await startHarness();
    const lane = await app.saveWorkflow(statusLane());

    const response = await app.h.deliver("projects_v2_item.edited", {
      deliveryId: "move-1",
      payload: moveInto("Done"),
    });

    expect(await outcomeOf(response)).toBe("tracker_updated");
    expect(await runsOf(app, lane.id)).toHaveLength(0);
  });

  // #1036-T02
  it("starts nothing for a second move into the status while the run is active, and the next one when it has ended", async () => {
    const { app, kicked } = await startHarness();
    const lane = await app.saveWorkflow(statusLane());
    await app.h.deliver("projects_v2_item.edited", { deliveryId: "move-1" });

    // The item goes out and back in while the first run goes on: a second delivery, another delivery id.
    const again = await app.h.deliver("projects_v2_item.edited", {
      deliveryId: "move-2",
      payload: moveInto(READY, "Todo"),
    });

    expect(await outcomeOf(again)).toBe("tracker_updated");
    const [run] = await runsOf(app, lane.id);
    expect(await runsOf(app, lane.id)).toHaveLength(1);
    expect(kicked).toEqual([run?.id]);

    // The run ends: the next move starts the next run.
    await app.h.db
      .updateTable("workflow_runs")
      .set({ status: "succeeded", finished_at: "2026-11-14T10:00:00.000Z" })
      .where("id", "=", run?.id ?? "")
      .execute();
    const next = await app.h.deliver("projects_v2_item.edited", {
      deliveryId: "move-3",
      payload: moveInto(READY, "Todo"),
    });
    expect(await outcomeOf(next)).toBe("workflow_runs_started");
    expect(await runsOf(app, lane.id)).toHaveLength(2);
  });

  it("starts a run for a move whoever made it, the factory's own App included", async () => {
    const { app } = await startHarness();
    const lane = await app.saveWorkflow(statusLane());
    const payload = {
      ...moveInto(READY),
      sender: { login: "code-review-app[bot]", id: 77, type: "Bot" },
    };

    const response = await app.h.deliver("projects_v2_item.edited", {
      deliveryId: "move-1",
      payload,
    });

    expect(await outcomeOf(response)).toBe("workflow_runs_started");
    expect((await runsOf(app, lane.id))[0]).toMatchObject({
      actorLogin: "code-review-app[bot]",
      createdBy: null,
    });
  });

  it("starts nothing twice: the retry of a delivery changes nothing", async () => {
    const { app } = await startHarness();
    const lane = await app.saveWorkflow(statusLane());
    await app.h.deliver("projects_v2_item.edited", { deliveryId: "move-1" });

    const retry = await app.h.deliver("projects_v2_item.edited", {
      deliveryId: "move-1",
    });

    expect(await outcomeOf(retry)).toBe("duplicate");
    expect(await runsOf(app, lane.id)).toHaveLength(1);
  });

  it("starts only the lanes that wait for this status: not a label lane, not a lane of another status", async () => {
    const { app } = await startHarness();
    const waiting = await app.saveWorkflow(statusLane(READY, "Waiting lane"));
    const other = await app.saveWorkflow(statusLane("Done", "Other lane"));
    const labeled = await app.saveWorkflow({
      ...statusLane(),
      name: "Label lane",
      triggers: [{ id: "labeled", kind: "ticket.labeled", label: "go" }],
      steps: [
        {
          id: "implement",
          kind: "agent",
          profile: "worker",
          environment: "Python",
          instruction: "{{trigger.ticket.title}}",
          result: SUMMARY_RESULT,
        },
      ],
    });

    await app.h.deliver("projects_v2_item.edited", { deliveryId: "move-1" });

    expect(await runsOf(app, waiting.id)).toHaveLength(1);
    expect(await runsOf(app, other.id)).toHaveLength(0);
    expect(await runsOf(app, labeled.id)).toHaveLength(0);
  });

  it("starts nothing for a lane whose project is switched off", async () => {
    const { app } = await startHarness();
    const lane = await app.saveWorkflow(statusLane());
    await app.h.projects.deactivateProject(app.repository.id);

    const response = await app.h.deliver("projects_v2_item.edited", {
      deliveryId: "move-1",
    });

    // The mirror still takes the status (its row exists); no lane of a switched-off project starts.
    expect(await outcomeOf(response)).toBe("tracker_updated");
    expect(await runsOf(app, lane.id)).toHaveLength(0);
  });
});
