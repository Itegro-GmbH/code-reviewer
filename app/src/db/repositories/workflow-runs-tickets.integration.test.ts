// SPDX-License-Identifier: LicenseRef-Proprietary

// What the runs of a ticket add up to (#923), against a real Postgres: the money of every run of the ticket whatever its status, the newest
// running run as the ticket's lane with its workflow's name and its current step, and nothing of another workspace's tickets. Read at the time
// of the question; nothing is stored.
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "../../test-support/test-database.ts";
import { addUser } from "../../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../../test-support/workspaces.ts";
import { createIntegrationsRepository } from "./integrations-repository.ts";
import { createRepositoriesRepository } from "./repositories-repository.ts";
import { createWorkflowRunsRepository } from "./workflow-runs-repository.ts";
import { createWorkflowsRepository } from "./workflows-repository.ts";

async function setup() {
  const { db } = await createTestDatabase();
  const workspaceId = await defaultWorkspaceId(db);
  const otherId = await addWorkspace(db, "other");
  await addUser(db, "u-1");
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 7, 8, 0, tick++));
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
    now,
  ).create({
    type: "github_app",
    displayName: "acme",
    externalId: "4242",
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId, now);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
  ]);
  const [repository] = await repositories.list();
  if (repository === undefined) throw new Error("seeding failed");
  const workflows = createWorkflowsRepository(db, workspaceId, { now });
  const created = await workflows.create(
    { name: "Issue to PR", document: "{}", createdBy: "u-1" },
    100,
  );
  if (!created.ok) throw new Error("seeding failed");
  const workflowId = created.workflow.id;
  const repositoryId = repository.id;
  const runs = createWorkflowRunsRepository(db, workspaceId, { now });
  let n = 0;
  async function run(ticketRef: string | undefined, spent: number) {
    n += 1;
    const made = await runs.createRun({
      workflowId,
      workflowVersion: 1,
      repositoryId,
      baseBranch: "main",
      triggerInput: "{}",
      budgetMicroUsd: 20_000_000,
      clientRequestId: `request-${n}`,
      createdBy: "u-1",
      actorLogin: "octocat",
      ...(ticketRef === undefined ? {} : { ticketRef }),
    });
    await db
      .updateTable("workflow_runs")
      .set({ spent_micro_usd: spent })
      .where("id", "=", made.run.id)
      .execute();
    return made.run;
  }
  return {
    db,
    runs,
    run,
    otherRuns: createWorkflowRunsRepository(db, otherId, { now }),
    workspaceId,
    workflowId,
  };
}

const REF = "github:acme/widgets#12";

describe("the runs of a ticket", () => {
  // #923-T108
  it("adds up the money of every run of the ticket and names the run that is going on, with its workflow and its step", async () => {
    const { runs, run, db, workflowId } = await setup();
    const ended = await run(REF, 1_500_000);
    await db
      .updateTable("workflow_runs")
      .set({ status: "succeeded", finished_at: "2026-11-07T09:00:00.000Z" })
      .where("id", "=", ended.id)
      .execute();
    const active = await run(REF, 2_250_000);
    await runs.lockRun(active.id, async (lock) => {
      const first = await lock.addStep({
        position: 0,
        stepId: "plan",
        kind: "action",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
      await lock.addStep({
        position: 1,
        stepId: "implement",
        kind: "action",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
      await lock.finishStep(first.id, {
        status: "succeeded",
        output: null,
        costMicroUsd: null,
      });
    });

    expect(await runs.summarizeTickets([REF])).toEqual([
      {
        ticketRef: REF,
        spentMicroUsd: 3_750_000,
        activeRun: {
          runId: active.id,
          workflowId,
          workflowName: "Issue to PR",
          // The step that waits next: the first one has ended.
          stepId: "implement",
          status: "running",
        },
      },
    ]);
  });

  // #925-T01
  it("names a run that waits for an answer as the active run, with the step that asks", async () => {
    const { runs, run, db, workflowId } = await setup();
    const waiting = await run(REF, 500_000);
    await runs.lockRun(waiting.id, async (lock) => {
      await lock.addStep({
        position: 0,
        stepId: "plan",
        kind: "action",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
      await lock.addStep({
        position: 1,
        stepId: "implement",
        kind: "agent",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
    });
    await db
      .updateTable("workflow_runs")
      .set({ status: "waiting" })
      .where("id", "=", waiting.id)
      .execute();
    await db
      .updateTable("workflow_step_runs")
      // A waiting step always holds its question (workflow_step_runs_ask_check).
      .set({
        status: "waiting",
        ask: JSON.stringify({ state: "open", question: "Which branch?" }),
      })
      .where("run_id", "=", waiting.id)
      .where("step_id", "=", "implement")
      .execute();

    expect(await runs.summarizeTickets([REF])).toEqual([
      {
        ticketRef: REF,
        spentMicroUsd: 500_000,
        activeRun: {
          runId: waiting.id,
          workflowId,
          workflowName: "Issue to PR",
          stepId: "implement",
          status: "waiting",
        },
      },
    ]);
  });

  // #925-T01
  it("leaves a discarded run out, and names the newest of a running and a newer waiting run", async () => {
    const { runs, run, db, workflowId } = await setup();
    const older = await run(REF, 0);
    const newer = await run(REF, 0);
    const discarded = await run(REF, 0);
    await db
      .updateTable("workflow_runs")
      .set({ status: "waiting" })
      .where("id", "=", newer.id)
      .execute();
    await db
      .updateTable("workflow_runs")
      // A discarded run is over: it has its end (workflow_runs_end_check).
      .set({
        status: "discarded",
        discarded_at: "2026-11-07T09:30:00.000Z",
        finished_at: "2026-11-07T09:30:00.000Z",
      })
      .where("id", "=", discarded.id)
      .execute();

    const [summary] = await runs.summarizeTickets([REF]);

    expect(older.id).not.toBe(newer.id);
    expect(summary?.activeRun).toEqual({
      runId: newer.id,
      workflowId,
      workflowName: "Issue to PR",
      stepId: null,
      status: "waiting",
    });
  });

  // #925-T01
  it("shows the step that runs, then the one that waits for the answer, then the next one that is pending", async () => {
    const { runs, run, db } = await setup();
    const made = await run(REF, 0);
    await runs.lockRun(made.id, async (lock) => {
      for (const [position, stepId] of ["first", "second", "third"].entries())
        await lock.addStep({
          position,
          stepId,
          kind: "agent",
          round: 1,
          profile: null,
          capMicroUsd: null,
        });
    });
    const setStep = (stepId: string, status: "running" | "waiting") =>
      db
        .updateTable("workflow_step_runs")
        .set(
          status === "waiting"
            ? {
                status,
                ask: JSON.stringify({ state: "open", question: "Which?" }),
              }
            : { status },
        )
        .where("run_id", "=", made.id)
        .where("step_id", "=", stepId)
        .execute();
    const stepOf = async () =>
      (await runs.summarizeTickets([REF]))[0]?.activeRun?.stepId;

    // Only pending steps: the first of them.
    expect(await stepOf()).toBe("first");
    // A waiting step comes before a pending one that is earlier.
    await setStep("second", "waiting");
    expect(await stepOf()).toBe("second");
    // A running step comes before a waiting one.
    await setStep("third", "running");
    expect(await stepOf()).toBe("third");
  });

  // #923-T109
  it("has no active run for a ticket whose runs have ended, and says nothing of a ticket without a run", async () => {
    const { runs, run, db } = await setup();
    const ended = await run(REF, 1_000_000);
    await db
      .updateTable("workflow_runs")
      .set({
        status: "failed",
        error_code: "action_failed",
        finished_at: "2026-11-07T09:00:00.000Z",
      })
      .where("id", "=", ended.id)
      .execute();
    await run("github:acme/widgets#99", 5);

    const summaries = await runs.summarizeTickets([
      REF,
      "github:acme/widgets#7",
    ]);

    expect(summaries).toEqual([
      { ticketRef: REF, spentMicroUsd: 1_000_000, activeRun: null },
    ]);
    expect(await runs.summarizeTickets([])).toEqual([]);
  });

  // #923-T110
  it("names the step that runs now before the ones that wait, and keeps the tickets apart", async () => {
    const { runs, run } = await setup();
    const first = await run(REF, 0);
    await run("github:acme/widgets#13", 7);
    const running = await runs.lockRun(first.id, async (lock) => {
      await lock.addStep({
        position: 0,
        stepId: "later",
        kind: "action",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
      return lock.addStep({
        position: 1,
        stepId: "now",
        kind: "action",
        round: 1,
        profile: null,
        capMicroUsd: null,
      });
    });
    // The claim has its own transaction: it is taken after the lock of the run is let go.
    if (running === undefined) throw new Error("seeding failed");
    await runs.claimStep(running.id);

    const summaries = await runs.summarizeTickets([
      REF,
      "github:acme/widgets#13",
    ]);

    expect(summaries.find((s) => s.ticketRef === REF)?.activeRun?.stepId).toBe(
      "now",
    );
    expect(
      summaries.find((s) => s.ticketRef === "github:acme/widgets#13"),
    ).toMatchObject({
      spentMicroUsd: 7,
      activeRun: { stepId: null },
    });
  });

  // #923-T111
  it("does not read the runs of another workspace", async () => {
    const { run, otherRuns } = await setup();
    await run(REF, 1_000_000);

    expect(await otherRuns.summarizeTickets([REF])).toEqual([]);
  });

  // #923-T112
  it("refuses a ticket reference that is too long", async () => {
    const { run } = await setup();

    await expect(run("x".repeat(513), 0)).rejects.toThrow();
  });
});

describe("the runs that wait for an answer (#920)", () => {
  // #920-T127
  it("finds the waiting runs of a ticket by its reference, newest first, and the waiting runs of a repository that are about no ticket", async () => {
    const { runs, otherRuns, run, db } = await setup();
    const wait = (id: string, at: string) =>
      db
        .updateTable("workflow_runs")
        .set({ status: "waiting", updated_at: at })
        .where("id", "=", id)
        .execute();
    const older = await run(REF, 0);
    const newer = await run(REF, 0);
    const running = await run(REF, 0);
    const other = await run("github:acme/widgets#13", 0);
    const noTicket = await run(undefined, 0);
    await wait(older.id, "2026-11-07T09:00:00.000Z");
    await wait(newer.id, "2026-11-07T10:00:00.000Z");
    await wait(other.id, "2026-11-07T10:00:00.000Z");
    await wait(noTicket.id, "2026-11-07T10:00:00.000Z");

    expect(
      (await runs.listWaitingForTicket(REF, 10)).map((found) => found.id),
    ).toEqual([newer.id, older.id]);
    expect(
      (await runs.listWaitingForTicket(REF, 1)).map((found) => found.id),
    ).toEqual([newer.id]);
    expect(
      (await runs.listWaitingWithoutTicket(older.repositoryId, 10)).map(
        (found) => found.id,
      ),
    ).toEqual([noTicket.id]);
    expect(running.status).toBe("running");
    // #921: the runs that go on in a repository are the running and the waiting ones, whatever their ticket.
    expect(
      (await runs.listActiveOnRepository(older.repositoryId, 10)).map(
        (found) => found.id,
      ),
    ).toEqual(
      expect.arrayContaining([
        older.id,
        newer.id,
        running.id,
        other.id,
        noTicket.id,
      ]),
    );
    expect(
      await runs.listActiveOnRepository(older.repositoryId, 2),
    ).toHaveLength(2);
    // Another workspace sees none of them.
    expect(await otherRuns.listWaitingForTicket(REF, 10)).toEqual([]);
    expect(
      await otherRuns.listWaitingWithoutTicket(older.repositoryId, 10),
    ).toEqual([]);
    expect(
      await otherRuns.listActiveOnRepository(older.repositoryId, 10),
    ).toEqual([]);
  });
});
