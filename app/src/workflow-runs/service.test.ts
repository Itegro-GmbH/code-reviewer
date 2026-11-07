// SPDX-License-Identifier: LicenseRef-Proprietary

// What a start writes as `trigger_input` (#916) and as `ticket_ref` (#923). Without a ticket the input is stored as handed in, the shape every
// version stored: the version that still runs during a deploy reads `{{trigger.input.repo}}` from it. With a ticket it is `{ input, ticket }`.
import { describe, expect, it } from "vitest";
import type { NewWorkflowRun } from "../db/repositories/workflow-runs-repository.ts";
import type { StoredWorkflowRun } from "../db/repositories/workflow-runs-repository.ts";
import { labelTicketRef } from "./label-trigger.ts";
import { createWorkflowRunService } from "./service.ts";
import { readStoredInput, storedInputOf } from "./ticket.ts";

const USER = { id: "user-1", githubLogin: "octocat" };

const ISSUE = {
  number: 128,
  title: "Cache the widget list",
  body: "Slow",
  url: "https://github.com/acme/widgets/issues/128",
  labels: ["bug"],
  assignees: ["octocat"],
  type: "Bug",
};

function harness(document: unknown) {
  const created: NewWorkflowRun[] = [];
  const service = createWorkflowRunService({
    runs: {
      async findByRequest() {
        return undefined;
      },
      async createRun(input: NewWorkflowRun) {
        created.push(input);
        return {
          status: "created",
          run: {
            id: "run-1",
            workflowId: input.workflowId,
            triggerInput: input.triggerInput,
          } as unknown as StoredWorkflowRun,
        };
      },
      async listSteps() {
        return [];
      },
    },
    workflows: {
      async get() {
        return {
          workflow: { archivedAt: null },
          current: { version: 1, document: JSON.stringify(document) },
        };
      },
    },
    async resolveRepository(fullName: string) {
      return { id: "repo-1", fullName, defaultBranch: "main" };
    },
    async readTicket() {
      return ISSUE;
    },
    kick() {},
  } as unknown as Parameters<typeof createWorkflowRunService>[0]);
  return { service, created };
}

const STEP = {
  id: "say",
  kind: "action",
  connector: "ticket.comment",
  ticket: 7,
  body: "hi",
};

describe("the trigger_input of a run started by hand", () => {
  // #916-T66
  it("stores the input as handed in when the trigger has no ticket input, for a document of before and a new one alike", async () => {
    const legacy = harness({
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
      steps: [STEP],
    });
    await legacy.service.start(USER, "wf-1", {
      input: { repo: "acme/widgets", topic: "caching" },
      clientRequestId: "r-1",
    });
    expect(legacy.created.map((c) => JSON.parse(c.triggerInput))).toEqual([
      { repo: "acme/widgets", topic: "caching" },
    ]);

    const current = harness({
      version: 1,
      name: "Lane",
      triggers: [
        {
          id: "manual",
          kind: "manual",
          input: {
            type: "object",
            required: ["repo"],
            properties: { repo: { type: "string" } },
          },
        },
      ],
      steps: [STEP],
    });
    await current.service.start(USER, "wf-1", {
      trigger: "manual",
      input: { repo: "acme/widgets" },
      clientRequestId: "r-2",
    });
    expect(current.created.map((c) => JSON.parse(c.triggerInput))).toEqual([
      { repo: "acme/widgets" },
    ]);
  });

  // #916-T67
  it("stores { input, ticket } once a ticket is resolved", async () => {
    const lane = harness({
      version: 1,
      name: "Lane",
      triggers: [
        {
          id: "manual",
          kind: "manual",
          input: {
            type: "object",
            required: ["ticket"],
            properties: { ticket: { type: "ticket" } },
          },
        },
      ],
      steps: [STEP],
    });
    await lane.service.start(USER, "wf-1", {
      trigger: "manual",
      input: { ticket: "github:acme/widgets#128" },
      clientRequestId: "r-3",
    });
    const stored = JSON.parse(lane.created[0]?.triggerInput ?? "null");
    expect(stored).toMatchObject({
      input: {},
      ticket: { number: 128, repo: { fullName: "acme/widgets" } },
    });
  });

  // #923-T86
  it("names the ticket of the run as the label trigger does, and names none for a run without a ticket", async () => {
    const lane = harness({
      version: 1,
      name: "Lane",
      triggers: [
        {
          id: "with-ticket",
          kind: "manual",
          input: {
            type: "object",
            required: ["ticket"],
            properties: { ticket: { type: "ticket" } },
          },
        },
        {
          id: "plain",
          kind: "manual",
          input: {
            type: "object",
            required: ["repo"],
            properties: { repo: { type: "string" } },
          },
        },
      ],
      steps: [STEP],
    });
    await lane.service.start(USER, "wf-1", {
      trigger: "with-ticket",
      input: { ticket: "github:acme/widgets#128" },
      clientRequestId: "r-4",
    });
    await lane.service.start(USER, "wf-1", {
      trigger: "plain",
      input: { repo: "acme/widgets" },
      clientRequestId: "r-5",
    });
    expect(lane.created.map((c) => c.ticketRef)).toEqual([
      labelTicketRef("acme/widgets", 128),
      undefined,
    ]);
  });
});

describe("reading a stored trigger input", () => {
  // #916-T68
  it("accepts the input as it was handed in and the wrapped shape", () => {
    expect(readStoredInput({ repo: "acme/widgets" })).toEqual({
      input: { repo: "acme/widgets" },
    });
    expect(readStoredInput({})).toEqual({ input: {} });
    expect(readStoredInput("text")).toEqual({ input: {} });
    expect(
      readStoredInput({ input: { repo: "a/b" }, ticket: { number: 1 } }),
    ).toEqual({
      input: { repo: "a/b" },
      ticket: { number: 1 },
    });
    // An input that has a field called `input` or `ticket` of its own is still the input.
    expect(readStoredInput({ input: { x: 1 } })).toEqual({
      input: { input: { x: 1 } },
    });
    expect(
      readStoredInput({ input: { x: 1 }, ticket: { y: 2 }, other: 3 }),
    ).toEqual({ input: { input: { x: 1 }, ticket: { y: 2 }, other: 3 } });
    expect(storedInputOf({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});
