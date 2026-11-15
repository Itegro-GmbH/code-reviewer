// SPDX-License-Identifier: LicenseRef-Proprietary

// #1036: which workflows a move of a ticket into a status starts, and what the run they get holds. The database is replaced by a list: the
// rules about the trigger are what is tested here; the real tables are in status-trigger.integration.test.ts and the webhook in
// webhooks/github-app-handler.status.test.ts.
import { describe, expect, it } from "vitest";
import type {
  NewWorkflowRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
} from "../db/repositories/workflows-repository.ts";
import type { TicketRead } from "../integrations/ticket-provider.ts";
import {
  createStatusTrigger,
  statusRequestId,
  statusTriggerInput,
  type BoardMove,
} from "./status-trigger.ts";
import { labelTriggerKey } from "./label-trigger.ts";

const MOVE: BoardMove = {
  nodeId: "I_kwDOAAA12",
  from: "Backlog",
  to: "Ready for agent",
  projectId: "PVT_1",
  integrationId: "int-1",
  actor: { login: "bob", externalId: "1002" },
};

const TICKET: TicketRead = {
  key: "12",
  number: 12,
  title: "Cache the widget list",
  body: "Rebuilt on every request.",
  url: "https://github.test/acme/widgets/issues/12",
  labels: ["enhancement"],
  assignees: ["alice"],
  type: "Bug",
};

const STEPS = [
  {
    id: "implement",
    kind: "agent",
    profile: "worker",
    environment: "Python",
    instruction: "{{trigger.ticket.title}} {{trigger.status.to}}",
  },
];

function workflowDocument(trigger: Record<string, unknown>): string {
  return JSON.stringify({
    version: 1,
    name: "Flow",
    triggers: [trigger],
    steps: STEPS,
  });
}

const READY = {
  id: "ready",
  kind: "ticket.statusChanged",
  to: "Ready for agent",
};

type Seed = { id: string; document: string; version?: number };

function harness(
  seeds: Seed[],
  options: {
    item?: "none";
    board?: string | undefined;
    /** The integration the ticket's repository belongs to. */
    integration?: string;
    /** The status the board gives the item now: a name, null for none, "unavailable" when boards cannot be read. */
    current?: string | null | "unavailable";
    repository?: "none";
    ticket?: "none";
    failFor?: string[];
  } = {},
) {
  const written = new Map<string, StoredWorkflowRun>();
  const keys = new Map<string, string>();
  const created: NewWorkflowRun[] = [];
  const kicked: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const reads: string[] = [];
  const statusReads: string[] = [];
  // The status the item has now is the one the move names, unless a test says otherwise.
  let movedTo: string | null = null;
  const trigger = createStatusTrigger({
    runs: {
      async createRun(input) {
        if (options.failFor?.includes(input.workflowId))
          throw new Error("the database is gone");
        const earlier = written.get(input.clientRequestId);
        if (earlier !== undefined) return { status: "existing", run: earlier };
        const holder = [...written.values()].find(
          (run) =>
            run.status === "running" &&
            run.workflowId === input.workflowId &&
            keys.get(run.id) === input.triggerKey,
        );
        if (input.triggerKey !== undefined && holder !== undefined)
          return { status: "busy", run: holder };
        created.push(input);
        const run = {
          id: `run-${written.size + 1}`,
          workflowId: input.workflowId,
          status: "running",
          triggerInput: input.triggerInput,
          clientRequestId: input.clientRequestId,
        } as StoredWorkflowRun;
        written.set(input.clientRequestId, run);
        if (input.triggerKey !== undefined) keys.set(run.id, input.triggerKey);
        return { status: "created", run };
      },
    },
    workflows: {
      async listWithStatusTrigger(repositoryId) {
        asked.push(repositoryId);
        return seeds.map((seed) => ({
          workflow: { id: seed.id, name: seed.id } as StoredWorkflow,
          current: {
            workflowId: seed.id,
            version: seed.version ?? 1,
            document: seed.document,
          } as StoredWorkflowVersion,
        }));
      },
    },
    async ticketOfNode(nodeId) {
      if (options.item === "none" || nodeId !== MOVE.nodeId) return undefined;
      return {
        provider: "github",
        repositoryId: "repo-1",
        integrationId: options.integration ?? "int-1",
        key: "12",
      };
    },
    async currentStatusOf(repositoryId, nodeId, board) {
      statusReads.push(`${repositoryId}#${nodeId}@${board}`);
      if (options.current === "unavailable")
        return { available: false, status: null };
      return {
        available: true,
        status: "current" in options ? (options.current ?? null) : movedTo,
      };
    },
    async boardOf() {
      return "board" in options ? options.board : "PVT_1";
    },
    async repositoryOf(repositoryId) {
      return options.repository === "none"
        ? undefined
        : { id: repositoryId, fullName: "acme/widgets", defaultBranch: "main" };
    },
    async readTicket(repositoryId, key) {
      reads.push(`${repositoryId}#${key}`);
      return options.ticket === "none" ? undefined : TICKET;
    },
    kick: (runId) => void kicked.push(runId),
    log: (line) => lines.push(line),
  });
  return {
    trigger: {
      start(deliveryId: string, move: BoardMove) {
        movedTo = move.to;
        return trigger.start(deliveryId, move);
      },
    },
    created,
    kicked,
    lines,
    written,
    asked,
    reads,
    statusReads,
  };
}

describe("which workflows a move into a status starts", () => {
  // #1036-T01
  it("starts exactly one run with the ticket fields when a person moves a board item into the trigger status", async () => {
    const { trigger, created, kicked, reads } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    const result = await trigger.start("delivery-1", MOVE);

    expect(result).toEqual({
      matched: 1,
      started: 1,
      existing: 0,
      skipped: 0,
      busy: 0,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      workflowId: "wf-1",
      workflowVersion: 1,
      repositoryId: "repo-1",
      baseBranch: "main",
      triggerKind: "ticket.statusChanged",
      triggerId: "ready",
      // The key of the label trigger: a workflow has one running run for one ticket, whichever trigger started it.
      triggerKey: labelTriggerKey("repo-1", 12),
      ticketRef: "github:acme/widgets#12",
      createdBy: null,
      actorLogin: "bob",
      clientRequestId: "gh-delivery-1-wf-1",
    });
    expect(JSON.parse(created[0]?.triggerInput ?? "")).toEqual({
      ticket: {
        key: "12",
        number: 12,
        title: "Cache the widget list",
        body: "Rebuilt on every request.",
        url: "https://github.test/acme/widgets/issues/12",
        labels: ["enhancement"],
        type: "Bug",
        assignees: ["alice"],
        status: "",
        repo: {
          fullName: "acme/widgets",
          owner: "acme",
          name: "widgets",
          defaultBranch: "main",
        },
      },
      status: { from: "Backlog", to: "Ready for agent" },
    });
    expect(kicked).toEqual(["run-1"]);
    expect(reads).toEqual(["repo-1#12"]);
  });

  // #1036-T02
  it("starts nothing for a move into another status, and reads nothing from the platform for it", async () => {
    const { trigger, created, reads } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    const result = await trigger.start("delivery-1", {
      ...MOVE,
      to: "In progress",
    });

    expect(result).toEqual({
      matched: 0,
      started: 0,
      existing: 0,
      skipped: 0,
      busy: 0,
    });
    expect(created).toEqual([]);
    expect(reads).toEqual([]);
  });

  // #1036-T02
  it("starts nothing for a second move into the status while the first run is going on, and starts the next one when it has ended", async () => {
    const { trigger, created, lines, written } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);
    await trigger.start("delivery-1", MOVE);

    const second = await trigger.start("delivery-2", MOVE);

    expect(second).toMatchObject({ started: 0, busy: 1 });
    expect(created).toHaveLength(1);
    expect(lines.join("\n")).toContain("still running for ticket 12");
    // The run ends: the move after that starts the next one.
    for (const run of written.values())
      (run as { status: string }).status = "succeeded";
    expect(await trigger.start("delivery-3", MOVE)).toMatchObject({
      started: 1,
    });
    expect(created).toHaveLength(2);
  });

  it("starts a run for a move whoever made it: a bot, a person and a move without a known mover", async () => {
    for (const actor of [
      { login: "code-review-app[bot]", externalId: "77" },
      { login: "bob", externalId: "1002" },
      undefined,
    ]) {
      const { trigger, created } = harness([
        { id: "wf-1", document: workflowDocument(READY) },
      ]);
      const { actor: _dropped, ...rest } = MOVE;
      void _dropped;

      await trigger.start("delivery-1", {
        ...rest,
        ...(actor === undefined ? {} : { actor }),
      });

      expect(created).toHaveLength(1);
      expect(created[0]?.actorLogin).toBe(actor?.login ?? "unknown");
    }
  });

  it("honours `from`: only a move out of that status starts the workflow", async () => {
    const seeds = [
      {
        id: "wf-1",
        document: workflowDocument({ ...READY, from: "Backlog" }),
      },
    ];

    const fromBacklog = harness(seeds);
    await fromBacklog.trigger.start("delivery-1", MOVE);
    const fromOther = harness(seeds);
    await fromOther.trigger.start("delivery-1", { ...MOVE, from: "Review" });
    const fromNone = harness(seeds);
    await fromNone.trigger.start("delivery-1", { ...MOVE, from: null });

    expect(fromBacklog.created).toHaveLength(1);
    expect(fromOther.created).toEqual([]);
    expect(fromNone.created).toEqual([]);
  });

  it("gives status.from as an empty text when the item had no status, and starts a workflow without `from` all the same", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    await trigger.start("delivery-1", { ...MOVE, from: null });

    expect(
      (JSON.parse(created[0]?.triggerInput ?? "") as { status: unknown })
        .status,
    ).toEqual({ from: "", to: "Ready for agent" });
  });

  it("starts nothing when the status was cleared, the item is no ticket of the mirror's (a pull request is none) or a ticket the platform no longer has", async () => {
    const seeds = [{ id: "wf-1", document: workflowDocument(READY) }];
    const cleared = harness(seeds);
    expect(
      await cleared.trigger.start("d", { ...MOVE, to: null }),
    ).toMatchObject({ matched: 0, started: 0 });
    expect(cleared.asked).toEqual([]);

    for (const options of [
      { item: "none" },
      { ticket: "none" },
      { repository: "none" },
    ] as const) {
      const { trigger, created, lines } = harness(seeds, options);
      await trigger.start("delivery-1", MOVE);
      expect(created).toEqual([]);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  // #1036: a deliberate decision of the PR (review finding 1): a run starts only for a board the project chose AND the delivery names.
  it("starts a run only for a move on the board the project chose, and nothing for another board, an unnamed board or a project without a board", async () => {
    const seeds = [{ id: "wf-1", document: workflowDocument(READY) }];

    const same = harness(seeds, { board: "PVT_1" });
    await same.trigger.start("d", MOVE);
    const unnamed = harness(seeds, { board: "PVT_1" });
    const { projectId: _id, ...withoutBoard } = MOVE;
    void _id;
    await unnamed.trigger.start("d", withoutBoard);
    const other = harness(seeds, { board: "PVT_2" });
    await other.trigger.start("d", MOVE);
    const unchosen = harness(seeds, { board: undefined });
    await unchosen.trigger.start("d", MOVE);
    const neither = harness(seeds, { board: undefined });
    await neither.trigger.start("d", withoutBoard);

    expect(same.created).toHaveLength(1);
    expect(unnamed.created).toEqual([]);
    expect(other.created).toEqual([]);
    expect(unchosen.created).toEqual([]);
    expect(neither.created).toEqual([]);
    for (const left of [unnamed, other, unchosen, neither]) {
      expect(left.lines.length).toBeGreaterThan(0);
      // Nothing is asked of GitHub for a move that cannot start anything.
      expect(left.reads).toEqual([]);
      expect(left.asked).toEqual([]);
    }
  });

  it("starts nothing for a ticket whose repository belongs to another integration than the delivery's", async () => {
    const { trigger, created, lines, reads } = harness(
      [{ id: "wf-1", document: workflowDocument(READY) }],
      { integration: "int-2" },
    );

    await trigger.start("d", MOVE);

    expect(created).toEqual([]);
    expect(reads).toEqual([]);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("starts nothing when the item's current board status is no longer the one the delivery names (stale or redelivered)", async () => {
    const seeds = [{ id: "wf-1", document: workflowDocument(READY) }];
    const current = harness(seeds, { current: "Ready for agent" });
    await current.trigger.start("d", MOVE);
    expect(current.created).toHaveLength(1);
    expect(current.statusReads).toEqual(["repo-1#I_kwDOAAA12@PVT_1"]);

    for (const options of [
      { current: "Done" },
      { current: null },
      { current: "unavailable" },
    ] as const) {
      const stale = harness(seeds, options);
      const result = await stale.trigger.start("d", MOVE);
      expect(stale.created).toEqual([]);
      expect(result).toMatchObject({ matched: 1, started: 0, skipped: 1 });
      expect(stale.lines.length).toBeGreaterThan(0);
    }
  });

  it("reads the current status only once a workflow matched", async () => {
    const { trigger, statusReads } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    await trigger.start("d", { ...MOVE, to: "Other" });

    expect(statusReads).toEqual([]);
  });

  it("starts the workflow once when two of its triggers match the same move, and each workflow that matches", async () => {
    const { trigger, created } = harness([
      {
        id: "wf-1",
        document: JSON.stringify({
          version: 1,
          name: "Flow",
          triggers: [READY, { ...READY, id: "again" }],
          steps: STEPS,
        }),
      },
      { id: "wf-2", document: workflowDocument(READY) },
    ]);

    const result = await trigger.start("delivery-1", MOVE);

    expect(result).toMatchObject({ matched: 2, started: 2 });
    expect(created.map((run) => [run.workflowId, run.triggerId])).toEqual([
      ["wf-1", "ready"],
      ["wf-2", "ready"],
    ]);
  });

  it("starts through the status trigger of a workflow that has a label trigger too, and ignores the label trigger", async () => {
    const { trigger, created } = harness([
      {
        id: "wf-1",
        document: JSON.stringify({
          version: 1,
          name: "Flow",
          triggers: [
            { id: "labeled", kind: "ticket.labeled", label: "go" },
            READY,
          ],
          steps: STEPS,
        }),
      },
    ]);

    await trigger.start("delivery-1", MOVE);

    expect(created[0]).toMatchObject({
      triggerId: "ready",
      triggerKind: "ticket.statusChanged",
    });
  });

  it("starts no run for a workflow with a step the engine does not run, and says why", async () => {
    const { trigger, created, lines } = harness([
      {
        id: "wf-1",
        document: JSON.stringify({
          version: 1,
          name: "Flow",
          triggers: [READY],
          steps: [{ id: "each", kind: "forEach" }],
        }),
      },
    ]);

    const result = await trigger.start("delivery-1", MOVE);

    expect(result).toMatchObject({ matched: 1, started: 0, skipped: 1 });
    expect(created).toEqual([]);
    expect(lines.join("\n")).toContain("does not run");
  });

  it("writes no second run for a delivery that is tried again, and still kicks a run whose first push was lost", async () => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);
    await trigger.start("delivery-1", MOVE);

    const again = await trigger.start("delivery-1", MOVE);

    expect(again).toMatchObject({ started: 0, existing: 1 });
    expect(created).toHaveLength(1);
    expect(kicked).toEqual(["run-1", "run-1"]);
    expect(statusRequestId("delivery-1", "wf-1")).toBe("gh-delivery-1-wf-1");
  });

  it("starts the other workflows when one cannot be written, then throws so that the delivery is tried again", async () => {
    const { trigger, created } = harness(
      [
        { id: "wf-1", document: workflowDocument(READY) },
        { id: "wf-2", document: workflowDocument(READY) },
      ],
      { failFor: ["wf-1"] },
    );

    await expect(trigger.start("delivery-1", MOVE)).rejects.toThrow(
      "the database is gone",
    );
    expect(created.map((run) => run.workflowId)).toEqual(["wf-2"]);
  });

  it("does not read the platform when no workflow waits for the status", async () => {
    const { trigger, reads, asked } = harness([]);

    expect(await trigger.start("delivery-1", MOVE)).toMatchObject({
      matched: 0,
    });
    expect(asked).toEqual(["repo-1"]);
    expect(reads).toEqual([]);
  });
});

describe("the input of a run a move started", () => {
  it("bounds the ticket and the status names like every value that goes into a text", () => {
    const input = statusTriggerInput(
      { ...TICKET, title: "t".repeat(300) },
      { fullName: "acme/widgets", defaultBranch: "main" },
      { from: "a\u0000b", to: "x".repeat(500) },
    );

    expect(input.ticket.title.length).toBeLessThan(300);
    expect(input.status.from).toBe("ab");
    expect(input.status.to.length).toBeLessThanOrEqual(100);
  });
});
