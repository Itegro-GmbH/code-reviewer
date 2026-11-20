// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: the built-in lanes a new project copies pass the validator, and "Issue to PR" is the example of the documentation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LANE_KEYS,
  DEFAULT_LANE_STATUSES,
  builtInLaneDocument,
  isBuiltInLaneKey,
  laneStatusesFromNames,
} from "./built-in-lanes.ts";
import { FAKE_RESOLVER } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

describe("the built-in lanes", () => {
  // #922-T01
  it.each(BUILT_IN_LANE_KEYS)("%s validates clean", (key) => {
    const result = validateWorkflow(
      builtInLaneDocument(key, "node"),
      FAKE_RESOLVER,
      { maxBudgetUsd: 100 },
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // #1107-T08
  it.each(BUILT_IN_LANE_KEYS)(
    "%s has a description: a new lane must have one (it is what version 1 says)",
    (key) => {
      const { description } = builtInLaneDocument(key, "node") as {
        description?: unknown;
      };
      expect(
        typeof description === "string" && description.trim(),
      ).toBeTruthy();
    },
  );

  // #922-T02
  it("Issue to PR is the example of the documentation", () => {
    const example = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../contracts/examples/workflow/Workflow.json",
        ),
        "utf8",
      ),
    ) as unknown;
    expect(builtInLaneDocument("issue-to-pr", "node")).toEqual(example);
  });

  // #922-T03
  it("takes the environment it is given and names the lane", () => {
    const document = JSON.stringify(
      builtInLaneDocument("review-a-pull-request", "Python"),
    );
    expect(document).toContain('"environment":"Python"');
    expect(document).toContain('"name":"Review a pull request"');
  });

  // #966-T01
  it("Issue to PR hands the reviewer the issue and the implementer's report", () => {
    const document = builtInLaneDocument("issue-to-pr", "node") as {
      steps: { id: string; body?: { id: string; instruction?: unknown }[] }[];
    };
    const review = document.steps
      .find((step) => step.id === "fix")
      ?.body?.find((step) => step.id === "review");
    expect(review?.instruction).toEqual(expect.any(String));
    const instruction = String(review?.instruction);
    expect(instruction).toContain("{{trigger.ticket.title}}");
    expect(instruction).toContain("{{trigger.ticket.body}}");
    expect(instruction).toContain("{{implement.summary}}");
  });

  // #966-T02
  it("Issue to PR tells both agents that the lane opens the pull request", () => {
    const fix = (
      builtInLaneDocument("issue-to-pr", "node") as {
        steps: { id: string; body?: { id: string; instruction?: unknown }[] }[];
      }
    ).steps.find((step) => step.id === "fix");
    const text = JSON.stringify(fix?.body?.map((step) => step.instruction));
    expect(text.match(/The lane opens the pull request itself/g)).toHaveLength(
      3,
    );
  });

  // #922-T04
  it("knows its keys", () => {
    expect(isBuiltInLaneKey("issue-to-pr")).toBe(true);
    expect(isBuiltInLaneKey("nothing")).toBe(false);
    expect(isBuiltInLaneKey(3)).toBe(false);
  });

  // #1036
  it("Issue to PR (status) starts on a move into its status, reports on the board and never moves a ticket into the status that starts it", () => {
    const document = builtInLaneDocument("issue-to-pr-status", "node") as {
      name: string;
      triggers: { kind: string; to?: string }[];
    };
    const text = JSON.stringify(document);
    const statuses = [
      ...text.matchAll(
        /"connector":"ticket\.setStatus","ticket":"[^"]*","status":"([^"]+)"/g,
      ),
    ].map((match) => match[1]);

    expect(document.name).toBe("Issue to PR (status)");
    expect(document.triggers[0]).toMatchObject({
      kind: "ticket.statusChanged",
      to: DEFAULT_LANE_STATUSES.ready,
    });
    expect(statuses).toEqual([
      DEFAULT_LANE_STATUSES.inProgress,
      DEFAULT_LANE_STATUSES.inReview,
      DEFAULT_LANE_STATUSES.back,
      DEFAULT_LANE_STATUSES.back,
    ]);
    expect(statuses).not.toContain(DEFAULT_LANE_STATUSES.ready);
    const result = validateWorkflow(document, FAKE_RESOLVER, {
      maxBudgetUsd: 100,
    });
    expect(result.warnings ?? []).toEqual([]);
  });

  // #1036
  it("takes the names of the board statuses it is given", () => {
    const statuses = {
      ready: "Agent please",
      inProgress: "Working",
      inReview: "Review",
      back: "Todo",
    };
    const document = builtInLaneDocument(
      "issue-to-pr-status",
      "node",
      statuses,
    );

    expect(
      validateWorkflow(document, FAKE_RESOLVER, { maxBudgetUsd: 100 }).errors,
    ).toEqual([]);
    const text = JSON.stringify(document);
    for (const name of Object.values(statuses)) expect(text).toContain(name);
    expect(text).not.toContain(DEFAULT_LANE_STATUSES.ready);
  });

  // #1040-T02
  it("Issue to PR (status) for a Jira project puts the key in the pull request title and the ticket address in its body, never `Closes #n`", () => {
    const document = builtInLaneDocument(
      "issue-to-pr-status",
      "node",
      DEFAULT_LANE_STATUSES,
      "jira",
    );
    const text = JSON.stringify(document);
    expect(text).toContain("{{trigger.ticket.key}}: {{trigger.ticket.title}}");
    expect(text).toContain("Ticket: {{trigger.ticket.url}}");
    expect(text).not.toContain("Closes #");
    expect(text).toContain("jira:owner/repo#PROJ-128");
    const result = validateWorkflow(document, FAKE_RESOLVER, {
      maxBudgetUsd: 100,
    });
    expect(result.errors).toEqual([]);
    // The GitHub lane keeps its words.
    expect(
      JSON.stringify(builtInLaneDocument("issue-to-pr-status", "node")),
    ).toContain("Closes #{{trigger.ticket.number}}");
  });

  // #1040
  it("takes the status names of a Jira workflow where they fit, and never lets the trigger status be one of the others", () => {
    expect(
      laneStatusesFromNames([
        "Backlog",
        "Selected for Development",
        "In Progress",
        "Code Review",
        "Ready for agent",
        "Done",
      ]),
    ).toEqual({
      ready: "Ready for agent",
      inProgress: "In Progress",
      inReview: "Code Review",
      back: "Backlog",
    });
    // The statuses of a plain Jira project: what fits is taken, the rest keeps the lane's own name.
    expect(laneStatusesFromNames(["To Do", "In Progress", "Done"])).toEqual({
      ready: DEFAULT_LANE_STATUSES.ready,
      inProgress: "In Progress",
      inReview: DEFAULT_LANE_STATUSES.inReview,
      back: "To Do",
    });
    expect(laneStatusesFromNames([])).toEqual(DEFAULT_LANE_STATUSES);
    const same = laneStatusesFromNames(["Ready for review", "Review"]);
    expect(new Set(Object.values(same)).size).toBe(4);
  });
});
