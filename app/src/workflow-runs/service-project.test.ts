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

const NO_INPUT = {
  version: 1,
  name: "No input",
  triggers: [{ id: "manual", kind: "manual" }],
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

const JIRA_SOURCE = {
  provider: "jira",
  repositoryId: "repo-widgets",
  board: null,
  connectionId: "conn-1",
  projectKey: "PROJ",
};

const JIRA_ISSUE = {
  key: "PROJ-12",
  title: "Fix the login",
  body: "It fails.",
  url: "https://acme.atlassian.net/browse/PROJ-12",
  labels: [],
  assignees: ["Ada"],
  type: "Bug",
  status: "Ready for agent",
};

function harness(
  document: unknown,
  projectId: string | null = "project-1",
  earlier?: StoredWorkflowRun,
  source: Record<string, unknown> = {
    provider: "github",
    repositoryId: "repo-widgets",
    board: null,
  },
  options: { active?: boolean; unresolvable?: string[] } = {},
) {
  const created: NewWorkflowRun[] = [];
  const readTicket = vi.fn(async (_repositoryId: string, key: string) =>
    source.provider === "jira" ? { ...JIRA_ISSUE, key } : ISSUE,
  );
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
          active: options.active ?? true,
          ticketSource: source,
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
      return id === undefined || options.unresolvable?.includes(fullName)
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

  // #1039
  it("starts with a Jira issue in a lane of a Jira project: the ticket is read by its key and the run names the Jira reference", async () => {
    const { service, created, readTicket } = harness(
      BY_TICKET,
      "project-1",
      undefined,
      JIRA_SOURCE,
    );

    const started = await service.start(USER, "wf-1", {
      input: { ticket: "jira:acme/widgets#PROJ-12" },
      clientRequestId: "r-1",
    });

    expect(started.created).toBe(true);
    expect(readTicket).toHaveBeenCalledWith("repo-widgets", "PROJ-12");
    expect(created[0]).toMatchObject({
      repositoryId: "repo-widgets",
      ticketRef: "jira:acme/widgets#PROJ-12",
    });
    const input = JSON.parse(created[0]?.triggerInput ?? "{}") as {
      ticket: Record<string, unknown>;
    };
    expect(input.ticket).toMatchObject({
      key: "PROJ-12",
      title: "Fix the login",
      status: "Ready for agent",
      assignees: ["Ada"],
    });
  });

  // #1039
  it("refuses a GitHub ticket in a lane of a Jira project, and a Jira ticket in a lane without a project, before anything is asked", async () => {
    const jira = harness(BY_TICKET, "project-1", undefined, JIRA_SOURCE);
    const wrong = await refusal(
      jira.service.start(USER, "wf-1", {
        input: { ticket: "github:acme/widgets#128" },
        clientRequestId: "r-1",
      }),
    );
    expect(wrong.code).toBe("WORKFLOW_RUN_TICKET_PROVIDER_UNSUPPORTED");
    expect(jira.readTicket).not.toHaveBeenCalled();
    expect(jira.created).toEqual([]);

    const none = harness(BY_TICKET, null);
    const noProject = await refusal(
      none.service.start(USER, "wf-1", {
        input: { ticket: "jira:acme/widgets#PROJ-12" },
        clientRequestId: "r-2",
      }),
    );
    expect(noProject.code).toBe("WORKFLOW_RUN_TICKET_PROVIDER_UNSUPPORTED");
    expect(none.readTicket).not.toHaveBeenCalled();
  });

  // #1038
  it("refuses a ticket of the Jira provider in a lane of a GitHub project before anything is asked and writes no run", async () => {
    const { service, created, readTicket } = harness(BY_TICKET);

    const failure = await refusal(
      service.start(USER, "wf-1", {
        input: { ticket: "jira:acme/widgets#PROJ-12" },
        clientRequestId: "r-1",
      }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_TICKET_PROVIDER_UNSUPPORTED");
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

describe("a manual start of a trigger without input (#1106)", () => {
  // #1106-T01
  it("works on the repository of the project and its default branch, with no input at all", async () => {
    const { service, created } = harness(NO_INPUT);

    const started = await service.start(USER, "wf-1", {
      clientRequestId: "r-1",
    });

    expect(started.created).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      repositoryId: "repo-widgets",
      baseBranch: "main",
      triggerKind: "manual",
      triggerId: "manual",
    });
    expect(JSON.parse(created[0]?.triggerInput ?? "{}")).toEqual({});
  });

  // #1106-T02
  it("refuses a field the trigger does not declare, and writes no run", async () => {
    const { service, created } = harness(NO_INPUT);

    const failure = await refusal(
      service.start(USER, "wf-1", {
        input: { repo: "acme/other" },
        clientRequestId: "r-1",
      }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_INPUT_INVALID");
    expect(created).toEqual([]);
  });

  // #1106-T03
  it("refuses a lane without a project with its own code: there is no repository to work on", async () => {
    const { service, created } = harness(NO_INPUT, null);

    const failure = await refusal(
      service.start(USER, "wf-1", { clientRequestId: "r-1" }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_PROJECT_REQUIRED");
    expect(created).toEqual([]);
  });

  // #1106-T04
  it("starts an api trigger without input the same way", async () => {
    const { service, created } = harness({
      ...NO_INPUT,
      triggers: [{ id: "hook", kind: "api" }],
    });

    const started = await service.start(USER, "wf-1", {
      clientRequestId: "r-1",
    });

    expect(started.created).toBe(true);
    expect(created[0]).toMatchObject({
      repositoryId: "repo-widgets",
      baseBranch: "main",
      triggerKind: "api",
      triggerId: "hook",
    });
  });

  // #1106-T05
  it("works on the code repository of a Jira-source project", async () => {
    const { service, created, readTicket } = harness(
      NO_INPUT,
      "project-1",
      undefined,
      JIRA_SOURCE,
    );

    const started = await service.start(USER, "wf-1", {
      clientRequestId: "r-1",
    });

    expect(started.created).toBe(true);
    expect(created[0]).toMatchObject({
      repositoryId: "repo-widgets",
      baseBranch: "main",
    });
    expect(readTicket).not.toHaveBeenCalled();
  });

  // #1106-T06
  it("answers a replay of the same request id with the run it made, and refuses a replay that adds a field", async () => {
    const earlier = {
      id: "run-1",
      workflowId: "wf-1",
      triggerId: "manual",
      triggerInput: "{}",
    } as unknown as StoredWorkflowRun;
    const { service, created } = harness(NO_INPUT, "project-1", earlier);

    const again = await service.start(USER, "wf-1", {
      clientRequestId: "r-1",
    });
    const same = await service.start(USER, "wf-1", {
      input: {},
      clientRequestId: "r-1",
    });
    const other = await refusal(
      service.start(USER, "wf-1", {
        input: { repo: "acme/widgets" },
        clientRequestId: "r-1",
      }),
    );

    expect(again.created).toBe(false);
    expect(same.created).toBe(false);
    expect(other.code).toBe("WORKFLOW_RUN_REQUEST_REUSED");
    expect(created).toEqual([]);
  });

  // #1106-T07
  it("names the repository of the project, not input.repo, when it is not available", async () => {
    const { service, created } = harness(
      NO_INPUT,
      "project-1",
      undefined,
      undefined,
      { unresolvable: ["acme/widgets"] },
    );

    const failure = await refusal(
      service.start(USER, "wf-1", { clientRequestId: "r-1" }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_REPOSITORY_NOT_FOUND");
    expect(failure.message).toContain("acme/widgets");
    expect(failure.message).not.toContain("input.repo");
    expect(created).toEqual([]);
  });

  // #1106-T08
  it("tells the project's repository is not available when its name cannot be found at all", async () => {
    const { service, created } = harness(NO_INPUT, "project-1", undefined, {
      provider: "github",
      repositoryId: "repo-gone",
      board: null,
    });

    const failure = await refusal(
      service.start(USER, "wf-1", { clientRequestId: "r-1" }),
    );

    expect(failure.code).toBe("WORKFLOW_RUN_REPOSITORY_NOT_FOUND");
    expect(failure.message).toContain("project of this lane");
    expect(failure.message).not.toContain("input.repo");
    expect(created).toEqual([]);
  });

  // #1106-T09
  it("refuses a lane whose project is switched off, and writes no run, while a trigger with input is not held to it", async () => {
    const off = harness(NO_INPUT, "project-1", undefined, undefined, {
      active: false,
    });
    const withInput = harness(BY_REPO, "project-1", undefined, undefined, {
      active: false,
    });

    const failure = await refusal(
      off.service.start(USER, "wf-1", { clientRequestId: "r-1" }),
    );
    const started = await withInput.service.start(USER, "wf-1", {
      input: {},
      clientRequestId: "r-2",
    });

    expect(failure.code).toBe("WORKFLOW_RUN_PROJECT_INACTIVE");
    expect(off.created).toEqual([]);
    expect(started.created).toBe(true);
  });

  // #1106-T10
  it("starts the manual trigger of a lane that also has a label trigger, on the project's repository", async () => {
    const { service, created } = harness({
      ...NO_INPUT,
      triggers: [
        { id: "labeled", kind: "ticket.labeled", label: "go" },
        { id: "manual", kind: "manual" },
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
    });

    const started = await service.start(USER, "wf-1", {
      trigger: "manual",
      clientRequestId: "r-1",
    });

    expect(started.created).toBe(true);
    expect(created[0]).toMatchObject({
      repositoryId: "repo-widgets",
      triggerKind: "manual",
      triggerId: "manual",
    });
  });
});
