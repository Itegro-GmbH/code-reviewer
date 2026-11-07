// SPDX-License-Identifier: LicenseRef-Proprietary

// #845: which workflows a label starts, and what the run they get holds. The database is replaced by a list: the rules about the
// trigger are what is tested here; the real tables, the webhook and the engine are in label-trigger.integration.test.ts.
import { describe, expect, it } from "vitest";
import type {
  NewWorkflowRun,
  StoredWorkflowRun,
} from "../db/repositories/workflow-runs-repository.ts";
import type {
  StoredWorkflow,
  StoredWorkflowVersion,
} from "../db/repositories/workflows-repository.ts";
import { INSTRUCTION_MAX_LENGTH } from "../implementer/start-input.ts";
import type { IssueLabeled } from "../integrations/types.ts";
import {
  createLabelTrigger,
  labelRequestId,
  labelTriggerInput,
} from "./label-trigger.ts";

const LABELED: IssueLabeled = {
  repo: {
    integrationId: "integration-1",
    externalId: "7001",
    fullName: "acme/widgets",
    url: "https://github.test/acme/widgets",
  },
  defaultBranch: "main",
  issue: {
    number: 12,
    title: "Cache the widget list",
    body: "Rebuilt on every request.",
    url: "https://github.test/acme/widgets/issues/12",
    labels: ["enhancement", "ready for agent"],
  },
  label: "ready for agent",
  actor: { login: "bob", externalId: "1002" },
};

const STEPS = [
  {
    id: "implement",
    kind: "agent",
    profile: "worker",
    environment: "Python",
    instruction: "{{trigger.issue.title}}",
  },
];

function workflowDocument(
  trigger: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    name: "Flow",
    trigger,
    steps: STEPS,
    ...extra,
  });
}

type Seed = { id: string; document: string; version?: number };

function harness(
  seeds: Seed[],
  options: { active?: boolean; failFor?: string[] } = {},
) {
  const written = new Map<string, StoredWorkflowRun>();
  const keys = new Map<string, string>();
  const created: NewWorkflowRun[] = [];
  const kicked: string[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const trigger = createLabelTrigger({
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
        const run: StoredWorkflowRun = {
          id: `run-${written.size + 1}`,
          workspaceId: "w-1",
          workflowId: input.workflowId,
          workflowVersion: input.workflowVersion,
          repositoryId: input.repositoryId,
          baseBranch: input.baseBranch,
          triggerInput: input.triggerInput,
          status: "running",
          errorCode: null,
          budgetMicroUsd: input.budgetMicroUsd,
          spentMicroUsd: 0,
          clientRequestId: input.clientRequestId,
          triggerKind: input.triggerKind ?? "manual",
          triggerId: input.triggerId ?? null,
          createdBy: input.createdBy,
          actorLogin: input.actorLogin,
          cancelRequestedAt: null,
          discardedAt: null,
          pauseRequestedAt: null,
          failure: null,
          ticketRef: input.ticketRef ?? null,
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:00:00.000Z",
          finishedAt: null,
        };
        written.set(input.clientRequestId, run);
        if (input.triggerKey !== undefined) keys.set(run.id, input.triggerKey);
        return { status: "created", run };
      },
    },
    workflows: {
      async listWithIssueTrigger(repositoryId) {
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
    async activeRepository(repo) {
      return options.active === false || repo.externalId !== "7001"
        ? undefined
        : { id: "repo-1" };
    },
    kick: (runId) => void kicked.push(runId),
    log: (line) => lines.push(line),
  });
  return { trigger, created, kicked, lines, written, asked };
}

const READY = { kind: "github.issueLabeled", label: "ready for agent" };

describe("which workflows a label starts", () => {
  // #845-T10
  it("starts the workflow whose label is exactly the label that was put on", async () => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

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
      triggerKind: "ticket.labeled",
      triggerId: "labeled",
      createdBy: null,
      actorLogin: "bob",
      clientRequestId: "gh-delivery-1-wf-1",
    });
    expect(kicked).toEqual(["run-1"]);
  });

  // #922-T20
  it("asks only for the lanes of the project whose ticket source is the repository of the issue, and for none when the repository is not an active one", async () => {
    const own = harness([{ id: "wf-1", document: workflowDocument(READY) }]);
    await own.trigger.start("delivery-1", LABELED);
    expect(own.asked).toEqual(["repo-1"]);

    const other = harness([{ id: "wf-1", document: workflowDocument(READY) }]);
    await other.trigger.start("delivery-2", {
      ...LABELED,
      repo: { ...LABELED.repo, externalId: "9999", fullName: "acme/other" },
    });
    expect(other.asked).toEqual([]);
    expect(other.created).toEqual([]);
  });

  // #923-T85
  it("names the ticket the run is about, in the form the ticket mirror reads it by", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    await trigger.start("delivery-1", LABELED);

    expect(created[0]?.ticketRef).toBe(
      `github:${LABELED.repo.fullName}#${LABELED.issue.number}`,
    );
  });

  // #916-T80
  it("starts a workflow through the label trigger of its list of triggers, under the id of that trigger", async () => {
    const { trigger, created } = harness([
      {
        id: "wf-1",
        document: JSON.stringify({
          version: 1,
          name: "Lane",
          triggers: [
            {
              id: "by-hand",
              kind: "manual",
              input: { type: "object", properties: {} },
            },
            {
              id: "second",
              kind: "ticket.labeled",
              label: "other",
              steps: [],
            },
            {
              id: "labeled",
              kind: "ticket.labeled",
              label: "ready for agent",
              steps: [],
            },
            {
              id: "again",
              kind: "github.issueLabeled",
              label: "ready for agent",
            },
          ],
          steps: STEPS,
        }),
      },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toMatchObject({ matched: 1, started: 1 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      triggerKind: "ticket.labeled",
      triggerId: "labeled",
    });
  });

  // #916-T81
  it("leaves a workflow out whose pre-steps for this label hold a step the engine does not run, and not one whose other trigger does", async () => {
    const { trigger, created, lines } = harness([
      {
        id: "wf-1",
        document: JSON.stringify({
          version: 1,
          name: "Lane",
          triggers: [
            {
              id: "labeled",
              kind: "ticket.labeled",
              label: "ready for agent",
              steps: [{ id: "each", kind: "forEach" }],
            },
          ],
          steps: STEPS,
        }),
      },
      {
        id: "wf-2",
        document: JSON.stringify({
          version: 1,
          name: "Lane",
          triggers: [
            {
              id: "labeled",
              kind: "ticket.labeled",
              label: "ready for agent",
            },
            {
              id: "other",
              kind: "manual",
              input: { type: "object", properties: {} },
              steps: [{ id: "each", kind: "forEach" }],
            },
          ],
          steps: STEPS,
        }),
      },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toMatchObject({ matched: 2, started: 1, skipped: 1 });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-2"]);
    expect(lines).toHaveLength(1);
  });

  // #845-T11
  it.each([
    ["another label", "bug"],
    ["the same label in another case", "Ready For Agent"],
    ["the label with a space more", "ready for agent "],
    ["a part of the label", "ready"],
  ])("does not start a workflow for %s", async (_name, label) => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: workflowDocument({ ...READY, label }) },
    ]);

    expect(await trigger.start("delivery-1", LABELED)).toEqual({
      matched: 0,
      started: 0,
      existing: 0,
      skipped: 0,
      busy: 0,
    });
    expect(created).toEqual([]);
    expect(kicked).toEqual([]);
  });

  // #845-T12
  it("starts no workflow with the manual trigger, even if its description names the label trigger", async () => {
    const { trigger, created } = harness([
      {
        id: "wf-1",
        document: workflowDocument(
          { kind: "manual", input: { type: "object", properties: {} } },
          { description: 'Not "github.issueLabeled".' },
        ),
      },
      { id: "wf-2", document: "not json" },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result.matched).toBe(0);
    expect(created).toEqual([]);
  });

  // #845-T13
  it("starts every workflow the label matches, each once, under its own request id", async () => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
      { id: "wf-2", document: workflowDocument({ ...READY, label: "other" }) },
      { id: "wf-3", document: workflowDocument(READY), version: 4 },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toEqual({
      matched: 2,
      started: 2,
      existing: 0,
      skipped: 0,
      busy: 0,
    });
    expect(created.map((run) => [run.workflowId, run.workflowVersion])).toEqual(
      [
        ["wf-1", 1],
        ["wf-3", 4],
      ],
    );
    expect(created.map((run) => run.clientRequestId)).toEqual([
      "gh-delivery-1-wf-1",
      "gh-delivery-1-wf-3",
    ]);
    expect(kicked).toHaveLength(2);
  });

  // #845-T14
  it("starts nothing in a repository that is not an active one of the workspace", async () => {
    const inactive = harness(
      [{ id: "wf-1", document: workflowDocument(READY) }],
      {
        active: false,
      },
    );
    const elsewhere = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    expect(await inactive.trigger.start("delivery-1", LABELED)).toEqual({
      matched: 0,
      started: 0,
      existing: 0,
      skipped: 0,
      busy: 0,
    });
    expect(
      await elsewhere.trigger.start("delivery-1", {
        ...LABELED,
        repo: { ...LABELED.repo, externalId: "9999" },
      }),
    ).toMatchObject({ started: 0 });
    expect(inactive.created).toEqual([]);
    expect(elsewhere.created).toEqual([]);
  });

  // #845-T15a
  it("starts nothing for an issue a workflow has a running run for, and logs why; an ended run frees the issue", async () => {
    const { trigger, created, kicked, lines, written } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
      { id: "wf-2", document: workflowDocument(READY) },
    ]);

    const first = await trigger.start("delivery-1", LABELED);
    // Labeled, unlabeled, labeled again: another delivery for the same issue while the runs go on.
    const again = await trigger.start("delivery-2", LABELED);
    // Another issue is another key.
    const other = await trigger.start("delivery-3", {
      ...LABELED,
      issue: { ...LABELED.issue, number: 13 },
    });

    expect(first).toMatchObject({ started: 2, busy: 0 });
    expect(again).toEqual({
      matched: 2,
      started: 0,
      existing: 0,
      skipped: 0,
      busy: 2,
    });
    expect(other).toMatchObject({ started: 2, busy: 0 });
    expect(created.map((run) => run.triggerKey)).toEqual([
      "repo-1#12",
      "repo-1#12",
      "repo-1#13",
      "repo-1#13",
    ]);
    expect(kicked).toHaveLength(4);
    expect(lines.filter((line) => line.includes("is still running"))).toEqual([
      expect.stringContaining("workflow=wf-1 starts no run: run=run-1"),
      expect.stringContaining("workflow=wf-2 starts no run: run=run-2"),
    ]);

    // The first runs end: the next label starts the next ones.
    for (const run of written.values())
      if (run.clientRequestId.startsWith("gh-delivery-1-"))
        run.status = "succeeded";
    const next = await trigger.start("delivery-4", LABELED);
    expect(next).toMatchObject({ started: 2, busy: 0 });
  });

  // #845-T15
  it("starts the same delivery once: a retry finds the runs and writes none", async () => {
    const { trigger, created, kicked, written } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    await trigger.start("delivery-1", LABELED);
    const retry = await trigger.start("delivery-1", LABELED);
    // The first run is over: another delivery of the label is another start.
    for (const run of written.values()) run.status = "succeeded";
    const next = await trigger.start("delivery-2", LABELED);

    expect(retry).toEqual({
      matched: 1,
      started: 0,
      existing: 1,
      skipped: 0,
      busy: 0,
    });
    expect(next.started).toBe(1);
    expect(created.map((run) => run.clientRequestId)).toEqual([
      "gh-delivery-1-wf-1",
      "gh-delivery-2-wf-1",
    ]);
    // The retry pushes the run again: one whose first push was lost starts now, one that moves is left alone by the engine.
    expect(kicked).toEqual(["run-1", "run-1", "run-2"]);
  });

  // #845-T16
  it("does not push a run of an earlier try that is over", async () => {
    const { trigger, kicked, written } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);
    await trigger.start("delivery-1", LABELED);
    const run = written.get("gh-delivery-1-wf-1");
    if (run === undefined) throw new Error("no run");
    written.set(run.clientRequestId, { ...run, status: "succeeded" });
    kicked.length = 0;

    await trigger.start("delivery-1", LABELED);

    expect(kicked).toEqual([]);
  });

  // #845-T17
  it("leaves out a workflow with a step the engine does not run, and says which, without the issue's words", async () => {
    const { trigger, created, lines } = harness([
      {
        id: "wf-1",
        document: workflowDocument(READY, {
          steps: [...STEPS, { id: "each", kind: "forEach" }],
        }),
      },
      { id: "wf-2", document: workflowDocument(READY) },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toEqual({
      matched: 2,
      started: 1,
      existing: 0,
      skipped: 1,
      busy: 0,
    });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-2"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("wf-1");
    expect(lines[0]).toContain("each");
    expect(lines[0]).not.toContain(LABELED.issue.title);
  });

  // #846-T70
  it("starts a workflow with a loop and an if, however deep: the engine runs both", async () => {
    const { trigger, created, kicked } = harness([
      {
        id: "wf-1",
        document: workflowDocument(READY, {
          steps: [
            {
              id: "fix",
              kind: "loop",
              maxRounds: 3,
              body: STEPS,
              until: { empty: "{{implement.summary}}" },
            },
            {
              id: "done",
              kind: "if",
              when: { equals: ["{{fix.exit}}", "until"] },
              then: [{ id: "pr", kind: "action" }],
              else: [{ id: "stuck", kind: "action" }],
            },
          ],
        }),
      },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toEqual({
      matched: 1,
      started: 1,
      existing: 0,
      skipped: 0,
      busy: 0,
    });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-1"]);
    expect(kicked).toEqual(["run-1"]);
  });

  // #846-T71
  it("leaves out a workflow that holds a step the engine does not run inside a branch or a loop", async () => {
    const { trigger, created } = harness([
      {
        id: "wf-1",
        document: workflowDocument(READY, {
          steps: [
            {
              id: "fix",
              kind: "loop",
              maxRounds: 2,
              body: [{ id: "each", kind: "forEach" }],
              until: {},
            },
          ],
        }),
      },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toMatchObject({ matched: 1, started: 0, skipped: 1 });
    expect(created).toEqual([]);
  });

  // #845-T18
  it("takes the budget of the workflow, capped by the operator's maximum", async () => {
    const { trigger, created } = harness([
      { id: "wf-1", document: workflowDocument(READY, { budgetUsd: 5 }) },
      { id: "wf-2", document: workflowDocument(READY) },
      { id: "wf-3", document: workflowDocument(READY, { budgetUsd: 9999 }) },
    ]);

    await trigger.start("delivery-1", LABELED);

    expect(created.map((run) => run.budgetMicroUsd)).toEqual([
      5_000_000, 20_000_000, 100_000_000,
    ]);
  });

  // #845-T19
  it("tries the other workflows when one cannot be written, then fails so that the delivery is tried again", async () => {
    const { trigger, created } = harness(
      [
        { id: "wf-1", document: workflowDocument(READY) },
        { id: "wf-2", document: workflowDocument(READY) },
      ],
      { failFor: ["wf-1"] },
    );

    await expect(trigger.start("delivery-1", LABELED)).rejects.toThrow(
      "the database is gone",
    );

    expect(created.map((run) => run.workflowId)).toEqual(["wf-2"]);
  });
});

describe("what a run of a label holds", () => {
  // #845-T20
  it("is the ticket, and the issue and the repository as workflows written before #916 read them", () => {
    const repo = {
      fullName: "acme/widgets",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
    };
    expect(labelTriggerInput(LABELED)).toEqual({
      ticket: {
        number: 12,
        title: "Cache the widget list",
        body: "Rebuilt on every request.",
        url: "https://github.test/acme/widgets/issues/12",
        labels: ["enhancement", "ready for agent"],
        type: "",
        assignees: [],
        repo,
      },
      issue: {
        number: 12,
        title: "Cache the widget list",
        body: "Rebuilt on every request.",
        url: "https://github.test/acme/widgets/issues/12",
        labels: ["enhancement", "ready for agent"],
      },
      repo,
    });
  });

  // #916-T82
  it("carries the assignees and the issue type the webhook had, bounded", () => {
    const input = labelTriggerInput({
      ...LABELED,
      issue: {
        ...LABELED.issue,
        assignees: ["alice", ...Array.from({ length: 40 }, (_, i) => `u${i}`)],
        type: "Bug",
      },
    });

    expect(input.ticket.type).toBe("Bug");
    expect(input.ticket.assignees).toHaveLength(20);
    expect(input.ticket.assignees[0]).toBe("alice");
  });

  // #845-T21
  it("bounds what whoever opened the issue wrote: the title, the body, the labels", () => {
    const input = labelTriggerInput({
      ...LABELED,
      issue: {
        ...LABELED.issue,
        title: "t".repeat(1000),
        body: "b".repeat(50_000),
        labels: Array.from(
          { length: 80 },
          (_, i) => `label-${i}-${"x".repeat(200)}`,
        ),
      },
    });

    expect(Array.from(input.issue.title)).toHaveLength(256);
    expect(input.issue.title.endsWith("…")).toBe(true);
    // The body is 8,000 characters at most, cut note included, so that the instruction of a step keeps room for the workflow's own text.
    expect(Array.from(input.issue.body)).toHaveLength(8_000);
    expect(input.issue.body).toMatch(/… \[cut: 50000 characters\]$/);
    expect(input.issue.labels).toHaveLength(20);
    expect(Array.from(input.issue.labels[0] ?? "")).toHaveLength(50);
    // Title, body and labels together, put into one instruction (20,000 at most), leave more than half of it to the workflow.
    const together = [
      input.issue.title,
      input.issue.body,
      ...input.issue.labels,
    ].join("").length;
    expect(together).toBeLessThanOrEqual(256 + 8_000 + 20 * 50);
    expect(INSTRUCTION_MAX_LENGTH - together).toBeGreaterThan(10_000);
    expect(JSON.stringify(input).length).toBeLessThan(64 * 1024);
  });

  // #845-T22
  it("cleans a text of the characters no task may hold and keeps what is no reference", () => {
    const input = labelTriggerInput({
      ...LABELED,
      issue: {
        ...LABELED.issue,
        title: "a\u0000b‮c",
        body: "{{implement.summary}} \ud800 and\ttabs\nlines",
      },
    });

    expect(input.issue.title).toBe("abc");
    expect(input.issue.body).toBe("{{implement.summary}} � and\ttabs\nlines");
  });

  // #845-T23
  it("is stored under a request id that the column holds", () => {
    expect(labelRequestId("a".repeat(128), "f".repeat(36)).length).toBeLessThan(
      200,
    );
  });
});
