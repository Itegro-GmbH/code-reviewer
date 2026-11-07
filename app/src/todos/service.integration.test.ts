// SPDX-License-Identifier: LicenseRef-Proprietary

// #924: the ToDos over a seeded database: a run that waits with an open question, an answered question, a pull request a lane opened
// with a review asked for, the tickets of the mirror, and nothing of another workspace.
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createProjectsRepository } from "../db/repositories/projects-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createTrackerRepository } from "../db/repositories/tracker-repository.ts";
import { createWorkflowRunsRepository } from "../db/repositories/workflow-runs-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import type { Database } from "../db/schema.ts";
import { createProjectService } from "../projects/service.ts";
import { createTestDatabase } from "../test-support/test-database.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import {
  addWorkspace,
  defaultWorkspaceId,
} from "../test-support/workspaces.ts";
import { serializeAsk, type StepAsk } from "../workflow-runs/ask.ts";
import { createTodosService } from "./service.ts";

let tick = 0;
const now = () => new Date(Date.UTC(2026, 10, 7, 8, 0, tick++));

async function workspaceWith(
  db: Kysely<Database>,
  workspaceId: string,
  tag: string,
  laneName = "Implement",
) {
  const integration = await createIntegrationsRepository(
    db,
    workspaceId,
    now,
  ).create({
    type: "github_app",
    displayName: tag,
    externalId: `ext-${tag}`,
    config: {},
  });
  const repositories = createRepositoriesRepository(db, workspaceId, now);
  await repositories.reconcile(integration.id, [
    {
      integrationId: integration.id,
      externalId: `ext-repo-${tag}`,
      fullName: `acme/${tag}`,
      url: `https://github.test/acme/${tag}`,
    },
  ]);
  const repository = (await repositories.list()).find(
    (candidate) => candidate.fullName === `acme/${tag}`,
  );
  if (repository === undefined) throw new Error("seeding failed");
  const projects = createProjectService({
    projects: createProjectsRepository(db, workspaceId),
  });
  const { project } = await projects.activateProject(repository.id);
  const workflows = createWorkflowsRepository(db, workspaceId, { now });
  const created = await workflows.create(
    {
      name: laneName,
      document: "{}",
      createdBy: "u-1",
      projectId: project.id,
    },
    100,
  );
  if (!created.ok) throw new Error("seeding failed");
  // A lane that asks the members for the review (the fan-out any member may answer), next to the one that names nobody.
  const fanOutLane = await workflows.create(
    {
      name: `${laneName} and ask the members`,
      document: JSON.stringify({
        steps: [
          {
            id: "ask",
            action: "ticket.requestReview",
            inputs: { reviewers: "project members" },
          },
        ],
      }),
      createdBy: "u-1",
      projectId: project.id,
    },
    100,
  );
  if (!fanOutLane.ok) throw new Error("seeding failed");
  const runs = createWorkflowRunsRepository(db, workspaceId, { now });
  const tracker = createTrackerRepository(db, workspaceId, { now });
  let n = 0;
  const newRun = async (ticket: number | null, fanOut = false) => {
    n += 1;
    const made = await runs.createRun({
      workflowId: (fanOut ? fanOutLane : created).workflow.id,
      workflowVersion: 1,
      repositoryId: repository.id,
      baseBranch: "main",
      triggerInput: "{}",
      budgetMicroUsd: 5_000_000,
      clientRequestId: `${tag}-request-${n}`,
      createdBy: "u-1",
      actorLogin: "octocat",
      ...(ticket === null ? {} : { ticketRef: `github:acme/${tag}#${ticket}` }),
    });
    return made.run;
  };
  const addItem = (
    number: number,
    over: Partial<Parameters<typeof tracker.upsertItem>[1]> = {},
  ) =>
    tracker.upsertItem(repository.id, {
      provider: "github",
      repo: `acme/${tag}`,
      number,
      nodeId: `N_${tag}_${number}`,
      kind: "issue",
      state: "open",
      stateReason: null,
      type: null,
      title: `Ticket ${number} of ${tag}`,
      bodyExcerpt: "",
      labels: [],
      assignees: [],
      closes: [],
      updatedAt: "2026-11-07T08:30:00.000Z",
      ...over,
    });
  /** A step of the run, written and claimed (running), the way the engine starts one. */
  const startStep = async (
    runId: string,
    step: { position: number; stepId: string; kind: "agent" | "action" },
  ) => {
    const added = await runs.lockRun(runId, (lock) =>
      lock.addStep({ ...step, round: 1, profile: null, capMicroUsd: null }),
    );
    if (added === undefined) throw new Error("seeding failed");
    await runs.claimStep(added.id);
    return added;
  };
  /** A run that asked: its agent step is `waiting` with the question. */
  const ask = async (ticket: number, question: StepAsk) => {
    const run = await newRun(ticket);
    const step = await startStep(run.id, {
      position: 0,
      stepId: "plan",
      kind: "agent",
    });
    await runs.lockRun(run.id, (lock) =>
      lock.askStep(step.id, serializeAsk(question), {
        costMicroUsd: 750_000,
        costBasis: "reported",
      }),
    );
    return run;
  };
  /** A run that opened the pull request `number` (an action step with its output). */
  const openPullRequest = async (number: number, fanOut = false) => {
    const run = await newRun(null, fanOut);
    const step = await startStep(run.id, {
      position: 0,
      stepId: "open",
      kind: "action",
    });
    await runs.lockRun(run.id, (lock) =>
      lock.finishStep(step.id, {
        status: "succeeded",
        output: JSON.stringify({
          number,
          url: `https://github.test/acme/${tag}/pull/${number}`,
        }),
        costMicroUsd: null,
      }),
    );
    return run;
  };
  const todos = createTodosService({
    projects: createProjectService({
      projects: createProjectsRepository(db, workspaceId),
    }),
    workflows,
    runs,
    tracker,
    memberLogins: async () => ["alice", "bob"],
  });
  return {
    repository,
    project,
    workflow: created.workflow,
    runs,
    ask,
    addItem,
    openPullRequest,
    todos,
    tracker,
  };
}

async function setup() {
  const { db } = await createTestDatabase();
  const alphaId = await defaultWorkspaceId(db);
  const betaId = await addWorkspace(db, "beta");
  await addUser(db, "u-1");
  return {
    db,
    alpha: await workspaceWith(db, alphaId, "alpha"),
    beta: await workspaceWith(db, betaId, "beta"),
  };
}

const QUESTION: StepAsk = {
  n: 1,
  state: "open",
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx"],
  askedAt: "2026-11-07T08:20:00.000Z",
};

describe("the ToDos of a workspace", () => {
  // #924-T90
  it("lists the run that waits with its question, the ticket from the mirror and what it spent of its budget", async () => {
    const { alpha } = await setup();
    await alpha.addItem(12, {
      labels: [{ name: "agent waiting", color: "fbca04" }],
    });
    const run = await alpha.ask(12, QUESTION);

    const list = await alpha.todos.list({ githubLogin: "alice" });

    expect(list.questions).toEqual([
      expect.objectContaining({
        kind: "question",
        projectId: alpha.project.id,
        repositoryId: alpha.repository.id,
        repo: "acme/alpha",
        runId: run.id,
        lane: "Implement",
        stepId: "plan",
        n: 1,
        question: "Retry which failures?",
        options: ["Network errors", "Network errors and 5xx"],
        since: "2026-11-07T08:20:00.000Z",
        spentUsd: 0.75,
        budgetUsd: 5,
        ticket: {
          number: 12,
          kind: "issue",
          title: "Ticket 12 of alpha",
          url: "https://github.test/acme/alpha/issues/12",
          labelled: true,
        },
      }),
    ]);
    expect(list.reviews).toEqual([]);
  });

  // #924-T91
  it("lists the review that is asked for on a pull request a lane opened, and not on one a person opened", async () => {
    const { alpha } = await setup();
    await alpha.addItem(7, {
      kind: "pull_request",
      title: "Add widget caching",
      reviewRequestedFrom: ["alice"],
    });
    await alpha.addItem(8, {
      kind: "pull_request",
      reviewRequestedFrom: ["alice"],
    });
    await alpha.openPullRequest(7);

    const list = await alpha.todos.list({ githubLogin: "alice" });

    expect(
      list.reviews.map((review) => [review.number, review.audience]),
    ).toEqual([[7, "you"]]);
    // the lane names the person: nobody else can act on it, a member or not
    for (const login of ["bob", "carol", null])
      expect((await alpha.todos.list({ githubLogin: login })).reviews).toEqual(
        [],
      );
  });

  // #924-T95
  it("shows the fan-out of a lane that asked `project members` to any member, and a person who acted on it no more", async () => {
    const { alpha } = await setup();
    await alpha.addItem(9, {
      kind: "pull_request",
      reviewRequestedFrom: ["alice", "bob"],
    });
    await alpha.openPullRequest(9, true);

    const seenBy = async (githubLogin: string | null) =>
      (await alpha.todos.list({ githubLogin })).reviews.map((review) => [
        review.number,
        review.audience,
      ]);
    expect(await seenBy("alice")).toEqual([[9, "you"]]);
    expect(await seenBy("carol")).toEqual([[9, "members"]]);
    expect(
      await alpha.todos.findReview(
        { githubLogin: "carol" },
        alpha.repository.id,
        9,
      ),
    ).toMatchObject({ audience: "members" });

    await alpha.tracker.markReviewActed(alpha.repository.id, 9, "alice");

    expect(await seenBy("alice")).toEqual([]);
    expect(await seenBy("bob")).toEqual([[9, "you"]]);
  });

  // #924-T92
  it("keeps an answered question in the done list with the answer, and a question that is answered is no question any more", async () => {
    const { alpha } = await setup();
    const run = await alpha.ask(12, QUESTION);
    await alpha.runs.lockRun(run.id, async (lock) => {
      const [step] = lock.steps;
      if (step === undefined) throw new Error("no step");
      await lock.answerStep(
        step.id,
        serializeAsk({
          ...QUESTION,
          state: "answered",
          answer: {
            text: "Network errors",
            choice: 1,
            by: "alice",
            via: "ui",
            at: "2026-11-07T08:40:00.000Z",
          },
        }),
      );
    });

    const list = await alpha.todos.list({ githubLogin: "alice" });

    expect(list.questions).toEqual([]);
    expect(list.done).toEqual([
      expect.objectContaining({
        kind: "question",
        runId: run.id,
        question: "Retry which failures?",
        answer: { text: "Network errors", choice: 1, by: "alice", via: "ui" },
        at: "2026-11-07T08:40:00.000Z",
      }),
    ]);
  });

  // #924-T96
  it("narrows the reads of the runs to the repositories of a project inside the query, so the rows of another project cannot fill the bound", async () => {
    const { db } = await setup();
    const workspaceId = await defaultWorkspaceId(db);
    const first = await workspaceWith(db, workspaceId, "gamma", "Gamma lane");
    const second = await workspaceWith(db, workspaceId, "delta", "Delta lane");
    const older = await first.ask(1, QUESTION);
    // the other project's runs are newer and more numerous than the bound of one
    await second.ask(2, { ...QUESTION, askedAt: "2026-11-07T08:50:00.000Z" });
    await second.ask(3, { ...QUESTION, askedAt: "2026-11-07T08:51:00.000Z" });
    await first.openPullRequest(7);
    await second.openPullRequest(8);
    await second.openPullRequest(9);

    expect(
      (await first.runs.listWaiting(1, [first.repository.id])).map(
        (run) => run.id,
      ),
    ).toEqual([older.id]);
    expect(await first.runs.listWaiting(1, [])).toEqual([]);
    expect(
      (await first.runs.listPullRequestSteps(1, [first.repository.id])).map(
        ({ run }) => run.repositoryId,
      ),
    ).toEqual([first.repository.id]);
    expect(
      (await first.runs.listPullRequestSteps(10)).map(
        ({ run }) => run.repositoryId,
      ),
    ).toHaveLength(3);
    const waiting = await first.runs.listWaiting(10);
    const steps = await first.runs.listStepsOfRuns(
      waiting.map((run) => run.id),
    );
    expect([...steps.keys()].sort()).toEqual(
      waiting.map((run) => run.id).sort(),
    );
    for (const list of steps.values()) expect(list).toHaveLength(1);
  });

  // #924-T93
  it("narrows to a project and never shows what belongs to another workspace", async () => {
    const { alpha, beta } = await setup();
    await alpha.ask(12, QUESTION);
    await beta.ask(5, { ...QUESTION, question: "A question of beta?" });
    await beta.addItem(7, {
      kind: "pull_request",
      reviewRequestedFrom: ["alice"],
    });
    await beta.openPullRequest(7);

    const own = await alpha.todos.list({ githubLogin: "alice" });
    const narrowed = await alpha.todos.list(
      { githubLogin: "alice" },
      { projectId: alpha.project.id },
    );

    expect(own.questions.map((todo) => todo.repo)).toEqual(["acme/alpha"]);
    expect(own.reviews).toEqual([]);
    expect(narrowed.questions).toHaveLength(1);
    await expect(
      alpha.todos.list(
        { githubLogin: "alice" },
        { projectId: beta.project.id },
      ),
    ).rejects.toMatchObject({ code: "TODOS_PROJECT_NOT_FOUND" });
    expect(
      await beta.todos.findReview(
        { githubLogin: "alice" },
        alpha.repository.id,
        7,
      ),
    ).toBeUndefined();
  });
});
