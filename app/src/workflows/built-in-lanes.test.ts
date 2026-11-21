// SPDX-License-Identifier: LicenseRef-Proprietary

// #922: the built-in lanes a new project copies pass the validator, and "Issue to PR" is the example of the documentation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LANE_KEYS,
  BUILT_IN_ROLES,
  DEFAULT_LANE_STATUSES,
  builtInLaneDocument as documentOf,
  isBuiltInLaneKey,
  laneStatusesFromNames,
  type BuiltInAgents,
  type BuiltInLaneKey,
  type LaneStatuses,
} from "./built-in-lanes.ts";
import { agentNodesOf } from "./agent-settings.ts";
import { createResolver } from "./resolver.ts";
import type { TicketProviderName } from "./ticket-ref.ts";
import { EXAMPLE_BUILT_IN_AGENTS } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

// The settings of the two agents the documentation's example has (`contracts/examples/workflow/Workflow.json`), and the runner they name.
const RUNNER = "runner-vercel-4-vcpu";
const AGENTS = EXAMPLE_BUILT_IN_AGENTS;
/** A workspace with the hosted runner the built-in lanes name, and no profile and no environment: they need neither (#1105). */
const RESOLVER = createResolver({
  profiles: [],
  environments: [],
  runners: [{ id: RUNNER, name: "Vercel Sandbox 4 vCPU", kind: "hosted" }],
});

const builtInLaneDocument = (
  key: BuiltInLaneKey,
  agents: BuiltInAgents = AGENTS,
  statuses?: LaneStatuses,
  provider?: TicketProviderName,
) => documentOf(key, agents, statuses, provider);

describe("the built-in lanes", () => {
  // #922-T01
  it.each(BUILT_IN_LANE_KEYS)("%s validates clean", (key) => {
    const result = validateWorkflow(builtInLaneDocument(key), RESOLVER, {
      maxBudgetUsd: 100,
    });
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  // #1107-T08
  it.each(BUILT_IN_LANE_KEYS)(
    "%s has a description: a new lane must have one (it is what version 1 says)",
    (key) => {
      const { description } = builtInLaneDocument(key) as {
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
    expect(builtInLaneDocument("issue-to-pr")).toEqual(example);
  });

  // #922-T03
  it("takes the settings and the runner of the agents it is given and names the lane", () => {
    const own: BuiltInAgents = {
      implementer: { ...AGENTS.implementer, runner: "r-1" },
      reviewer: {
        harness: "claude-code",
        model: { provider: "claude-code", model: "sonnet" },
        canPush: false,
        runner: "r-2",
      },
    };
    const review = JSON.stringify(
      builtInLaneDocument("review-a-pull-request", own),
    );
    const both = JSON.stringify(builtInLaneDocument("issue-to-pr", own));

    expect(review).toContain('"runner":"r-2"');
    expect(review).toContain('"harness":"claude-code"');
    expect(review).not.toContain('"runner":"r-1"');
    expect(review).toContain('"name":"Review a pull request"');
    expect(both).toContain('"runner":"r-1"');
    expect(both).toContain(AGENTS.implementer.instructions);
  });

  // #1105-T400
  it.each(BUILT_IN_LANE_KEYS)(
    "%s carries its agents' settings inline: no profile, no environment, a model, a push right and a runner on every agent step",
    (key) => {
      const text = JSON.stringify(builtInLaneDocument(key));
      expect(text).not.toContain('"profile"');
      expect(text).not.toContain('"environment"');
      const agents = [...agentNodesOf(builtInLaneDocument(key))];
      expect(agents.length).toBeGreaterThan(0);
      for (const agent of agents)
        expect(agent).toMatchObject({
          model: expect.any(Object) as unknown,
          canPush: expect.any(Boolean) as unknown,
          runner: RUNNER,
        });
    },
  );

  // #966-T01
  it("Issue to PR hands the reviewer the issue and the implementer's report", () => {
    const document = builtInLaneDocument("issue-to-pr") as {
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
      builtInLaneDocument("issue-to-pr") as {
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
    expect(isBuiltInLaneKey("one-off-task")).toBe(true);
    expect(isBuiltInLaneKey("nothing")).toBe(false);
    expect(isBuiltInLaneKey(3)).toBe(false);
  });

  // #1105-T410 (ADR 0007 decision 15)
  it("One-off task has a manual trigger with one required text, one agent step on the hosted runner and the pull request, and names no repository, ticket or profile", () => {
    const document = builtInLaneDocument("one-off-task") as {
      name: string;
      triggers: { kind: string; input: Record<string, unknown> }[];
      steps: Record<string, unknown>[];
    };

    expect(document.name).toBe("One-off task");
    expect(document.triggers).toHaveLength(1);
    expect(document.triggers[0]).toMatchObject({
      kind: "manual",
      input: {
        required: ["task"],
        properties: { task: { type: "string" } },
      },
    });
    expect(Object.keys(document.triggers[0]?.input.properties ?? {})).toEqual([
      "task",
    ]);
    expect(document.steps.map((step) => [step.id, step.kind])).toEqual([
      ["implement", "agent"],
      ["pr", "action"],
    ]);
    expect(document.steps[0]).toMatchObject({
      canPush: true,
      runner: RUNNER,
      instruction: expect.stringContaining("{{trigger.input.task}}"),
    });
    expect(document.steps[1]).toMatchObject({
      connector: "github.pullRequest.open",
      head: "{{implement.branch}}",
      title: "One-off task: {{trigger.input.task}}",
    });
    // It has no review step, so the note must not speak of one (#1119).
    expect(document.steps[0]?.instruction).toContain(
      "The lane opens the pull request itself; do not open one.",
    );
    expect(document.steps[0]?.instruction).not.toContain("review");
    const text = JSON.stringify(document);
    for (const absent of ['"profile"', '"environment"', '"repo"', '"ticket"'])
      expect(text).not.toContain(absent);
  });

  // #1105-T411
  it("One-off task needs the implementer's settings only, so a workspace with no reviewer still gets it", () => {
    expect(BUILT_IN_ROLES["one-off-task"]).toEqual(["implementer"]);
  });

  // #1036
  it("Issue to PR (status) starts on a move into its status, reports on the board and never moves a ticket into the status that starts it", () => {
    const document = builtInLaneDocument("issue-to-pr-status") as {
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
    const result = validateWorkflow(document, RESOLVER, {
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
      AGENTS,
      statuses,
    );

    expect(
      validateWorkflow(document, RESOLVER, { maxBudgetUsd: 100 }).errors,
    ).toEqual([]);
    const text = JSON.stringify(document);
    for (const name of Object.values(statuses)) expect(text).toContain(name);
    expect(text).not.toContain(DEFAULT_LANE_STATUSES.ready);
  });

  // #1040-T02
  it("Issue to PR (status) for a Jira project puts the key in the pull request title and the ticket address in its body, never `Closes #n`", () => {
    const document = builtInLaneDocument(
      "issue-to-pr-status",
      AGENTS,
      DEFAULT_LANE_STATUSES,
      "jira",
    );
    const text = JSON.stringify(document);
    expect(text).toContain("{{trigger.ticket.key}}: {{trigger.ticket.title}}");
    expect(text).toContain("Ticket: {{trigger.ticket.url}}");
    expect(text).not.toContain("Closes #");
    expect(text).toContain("jira:owner/repo#PROJ-128");
    const result = validateWorkflow(document, RESOLVER, {
      maxBudgetUsd: 100,
    });
    expect(result.errors).toEqual([]);
    // The GitHub lane keeps its words.
    expect(JSON.stringify(builtInLaneDocument("issue-to-pr-status"))).toContain(
      "Closes #{{trigger.ticket.number}}",
    );
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
