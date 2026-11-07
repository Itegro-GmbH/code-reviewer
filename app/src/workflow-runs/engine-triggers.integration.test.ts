// SPDX-License-Identifier: LicenseRef-Proprietary

// #916: a workflow with several triggers on a real Postgres. The engine runs the pre-steps of the trigger that fired and then the shared
// steps, for the trigger a person started and for the one a label started; the start API names the trigger and hands in a ticket that is
// resolved when the run starts; a workflow written with the single trigger of before runs as it did.
import { describe, expect, it } from "vitest";
import { startEngineHarness } from "../test-support/workflow-engine-harness.ts";
import { createLabelTrigger } from "./label-trigger.ts";
import type { ActionConnector } from "./connectors.ts";
import { WorkflowRunError } from "./errors.ts";
import type { IssueLabeled } from "../integrations/types.ts";

const TICKET = {
  number: 128,
  title: "Cache the widget list",
  body: "Rebuilt on every request.",
  url: "https://github.test/acme/widgets/issues/128",
  labels: ["enhancement"],
  assignees: ["alice"],
  type: "Bug",
};

const TICKET_INPUT = {
  type: "object",
  required: ["ticket"],
  properties: { ticket: { type: "ticket" } },
};

/** Records what it was asked, answers like the connector of its name would. */
function recording(name: string, calls: { name: string; inputs: unknown }[]) {
  const connector: ActionConnector = {
    name,
    async run(call) {
      calls.push({ name, inputs: call.inputs });
      return name === "ticket.labels"
        ? { labels: ["agent implement"] }
        : {
            url: "https://github.test/acme/widgets/issues/128#c",
            existing: false,
          };
    },
  };
  return connector;
}

function laneDocument(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: "Lane",
    triggers: [
      { id: "labeled", kind: "ticket.labeled", label: "agent implement" },
      {
        id: "manual",
        kind: "manual",
        input: TICKET_INPUT,
        steps: [
          {
            id: "mark",
            kind: "action",
            connector: "ticket.labels",
            ticket: "{{trigger.ticket}}",
            add: ["agent implement"],
          },
        ],
      },
    ],
    steps: [
      {
        id: "say",
        kind: "action",
        connector: "ticket.comment",
        ticket: "{{trigger.ticket}}",
        body: "{{trigger.ticket.title}} ({{trigger.ticket.number}}, {{trigger.ticket.type}}) in {{trigger.ticket.repo.fullName}} via {{trigger.id}}/{{trigger.kind}}",
      },
    ],
    ...overrides,
  };
}

function labeled(): IssueLabeled {
  return {
    repo: {
      integrationId: "i",
      externalId: "7001",
      fullName: "acme/widgets",
      url: "https://github.test/acme/widgets",
    },
    defaultBranch: "main",
    issue: {
      number: 128,
      title: TICKET.title,
      body: TICKET.body,
      url: TICKET.url,
      labels: ["agent implement"],
      assignees: ["alice"],
      type: "Bug",
    },
    label: "agent implement",
    actor: { login: "bob", externalId: "1002" },
  };
}

async function harness() {
  const calls: { name: string; inputs: unknown }[] = [];
  const app = await startEngineHarness({
    connectors: [
      recording("ticket.labels", calls),
      recording("ticket.comment", calls),
    ],
    tickets: { "acme/widgets#128": TICKET },
  });
  return { app, calls };
}

describe("the pre-steps of the trigger that fired, then the shared steps", () => {
  // #916-T60
  it("runs the pre-steps and then the shared steps for the manual trigger, with the ticket the start resolved", async () => {
    const { app, calls } = await harness();
    const workflow = await app.saveWorkflow(laneDocument());

    const { run } = await app.start(workflow.id, {
      trigger: "manual",
      input: { ticket: "github:acme/widgets#128" },
    });
    await app.engine.advance(run.id);

    const state = await app.stateOf(run.id);
    expect(state.run).toMatchObject({
      status: "succeeded",
      triggerKind: "manual",
      triggerId: "manual",
    });
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["mark", "succeeded"],
      ["say", "succeeded"],
    ]);
    expect(calls).toEqual([
      {
        name: "ticket.labels",
        inputs: { ticket: 128, add: ["agent implement"] },
      },
      {
        name: "ticket.comment",
        inputs: {
          ticket: 128,
          body: "Cache the widget list (128, Bug) in acme/widgets via manual/manual",
        },
      },
    ]);
    // What the run keeps: the input as handed in (the ticket resolved, not repeated), and the ticket as the steps read it.
    expect(JSON.parse(state.run.triggerInput)).toEqual({
      input: {},
      ticket: {
        ...TICKET,
        repo: {
          fullName: "acme/widgets",
          owner: "acme",
          name: "widgets",
          defaultBranch: "main",
        },
      },
    });
  });

  // #916-T61
  it("runs only the shared steps for the label trigger, which has no pre-steps, and reads the same ticket", async () => {
    const { app, calls } = await harness();
    await app.saveWorkflow(laneDocument());
    const repository = (await app.h.repositories.list({ active: true })).find(
      (candidate) => candidate.fullName === "acme/widgets",
    );
    if (repository === undefined) throw new Error("no repository");
    const kicked: string[] = [];
    const trigger = createLabelTrigger({
      runs: app.runs,
      workflows: app.workflows,
      activeRepository: async () => ({ id: repository.id }),
      kick: (runId) => void kicked.push(runId),
    });

    const result = await trigger.start("delivery-1", labeled());

    expect(result).toMatchObject({ matched: 1, started: 1 });
    const [runId] = kicked;
    if (runId === undefined) throw new Error("no run was started");
    await app.engine.advance(runId);
    const state = await app.stateOf(runId);
    expect(state.run).toMatchObject({
      status: "succeeded",
      triggerKind: "ticket.labeled",
      triggerId: "labeled",
      createdBy: null,
    });
    expect(state.steps.map((step) => step.stepId)).toEqual(["say"]);
    expect(calls).toEqual([
      {
        name: "ticket.comment",
        inputs: {
          ticket: 128,
          body: "Cache the widget list (128, Bug) in acme/widgets via labeled/ticket.labeled",
        },
      },
    ]);
  });

  // #916-T62
  it("ends the run when a pre-step fails, before any shared step runs", async () => {
    const failing: ActionConnector = {
      name: "ticket.labels",
      async run() {
        throw new Error("boom");
      },
    };
    const app = await startEngineHarness({
      connectors: [failing, recording("ticket.comment", [])],
      tickets: { "acme/widgets#128": TICKET },
    });
    const workflow = await app.saveWorkflow(laneDocument());

    const { run } = await app.start(workflow.id, {
      trigger: "manual",
      input: { ticket: "github:acme/widgets#128" },
    });
    await app.engine.advance(run.id);

    const state = await app.stateOf(run.id);
    expect(state.run.status).toBe("failed");
    expect(state.steps.map((step) => [step.stepId, step.status])).toEqual([
      ["mark", "failed"],
    ]);
  });

  // #916-T63
  it("starts a workflow written with the single trigger of before as it did: its id is read from the kind, its input is stored as handed in", async () => {
    const { app } = await harness();
    const workflow = await app.saveWorkflow({
      version: 1,
      name: "Legacy",
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo", "topic"],
          properties: { repo: { type: "string" }, topic: { type: "string" } },
        },
      },
      steps: [
        {
          id: "say",
          kind: "action",
          connector: "ticket.comment",
          ticket: 7,
          body: "{{trigger.input.topic}} via {{trigger.id}}",
        },
      ],
    });

    const { run } = await app.start(workflow.id);
    await app.engine.advance(run.id);

    const state = await app.stateOf(run.id);
    expect(state.run).toMatchObject({
      status: "succeeded",
      triggerKind: "manual",
      triggerId: "manual",
    });
    // A manual run without a ticket stores the input exactly as development does (the version that runs during a deploy reads it so).
    expect(JSON.parse(state.run.triggerInput)).toEqual({
      repo: "acme/widgets",
      topic: "caching",
    });
  });

  // #916-T64
  it("keeps running a run that was written before triggers had ids: no trigger id, the input stored as it was handed in", async () => {
    const calls: { name: string; inputs: unknown }[] = [];
    const app = await startEngineHarness({
      connectors: [recording("ticket.comment", calls)],
    });
    const workflow = await app.saveWorkflow({
      version: 1,
      name: "Old",
      trigger: {
        kind: "manual",
        input: {
          type: "object",
          required: ["repo", "topic"],
          properties: { repo: { type: "string" }, topic: { type: "string" } },
        },
      },
      steps: [
        {
          id: "say",
          kind: "action",
          connector: "ticket.comment",
          ticket: 7,
          body: "{{trigger.input.topic}} via {{trigger.id}} {{trigger.kind}}",
        },
      ],
    });
    const repository = (await app.h.repositories.list({ active: true }))[0];
    if (repository === undefined) throw new Error("no repository");
    const created = await app.runs.createRun({
      workflowId: workflow.id,
      workflowVersion: 1,
      repositoryId: repository.id,
      baseBranch: "main",
      // As a run of before stored it: the input itself, no trigger id.
      triggerInput: JSON.stringify({ repo: "acme/widgets", topic: "caching" }),
      budgetMicroUsd: 1_000_000,
      clientRequestId: "old-1",
      createdBy: "user-1",
      actorLogin: "octocat",
    });
    if (created.status !== "created") throw new Error("not created");

    await app.engine.advance(created.run.id);

    expect((await app.stateOf(created.run.id)).run.status).toBe("succeeded");
    expect(calls).toEqual([
      {
        name: "ticket.comment",
        inputs: { ticket: 7, body: "caching via manual manual" },
      },
    ]);
  });
});

describe("starting a run through the API with a ticket", () => {
  async function refusedWith(run: Promise<unknown>): Promise<WorkflowRunError> {
    const error = await run.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(WorkflowRunError);
    return error as WorkflowRunError;
  }

  // #916-T70
  it("names the trigger, resolves the ticket and answers the run with the trigger it was started by", async () => {
    const { app } = await harness();
    const workflow = await app.saveWorkflow(laneDocument());

    const started = await app.start(workflow.id, {
      trigger: "manual",
      input: { ticket: "github:acme/widgets#128" },
    });

    expect(started.created).toBe(true);
    expect(started.run).toMatchObject({
      trigger: "manual",
      triggerId: "manual",
      status: "running",
    });
    expect(app.kicked).toEqual([started.run.id]);
  });

  // #916-T71
  it("does not need the trigger named when exactly one trigger can be started", async () => {
    const { app } = await harness();
    const workflow = await app.saveWorkflow(laneDocument());

    const started = await app.start(workflow.id, {
      input: { ticket: "github:acme/widgets#128" },
    });

    expect(started.run.triggerId).toBe("manual");
  });

  // #916-T72
  it("asks for the trigger when several can be started, and refuses one that does not exist or is not started by hand", async () => {
    const { app } = await harness();
    const document = laneDocument();
    (document.triggers as unknown[]).push({
      id: "api",
      kind: "api",
      input: TICKET_INPUT,
    });
    const workflow = await app.saveWorkflow(document);
    const input = { ticket: "github:acme/widgets#128" };

    expect((await refusedWith(app.start(workflow.id, { input }))).code).toBe(
      "WORKFLOW_RUN_REQUEST_INVALID",
    );
    expect(
      (await refusedWith(app.start(workflow.id, { trigger: "nope", input })))
        .code,
    ).toBe("WORKFLOW_RUN_TRIGGER_UNKNOWN");
    expect(
      (await refusedWith(app.start(workflow.id, { trigger: "labeled", input })))
        .code,
    ).toBe("WORKFLOW_RUN_TRIGGER_NOT_MANUAL");
    const viaApi = await app.start(workflow.id, { trigger: "api", input });
    expect(viaApi.run).toMatchObject({ trigger: "api", triggerId: "api" });
  });

  // #916-T73
  it("refuses a ticket that is no reference, that names a repository of no workspace, or that does not exist", async () => {
    const { app } = await harness();
    const workflow = await app.saveWorkflow(laneDocument());
    const attempt = (ticket: unknown, id: string) =>
      app.start(workflow.id, {
        trigger: "manual",
        input: { ticket },
        clientRequestId: id,
      });

    const badText = await refusedWith(attempt("acme/widgets#128", "a"));
    expect(badText.code).toBe("WORKFLOW_RUN_INPUT_INVALID");
    expect(badText.errors).toEqual([
      expect.objectContaining({ path: "/ticket", code: "invalid_value" }),
    ]);
    expect(
      (await refusedWith(attempt("jira:ABC-1", "b"))).errors[0],
    ).toMatchObject({ code: "invalid_value", available: ["github"] });
    expect((await refusedWith(attempt(128, "c"))).errors[0]).toMatchObject({
      code: "wrong_type",
    });
    expect((await refusedWith(attempt("github:other/thing#1", "d"))).code).toBe(
      "WORKFLOW_RUN_REPOSITORY_NOT_FOUND",
    );
    expect(
      (await refusedWith(attempt("github:acme/widgets#999", "e"))).code,
    ).toBe("WORKFLOW_RUN_TICKET_NOT_FOUND");
    expect((await app.waitingJobs()).length).toBe(0);
  });

  // #916-T74
  it("answers the same run for the same request, and refuses another trigger or ticket under the same id", async () => {
    const { app } = await harness();
    const document = laneDocument();
    const workflow = await app.saveWorkflow(document);
    const input = { ticket: "github:Acme/Widgets#128" };

    const first = await app.start(workflow.id, { trigger: "manual", input });
    const again = await app.start(workflow.id, { trigger: "manual", input });
    const unnamed = await app.start(workflow.id, { input });

    expect(again).toMatchObject({ created: false });
    expect(again.run.id).toBe(first.run.id);
    expect(unnamed.run.id).toBe(first.run.id);
    const other = await refusedWith(
      app.start(workflow.id, {
        trigger: "manual",
        input: { ticket: "github:acme/widgets#129" },
      }),
    );
    expect(other).toMatchObject({
      code: "WORKFLOW_RUN_REQUEST_REUSED",
      runId: first.run.id,
    });
    const elsewhere = await refusedWith(
      app.start(workflow.id, { trigger: "labeled", input }),
    );
    expect(elsewhere.code).toBe("WORKFLOW_RUN_REQUEST_REUSED");
  });

  // #916-T75
  it("keeps the old form of the body working: a workflow with the single trigger is started with `input` and `repo`", async () => {
    const { app } = await harness();
    const workflow = await app.saveWorkflow({
      version: 1,
      name: "Legacy",
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
          id: "say",
          kind: "action",
          connector: "ticket.comment",
          ticket: 7,
          body: "hi",
        },
      ],
    });

    const started = await app.start(workflow.id, {
      input: { repo: "acme/widgets" },
    });

    expect(started.run).toMatchObject({
      trigger: "manual",
      triggerId: "manual",
      input: { repo: "acme/widgets" },
    });
    expect(started.run.baseBranch).toBe("main");
  });
});
