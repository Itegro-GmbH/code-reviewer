// SPDX-License-Identifier: LicenseRef-Proprietary

// #845 (agent workflows, milestone 4): a label put on an issue starts the workflows that wait for it. A real Postgres database, the
// route's handler with a signed delivery as GitHub sends it, the real label trigger, the engine and the GitHub connectors against the
// fake GitHub, and the real Implementer queue. What a turn does inside its VM is not simulated: the test pushes the branch to the fake
// GitHub and ends the turn with the report a runner would send.
import { describe, expect, it } from "vitest";
import { webhookFixture } from "../../../fakes/github/webhooks.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createWorkflowsRepository } from "../db/repositories/workflows-repository.ts";
import { sha } from "../test-support/jobs.ts";
import {
  SUMMARY_RESULT,
  USER,
  startEngineHarness,
  type EngineHarness,
} from "../test-support/workflow-engine-harness.ts";
import { addUser } from "../test-support/workspace-deletion-fixture.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { WORKFLOW_OWNER_GONE_TEXT } from "./errors.ts";
import { createGithubConnectors } from "./github-connectors.ts";
import { createLabelTrigger, labelRequestId } from "./label-trigger.ts";

const READY = "ready for agent";

/** Swap the labels, work on the issue, open the pull request, say so on the issue: the first workflow of the plan, without the review loop. */
function issueToPullRequest(
  name = "Issue to PR",
  label = READY,
): Record<string, unknown> {
  return {
    version: 1,
    name,
    trigger: { kind: "github.issueLabeled", label },
    steps: [
      {
        id: "start",
        kind: "action",
        connector: "github.issue.labels",
        issue: "{{trigger.issue}}",
        remove: [READY],
        add: ["agent working"],
      },
      {
        id: "implement",
        kind: "agent",
        profile: "worker",
        environment: "Python",
        instruction: "{{trigger.issue.title}}\n\n{{trigger.issue.body}}",
        result: SUMMARY_RESULT,
      },
      {
        id: "pr",
        kind: "action",
        connector: "github.pullRequest.open",
        head: "{{implement.branch}}",
        title: "{{trigger.issue.title}}",
        body: "{{implement.summary}}\n\nCloses #{{trigger.issue.number}}",
      },
      {
        id: "comment",
        kind: "action",
        connector: "github.issue.comment",
        issue: "{{trigger.issue}}",
        body: "Opened {{pr.url}} (pull request {{pr.number}}).",
      },
    ],
  };
}

async function startHarness() {
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
  const app = await startEngineHarness({ connectors });
  holder.app = app;
  const kicked: string[] = [];
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
      kick: (runId) => void kicked.push(runId),
    }),
  );
  app.h.fake.addIssue("acme/widgets", {
    number: 12,
    title: "Cache the widget list",
    labels: ["enhancement", READY],
  });
  return { app, kicked };
}

type Harness = Awaited<ReturnType<typeof startHarness>>;

async function outcomeOf(response: Response): Promise<unknown> {
  expect(response.status).toBe(202);
  return ((await response.json()) as { outcome: string }).outcome;
}

async function runsOf(app: EngineHarness, workflowId: string) {
  return app.runs.listRuns(workflowId, 50);
}

/** A delivery of `issues.labeled` with the issue changed. */
function labeledWith(issue: Record<string, unknown>) {
  const payload = webhookFixture("issues.labeled") as Record<
    string,
    unknown
  > & {
    issue: Record<string, unknown>;
  };
  return { ...payload, issue: { ...payload.issue, ...issue } };
}

/** A second repository of the installation with a project of its own (#922), and the delivery of a label on its issue 5. */
async function addOtherProject(app: EngineHarness) {
  app.h.fake.setRepositories(4242, [
    { id: 7001, fullName: "acme/widgets" },
    { id: 7002, fullName: "acme/other" },
  ]);
  await app.h.sync.syncAll();
  const repository = (await app.h.repositories.list()).find(
    (candidate) => candidate.fullName === "acme/other",
  );
  if (repository === undefined) throw new Error("seeding failed");
  const activated = await app.h.projects.activateProject(repository.id);
  const payload = labeledWith({
    number: 5,
    html_url: "https://github.com/acme/other/issues/5",
  }) as unknown as Record<string, unknown> & {
    repository: Record<string, unknown>;
  };
  return {
    project: activated.project,
    labelOnOther: {
      ...payload,
      repository: {
        ...payload.repository,
        id: 7002,
        name: "other",
        full_name: "acme/other",
        html_url: "https://github.com/acme/other",
      },
    },
  };
}

describe("a label starts only the lanes of the project whose ticket source is the repository (#922)", () => {
  // #922-T21
  it("ignores the lanes of another project and the workflows that belong to no project, and the label on another repository starts only its own project's lanes", async () => {
    const { app } = await startHarness();
    const other = await addOtherProject(app);
    const own = await app.saveWorkflow(issueToPullRequest("Own lane"));
    const elsewhere = await app.workflows.create(
      {
        name: "Lane of the other project",
        document: JSON.stringify(
          issueToPullRequest("Lane of the other project"),
        ),
        createdBy: USER.id,
        projectId: other.project.id,
      },
      100,
    );
    const homeless = await app.workflows.create(
      {
        name: "Without a project",
        document: JSON.stringify(issueToPullRequest("Without a project")),
        createdBy: USER.id,
      },
      100,
    );
    if (!elsewhere.ok || !homeless.ok) throw new Error("seeding failed");

    await app.h.deliver("issues.labeled", { deliveryId: "delivery-1" });
    expect(await runsOf(app, own.id)).toHaveLength(1);
    expect(await runsOf(app, elsewhere.workflow.id)).toHaveLength(0);
    expect(await runsOf(app, homeless.workflow.id)).toHaveLength(0);

    await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-2",
      payload: other.labelOnOther,
    });
    expect(await runsOf(app, own.id)).toHaveLength(1);
    expect(await runsOf(app, elsewhere.workflow.id)).toHaveLength(1);
    expect(await runsOf(app, homeless.workflow.id)).toHaveLength(0);
  });

  // #922-T22
  it("starts nothing for a lane whose project is switched off", async () => {
    const { app } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());
    await app.h.projects.deactivateProject(app.repository.id);

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });

    expect(response.status).toBe(202);
    expect(await runsOf(app, workflow.id)).toHaveLength(0);
  });
});

describe("the webhook: a label on an issue starts the workflows that wait for it", () => {
  // #845-T30
  it("starts exactly one run for a signed delivery, as a run of a label without a person", async () => {
    const { app, kicked } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });

    expect(await outcomeOf(response)).toBe("workflow_runs_started");
    const runs = await runsOf(app, workflow.id);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({
      workflowId: workflow.id,
      workflowVersion: 1,
      status: "running",
      // A workflow written with the single trigger of before is read as a list of one: `github.issueLabeled` is `ticket.labeled`.
      triggerKind: "ticket.labeled",
      triggerId: "labeled",
      createdBy: null,
      // Who put the label on, to be shown; the sender of the recorded delivery.
      actorLogin: "bob",
      baseBranch: "main",
      clientRequestId: labelRequestId("delivery-1", workflow.id),
    });
    const repo = {
      fullName: "acme/widgets",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
    };
    const issue = {
      number: 12,
      title: "Cache the widget list",
      body: "The widget list is rebuilt on every request.\nCache it for a minute.",
      url: "https://github.com/acme/widgets/issues/12",
      labels: ["enhancement", READY],
    };
    expect(JSON.parse(run?.triggerInput ?? "null")).toEqual({
      ticket: { ...issue, type: "", assignees: [], repo },
      issue,
      repo,
    });
    expect(kicked).toEqual([run?.id]);
    // The run as the routes and the run page show it: the real trigger and who put the label on, no starter.
    const view = await app.service.get(workflow.id, run?.id ?? "");
    expect(view).toMatchObject({
      trigger: "ticket.labeled",
      triggerId: "labeled",
      actorLogin: "bob",
    });
    expect(view).not.toHaveProperty("createdBy");
    // The delivery is recorded as a success: it stays a duplicate.
    expect(
      await app.h.db
        .selectFrom("webhook_deliveries")
        .select("outcome")
        .where("delivery_id", "=", "delivery-1")
        .executeTakeFirst(),
    ).toEqual({ outcome: "workflow_runs_started" });
  });

  // #845-T31
  it("starts nothing twice: the retry of a delivery changes nothing, also when its claim is gone", async () => {
    const { app, kicked } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());
    await app.h.deliver("issues.labeled", { deliveryId: "delivery-1" });

    // GitHub's "Redeliver" carries the same delivery id: the claim of the first one answers it.
    const retry = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });
    expect(await outcomeOf(retry)).toBe("duplicate");
    expect(await runsOf(app, workflow.id)).toHaveLength(1);

    // The claim is forgotten (a record that ran out): the run's own request id still finds the run.
    await app.h.db
      .deleteFrom("webhook_deliveries")
      .where("delivery_id", "=", "delivery-1")
      .execute();
    const again = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });
    expect(await outcomeOf(again)).toBe("workflow_runs_started");
    const runs = await runsOf(app, workflow.id);
    expect(runs).toHaveLength(1);
    // The run is pushed to the engine again, which does nothing for a run that moves.
    expect(kicked).toEqual([runs[0]?.id, runs[0]?.id]);
  });

  // #845-T31a
  it("starts one run for an issue while one is running: labeled, unlabeled, labeled again; when it has ended, the next label starts the next", async () => {
    const { app } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());

    await app.h.deliver("issues.labeled", { deliveryId: "delivery-1" });
    expect(
      await outcomeOf(
        await app.h.deliver("issues.unlabeled", { deliveryId: "delivery-2" }),
      ),
    ).not.toBe("workflow_runs_started");
    const again = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-3",
    });

    // Nothing started: the delivery is not a success that stays claimed.
    expect(await outcomeOf(again)).toBe("no_workflow_matched");
    const [first, ...rest] = await runsOf(app, workflow.id);
    expect(rest).toEqual([]);

    // Another issue is not held by it.
    app.h.fake.addIssue("acme/widgets", {
      number: 13,
      title: "Another",
      labels: [READY],
    });
    await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-4",
      payload: labeledWith({
        number: 13,
        html_url: "https://github.com/acme/widgets/issues/13",
      }),
    });
    expect(await runsOf(app, workflow.id)).toHaveLength(2);

    // The first run ends; the label put on again starts a new run for issue 12.
    await app.runs.lockRun(first?.id ?? "", (lock) =>
      lock.finishRun({ status: "failed", errorCode: "step_failed" }),
    );
    const next = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-5",
    });
    expect(await outcomeOf(next)).toBe("workflow_runs_started");
    expect(await runsOf(app, workflow.id)).toHaveLength(3);
  });

  // #845-T31b
  it("starts one run when two deliveries for the same issue arrive at once", async () => {
    const { app } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());

    const answers = await Promise.all(
      ["delivery-1", "delivery-2", "delivery-3"].map((deliveryId) =>
        app.h.deliver("issues.labeled", { deliveryId }),
      ),
    );

    expect(await Promise.all(answers.map(outcomeOf))).toEqual(
      expect.arrayContaining(["workflow_runs_started"]),
    );
    expect(await runsOf(app, workflow.id)).toHaveLength(1);
  });

  // #845-T32
  it("starts every workflow that waits for the label, each once, and none that waits for another", async () => {
    const { app } = await startHarness();
    const first = await app.saveWorkflow(issueToPullRequest("First"));
    const second = await app.saveWorkflow(issueToPullRequest("Second"));
    const other = await app.saveWorkflow(
      issueToPullRequest("Other", "needs triage"),
    );
    const manual = await app.saveWorkflow({
      version: 1,
      name: "By hand",
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
          id: "implement",
          kind: "agent",
          profile: "worker",
          environment: "Python",
          instruction: "Work.",
        },
      ],
    });

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });

    expect(await outcomeOf(response)).toBe("workflow_runs_started");
    expect(await runsOf(app, first.id)).toHaveLength(1);
    expect(await runsOf(app, second.id)).toHaveLength(1);
    expect(await runsOf(app, other.id)).toHaveLength(0);
    expect(await runsOf(app, manual.id)).toHaveLength(0);
  });

  // #845-T33
  it("starts nothing for a workflow that is archived, and takes the current version of one that was saved again", async () => {
    const { app } = await startHarness();
    const archived = await app.saveWorkflow(issueToPullRequest("Archived"));
    const changed = await app.saveWorkflow(issueToPullRequest("Changed"));
    await app.workflows.archive(archived.id, 100);
    // Version 2 waits for another label: version 1 no longer starts.
    await app.workflows.saveVersion(
      changed.id,
      {
        name: "Changed",
        document: JSON.stringify(issueToPullRequest("Changed", "other label")),
        createdBy: "user-1",
      },
      100,
    );

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });

    expect(await outcomeOf(response)).toBe("no_workflow_matched");
    expect(await runsOf(app, archived.id)).toHaveLength(0);
    expect(await runsOf(app, changed.id)).toHaveLength(0);
  });

  // #845-T34
  it("starts nothing for a workflow of another workspace, whatever label it waits for", async () => {
    const { app } = await startHarness();
    const otherWorkspace = await addWorkspace(app.h.db, "other");
    await addUser(app.h.db, "user-2");
    const foreign = await createWorkflowsRepository(
      app.h.db,
      otherWorkspace,
    ).create(
      {
        name: "Issue to PR",
        document: JSON.stringify(issueToPullRequest()),
        createdBy: "user-2",
      },
      100,
    );
    if (!foreign.ok) throw new Error("seeding failed");

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });

    expect(await outcomeOf(response)).toBe("no_workflow_matched");
    expect(
      await app.h.db.selectFrom("workflow_runs").select("id").execute(),
    ).toEqual([]);
  });

  // #845-T35
  it("starts nothing in a repository that is no longer an active one of the workspace, and starts when it is again", async () => {
    const { app } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());
    await app.h.repositories.deactivateAll(app.integration.id);

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });

    expect(await outcomeOf(response)).toBe("no_workflow_matched");
    expect(await runsOf(app, workflow.id)).toHaveLength(0);

    // Not a final outcome: the same delivery, redelivered once the repository is back, starts the workflow.
    await app.h.repositories.reconcile(app.integration.id, [
      {
        integrationId: app.integration.id,
        externalId: "7001",
        fullName: "acme/widgets",
        url: "https://github.com/acme/widgets",
      },
    ]);
    const redelivered = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
    });
    expect(await outcomeOf(redelivered)).toBe("workflow_runs_started");
    expect(await runsOf(app, workflow.id)).toHaveLength(1);
  });

  // #845-T36
  it.each([
    ["a bot (the App itself)", "issues.labeled.bot"],
    ["a pull request", "issues.labeled.pull-request"],
    ["a closed issue", "issues.labeled.closed"],
    ["a label taken off", "issues.unlabeled"],
    ["a new issue", "issues.opened"],
  ])("starts nothing for %s", async (_name, fixture) => {
    const { app } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());

    const response = await app.h.deliver(fixture);

    expect(await outcomeOf(response)).toBe("ignored");
    expect(await runsOf(app, workflow.id)).toHaveLength(0);
  });

  // #845-T37
  it("refuses a delivery with a wrong signature and starts nothing", async () => {
    const { app } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());

    const response = await app.h.deliver("issues.labeled", {
      signature: `sha256=${"0".repeat(64)}`,
    });

    expect(response.status).toBe(401);
    expect(await runsOf(app, workflow.id)).toHaveLength(0);
  });

  // #845-T38
  it("starts nothing for an installation that is switched off", async () => {
    const { app } = await startHarness();
    const workflow = await app.saveWorkflow(issueToPullRequest());
    await createIntegrationsRepository(app.h.db, app.h.workspaceId).setStatus(
      app.integration.id,
      "disabled",
    );

    const response = await app.h.deliver("issues.labeled");

    expect(await outcomeOf(response)).toBe("integration_disabled");
    expect(await runsOf(app, workflow.id)).toHaveLength(0);
  });
});

async function endAgentTurn(app: EngineHarness, runId: string) {
  // The Worker pushed the branch of the step: the fake GitHub knows it at a commit of its own.
  app.h.fake.addBranch("acme/widgets", `workflow/${runId}/implement`, sha("d"));
  const jobId = await app.finishTurn({
    agentResult: { summary: "Cache the widget list" },
    commits: [sha("d")],
    headCommit: sha("d"),
  });
  await app.engine.jobEnded(jobId);
  return jobId;
}

async function deliverAndAdvance({ app, kicked }: Harness, delivery: string) {
  const response = await app.h.deliver("issues.labeled", {
    deliveryId: delivery,
  });
  expect(await outcomeOf(response)).toBe("workflow_runs_started");
  const runId = kicked.at(-1);
  if (runId === undefined) throw new Error("no run was started");
  // What the route does after the response (`runAfterResponse`): the engine takes the run on.
  await app.engine.advance(runId);
  return runId;
}

describe("label, implementer, pull request, comment (#845)", () => {
  // #845-T40
  it("takes the issue through the whole first workflow against the fake GitHub", async () => {
    const harness = await startHarness();
    const { app } = harness;
    await app.saveWorkflow(issueToPullRequest());

    const runId = await deliverAndAdvance(harness, "delivery-1");

    // The first step swapped the labels before the agent started; the agent's turn waits for a runner.
    expect(app.h.fake.issueLabels("acme/widgets", 12)).toEqual([
      "enhancement",
      "agent working",
    ]);
    const waiting = await app.stateOf(runId);
    expect(waiting.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["start", "succeeded"],
      ["implement", "running"],
    ]);

    const jobId = await endAgentTurn(app, runId);

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "succeeded", errorCode: null });
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["start", "succeeded"],
      ["implement", "succeeded"],
      ["pr", "succeeded"],
      ["comment", "succeeded"],
    ]);
    // The agent was given the issue as its task: title, a blank line, body.
    const turn = await app.h.db
      .selectFrom("implementer_turns")
      .select(["instruction", "created_by"])
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow();
    expect(turn.instruction).toBe(
      "Cache the widget list\n\nThe widget list is rebuilt on every request.\nCache it for a minute.",
    );
    // The session belongs to the account that owns the workflow, the job shows who put the label on.
    expect(turn.created_by).toBe("user-1");
    expect(
      await app.h.db
        .selectFrom("jobs")
        .select("actor_login")
        .where("id", "=", jobId)
        .executeTakeFirst(),
    ).toEqual({ actor_login: "bob" });
    // The pull request is on GitHub, from the branch of the step into the default branch the delivery named, and closes the issue.
    const [opened] = app.h.fake
      .pullRequests("acme/widgets")
      .filter((pr) => pr.headRef === `workflow/${runId}/implement`);
    expect(opened).toMatchObject({
      number: 13,
      title: "Cache the widget list",
      baseRef: "main",
      state: "open",
    });
    expect(opened?.body).toBe("Cache the widget list\n\nCloses #12");
    // And the issue is told where it is, under the invisible marker of its step.
    expect(
      app.h.fake.issueComments("acme/widgets", 12).map((c) => c.body),
    ).toEqual([
      `Opened ${String(JSON.parse(state.steps[2]?.output ?? "null").url)} (pull request 13).\n\n<!-- wf-${runId}-3 -->`,
    ]);
  });

  // #845-T40a
  it("ends a run with workflow_owner_gone, before its first step, when the owner of the workflow has left the workspace", async () => {
    const harness = await startHarness();
    const { app } = harness;
    await app.saveWorkflow(issueToPullRequest());
    expect(await app.members.remove("user-1")).toBe(true);

    const runId = await deliverAndAdvance(harness, "delivery-1");

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "failed",
      errorCode: "workflow_owner_gone",
    });
    // Nothing was done on GitHub and no turn was queued.
    expect(state.steps).toEqual([]);
    expect(app.h.fake.issueLabels("acme/widgets", 12)).toEqual([
      "enhancement",
      READY,
    ]);
    expect(await app.waitingJobs()).toEqual([]);
    // The failed run frees the issue: once the owner is back (or the workflow is taken over), the next label starts the run.
    expect(await app.members.add("user-1", "member")).toBe("added");
    const next = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-2",
    });
    expect(await outcomeOf(next)).toBe("workflow_runs_started");
  });

  // #845-T40c
  it("hands the next label run to whoever saved the workflow again, when the owner of the earlier version has left", async () => {
    const harness = await startHarness();
    const { app } = harness;
    const workflow = await app.saveWorkflow(issueToPullRequest());
    expect(await app.members.remove("user-1")).toBe(true);
    const first = await deliverAndAdvance(harness, "delivery-1");
    expect((await app.stateOf(first)).run).toMatchObject({
      status: "failed",
      errorCode: "workflow_owner_gone",
    });

    // Another member saves the workflow: the new version is theirs, and so are the runs that start with it.
    await addUser(app.h.db, "user-2");
    expect(await app.members.add("user-2", "member")).toBe("added");
    const saved = await app.workflows.saveVersion(
      workflow.id,
      {
        name: workflow.name,
        document: JSON.stringify(issueToPullRequest()),
        createdBy: "user-2",
      },
      100,
    );
    expect(saved.ok).toBe(true);
    const runId = await deliverAndAdvance(harness, "delivery-2");

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({ status: "running", errorCode: null });
    const agent = state.steps.at(-1);
    expect(agent).toMatchObject({ stepId: "implement", status: "running" });
    expect(
      await app.h.db
        .selectFrom("implementer_turns")
        .select("created_by")
        .where("job_id", "=", agent?.jobId ?? "")
        .executeTakeFirst(),
    ).toEqual({ created_by: "user-2" });
  });

  // #845-T40b
  it("fails the agent step with the same sentence when the owner leaves after the run began", async () => {
    const harness = await startHarness();
    const { app } = harness;
    await app.saveWorkflow(issueToPullRequest());
    // The check at the start of the run finds the owner; by the time the agent step starts, they are gone.
    const present = app.members.get.bind(app.members);
    let asked = 0;
    app.members.get = async (userId) =>
      (asked += 1) === 1 ? present(userId) : undefined;

    const runId = await deliverAndAdvance(harness, "delivery-1");

    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "failed",
      errorCode: "step_failed",
    });
    expect(state.steps.at(-1)).toMatchObject({
      stepId: "implement",
      status: "failed",
      errorCode: "agent_start_failed",
      errorMessage: WORKFLOW_OWNER_GONE_TEXT,
    });
    expect(await app.waitingJobs()).toEqual([]);
  });

  // #845-T41
  it("defuses the words of whoever opened the issue where they go into a pull request, and hands them to the agent as they are", async () => {
    const harness = await startHarness();
    const { app } = harness;
    await app.saveWorkflow(issueToPullRequest());
    const title = "Ping @acme/security about #5";
    const body = "Closes #98.\nCc @bob {{implement.summary}}";

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
      payload: labeledWith({ title, body }),
    });
    expect(await outcomeOf(response)).toBe("workflow_runs_started");
    const runId = harness.kicked.at(-1) ?? "";
    await app.engine.advance(runId);
    const jobId = await endAgentTurn(app, runId);

    const turn = await app.h.db
      .selectFrom("implementer_turns")
      .select("instruction")
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow();
    // The agent reads the issue as it was written; `{{` in it is no reference.
    expect(turn.instruction).toBe(`${title}\n\n${body}`);
    const [opened] = app.h.fake
      .pullRequests("acme/widgets")
      .filter((pr) => pr.headRef === `workflow/${runId}/implement`);
    // The pull request mentions nobody and names no issue it would close: a zero-width space after `@` and `#`.
    expect(opened?.title).toBe("Ping @​acme/security about #​5");
    expect(opened?.body).toBe("Cache the widget list\n\nCloses #12");
  });

  // #845-T42
  it("bounds a very long issue before it is stored, and the run still starts", async () => {
    const harness = await startHarness();
    const { app } = harness;
    const workflow = await app.saveWorkflow(issueToPullRequest());

    const response = await app.h.deliver("issues.labeled", {
      deliveryId: "delivery-1",
      payload: labeledWith({
        title: "t".repeat(5000),
        body: "b".repeat(200_000),
      }),
    });

    expect(await outcomeOf(response)).toBe("workflow_runs_started");
    const [run] = await runsOf(app, workflow.id);
    const input = JSON.parse(run?.triggerInput ?? "null") as {
      issue: { title: string; body: string };
    };
    expect(Array.from(input.issue.title)).toHaveLength(256);
    expect(Array.from(input.issue.body)).toHaveLength(8_000);
  });
});
