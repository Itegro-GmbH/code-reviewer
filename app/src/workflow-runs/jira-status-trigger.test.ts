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
import type { StatusRef } from "../workflows/status-match.ts";
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
    ticket?: (StatusTicket & { statusId?: string }) | undefined | "none";
    readFails?: boolean;
    repository?: "none";
    /** The statuses of the project; "unreadable" for a Jira that cannot be asked, left out for a trigger wired without them. */
    statuses?: StatusRef[] | "unreadable";
  } = {},
) {
  const created: NewWorkflowRun[] = [];
  const kicked: string[] = [];
  const lines: string[] = [];
  const reads: string[] = [];
  const written = new Map<string, StoredWorkflowRun>();
  const trigger = createJiraStatusTrigger({
    ...(options.statuses === undefined
      ? {}
      : {
          statusesOf: async () =>
            options.statuses === "unreadable" ? undefined : options.statuses,
        }),
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

// #1058: Jira names a status in the user's language in a REST answer and by the name it keeps for every language in a webhook delivery; the id
// is the same in both.
describe("a status that Jira names in two languages", () => {
  const GERMAN: StatusRef[] = [
    { id: "10100", name: "Zu erledigen", untranslatedName: "To Do" },
    { id: "10101", name: "In Arbeit", untranslatedName: "In Progress" },
  ];
  const DELIVERY: JiraStatusMove = {
    ...MOVE,
    from: "In Progress",
    fromId: "10101",
    to: "To Do",
    toId: "10100",
  };
  const german = { ...TICKET, status: "Zu erledigen", statusId: "10100" };
  const lane = (to: string) => [
    { id: "wf-1", document: doc({ ...READY, to }) },
  ];

  // #1058-T01
  it("starts the lane that waits for the localized name, and gives the run the localized names", async () => {
    const { trigger, created } = harness(lane("Zu erledigen"), {
      statuses: GERMAN,
      ticket: german,
    });
    expect(await trigger.start("d1", DELIVERY)).toMatchObject({ started: 1 });
    const input = JSON.parse(created[0]?.triggerInput ?? "{}") as {
      ticket: { status: string };
      status: unknown;
    };
    expect(input.ticket.status).toBe("Zu erledigen");
    expect(input.status).toEqual({ from: "In Arbeit", to: "Zu erledigen" });
  });

  // #1058-T02
  it("starts the lane that waits for the untranslated name", async () => {
    const { trigger } = harness(lane("To Do"), {
      statuses: GERMAN,
      ticket: german,
    });
    expect(await trigger.start("d1", DELIVERY)).toMatchObject({ started: 1 });
  });

  // #1058
  it("matches the name case-insensitively and trimmed, and a `from` the same way", async () => {
    const { trigger } = harness(
      [
        {
          id: "wf-1",
          document: doc({ ...READY, to: " zu ERLEDIGEN ", from: "In Arbeit" }),
        },
      ],
      { statuses: GERMAN, ticket: german },
    );
    expect(await trigger.start("d1", DELIVERY)).toMatchObject({ started: 1 });
  });

  // #1058
  it("starts nothing for another status, or a `from` that was another one", async () => {
    const other = harness(lane("Erledigt"), {
      statuses: [...GERMAN, { id: "10102", name: "Erledigt" }],
      ticket: german,
    });
    expect(await other.trigger.start("d1", DELIVERY)).toMatchObject({
      matched: 0,
      started: 0,
    });
    expect(other.reads).toEqual([]);

    const wrongFrom = harness(
      [
        {
          id: "wf-1",
          document: doc({ ...READY, to: "Zu erledigen", from: "Erledigt" }),
        },
      ],
      { statuses: GERMAN, ticket: german },
    );
    expect(await wrongFrom.trigger.start("d1", DELIVERY)).toMatchObject({
      matched: 0,
    });
  });

  // #1058-T03
  it("stops a delivery for a status the issue has left, comparing the ids", async () => {
    const { trigger, created, lines } = harness(lane("Zu erledigen"), {
      statuses: GERMAN,
      ticket: { ...TICKET, status: "In Arbeit", statusId: "10101" },
    });
    expect(await trigger.start("d1", DELIVERY)).toMatchObject({
      matched: 1,
      started: 0,
      skipped: 1,
    });
    expect(created).toEqual([]);
    expect(lines.join("\n")).toContain("no longer has the status");
  });

  // #1058
  it("still compares the names as they are spelled when the project's statuses cannot be read", async () => {
    const same = harness(lane("To Do"), {
      statuses: "unreadable",
      ticket: { ...TICKET, status: "To Do" },
    });
    expect(await same.trigger.start("d1", DELIVERY)).toMatchObject({
      started: 1,
    });
    // The ticket's id decides when both sides have one, whatever the names say.
    const ids = harness(lane("To Do"), {
      statuses: "unreadable",
      ticket: german,
    });
    expect(await ids.trigger.start("d1", DELIVERY)).toMatchObject({
      started: 1,
    });
  });

  // #1058
  it("keeps working for a delivery without ids and a trigger without the statuses: the names decide", async () => {
    const { trigger } = harness(lane("Ready for agent"));
    expect(await trigger.start("d1", MOVE)).toMatchObject({ started: 1 });
  });
});
