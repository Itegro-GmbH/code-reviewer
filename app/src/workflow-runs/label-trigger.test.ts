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
  const created: NewWorkflowRun[] = [];
  const kicked: string[] = [];
  const lines: string[] = [];
  const trigger = createLabelTrigger({
    runs: {
      async createRun(input) {
        if (options.failFor?.includes(input.workflowId))
          throw new Error("the database is gone");
        const earlier = written.get(input.clientRequestId);
        if (earlier !== undefined) return { status: "existing", run: earlier };
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
          createdBy: input.createdBy,
          actorLogin: input.actorLogin,
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:00:00.000Z",
          finishedAt: null,
        };
        written.set(input.clientRequestId, run);
        return { status: "created", run };
      },
    },
    workflows: {
      async listWithIssueTrigger() {
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
  return { trigger, created, kicked, lines, written };
}

const READY = { kind: "github.issueLabeled", label: "ready for agent" };

describe("which workflows a label starts", () => {
  // #845-T10
  it("starts the workflow whose label is exactly the label that was put on", async () => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toEqual({ matched: 1, started: 1, existing: 0, skipped: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      workflowId: "wf-1",
      workflowVersion: 1,
      repositoryId: "repo-1",
      baseBranch: "main",
      triggerKind: "github.issueLabeled",
      createdBy: null,
      actorLogin: "bob",
      clientRequestId: "gh-delivery-1-wf-1",
    });
    expect(kicked).toEqual(["run-1"]);
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

    expect(result).toEqual({ matched: 2, started: 2, existing: 0, skipped: 0 });
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

  // #845-T15
  it("starts the same delivery once: a retry finds the runs and writes none", async () => {
    const { trigger, created, kicked } = harness([
      { id: "wf-1", document: workflowDocument(READY) },
    ]);

    await trigger.start("delivery-1", LABELED);
    const retry = await trigger.start("delivery-1", LABELED);
    const next = await trigger.start("delivery-2", LABELED);

    expect(retry).toEqual({ matched: 1, started: 0, existing: 1, skipped: 0 });
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
          steps: [
            ...STEPS,
            { id: "again", kind: "loop", maxRounds: 3, body: [], until: {} },
          ],
        }),
      },
      { id: "wf-2", document: workflowDocument(READY) },
    ]);

    const result = await trigger.start("delivery-1", LABELED);

    expect(result).toEqual({ matched: 2, started: 1, existing: 0, skipped: 1 });
    expect(created.map((run) => run.workflowId)).toEqual(["wf-2"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("wf-1");
    expect(lines[0]).toContain("again");
    expect(lines[0]).not.toContain(LABELED.issue.title);
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
  it("is the issue and the repository, as the steps read them", () => {
    expect(labelTriggerInput(LABELED)).toEqual({
      issue: {
        number: 12,
        title: "Cache the widget list",
        body: "Rebuilt on every request.",
        url: "https://github.test/acme/widgets/issues/12",
        labels: ["enhancement", "ready for agent"],
      },
      repo: {
        fullName: "acme/widgets",
        owner: "acme",
        name: "widgets",
        defaultBranch: "main",
      },
    });
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
    // The body fits one value of a text (10,000), cut note included: it is not cut a second time when it is put into a text.
    expect(Array.from(input.issue.body)).toHaveLength(10_000);
    expect(input.issue.body).toMatch(/… \[cut: 50000 characters\]$/);
    expect(input.issue.labels).toHaveLength(50);
    expect(Array.from(input.issue.labels[0] ?? "")).toHaveLength(100);
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
