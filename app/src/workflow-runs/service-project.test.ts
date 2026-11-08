// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: a lane works within the ticket source of its project. A manual or api start whose `ticket` (or `input.repo`) is outside it is
// refused before the platform is asked about the ticket and before a run is written; a lane without a project is held to nothing.
import { describe, expect, it, vi } from "vitest";
import type { NewWorkflowRun } from "../db/repositories/workflow-runs-repository.ts";
import type { StoredWorkflowRun } from "../db/repositories/workflow-runs-repository.ts";
import { WorkflowRunError } from "./errors.ts";
import { createWorkflowRunService } from "./service.ts";

const USER = { id: "user-1", githubLogin: "octocat" };

const ISSUE = {
  number: 128,
  title: "Cache the widget list",
  body: "Slow",
  url: "https://github.com/acme/widgets/issues/128",
  labels: ["bug"],
  assignees: [],
  type: "Bug",
};

const BY_TICKET = {
  version: 1,
  name: "By ticket",
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
  steps: [
    {
      id: "say",
      kind: "action",
      connector: "ticket.comment",
      ticket: "{{trigger.ticket}}",
      body: "hi",
    },
  ],
};

const BY_REPO = {
  version: 1,
  name: "By repo",
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
  steps: [
    {
      id: "say",
      kind: "action",
      connector: "ticket.comment",
      ticket: 7,
      body: "hi",
    },
  ],
};

/** The repositories of the workspace by name; the project of the lane takes its tickets from `acme/widgets`. */
const REPOSITORIES: Record<string, string> = {
  "acme/widgets": "repo-widgets",
  "acme/other": "repo-other",
};

function harness(
  document: unknown,
  projectId: string | null = "project-1",
  earlier?: StoredWorkflowRun,
) {
  const created: NewWorkflowRun[] = [];
  const readTicket = vi.fn(async () => ISSUE);
  const service = createWorkflowRunService({
    runs: {
      async findByRequest() {
        return earlier;
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
          workflow: { archivedAt: null, projectId },
          current: { version: 1, document: JSON.stringify(document) },
        };
      },
    },
    projects: {
      async getById() {
        return {
          id: "project-1",
          ticketSource: {
            provider: "github",
            repositoryId: "repo-widgets",
            board: null,
          },
        };
      },
    },
    async repositoryName(id: string) {
      return Object.entries(REPOSITORIES).find(
        ([, value]) => value === id,
      )?.[0];
    },
    async resolveRepository(fullName: string) {
      const id = REPOSITORIES[fullName];
      return id === undefined
        ? undefined
        : { id, fullName, defaultBranch: "main" };
    },
    readTicket,
    kick() {},
  } as unknown as Parameters<typeof createWorkflowRunService>[0]);
  return { service, created, readTicket };
}

async function refusal(promise: Promise<unknown>): Promise<WorkflowRunError> {
  const reason = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(reason instanceof WorkflowRunError))
    throw new Error("expected a WorkflowRunError");
  return reason;
}

describe("a manual start within the project of the lane (#922)", () => {
  // #922-T23
  it("starts with a ticket of the project's repository", async () => {
    const { service, created } = harness(BY_TICKET);

    const started = await service.start(USER, "wf-1", {
      input: { ticket: "github:acme/widgets#128" },
      clientRequestId: "r-1",
    });

    expect(started.created).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.repositoryId).toBe("repo-widgets");
  });

  // #922-T24
  it("refuses a ticket of another repository before the platform is asked and writes no run, naming the repository the project has", async () => {
    const { service, created, readTicket } = harness(BY_TICKET);

    const failure = await refusal(
      service.start(USER, "wf-1", {
        input: { ticket: "github:acme/other#5" },
        clientRequestId: "r-1",
      }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT");
    expect(failure.issues).toEqual([
      expect.objectContaining({
        path: "input.ticket",
        code: "ticket_outside_project",
        available: ["acme/widgets"],
      }),
    ]);
    expect(readTicket).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  // #922-T25
  it("refuses input.repo of another repository the same way", async () => {
    const { service, created } = harness(BY_REPO);

    const failure = await refusal(
      service.start(USER, "wf-1", {
        input: { repo: "acme/other" },
        clientRequestId: "r-1",
      }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_REPOSITORY_OUTSIDE_PROJECT");
    expect(failure.issues).toEqual([
      expect.objectContaining({
        path: "input.repo",
        code: "repository_outside_project",
        available: ["acme/widgets"],
      }),
    ]);
    expect(created).toEqual([]);
  });

  // #922-T26
  it("holds a lane without a project to no repository", async () => {
    const { service, created } = harness(BY_TICKET, null);

    await service.start(USER, "wf-1", {
      input: { ticket: "github:acme/other#5" },
      clientRequestId: "r-1",
    });

    expect(created.map((run) => run.repositoryId)).toEqual(["repo-other"]);
  });
  // #937-T20
  it("gives a start that leaves input.repo out the repository of the project, and stores it as if it was named", async () => {
    const { service, created } = harness(BY_REPO);

    await service.start(USER, "wf-1", { input: {}, clientRequestId: "r-1" });

    expect(created).toHaveLength(1);
    expect(created[0]?.repositoryId).toBe("repo-widgets");
    expect(JSON.parse(created[0]!.triggerInput)).toEqual({
      repo: "acme/widgets",
    });
  });

  // #937-T21
  it("still holds a named input.repo to the project, and leaves a lane without a project to name it", async () => {
    const named = harness(BY_REPO);
    const loose = harness(BY_REPO, null);

    const failure = await refusal(
      named.service.start(USER, "wf-1", {
        input: { repo: "acme/other" },
        clientRequestId: "r-1",
      }),
    );
    const missing = await refusal(
      loose.service.start(USER, "wf-1", { input: {}, clientRequestId: "r-1" }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_REPOSITORY_OUTSIDE_PROJECT");
    expect(missing.code).toBe("WORKFLOW_RUN_INPUT_INVALID");
    expect(named.created).toEqual([]);
    expect(loose.created).toEqual([]);
  });

  // #937-T22
  it("answers the replay of a start that left input.repo out with the run it made, and refuses another input under the same request id", async () => {
    const earlier = {
      id: "run-1",
      workflowId: "wf-1",
      triggerId: "manual",
      triggerInput: JSON.stringify({ repo: "acme/widgets" }),
    } as unknown as StoredWorkflowRun;
    const { service, created } = harness(BY_REPO, "project-1", earlier);

    const again = await service.start(USER, "wf-1", {
      input: {},
      clientRequestId: "r-1",
    });
    const other = await refusal(
      service.start(USER, "wf-1", {
        input: { repo: "acme/other" },
        clientRequestId: "r-1",
      }),
    );

    expect(again.created).toBe(false);
    expect(other.code).toBe("WORKFLOW_RUN_REQUEST_REUSED");
    expect(created).toEqual([]);
  });

  // #937-T23
  it("does not answer a replay that leaves repo out with a run that named it on a lane without a project", async () => {
    const earlier = {
      id: "run-1",
      workflowId: "wf-1",
      triggerId: "manual",
      triggerInput: JSON.stringify({ repo: "acme/widgets" }),
    } as unknown as StoredWorkflowRun;
    const { service, created } = harness(BY_REPO, null, earlier);

    const failure = await refusal(
      service.start(USER, "wf-1", { input: {}, clientRequestId: "r-1" }),
    );
    const same = await service.start(USER, "wf-1", {
      input: { repo: "acme/widgets" },
      clientRequestId: "r-1",
    });

    expect(failure.code).toBe("WORKFLOW_RUN_REQUEST_REUSED");
    expect(same.created).toBe(false);
    expect(created).toEqual([]);
  });
});
