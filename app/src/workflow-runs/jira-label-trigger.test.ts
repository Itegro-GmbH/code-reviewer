// SPDX-License-Identifier: LicenseRef-Proprietary

// #1129: which lanes of a Jira project a label put on an issue starts, and what the run holds. The database is replaced by a list: the rules
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
  createJiraLabelTrigger,
  type JiraLabelsAdded,
} from "./jira-label-trigger.ts";
import type { StatusTicket } from "./status-trigger.ts";

const ADDED: JiraLabelsAdded = {
  projectId: "proj-1",
  connectionId: "conn-1",
  projectKey: "PROJ",
  issueKey: "PROJ-7",
  labels: ["ready-for-agent"],
  actor: { accountId: "acc-1", name: "Grace" },
};

const TICKET: StatusTicket = {
  key: "PROJ-7",
  title: "Fix the login",
  body: "It fails.",
  url: "https://acme.atlassian.net/browse/PROJ-7",
  labels: ["backend", "ready-for-agent"],
  assignees: ["Ada"],
  type: "Bug",
  status: "To Do",
};

const LABELED = {
  id: "labeled",
  kind: "ticket.labeled",
  label: "ready for agent",
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
        instruction: "{{trigger.ticket.key}} {{trigger.ticket.url}}",
      },
    ],
  });

function harness(
  lanes: { id: string; document: string }[],
  options: {
    project?: "none" | "inactive" | "github" | "other-key";
    ticket?: StatusTicket | "none";
    readFails?: boolean;
    repository?: "none";
    /** The ids of the lanes that already have a running run for the ticket. */
    running?: string[];
    /**
     * Runs of a lane for the ticket that hold no trigger key: a run started by hand or through the API (`ticketRef` set, `triggerKey`
     * not). `clientRequestId` is the request that started it.
     */
    byHand?: { workflowId: string; clientRequestId: string }[];
  } = {},
) {
  const created: NewWorkflowRun[] = [];
  const kicked: string[] = [];
  const lines: string[] = [];
  const reads: string[] = [];
  const written = new Map<string, StoredWorkflowRun>();
  const trigger = createJiraLabelTrigger({
    runs: {
      async findActiveForTicket(workflowId, ticketRef) {
        const found = options.byHand?.find(
          (run) => run.workflowId === workflowId,
        );
        if (found === undefined || ticketRef !== "jira:acme/widgets#PROJ-7")
          return undefined;
        return {
          id: "run-by-hand",
          status: "running",
          clientRequestId: found.clientRequestId,
        } as StoredWorkflowRun;
      },
      async createRun(input) {
        const earlier = written.get(input.clientRequestId);
        if (earlier !== undefined) return { status: "existing", run: earlier };
        if (options.running?.includes(input.workflowId) === true)
          return {
            status: "busy",
            run: { id: "run-busy", status: "running" } as StoredWorkflowRun,
          };
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
      async listProjectWithIssueTrigger() {
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
      return options.ticket === "none" ? undefined : (options.ticket ?? TICKET);
    },
    kick: (runId) => void kicked.push(runId),
    log: (line) => lines.push(line),
  });
  return { trigger, created, kicked, lines, reads };
}

describe("which lanes of a Jira project a label put on an issue starts", () => {
  // #1129-T04
  it("starts the lane whose label has spaces for the hyphenated Jira label, with the ticket and the Jira reference", async () => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: doc(LABELED) },
    ]);
    const result = await trigger.start("reg-1-hook-1", ADDED);
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
      triggerKind: "ticket.labeled",
      triggerId: "labeled",
      triggerKey: "repo-1#PROJ-7",
      ticketRef: "jira:acme/widgets#PROJ-7",
      clientRequestId: "jira-label-reg-1-hook-1-wf-1",
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
        labels: ["backend", "ready-for-agent"],
        type: "Bug",
        assignees: ["Ada"],
        status: "To Do",
        repo: {
          fullName: "acme/widgets",
          owner: "acme",
          name: "widgets",
          defaultBranch: "main",
        },
      },
    });
  });

  // #1129-T04
  it("starts a lane that names the label with a hyphen or with its old kind name, and not one with another spelling", async () => {
    const { trigger, created } = harness([
      {
        id: "hyphen",
        document: doc({ ...LABELED, label: "ready-for-agent" }),
      },
      {
        id: "old-kind",
        document: doc({ ...LABELED, kind: "github.issueLabeled" }),
      },
      { id: "case", document: doc({ ...LABELED, label: "Ready for agent" }) },
      { id: "other", document: doc({ ...LABELED, label: "ready for review" }) },
      {
        id: "status",
        document: doc({ id: "s", kind: "ticket.statusChanged", to: "Done" }),
      },
    ]);
    const result = await trigger.start("d1", ADDED);
    expect(result.matched).toBe(2);
    expect(created.map((run) => run.workflowId)).toEqual([
      "hyphen",
      "old-kind",
    ]);
  });

  // #1129-T02
  it("starts a lane once when several of the labels put on are its own", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: doc(LABELED) },
    ]);
    await trigger.start("d1", {
      ...ADDED,
      labels: ["ready-for-agent", "backend"],
    });
    expect(created).toHaveLength(1);
  });

  // #1129-T07
  it("starts the same delivery's lane once, and none while a run for the ticket goes on", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: doc(LABELED) },
    ]);
    await trigger.start("d1", ADDED);
    const again = await trigger.start("d1", ADDED);
    expect(again).toMatchObject({ started: 0, existing: 1 });
    expect(created).toHaveLength(1);

    const held = harness([{ id: "wf-1", document: doc(LABELED) }], {
      running: ["wf-1"],
    });
    expect(await held.trigger.start("d2", ADDED)).toMatchObject({
      matched: 1,
      started: 0,
      busy: 1,
    });
    expect(held.kicked).toEqual([]);
    expect(held.lines.join("\n")).toContain("[label-trigger]");
  });

  // #1129-T21 (review of #1130, finding 1): a run started by hand or through the API holds no trigger key, and its pre-step puts the lane's own
  // label on the ticket; on Jira that write is a person's, so the delivery it causes must not start a second run of the lane.
  it("starts nothing for the label a run started by hand wrote itself, and still starts the lanes that have no run", async () => {
    const { trigger, created, kicked, lines } = harness(
      [
        { id: "wf-1", document: doc(LABELED) },
        { id: "wf-2", document: doc(LABELED) },
      ],
      {
        byHand: [{ workflowId: "wf-1", clientRequestId: "request-by-hand" }],
      },
    );
    expect(await trigger.start("d1", ADDED)).toEqual({
      matched: 2,
      started: 1,
      existing: 0,
      skipped: 0,
      busy: 1,
    });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-2"]);
    expect(kicked).toEqual(["run-1"]);
    expect(lines.join("\n")).toContain("run-by-hand");
  });

  // #1129-T21
  it("does not hold back the run its own delivery wrote when the delivery is tried again", async () => {
    const { trigger, created } = harness(
      [{ id: "wf-1", document: doc(LABELED) }],
      {
        byHand: [
          {
            workflowId: "wf-1",
            clientRequestId: "jira-label-d1-wf-1",
          },
        ],
      },
    );
    expect(await trigger.start("d1", ADDED)).toMatchObject({
      busy: 0,
      started: 1,
    });
    expect(created).toHaveLength(1);
  });

  // #1129
  it("takes whoever put the label on, also one that has no name", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: doc(LABELED) },
    ]);
    await trigger.start("d1", { ...ADDED, actor: undefined });
    expect(created[0]?.actorLogin).toBe("unknown");
  });

  // #1129-T05
  it("starts nothing and does not read the issue when no lane waits for the label or none was put on", async () => {
    const { trigger, created, reads } = harness([
      { id: "wf-1", document: doc({ ...LABELED, label: "other" }) },
    ]);
    expect(await trigger.start("d1", ADDED)).toMatchObject({ matched: 0 });
    expect(await trigger.start("d2", { ...ADDED, labels: [] })).toMatchObject({
      matched: 0,
    });
    expect(created).toEqual([]);
    expect(reads).toEqual([]);
  });

  // #1129-T06
  it("starts nothing when the issue no longer has the label (a late or repeated delivery)", async () => {
    const { trigger, created, lines } = harness(
      [{ id: "wf-1", document: doc(LABELED) }],
      { ticket: { ...TICKET, labels: ["backend"] } },
    );
    expect(await trigger.start("d1", ADDED)).toMatchObject({
      matched: 1,
      started: 0,
      skipped: 1,
    });
    expect(created).toEqual([]);
    expect(lines.join("\n")).toContain("no longer has the label");
  });

  // #1129-T05
  it("starts nothing for a project that is off, has no Jira source, or names another Jira project", async () => {
    for (const project of [
      "none",
      "inactive",
      "github",
      "other-key",
    ] as const) {
      const { trigger, created, reads } = harness(
        [{ id: "wf-1", document: doc(LABELED) }],
        { project },
      );
      expect(await trigger.start("d1", ADDED)).toMatchObject({
        matched: 0,
        started: 0,
      });
      expect(created).toEqual([]);
      expect(reads).toEqual([]);
    }
  });

  // #1129
  it("starts nothing when the issue is gone or the repository is no active one, and fails when Jira cannot be asked", async () => {
    const gone = harness([{ id: "wf-1", document: doc(LABELED) }], {
      ticket: "none",
    });
    expect(await gone.trigger.start("d1", ADDED)).toMatchObject({
      skipped: 1,
      started: 0,
    });
    const noRepo = harness([{ id: "wf-1", document: doc(LABELED) }], {
      repository: "none",
    });
    expect(await noRepo.trigger.start("d1", ADDED)).toMatchObject({
      skipped: 1,
      started: 0,
    });
    const down = harness([{ id: "wf-1", document: doc(LABELED) }], {
      readFails: true,
    });
    await expect(down.trigger.start("d1", ADDED)).rejects.toThrow(
      "jira_unavailable",
    );
    expect(down.created).toEqual([]);
  });
});
