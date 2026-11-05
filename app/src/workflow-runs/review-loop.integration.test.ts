// SPDX-License-Identifier: LicenseRef-Proprietary

// The review loop (#846, agent workflows, milestone 5): a label on an issue starts "Issue to PR", the agent implements, a reviewer looks at
// the branch, the agent goes on in its own session with the findings, until the review finds nothing (a pull request) or three rounds are
// over (a comment on the issue). A real Postgres database, the real engine and Implementer queue, the real GitHub connectors against the
// fake GitHub. What a turn does inside its VM is not simulated: the test ends a turn with the report a runner would send.
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { sha } from "../test-support/jobs.ts";
import {
  SUMMARY_RESULT,
  USER,
  startEngineHarness,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { issueToPr } from "../workflows/test-fixtures.ts";
import { createGithubConnectors } from "./github-connectors.ts";
import { createLabelTrigger } from "./label-trigger.ts";

const REPO = "acme/widgets";
const ISSUE = 12;

/** The finding a reviewer reports in round `round`. */
const finding = (round: number) => ({
  type: "bug",
  name: `Bug ${String(round)}`,
  description: "The cache is never emptied.",
});

/** The plan's workflow with the profiles and the environment of the test: `worker` pushes, `reviewer` does not, `Python` is the environment. */
function issueToPrDocument(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(issueToPr())
      .replaceAll("implementer@1", "worker@1")
      .replaceAll('"node"', '"Python"'),
  ) as Record<string, unknown>;
}

/** The harness with the real GitHub connectors, and the label trigger behind the webhook; the issue is on the fake GitHub. */
async function startHarness(options: { poolMax?: number } = {}) {
  // The connectors need the harness (its database and registry), the harness needs the connectors: the target is asked per call.
  const holder: { app?: EngineHarness } = {};
  const connectors = createGithubConnectors({
    async targetOf(call) {
      const app = holder.app;
      if (app === undefined) return undefined;
      const repository = await app.h.repositories.get(call.repository.id);
      if (repository === undefined) return undefined;
      const integration = await createIntegrationsRepository(
        app.h.db,
        app.h.workspaceId,
      ).get(repository.integrationId);
      if (integration === undefined) return undefined;
      return {
        provider: app.h.registry.resolve(integration.type),
        integration,
        repo: {
          integrationId: repository.integrationId,
          externalId: repository.externalId,
          fullName: repository.fullName,
          url: repository.url,
        },
      };
    },
  });
  const app = await startEngineHarness({ connectors, ...options });
  holder.app = app;
  app.h.setLabelTrigger(
    createLabelTrigger({
      runs: app.runs,
      workflows: app.workflows,
      async activeRepository(repo) {
        const found = await app.h.repositories.findByExternalId(
          repo.integrationId,
          repo.externalId,
        );
        return found?.active === true ? { id: found.id } : undefined;
      },
      kick: () => undefined,
    }),
  );
  app.h.fake.addIssue(REPO, {
    number: ISSUE,
    title: "Cache the widget list",
    labels: ["enhancement", "ready for agent"],
  });
  return app;
}

/** Puts the label on the issue the way GitHub tells the App, and lets the engine take the first steps. */
async function labeled(app: EngineHarness) {
  const workflow = await app.saveWorkflow(issueToPrDocument());
  const response = await app.h.deliver("issues.labeled", {
    deliveryId: "delivery-1",
  });
  expect(response.status).toBe(202);
  const [run] = await app.runs.listRuns(workflow.id, 10);
  if (run === undefined) throw new Error("the label started no run");
  await app.engine.advance(run.id);
  return { workflow, runId: run.id };
}

/** Ends the oldest waiting turn the way a runner reports it, and tells the engine as the runner API's hook does. */
async function endTurn(
  app: EngineHarness,
  report: Parameters<EngineHarness["finishTurn"]>[0] = {},
): Promise<string> {
  const jobId = await app.finishTurn(report);
  await app.engine.jobEnded(jobId);
  return jobId;
}

/** The Worker pushed the branch of the first implement turn: the fake GitHub knows it. */
function pushImplementBranch(app: EngineHarness, runId: string): void {
  app.h.fake.addBranch(REPO, `workflow/${runId}/implement`, sha("d"));
}

async function turnOf(app: EngineHarness, jobId: string) {
  return app.h.db
    .selectFrom("implementer_turns")
    .innerJoin(
      "implementer_sessions",
      "implementer_sessions.id",
      "implementer_turns.session_id",
    )
    .select([
      "implementer_turns.number",
      "implementer_turns.instruction",
      "implementer_turns.cost_limit_cents",
      "implementer_turns.session_id",
      "implementer_turns.profile_name",
      "implementer_sessions.branch",
    ])
    .where("implementer_turns.job_id", "=", jobId)
    .executeTakeFirstOrThrow();
}

/** Each row as `step#round:kind:status`, in the order the steps ran. */
function rowsOf(state: Awaited<ReturnType<EngineHarness["stateOf"]>>) {
  return state.steps.map(
    (step) =>
      `${step.stepId}#${String(step.round)}:${step.kind}:${step.status}`,
  );
}

function jobOf(
  state: Awaited<ReturnType<EngineHarness["stateOf"]>>,
  stepId: string,
  round: number,
): string {
  const step = state.steps.find(
    (candidate) => candidate.stepId === stepId && candidate.round === round,
  );
  if (step?.jobId == null)
    throw new Error(`${stepId} round ${round} has no job`);
  return step.jobId;
}

describe("Issue to PR: a label, implement and review in rounds, then a pull request or a comment", () => {
  // #846-T100
  it("opens the pull request when the review of round two finds nothing: the agent went on in its own session", async () => {
    const app = await startHarness();
    const { runId } = await labeled(app);
    pushImplementBranch(app, runId);

    // Round one: implement, then a review that finds a bug.
    await endTurn(app, { agentResult: { summary: "Round one." } });
    await endTurn(app, { agentResult: { findings: [finding(1)] } });
    // Round two: the agent goes on with the findings, the review finds nothing.
    await endTurn(app, { agentResult: { summary: "Round two." } });
    await endTurn(app, { agentResult: { findings: [] } });

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "succeeded",
      errorCode: null,
      spentMicroUsd: 2_000_000,
    });
    expect(rowsOf(state)).toEqual([
      "start#1:action:succeeded",
      "implement#1:agent:succeeded",
      "review#1:agent:succeeded",
      "implement#2:agent:succeeded",
      "review#2:agent:succeeded",
      "fix#1:loop:succeeded",
      "done#1:if:succeeded",
      "stuck#1:action:skipped",
      "pr#1:action:succeeded",
    ]);
    const output = (stepId: string) =>
      JSON.parse(
        state.steps.find((step) => step.stepId === stepId)?.output ?? "null",
      ) as unknown;
    expect(output("fix")).toEqual({ exit: "until", rounds: 2 });
    expect(output("done")).toEqual({ taken: "then" });

    // The turns: round two of `implement` is the second turn of the session round one started; each review is a session of its own, on
    // a branch no earlier round took.
    const first = await turnOf(app, jobOf(state, "implement", 1));
    const second = await turnOf(app, jobOf(state, "implement", 2));
    expect(first).toMatchObject({
      number: 1,
      branch: `workflow/${runId}/implement`,
      instruction:
        "Cache the widget list\n\nThe widget list is rebuilt on every request.\nCache it for a minute.",
    });
    expect(second).toMatchObject({
      number: 2,
      session_id: first.session_id,
      branch: `workflow/${runId}/implement`,
      profile_name: "worker",
    });
    // The findings of the round before are the text of the instruction, one per line.
    expect(second.instruction).toMatch(/^Fix these review findings:\n- \{/);
    expect(second.instruction).toContain('"name":"Bug 1"');
    const reviews = [
      await turnOf(app, jobOf(state, "review", 1)),
      await turnOf(app, jobOf(state, "review", 2)),
    ];
    expect(reviews.map((turn) => [turn.number, turn.branch])).toEqual([
      [1, `workflow/${runId}/review`],
      [1, `workflow/${runId}/review-r2`],
    ]);
    expect(reviews[0]?.session_id).not.toBe(reviews[1]?.session_id);
    expect(reviews[0]?.instruction).toBe(
      `Review branch workflow/${runId}/implement against the issue.`,
    );
    expect(await app.counts()).toEqual({ jobs: 4, sessions: 3, turns: 4 });

    // On GitHub: the labels were swapped, the pull request is open with the summary of round two, and nothing was said on the issue.
    expect(app.h.fake.issueLabels(REPO, ISSUE)).toEqual([
      "enhancement",
      "agent working",
    ]);
    const opened = app.h.fake
      .pullRequests(REPO)
      .filter((pull) => pull.headRef === `workflow/${runId}/implement`);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      title: "Cache the widget list",
      baseRef: "main",
      state: "open",
    });
    expect(opened[0]?.body).toBe("Round two.\n\nCloses #12");
    expect(app.h.fake.issueComments(REPO, ISSUE)).toEqual([]);
  });

  // #846-T101
  it("comments the open findings on the issue after three rounds, and opens no pull request", async () => {
    const app = await startHarness();
    const { runId } = await labeled(app);
    pushImplementBranch(app, runId);

    for (const round of [1, 2, 3]) {
      await endTurn(app, {
        agentResult: { summary: `Round ${String(round)}.` },
      });
      await endTurn(app, { agentResult: { findings: [finding(round)] } });
    }

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "succeeded",
      spentMicroUsd: 3_000_000,
    });
    expect(rowsOf(state)).toEqual([
      "start#1:action:succeeded",
      "implement#1:agent:succeeded",
      "review#1:agent:succeeded",
      "implement#2:agent:succeeded",
      "review#2:agent:succeeded",
      "implement#3:agent:succeeded",
      "review#3:agent:succeeded",
      "fix#1:loop:succeeded",
      "done#1:if:succeeded",
      "pr#1:action:skipped",
      "stuck#1:action:succeeded",
    ]);
    const loop = state.steps.find((step) => step.stepId === "fix");
    expect(JSON.parse(loop?.output ?? "null")).toEqual({
      exit: "maxRounds",
      rounds: 3,
    });
    // One session for the agent (turns 1, 2, 3), a new one for each review.
    const implement = [
      await turnOf(app, jobOf(state, "implement", 1)),
      await turnOf(app, jobOf(state, "implement", 2)),
      await turnOf(app, jobOf(state, "implement", 3)),
    ];
    expect(implement.map((turn) => turn.number)).toEqual([1, 2, 3]);
    expect(new Set(implement.map((turn) => turn.session_id)).size).toBe(1);
    expect(await app.counts()).toEqual({ jobs: 6, sessions: 4, turns: 6 });

    expect(app.h.fake.pullRequests(REPO)).toEqual([]);
    const [comment] = app.h.fake.issueComments(REPO, ISSUE);
    expect(app.h.fake.issueComments(REPO, ISSUE)).toHaveLength(1);
    expect(comment?.body).toContain("Stopped after 3 rounds. Open findings:");
    // The findings of the last round, not of the first.
    expect(comment?.body).toContain('"name":"Bug 3"');
    expect(comment?.body).not.toContain('"name":"Bug 1"');
  });

  // #846-T102
  it("starts the run from the label like any other: the workflow with a loop and an if is no longer left out", async () => {
    const app = await startHarness();
    const workflow = await app.saveWorkflow(issueToPrDocument());

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });

    expect(response.status).toBe(202);
    expect(((await response.json()) as { outcome: string }).outcome).toBe(
      "workflow_runs_started",
    );
    expect(await app.runs.listRuns(workflow.id, 10)).toHaveLength(1);
  });
});

/** A manual workflow: a loop of one agent step that goes on in its own session, until it says it is done. */
function workLoop(
  patch: { budgetUsd?: number; maxRounds?: number } = {},
): Record<string, unknown> {
  return {
    version: 1,
    name: "Work until done",
    trigger: {
      kind: "manual",
      input: {
        type: "object",
        required: ["repo"],
        properties: { repo: { type: "string" } },
      },
    },
    ...(patch.budgetUsd === undefined ? {} : { budgetUsd: patch.budgetUsd }),
    steps: [
      {
        id: "again",
        kind: "loop",
        maxRounds: patch.maxRounds ?? 5,
        body: [
          {
            id: "work",
            kind: "agent",
            profile: "worker",
            environment: "Python",
            session: { continue: "work" },
            instruction: {
              first: "Start.",
              next: "Go on after: {{previous.work.summary}}",
            },
            result: SUMMARY_RESULT,
          },
        ],
        until: { equals: ["{{work.summary}}", "done"] },
      },
    ],
  };
}

async function startedLoop(
  app: EngineHarness,
  document: Record<string, unknown>,
) {
  const workflow = await app.saveWorkflow(document);
  const { run } = await app.start(workflow.id, {
    input: { repo: REPO },
  });
  await app.engine.advance(run.id);
  return run.id;
}

describe("the budget over the rounds of a loop", () => {
  // #846-T110
  it("holds every round to what is left of the budget, and ends the loop with budget when it cannot pay another agent step", async () => {
    const app = await startEngineHarness();
    const runId = await startedLoop(app, workLoop({ budgetUsd: 1 }));
    app.h.fake.addBranch(REPO, `workflow/${runId}/work`, sha("d"));

    await endTurn(app, { agentResult: { summary: "more" }, costUsd: 0.75 });

    let state = await app.stateOf(runId);
    expect(rowsOf(state)).toEqual([
      "work#1:agent:succeeded",
      "work#2:agent:running",
    ]);
    // 25 cents are left: the second turn may spend that, whatever the limit of the first was.
    expect(state.steps[1]?.capMicroUsd).toBe(250_000);
    const second = await turnOf(app, jobOf(state, "work", 2));
    expect(second).toMatchObject({ number: 2, cost_limit_cents: 25 });
    expect(second.instruction).toBe("Go on after: more");

    await endTurn(app, { agentResult: { summary: "more" }, costUsd: 0.25 });

    state = await app.stateOf(runId);
    expect(rowsOf(state)).toEqual([
      "work#1:agent:succeeded",
      "work#2:agent:succeeded",
      "again#1:loop:succeeded",
    ]);
    expect(JSON.parse(state.steps[2]?.output ?? "null") as unknown).toEqual({
      exit: "budget",
      rounds: 2,
    });
    expect(state.run).toMatchObject({
      status: "succeeded",
      spentMicroUsd: 1_000_000,
    });
    expect(await app.counts()).toMatchObject({ jobs: 2, turns: 2 });
  });

  // #846-T111
  it("ends the loop with until before it asks the budget or the rounds", async () => {
    const app = await startEngineHarness();
    const runId = await startedLoop(app, workLoop({ maxRounds: 1 }));

    await endTurn(app, { agentResult: { summary: "done" } });

    const state = await app.stateOf(runId);
    expect(JSON.parse(state.steps[1]?.output ?? "null") as unknown).toEqual({
      exit: "until",
      rounds: 1,
    });
    expect(state.run.status).toBe("succeeded");
  });
});

describe("a round that changes while events and sweeps arrive together", () => {
  // The decision of the loop is made under the lock of the run: of any number of events and sweeps one writes the next round, the
  // others find it. The pool is small on purpose: a decision that read through a second connection would starve it (#875).
  // #846-T121
  it.each([1, 3])(
    "writes the next round once, and the end of the loop once, with a pool of %i connection(s)",
    async (poolMax) => {
      const app = await startEngineHarness({ poolMax });
      const runId = await startedLoop(app, workLoop());
      app.h.fake.addBranch(REPO, `workflow/${runId}/work`, sha("d"));
      const first = await app.finishTurn({ agentResult: { summary: "more" } });

      await Promise.all([
        app.engine.jobEnded(first),
        app.engine.jobEnded(first),
        app.engine.advance(runId),
        app.engine.advance(runId),
        app.engine.jobEnded(first),
        app.engine.advance(runId),
      ]);

      let state = await app.stateOf(runId);
      expect(rowsOf(state)).toEqual([
        "work#1:agent:succeeded",
        "work#2:agent:running",
      ]);
      expect(await app.counts()).toMatchObject({
        jobs: 2,
        sessions: 1,
        turns: 2,
      });

      const second = await app.finishTurn({ agentResult: { summary: "done" } });
      await Promise.all([
        app.engine.jobEnded(second),
        app.engine.advance(runId),
        app.engine.jobEnded(second),
        app.engine.advance(runId),
      ]);

      state = await app.stateOf(runId);
      expect(rowsOf(state)).toEqual([
        "work#1:agent:succeeded",
        "work#2:agent:succeeded",
        "again#1:loop:succeeded",
      ]);
      expect(state.run.status).toBe("succeeded");
      expect(await app.counts()).toMatchObject({ jobs: 2, turns: 2 });
      expect(app.engineLines.filter((line) => line.includes("FAILED"))).toEqual(
        [],
      );
    },
  );

  // #846-T120
  it("writes the branch an if took and the steps it skipped once, however many events decide it", async () => {
    const app = await startEngineHarness();
    const workflow = await app.saveWorkflow({
      version: 1,
      name: "Left or right",
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string" } },
        },
      },
      steps: [
        {
          id: "decide",
          kind: "agent",
          profile: "worker",
          environment: "Python",
          instruction: "Left or right?",
          result: {
            type: "object",
            required: ["route"],
            properties: {
              route: { type: "string", enum: ["left", "right"] },
            },
          },
        },
        {
          id: "which",
          kind: "if",
          when: { equals: ["{{decide.route}}", "left"] },
          then: [
            {
              id: "go-left",
              kind: "agent",
              profile: "worker",
              environment: "Python",
              instruction: "Go left from {{decide.branch}}.",
            },
          ],
          else: [
            {
              id: "go-right",
              kind: "agent",
              profile: "worker",
              environment: "Python",
              instruction: "Go right.",
            },
          ],
        },
      ],
    });
    const { run } = await app.start(workflow.id, { input: { repo: REPO } });
    await app.engine.advance(run.id);
    const jobId = await app.finishTurn({ agentResult: { route: "left" } });

    await Promise.all([
      app.engine.jobEnded(jobId),
      app.engine.jobEnded(jobId),
      app.engine.advance(run.id),
      app.engine.advance(run.id),
    ]);

    const state = await app.stateOf(run.id);
    expect(rowsOf(state)).toEqual([
      "decide#1:agent:succeeded",
      "which#1:if:succeeded",
      "go-right#1:agent:skipped",
      "go-left#1:agent:running",
    ]);
    expect(JSON.parse(state.steps[1]?.output ?? "null") as unknown).toEqual({
      taken: "then",
    });
    // The step that was skipped never started a turn.
    expect(await app.counts()).toMatchObject({ jobs: 2, turns: 2 });
    expect((await turnOf(app, jobOf(state, "go-left", 1))).instruction).toBe(
      `Go left from workflow/${run.id}/decide.`,
    );
  });
});

describe("session.continue", () => {
  // #846-T130
  it("takes no second turn while one runs: the instruction waits behind it and the step finds its turn later", async () => {
    const app = await startEngineHarness();
    const runId = await startedLoop(app, workLoop());
    const branch = `workflow/${runId}/work`;
    app.h.fake.addBranch(REPO, branch, sha("d"));
    const firstJob = await app.finishTurn({ agentResult: { summary: "more" } });
    const first = await turnOf(app, firstJob);
    // While the engine has not yet looked at the end of the first turn, a person starts a turn of the same session.
    const manual = await app.implementerService.continueSession(
      USER,
      first.session_id,
      { instruction: "A note from a person.", clientRequestId: "manual-1" },
    );
    expect(manual).toMatchObject({ status: "started", turnNumber: 2 });

    await app.engine.jobEnded(firstJob);

    // The next round asked for a turn of the session, which is busy: nothing was started, the instruction is queued, the step waits.
    let state = await app.stateOf(runId);
    expect(rowsOf(state)).toEqual([
      "work#1:agent:succeeded",
      "work#2:agent:running",
    ]);
    expect(state.steps[1]?.jobId).toBeNull();
    expect(await app.counts()).toMatchObject({ jobs: 2, turns: 2 });
    const queued = await app.h.db
      .selectFrom("implementer_sessions")
      .select("queued_instruction")
      .executeTakeFirstOrThrow();
    expect(queued.queued_instruction).not.toBeNull();

    // The person's turn ends and the queued instruction starts, as the hook at the end of a turn does.
    await app.finishTurn({});
    expect(
      await app.implementerService.startQueued(first.session_id),
    ).toMatchObject({ status: "started" });
    expect(await app.counts()).toMatchObject({ jobs: 3, turns: 3 });
    // The step is looked at again once its claim is stale: it repeats the same request and gets the turn that exists.
    app.advanceClock(3 * 60 * 1000);
    await app.engine.advance(runId);

    state = await app.stateOf(runId);
    const jobId = jobOf(state, "work", 2);
    expect(await turnOf(app, jobId)).toMatchObject({
      number: 3,
      session_id: first.session_id,
      instruction: "Go on after: more",
    });
    expect(await app.counts()).toMatchObject({ jobs: 3, turns: 3 });

    await endTurn(app, { agentResult: { summary: "done" } });
    expect((await app.stateOf(runId)).run.status).toBe("succeeded");
  });

  // #846-T131
  it("refuses to go on in the session of another step that asks for another result, before anything is started", async () => {
    const app = await startEngineHarness();
    const workflow = await app.saveWorkflow({
      version: 1,
      name: "Two steps, one session",
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string" } },
        },
      },
      steps: [
        {
          id: "plan",
          kind: "agent",
          profile: "worker",
          environment: "Python",
          instruction: "Plan.",
          result: SUMMARY_RESULT,
        },
        {
          id: "build",
          kind: "agent",
          profile: "worker",
          environment: "Python",
          session: { continue: "plan" },
          instruction: "Build.",
        },
      ],
    });
    const { run } = await app.start(workflow.id, { input: { repo: REPO } });
    await app.engine.advance(run.id);
    app.h.fake.addBranch(REPO, `workflow/${run.id}/plan`, sha("d"));

    await endTurn(app, { agentResult: { summary: "Plan." } });

    const state = await app.stateOf(run.id);
    expect(rowsOf(state)).toEqual([
      "plan#1:agent:succeeded",
      "build#1:agent:failed",
    ]);
    expect(state.steps[1]).toMatchObject({ errorCode: "agent_start_failed" });
    expect(state.steps[1]?.errorMessage).toContain("same result");
    expect(state.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
    expect(await app.counts()).toMatchObject({ jobs: 1, turns: 1 });
  });

  // #846-T132
  it("goes on in the session of another step that asks for the same result", async () => {
    const app = await startEngineHarness();
    const step = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      kind: "agent",
      profile: "worker",
      environment: "Python",
      instruction: `Work: ${id}.`,
      result: SUMMARY_RESULT,
      ...extra,
    });
    const workflow = await app.saveWorkflow({
      version: 1,
      name: "Two steps, one session",
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo"],
          properties: { repo: { type: "string" } },
        },
      },
      steps: [step("plan"), step("build", { session: { continue: "plan" } })],
    });
    const { run } = await app.start(workflow.id, { input: { repo: REPO } });
    await app.engine.advance(run.id);
    app.h.fake.addBranch(REPO, `workflow/${run.id}/plan`, sha("d"));

    await endTurn(app, { agentResult: { summary: "Plan." } });

    const state = await app.stateOf(run.id);
    expect(rowsOf(state)).toEqual([
      "plan#1:agent:succeeded",
      "build#1:agent:running",
    ]);
    const plan = await turnOf(app, jobOf(state, "plan", 1));
    expect(await turnOf(app, jobOf(state, "build", 1))).toMatchObject({
      number: 2,
      session_id: plan.session_id,
      branch: `workflow/${run.id}/plan`,
    });
    expect(await app.counts()).toMatchObject({ sessions: 1, turns: 2 });
  });
});
