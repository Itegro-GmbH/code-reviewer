// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { startFormOf } from "./start-form-spec.ts";
import {
  actionResultOf,
  agentResultOf,
  costBasesOf,
  formatUsd,
  repositoryOfRun,
  spentShare,
  stepDurationMs,
} from "./view.ts";

const REPO = "acme/widgets";

describe("what the workflow pages take from a run", () => {
  it("writes money the way the billing pages do", () => {
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsd(20)).toBe("$20.00");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("reads the repository from the input of the run", () => {
    expect(repositoryOfRun({ input: { repo: REPO } })).toBe(REPO);
    expect(repositoryOfRun({ input: { repo: 7 } })).toBeUndefined();
    expect(repositoryOfRun({ input: null })).toBeUndefined();
  });

  it("measures a finished step and gives no duration for the rest", () => {
    expect(
      stepDurationMs({
        startedAt: "2026-11-05T10:00:00.000Z",
        finishedAt: "2026-11-05T10:02:05.000Z",
      }),
    ).toBe(125_000);
    expect(
      stepDurationMs({
        startedAt: "2026-11-05T10:00:00.000Z",
        finishedAt: null,
      }),
    ).toBeNull();
    expect(stepDurationMs({ startedAt: null, finishedAt: null })).toBeNull();
    expect(
      stepDurationMs({
        startedAt: "2026-11-05T10:00:10.000Z",
        finishedAt: "2026-11-05T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("keeps the share of the budget between nothing and all of it", () => {
    expect(spentShare({ budgetUsd: 20, spentUsd: 5 })).toBe(0.25);
    expect(spentShare({ budgetUsd: 1, spentUsd: 1.5 })).toBe(1);
    expect(spentShare({ budgetUsd: 0, spentUsd: 0 })).toBe(0);
  });

  it("lists each cost basis of a run once, in the order the steps used them", () => {
    expect(
      costBasesOf([
        { costBasis: "limit" },
        { costBasis: null },
        { costBasis: "reported" },
        { costBasis: "limit" },
      ]),
    ).toEqual(["limit", "reported"]);
    expect(costBasesOf([])).toEqual([]);
  });

  // #873-T12
  describe("the result of an action", () => {
    it("shows the link of the run's repository, the number and whether it existed", () => {
      expect(
        actionResultOf(
          {
            kind: "action",
            output: {
              url: "https://github.com/acme/widgets/pull/12",
              number: 12,
              existing: true,
            },
          },
          REPO,
        ),
      ).toEqual({
        url: "https://github.com/acme/widgets/pull/12",
        number: 12,
        existing: true,
      });
    });

    it("keeps an address that may not be linked as text only", () => {
      for (const url of [
        "javascript:alert(1)",
        "https://evil.example/acme/widgets/pull/1",
        "https://github.com/other/repo/pull/1",
      ])
        expect(
          actionResultOf({ kind: "action", output: { url } }, REPO),
        ).toEqual({ urlText: url });
    });

    it("leaves out a value of the wrong type and gives nothing for an output without the known values", () => {
      expect(
        actionResultOf(
          { kind: "action", output: { number: "12", existing: "yes" } },
          REPO,
        ),
      ).toBeUndefined();
      expect(
        actionResultOf({ kind: "action", output: { labels: ["bug"] } }, REPO),
      ).toBeUndefined();
      expect(
        actionResultOf({ kind: "action", output: null }, REPO),
      ).toBeUndefined();
      expect(
        actionResultOf({ kind: "agent", output: { number: 1 } }, REPO),
      ).toBeUndefined();
    });
  });

  describe("the result of an agent", () => {
    it("shows the branch it pushed, linked to the repository, and the rest of its output as data", () => {
      expect(
        agentResultOf(
          {
            kind: "agent",
            output: {
              summary: "<b>Cached</b>",
              costUsd: 0.5,
              branch: "workflow/run-1/plan",
            },
          },
          REPO,
        ),
      ).toEqual({
        branch: "workflow/run-1/plan",
        branchUrl: "https://github.com/acme/widgets/tree/workflow/run-1/plan",
        fields: { summary: "<b>Cached</b>", costUsd: 0.5 },
      });
    });

    it("shows nothing for a step that returned nothing", () => {
      expect(
        agentResultOf({ kind: "agent", output: null }, REPO),
      ).toBeUndefined();
      expect(
        agentResultOf({ kind: "agent", output: {} }, REPO),
      ).toBeUndefined();
    });
  });
});

describe("the form that starts a run", () => {
  const document = (trigger: unknown) => ({ trigger, steps: [] });

  // #873-T30
  it("takes the fields from the input of the manual trigger, the repository first", () => {
    const spec = startFormOf(
      document({
        kind: "manual",
        input: {
          type: "object",
          required: ["repo", "issue"],
          properties: {
            topic: { type: "string", description: "What to look at" },
            issue: { type: "integer" },
            repo: { type: "string" },
            kind: { type: "string", enum: ["bug", "risk"] },
            dry: { type: "boolean" },
            labels: { type: "array", items: { type: "string" } },
            weight: { type: "number" },
          },
        },
      }),
    );
    expect(spec).toEqual({
      kind: "form",
      fields: [
        { name: "repo", required: true, kind: "string" },
        {
          name: "topic",
          required: false,
          kind: "string",
          description: "What to look at",
        },
        { name: "issue", required: true, kind: "integer" },
        {
          name: "kind",
          required: false,
          kind: "string",
          choices: ["bug", "risk"],
        },
        { name: "dry", required: false, kind: "boolean" },
        { name: "labels", required: false, kind: "json" },
        { name: "weight", required: false, kind: "number" },
      ],
    });
  });

  // #873-T31
  it("says when a workflow is not started by hand or cannot be read", () => {
    expect(
      startFormOf(document({ kind: "github.issueLabeled", label: "agent" })),
    ).toEqual({ kind: "not_manual" });
    expect(startFormOf(null)).toEqual({ kind: "unusable" });
    expect(startFormOf(document({ kind: "manual", input: 7 }))).toEqual({
      kind: "unusable",
    });
  });
});
