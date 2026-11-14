// SPDX-License-Identifier: LicenseRef-Proprietary

// #1039: which lanes of a Jira project a status change in Jira starts, and what the run holds. The database is replaced by a list: the rules
// are what is tested here; the whole path from a signed delivery is in jira/webhook.integration.test.ts.
import { describe, expect, it } from "vitest";
import type {
  NewWorkflowRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
} from "../db/repositories/workflows-repository.ts";
import {
  createJiraStatusTrigger,
  type JiraStatusMove,
} from "./jira-status-trigger.ts";
import type { StatusTicket } from "./status-trigger.ts";

const MOVE: JiraStatusMove = {
  projectId: "proj-1",
  connectionId: "conn-1",
  projectKey: "PROJ",
  issueKey: "PROJ-7",
  from: "To Do",
  to: "Ready for agent",
  actor: { accountId: "acc-1", name: "Grace" },
};

const TICKET: StatusTicket = {
  key: "PROJ-7",
  title: "Fix the login",
  body: "It fails.",
  url: "https://acme.atlassian.net/browse/PROJ-7",
  labels: ["backend"],
  assignees: ["Ada"],
  type: "Bug",
  status: "Ready for agent",
};

const READY = {
  id: "ready",
  kind: "ticket.statusChanged",
  to: "Ready for agent",
};

const doc = (trigger: Record<string, unknown>) =>
  JSON.stringify({
    version: 1,
    name: "Flow",
    triggers: [trigger],
    steps: [
      {
        id: "implement",
        kind: "agent",
        profile: "worker",
        environment: "Python",
        instruction: "{{trigger.ticket.key}} {{trigger.ticket.status}}",
      },
    ],
  });

function harness(
  lanes: { id: string; document: string }[],
  options: {
    project?: "none" | "inactive" | "github" | "other-key";
    ticket?: StatusTicket | undefined | "none";
    readFails?: boolean;
    repository?: "none";
  } = {},
) {
  const created: NewWorkflowRun[] = [];
  const kicked: string[] = [];
  const lines: string[] = [];
  const reads: string[] = [];
  const written = new Map<string, StoredWorkflowRun>();
  const trigger = createJiraStatusTrigger({
    runs: {
      async createRun(input) {
        const earlier = written.get(input.clientRequestId);
        if (earlier !== undefined) return { status: "existing", run: earlier };
        created.push(input);
        const run = {
          id: `run-${written.size + 1}`,
          status: "running",
        } as StoredWorkflowRun;
        written.set(input.clientRequestId, run);
        return { status: "created", run };
      },
    },
    workflows: {
      async listProjectWithStatusTrigger() {
        return lanes.map((lane) => ({
          workflow: { id: lane.id } as StoredWorkflow,
          current: {
            workflowId: lane.id,
            version: 1,
            document: lane.document,
          } as StoredWorkflowVersion,
        }));
      },
    },
    async projectOf() {
      if (options.project === "none") return undefined;
      return {
        id: "proj-1",
        active: options.project !== "inactive",
        repositoryId: "repo-1",
        jira:
          options.project === "github"
            ? null
            : {
                connectionId: "conn-1",
                projectKey: options.project === "other-key" ? "OTHER" : "PROJ",
              },
      };
    },
    async repositoryOf(repositoryId) {
      return options.repository === "none"
        ? undefined
        : { id: repositoryId, fullName: "acme/widgets", defaultBranch: "main" };
    },
    async readTicket(_source, key) {
      reads.push(key);
      if (options.readFails === true) throw new Error("jira_unavailable");
      return options.ticket === "none"
        ? undefined
        : "ticket" in options
          ? options.ticket
          : TICKET;
    },
    kick: (runId) => void kicked.push(runId),
    log: (line) => lines.push(line),
  });
  return { trigger, created, kicked, lines, reads };
}

describe("which lanes of a Jira project a status change starts", () => {
  // #1039-T01
  it("starts one run with the ticket fields, the status move and the Jira reference", async () => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: doc(READY) },
    ]);
    const result = await trigger.start("reg-1-hook-1", MOVE);
    expect(result).toEqual({
      matched: 1,
      started: 1,
      existing: 0,
      skipped: 0,
      busy: 0,
    });
    expect(kicked).toEqual(["run-1"]);
    const [run] = created;
    expect(run).toMatchObject({
      workflowId: "wf-1",
      repositoryId: "repo-1",
      baseBranch: "main",
      triggerKind: "ticket.statusChanged",
      triggerId: "ready",
      triggerKey: "repo-1#PROJ-7",
      ticketRef: "jira:acme/widgets#PROJ-7",
      clientRequestId: "jira-reg-1-hook-1-wf-1",
      actorLogin: "Grace",
      createdBy: null,
    });
    expect(JSON.parse(run?.triggerInput ?? "{}")).toEqual({
      ticket: {
        key: "PROJ-7",
        number: 0,
        title: "Fix the login",
        body: "It fails.",
        url: "https://acme.atlassian.net/browse/PROJ-7",
        labels: ["backend"],
        type: "Bug",
        assignees: ["Ada"],
        status: "Ready for agent",
        repo: {
          fullName: "acme/widgets",
          owner: "acme",
          name: "widgets",
          defaultBranch: "main",
        },
      },
      status: { from: "To Do", to: "Ready for agent" },
    });
  });

  // #1039
  it("starts the same delivery's lane once", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: doc(READY) },
    ]);
    await trigger.start("d1", MOVE);
    const again = await trigger.start("d1", MOVE);
    expect(again).toMatchObject({ started: 0, existing: 1 });
    expect(created).toHaveLength(1);
  });

  // #1039
  it("takes whoever made the change, also one that has no name", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: doc(READY) },
    ]);
    await trigger.start("d1", { ...MOVE, actor: undefined });
    expect(created[0]?.actorLogin).toBe("unknown");
  });

  // #1039
  it("honours `from` of the trigger and starts nothing for another status", async () => {
    const { trigger, created } = harness([
      { id: "from-ok", document: doc({ ...READY, from: "To Do" }) },
      { id: "from-other", document: doc({ ...READY, from: "Backlog" }) },
      { id: "other-to", document: doc({ ...READY, id: "x", to: "Done" }) },
    ]);
    const result = await trigger.start("d1", MOVE);
    expect(result.matched).toBe(1);
    expect(created.map((run) => run.workflowId)).toEqual(["from-ok"]);
  });

  // #1039
  it("does not read the issue when no lane waits for the status", async () => {
    const { trigger, reads } = harness([
      { id: "wf-1", document: doc({ ...READY, to: "Done" }) },
    ]);
    expect(await trigger.start("d1", MOVE)).toMatchObject({ matched: 0 });
    expect(reads).toEqual([]);
  });

  // #1039-T01
  it("starts nothing when the issue no longer has the status of the delivery (a late or repeated delivery)", async () => {
    const { trigger, created, lines } = harness(
      [{ id: "wf-1", document: doc(READY) }],
      { ticket: { ...TICKET, status: "In Progress" } },
    );
    expect(await trigger.start("d1", MOVE)).toMatchObject({
      matched: 1,
      started: 0,
      skipped: 1,
    });
    expect(created).toEqual([]);
    expect(lines.join("\n")).toContain("no longer has the status");
  });

  // #1039
  it("starts nothing for a project that is off, has no Jira source, or names another Jira project", async () => {
    for (const project of [
      "none",
      "inactive",
      "github",
      "other-key",
    ] as const) {
      const { trigger, created, reads } = harness(
        [{ id: "wf-1", document: doc(READY) }],
        { project },
      );
      expect(await trigger.start("d1", MOVE)).toMatchObject({
        matched: 0,
        started: 0,
      });
      expect(created).toEqual([]);
      expect(reads).toEqual([]);
    }
  });

  // #1039
  it("starts nothing when the issue is gone or the repository is no active one, and fails when Jira cannot be asked", async () => {
    const gone = harness([{ id: "wf-1", document: doc(READY) }], {
      ticket: "none",
    });
    expect(await gone.trigger.start("d1", MOVE)).toMatchObject({
      skipped: 1,
      started: 0,
    });
    const noRepo = harness([{ id: "wf-1", document: doc(READY) }], {
      repository: "none",
    });
    expect(await noRepo.trigger.start("d1", MOVE)).toMatchObject({
      skipped: 1,
      started: 0,
    });
    const down = harness([{ id: "wf-1", document: doc(READY) }], {
      readFails: true,
    });
    await expect(down.trigger.start("d1", MOVE)).rejects.toThrow(
      "jira_unavailable",
    );
    expect(down.created).toEqual([]);
  });
});
