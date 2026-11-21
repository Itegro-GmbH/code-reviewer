// SPDX-License-Identifier: LicenseRef-Proprietary

// The built-in lanes (#922): the documents a new project can copy as its first lanes. Plain data in format v1, copied into the
// project as the workflow of a lane like any other (validated, versioned, then the project's own): changing the copy never changes the
// built-in, and the built-in never changes a copy. The agent steps carry their settings and their runner inline (#1105, ADR 0007), never a
// profile or an environment: the caller passes the settings of the two agents (`BuiltInAgents`), and `WorkflowService.copyBuiltIn` takes
// them from the profiles `implementer@1` (may push) and `reviewer@1` (may not) of the workspace, on the hosted runner of 4 vCPU.
//
// "Issue to PR (status)" (#1036) is the same lane started by a move of the ticket on the project's board instead of a label, and it
// reports on the board: "in progress" when it starts, "in review" when the pull request is open, and back plus a comment on failure.
// The four status names are the options of the board's Status field; the defaults below are the lane's own, changed in the lane builder
// (the picker offers the names of the project's board) or by the caller that copies the lane (`LaneStatuses`).
//
// "One-off task" (ADR 0007 decision 15, the owner's "Einmalige Aufgabe") replaces a task started by hand outside a lane: a manual trigger with
// one required text, one agent step with the implementer's settings on the same hosted runner, and the pull request. It names no repository:
// a trigger whose input has neither a `ticket` nor a `repo` works on the repository of the lane's project, on its default branch.
//
// "Issue to PR" is the first workflow of `docs/workflows.md`, which a test holds to `contracts/examples/workflow/Workflow.json`.

import type { ModelChoice } from "../db/implementer-model-choice.ts";
import type { ProfileHarness } from "../runner-identity/harness.ts";
import type { TicketProviderName } from "./ticket-ref.ts";

/** The settings of one agent of a built-in lane, as an agent step carries them (#1105): what a profile held, and the id of the runner. */
export type BuiltInAgentSettings = {
  harness: ProfileHarness;
  model: ModelChoice;
  canPush: boolean;
  /** The standing text; left out for none. */
  instructions?: string;
  /** The id of the concrete runner the agent runs on. */
  runner: string;
};

/** The two agents of the built-in lanes: the one that implements (may push) and the one that reviews (may not). */
export type BuiltInAgents = {
  implementer: BuiltInAgentSettings;
  reviewer: BuiltInAgentSettings;
};

export type BuiltInRole = keyof BuiltInAgents;

/** The agents each built-in lane has: the review lane has a reviewer only. */
export const BUILT_IN_ROLES: Record<BuiltInLaneKey, readonly BuiltInRole[]> = {
  "one-off-task": ["implementer"],
  "issue-to-pr": ["implementer", "reviewer"],
  "issue-to-pr-status": ["implementer", "reviewer"],
  "review-a-pull-request": ["reviewer"],
};

/** The hosted runner type the built-in lanes run on: 4 vCPU, the size an environment of the documentation's examples has. */
export const BUILT_IN_RUNNER_VCPUS = 4;

/** The keys of an agent step that are its settings, in the order a lane written by hand has them. */
function settingsOf(settings: BuiltInAgentSettings): Record<string, unknown> {
  return {
    harness: settings.harness,
    model: settings.model,
    canPush: settings.canPush,
    ...(settings.instructions === undefined || settings.instructions === ""
      ? {}
      : { instructions: settings.instructions }),
    runner: settings.runner,
  };
}

/** The code a lane is reported with when copying it failed in a way no lane has a code for (the other lanes are still copied). */
export const LANE_COPY_FAILED = "LANE_COPY_FAILED";

/** The keys a new project names the lanes it copies by. */
export const BUILT_IN_LANE_KEYS = [
  "one-off-task",
  "issue-to-pr",
  "issue-to-pr-status",
  "review-a-pull-request",
] as const;
export type BuiltInLaneKey = (typeof BUILT_IN_LANE_KEYS)[number];

export const isBuiltInLaneKey = (value: unknown): value is BuiltInLaneKey =>
  typeof value === "string" &&
  (BUILT_IN_LANE_KEYS as readonly string[]).includes(value);

/** The names of the board statuses the status variant of "Issue to PR" works with. */
export type LaneStatuses = {
  /** The status that starts the lane (the trigger's `to`). The lane never moves a ticket into it: it would start itself again. */
  ready: string;
  /** Set when the run starts. */
  inProgress: string;
  /** Set when the pull request is open. */
  inReview: string;
  /** Set when the run ended without a pull request: the ticket goes back, to be picked up again. */
  back: string;
};

export const DEFAULT_LANE_STATUSES: LaneStatuses = {
  ready: "Ready for agent",
  inProgress: "In progress",
  inReview: "In review",
  back: "Backlog",
};

/**
 * The status names of a project's workflow that fit the four roles of "Issue to PR (status)" best (#1040): Jira's own names, never mapped.
 * A role no status fits keeps the default name (the lane then ends the step with `ticket_status_unknown`, naming the statuses there are, until
 * the owner creates that status or edits the lane). The trigger status is never one of the other three.
 */
export function laneStatusesFromNames(
  names: readonly string[],
  defaults: LaneStatuses = DEFAULT_LANE_STATUSES,
): LaneStatuses {
  const find = (
    pattern: RegExp,
    taken: readonly string[],
  ): string | undefined =>
    names.find((name) => pattern.test(name.trim()) && !taken.includes(name));
  const inProgress =
    find(/^(in progress|in development|doing)$/i, []) ?? defaults.inProgress;
  const inReview = find(/review/i, [inProgress]) ?? defaults.inReview;
  const back =
    find(/^(backlog|to ?do|open|selected for development)$/i, [
      inProgress,
      inReview,
    ]) ?? defaults.back;
  const ready = find(/^ready/i, [inProgress, inReview, back]) ?? defaults.ready;
  return { ready, inProgress, inReview, back };
}

const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["type", "name", "description"],
        properties: {
          type: { type: "string", enum: ["bug", "risk", "nit"] },
          name: { type: "string", maxLength: 120 },
          description: { type: "string" },
        },
      },
    },
  },
};

// #966: the lane opens the pull request after the review, which neither agent knows otherwise.
const PULL_REQUEST_NOTE =
  "The lane opens the pull request itself after the review; do not open one and do not report it as missing or open work.";

export const REVIEW_INSTRUCTION =
  `Review branch {{implement.branch}} against this issue. Do not change anything. ${PULL_REQUEST_NOTE}\n\n` +
  "Issue: {{trigger.ticket.title}}\n\n{{trigger.ticket.body}}\n\n" +
  "What the implementer reports it did. It names the answers people gave to its questions; those answers are binding, so do not report them as findings:\n" +
  "{{implement.summary}}";

/** The agent steps and the way they end, the same for both variants of "Issue to PR". */
function implementAndReview(agents: BuiltInAgents): Record<string, unknown> {
  return {
    id: "fix",
    kind: "loop",
    maxRounds: 3,
    body: [
      {
        id: "implement",
        kind: "agent",
        ...settingsOf(agents.implementer),
        session: { continue: "implement" },
        instruction: {
          first: `{{trigger.ticket.title}}\n\n{{trigger.ticket.body}}\n\n${PULL_REQUEST_NOTE}`,
          next: `Fix these review findings:\n{{previous.review.findings}}\n\n${PULL_REQUEST_NOTE}`,
        },
        result: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: {
              type: "string",
              description: "What was done, for the pull request.",
            },
          },
        },
      },
      {
        id: "review",
        kind: "agent",
        ...settingsOf(agents.reviewer),
        session: "new",
        branch: "{{implement.branch}}",
        // #966: the reviewer has no other way to the issue, nor to the answers people gave the implementer (its summary names them).
        instruction: REVIEW_INSTRUCTION,
        result: FINDINGS,
      },
    ],
    until: { empty: "{{review.findings}}" },
  };
}

/** The longest task a person can hand to the one-off lane: a few pages, so the instruction and the pull request body stay one readable text. */
export const ONE_OFF_TASK_MAX_LENGTH = 8000;

function oneOffTask(agents: BuiltInAgents): Record<string, unknown> {
  return {
    version: 1,
    name: "One-off task",
    description:
      "A person describes a task; one agent does it on the project's repository and the lane opens a pull request with the result. It replaces starting a task by hand: start it from the control panel or the project's Lanes tab and write the task in the form. A follow-up is a new run: start the lane again and name the earlier branch in the task.",
    triggers: [
      {
        id: "manual",
        kind: "manual",
        input: {
          type: "object",
          required: ["task"],
          properties: {
            task: {
              type: "string",
              maxLength: ONE_OFF_TASK_MAX_LENGTH,
              description:
                "What the agent should do, in your own words. It works on the project's repository, on its default branch.",
            },
          },
        },
        steps: [],
      },
    ],
    budgetUsd: 10,
    steps: [
      {
        id: "implement",
        kind: "agent",
        ...settingsOf(agents.implementer),
        session: "new",
        instruction: `{{trigger.input.task}}\n\n${PULL_REQUEST_NOTE}`,
        result: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: {
              type: "string",
              description: "What was done, for the pull request.",
            },
          },
        },
      },
      {
        id: "pr",
        kind: "action",
        connector: "github.pullRequest.open",
        head: "{{implement.branch}}",
        title: "{{trigger.input.task}}",
        body: "{{implement.summary}}\n\nTask: {{trigger.input.task}}",
      },
    ],
  };
}

function issueToPr(agents: BuiltInAgents): Record<string, unknown> {
  return {
    version: 1,
    name: "Issue to PR",
    description:
      "Implement the ticket, have it reviewed, fix until the review finds nothing (3 rounds at most), then open the pull request; otherwise comment on the ticket. A label starts it, or a person by hand: the manual trigger puts the label on first, so both arrive at the same context.",
    triggers: [
      {
        id: "labeled",
        kind: "ticket.labeled",
        label: "agent implement",
        steps: [],
      },
      {
        id: "manual",
        kind: "manual",
        input: {
          type: "object",
          required: ["ticket"],
          properties: {
            ticket: {
              type: "ticket",
              description:
                "The ticket to implement, like github:owner/repo#128.",
            },
          },
        },
        steps: [
          {
            id: "mark",
            kind: "action",
            connector: "ticket.labels",
            ticket: "{{trigger.ticket}}",
            add: ["agent implement"],
          },
        ],
      },
    ],
    budgetUsd: 20,
    steps: [
      {
        id: "start",
        kind: "action",
        connector: "ticket.labels",
        ticket: "{{trigger.ticket}}",
        remove: ["agent implement"],
        add: ["agent working"],
      },
      implementAndReview(agents),
      {
        id: "done",
        kind: "if",
        when: { equals: ["{{fix.exit}}", "until"] },
        then: [
          {
            id: "pr",
            kind: "action",
            connector: "github.pullRequest.open",
            head: "{{implement.branch}}",
            title: "{{trigger.ticket.title}}",
            body: "{{implement.summary}}\n\nCloses #{{trigger.ticket.number}}",
          },
        ],
        else: [
          {
            id: "stuck",
            kind: "action",
            connector: "ticket.comment",
            ticket: "{{trigger.ticket}}",
            body: "Stopped after {{fix.rounds}} rounds. Open findings:\n{{review.findings}}",
          },
        ],
      },
    ],
    onFailure: [
      {
        id: "report",
        kind: "action",
        connector: "ticket.comment",
        ticket: "{{trigger.ticket}}",
        body: "The agent stopped before a pull request was ready ({{failure.status}} at step {{failure.stepId}}, {{failure.code}}): {{failure.message}}",
      },
      {
        id: "release",
        kind: "action",
        connector: "ticket.labels",
        ticket: "{{trigger.ticket}}",
        remove: ["agent working"],
        add: ["agent failed"],
      },
    ],
  };
}

const failureComment = (id: string): Record<string, unknown> => ({
  id,
  kind: "action",
  connector: "ticket.comment",
  ticket: "{{trigger.ticket}}",
  body: "The agent stopped before a pull request was ready ({{failure.status}} at step {{failure.stepId}}, {{failure.code}}): {{failure.message}}",
});

const setStatus = (id: string, status: string): Record<string, unknown> => ({
  id,
  kind: "action",
  connector: "ticket.setStatus",
  ticket: "{{trigger.ticket}}",
  status,
});

/** What the pull request of a lane carries about its ticket: GitHub closes the issue, Jira's GitHub integration links by the key in the title and the address in the body (#1040). */
function pullRequestOf(provider: TicketProviderName): {
  title: string;
  body: string;
} {
  return provider === "jira"
    ? {
        title: "{{trigger.ticket.key}}: {{trigger.ticket.title}}",
        body: "{{implement.summary}}\n\nTicket: {{trigger.ticket.url}}",
      }
    : {
        title: "{{trigger.ticket.title}}",
        body: "{{implement.summary}}\n\nCloses #{{trigger.ticket.number}}",
      };
}

function issueToPrStatus(
  agents: BuiltInAgents,
  statuses: LaneStatuses,
  provider: TicketProviderName,
): Record<string, unknown> {
  const pullRequest = pullRequestOf(provider);
  return {
    version: 1,
    name: "Issue to PR (status)",
    description: `Implement the ticket, have it reviewed, fix until the review finds nothing (3 rounds at most), then open the pull request; otherwise comment on the ticket. Moving the ticket ${provider === "jira" ? "in Jira" : "on the project's board"} into "${statuses.ready}" starts it (whoever moves it, the lane's own moves included, so the lane never moves a ticket into that status), or a person by hand. It reports ${provider === "jira" ? "in Jira" : "on the board"}: "${statuses.inProgress}" at the start, "${statuses.inReview}" when the pull request is open, back to "${statuses.back}" plus a comment when it did not get there.`,
    triggers: [
      {
        id: "ready",
        kind: "ticket.statusChanged",
        to: statuses.ready,
        steps: [],
      },
      {
        id: "manual",
        kind: "manual",
        input: {
          type: "object",
          required: ["ticket"],
          properties: {
            ticket: {
              type: "ticket",
              description:
                provider === "jira"
                  ? "The ticket to implement, like jira:owner/repo#PROJ-128 (the repository the code lives in, the key of the Jira issue)."
                  : "The ticket to implement, like github:owner/repo#128.",
            },
          },
        },
        steps: [],
      },
    ],
    budgetUsd: 20,
    steps: [
      setStatus("start", statuses.inProgress),
      implementAndReview(agents),
      {
        id: "done",
        kind: "if",
        when: { equals: ["{{fix.exit}}", "until"] },
        then: [
          {
            id: "pr",
            kind: "action",
            connector: "github.pullRequest.open",
            head: "{{implement.branch}}",
            title: pullRequest.title,
            body: pullRequest.body,
          },
          setStatus("in_review", statuses.inReview),
        ],
        else: [
          {
            id: "stuck",
            kind: "action",
            connector: "ticket.comment",
            ticket: "{{trigger.ticket}}",
            body: "Stopped after {{fix.rounds}} rounds. Open findings:\n{{review.findings}}",
          },
          setStatus("back", statuses.back),
        ],
      },
    ],
    onFailure: [failureComment("report"), setStatus("release", statuses.back)],
  };
}

function reviewAPullRequest(agents: BuiltInAgents): Record<string, unknown> {
  return {
    version: 1,
    name: "Review a pull request",
    description:
      "A person starts it with the number of a pull request of the project's repository; the reviewer reads the change and the findings are written as a comment on the pull request.",
    triggers: [
      {
        id: "manual",
        kind: "manual",
        input: {
          type: "object",
          required: ["repo", "pullRequest"],
          properties: {
            repo: {
              type: "string",
              description:
                "The repository of the pull request, as owner/name. Leave it out: a lane of a project works in the project's repository.",
            },
            pullRequest: {
              type: "integer",
              description: "The number of the pull request to review.",
            },
          },
        },
        steps: [],
      },
    ],
    budgetUsd: 5,
    steps: [
      {
        id: "review",
        kind: "agent",
        ...settingsOf(agents.reviewer),
        session: "new",
        instruction:
          "Review pull request #{{trigger.input.pullRequest}} of this repository: fetch it with `git fetch origin pull/{{trigger.input.pullRequest}}/head` and read the change against its base. Do not change anything.",
        result: FINDINGS,
      },
      {
        id: "comment",
        kind: "action",
        connector: "pullRequest.comment",
        pullRequest: "{{trigger.input.pullRequest}}",
        body: "Review findings:\n{{review.findings}}",
      },
    ],
  };
}

/** The document of a built-in lane, with the settings of its agents (and, for the status variant, the board statuses it uses). */
export function builtInLaneDocument(
  key: BuiltInLaneKey,
  agents: BuiltInAgents,
  statuses: LaneStatuses = DEFAULT_LANE_STATUSES,
  /** The provider of the project's ticket source (#1040): "Issue to PR (status)" words its pull request and its texts for it. */
  provider: TicketProviderName = "github",
): Record<string, unknown> {
  if (key === "one-off-task") return oneOffTask(agents);
  if (key === "issue-to-pr") return issueToPr(agents);
  if (key === "issue-to-pr-status")
    return issueToPrStatus(agents, statuses, provider);
  return reviewAPullRequest(agents);
}
