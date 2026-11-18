// SPDX-License-Identifier: LicenseRef-Proprietary

// The list of the lane runs of a workspace (#1078), against a real Postgres: only the runs of the workspace (with its tickets, versions and
// repositories, never another workspace's), the active runs first and then the newest first, pages by cursor that neither repeat nor skip a
// run, the filters, and one query each for steps, versions and tickets however many runs the page holds.
import type {
  Kysely,
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from "kysely";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import type { Database } from "../schema.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";
import { createTrackerRepository } from "./tracker-repository.ts";
import { createWorkflowRunsRepository } from "./workflow-runs-repository.ts";
import { createWorkflowsRepository } from "./workflows-repository.ts";

const DOCUMENT = JSON.stringify({
  triggers: [{ id: "by-hand", kind: "manual" }],
  steps: [
    { id: "plan", kind: "agent" },
    { id: "ship", kind: "action", connector: "pr.merge" },
  ],
});

/** Counts the queries a repository sends, so a test can say "one for the whole page". */
function queryCounter() {
  const counter = { queries: 0 };
  const plugin: KyselyPlugin = {
    transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
      counter.queries += 1;
      return node;
    },
    transformResult({
      result,
    }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
      return Promise.resolve(result);
    },
  };
  return { counter, plugin };
}

async function seed(
  db: Kysely<Database>,
  workspaceId: string,
  fullName: string,
  externalId: string,
  userId: string,
  workflowName = "Ship it",
) {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 18, 8, 0, tick++));
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
    now,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId,
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId, now);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId,
      fullName,
      url: `https://github.test/${fullName}`,
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  const workflows = createWorkflowsRepository(db, workspaceId, { now });
  const created = await workflows.create(
    { name: workflowName, document: DOCUMENT, createdBy: userId },
    100,
  );
  if (!created.ok) throw new Error("seeding failed");
  const laneId = created.workflow.id;
  const runs = createWorkflowRunsRepository(db, workspaceId, { now });
  let n = 0;
  async function run(
    options: {
      status?: string;
      ticketRef?: string;
      workflowId?: string;
      repositoryId?: string;
    } = {},
  ) {
    n += 1;
    const made = await runs.createRun({
      workflowId: options.workflowId ?? laneId,
      workflowVersion: 1,
      repositoryId: options.repositoryId ?? repository.id,
      baseBranch: "main",
      triggerInput: "{}",
      triggerKind: "manual",
      triggerId: "by-hand",
      budgetMicroUsd: 20_000_000,
      clientRequestId: `${workspaceId}-request-${n}`,
      createdBy: userId,
      actorLogin: "octocat",
      ...(options.ticketRef === undefined
        ? {}
        : { ticketRef: options.ticketRef }),
    });
    if (options.status !== undefined && options.status !== "running")
      await db
        .updateTable("workflow_runs")
        .set({
          status: options.status,
          // The table holds that a run is over exactly when it has an end.
          finished_at:
            options.status === "waiting" ? null : "2026-11-18T09:00:00.000Z",
        })
        .where("id", "=", made.run.id)
        .execute();
    return made.run;
  }
  return {
    runs,
    run,
    repository,
    workflowId: laneId,
    tracker: createTrackerRepository(db, workspaceId, { now }),
  };
}

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const otherId = await addWorkspace(db, "other");
  await addUser(db, "u-1");
  const mine = await seed(db, workspaceId, "acme/widgets", "7001", "u-1");
  const theirs = await seed(
    db,
    otherId,
    "acme/widgets",
    "7002",
    "u-1",
    "Their lane",
  );
  return { db, workspaceId, mine, theirs };
}

const ticket = (number: number, title: string) => ({
  provider: "github",
  repo: "acme/widgets",
  number,
  nodeId: `N_${String(number)}`,
  kind: "issue" as const,
  state: "open" as const,
  stateReason: null,
  type: null,
  title,
  bodyExcerpt: "",
  labels: [],
  assignees: [],
  closes: [],
  updatedAt: "2026-11-18T07:00:00.000Z",
});

describe("the lane runs of a workspace", () => {
  // #1078-T90
  it("lists only the runs of its own workspace, with its own lane, repository, version and ticket", async () => {
    const { mine, theirs } = await setup();
    const own = await mine.run({ ticketRef: "github:acme/widgets#12" });
    await theirs.run({ ticketRef: "github:acme/widgets#12" });
    await mine.tracker.upsertItem(mine.repository.id, ticket(12, "Our title"));
    await theirs.tracker.upsertItem(
      theirs.repository.id,
      ticket(12, "Their title"),
    );

    const { rows, next } = await mine.runs.listWorkspaceRuns({ limit: 10 });

    expect(next).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run: { id: own.id },
      laneName: "Ship it",
      repositoryName: "acme/widgets",
      document: DOCUMENT,
      ticket: { title: "Our title" },
    });
    // The other workspace sees its own run, its own lane and its own ticket title.
    const others = await theirs.runs.listWorkspaceRuns({ limit: 10 });
    expect(others.rows.map((row) => [row.laneName, row.ticket?.title])).toEqual(
      [["Their lane", "Their title"]],
    );
  });

  // #1078-T91
  it("has no ticket for a run without one or one the mirror does not hold, and none from another repository's number", async () => {
    const { mine } = await setup();
    await mine.run({ ticketRef: "github:acme/widgets#13" });
    await mine.run();
    await mine.tracker.upsertItem(
      mine.repository.id,
      ticket(12, "Another ticket"),
    );

    const { rows } = await mine.runs.listWorkspaceRuns({ limit: 10 });

    expect(rows.map((row) => row.ticket)).toEqual([null, null]);
  });

  // #1078-T92
  it("puts the active runs first, then the newest first", async () => {
    const { mine } = await setup();
    const oldRunning = await mine.run();
    const succeeded = await mine.run({ status: "succeeded" });
    const waiting = await mine.run({ status: "waiting" });
    const failed = await mine.run({ status: "failed" });

    const { rows } = await mine.runs.listWorkspaceRuns({ limit: 10 });

    expect(rows.map((row) => row.run.id)).toEqual([
      waiting.id,
      oldRunning.id,
      failed.id,
      succeeded.id,
    ]);
  });

  // #1078-T93
  it("pages by cursor without repeating or skipping a run, across the active and the ended ones", async () => {
    const { mine } = await setup();
    const expected: string[] = [];
    for (let index = 0; index < 7; index += 1)
      expected.unshift(
        (await mine.run({ status: index % 3 === 0 ? "running" : "succeeded" }))
          .id,
      );
    const all = await mine.runs.listWorkspaceRuns({ limit: 50 });
    const order = all.rows.map((row) => row.run.id);

    const seen: string[] = [];
    let after = undefined as
      | Awaited<ReturnType<typeof mine.runs.listWorkspaceRuns>>["next"]
      | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await mine.runs.listWorkspaceRuns({
        limit: 3,
        ...(after === undefined || after === null ? {} : { after }),
      });
      seen.push(...page.rows.map((row) => row.run.id));
      if (page.next === null) break;
      expect(page.rows).toHaveLength(3);
      after = page.next;
    }

    expect(seen).toEqual(order);
    expect(new Set(seen).size).toBe(7);
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  // #1078-T94
  it("does not skip a run when one of the page before has ended meanwhile", async () => {
    const { mine, db } = await setup();
    const a = await mine.run();
    const b = await mine.run();
    const c = await mine.run();
    const first = await mine.runs.listWorkspaceRuns({ limit: 1 });
    expect(first.rows[0]?.run.id).toBe(c.id);
    await db
      .updateTable("workflow_runs")
      .set({ status: "succeeded", finished_at: "2026-11-18T09:00:00.000Z" })
      .where("id", "=", c.id)
      .execute();

    const second = await mine.runs.listWorkspaceRuns({
      limit: 5,
      ...(first.next === null ? {} : { after: first.next }),
    });

    // `c` ended and is no longer on top, so it comes again later; `b` and `a` must not be lost.
    expect(second.rows.map((row) => row.run.id)).toEqual(
      expect.arrayContaining([b.id, a.id]),
    );
  });

  // #1078-T95
  it("filters by status, project and lane", async () => {
    const { mine, db, workspaceId } = await setup();
    const other = await createWorkflowsRepository(db, workspaceId).create(
      { name: "Second lane", document: DOCUMENT, createdBy: "u-1" },
      100,
    );
    if (!other.ok) throw new Error("seeding failed");
    const running = await mine.run();
    const waiting = await mine.run({ status: "waiting" });
    const failed = await mine.run({ status: "failed" });
    const cancelled = await mine.run({ status: "cancelled" });
    const inOtherLane = await mine.run({ workflowId: other.workflow.id });
    const ids = async (
      filter: Parameters<typeof mine.runs.listWorkspaceRuns>[0]["filter"],
    ) =>
      (await mine.runs.listWorkspaceRuns({ filter, limit: 20 })).rows
        .map((row) => row.run.id)
        .sort();

    expect(await ids({ status: "active" })).toEqual(
      [running.id, waiting.id, inOtherLane.id].sort(),
    );
    expect(await ids({ status: "waiting" })).toEqual([waiting.id]);
    expect(await ids({ status: "failed" })).toEqual([failed.id]);
    expect(await ids({ status: "ended" })).toEqual(
      [failed.id, cancelled.id].sort(),
    );
    expect(await ids({ workflowId: other.workflow.id })).toEqual([
      inOtherLane.id,
    ]);
    expect(await ids({ repositoryId: mine.repository.id })).toHaveLength(5);
    expect(await ids({ repositoryId: "no-such-repository" })).toEqual([]);
  });

  // #1078-T96
  it("gives the step summaries of every run in the order they were written, and none for a run without steps", async () => {
    const { mine } = await setup();
    const withSteps = await mine.run();
    const bare = await mine.run();
    await mine.runs.lockRun(withSteps.id, async (lock) => {
      const first = await lock.addStep({
        position: 0,
        stepId: "plan",
        kind: "agent",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
      await lock.finishStep(first.id, {
        status: "succeeded",
        output: '{"secret":"never listed"}',
        costMicroUsd: 5,
      });
      await lock.addStep({
        position: 1,
        stepId: "ship",
        kind: "action",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
    });

    const { rows } = await mine.runs.listWorkspaceRuns({ limit: 10 });

    expect(rows.find((row) => row.run.id === bare.id)?.steps).toEqual([]);
    expect(rows.find((row) => row.run.id === withSteps.id)?.steps).toEqual([
      { stepId: "plan", kind: "agent", status: "succeeded", round: 1 },
      { stepId: "ship", kind: "action", status: "pending", round: 1 },
    ]);
  });

  // #1078-T97
  it("reads a page of runs with the same few queries however many runs it holds", async () => {
    const { db, workspaceId, mine } = await setup();
    for (let index = 0; index < 12; index += 1)
      await mine.run({ ticketRef: `github:acme/widgets#${String(index + 1)}` });
    const { counter, plugin } = queryCounter();
    const counted = createWorkflowRunsRepository(
      db.withPlugin(plugin),
      workspaceId,
    );

    const { rows } = await counted.listWorkspaceRuns({ limit: 12 });

    expect(rows).toHaveLength(12);
    // The runs with their lane and repository, then the steps, the versions and the tickets: one query each.
    expect(counter.queries).toBeLessThanOrEqual(4);
  });
});
