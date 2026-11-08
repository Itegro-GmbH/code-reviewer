// SPDX-License-Identifier: LicenseRef-Proprietary

// The built-in lanes (#922): the two documents a new project can copy as its first lanes. Plain data in format v1, copied into the
// project as the workflow of a lane like any other (validated, versioned, then the project's own): changing the copy never changes the
// built-in, and the built-in never changes a copy. They need what the documentation says they need: the profiles `implementer` (may
// push) and `reviewer` (may not), and an environment, whose name the caller passes in.
//
// "Issue to PR" is the first workflow of `docs/workflows.md`, which a test holds to `contracts/examples/workflow/Workflow.json`.

/** The code a lane is reported with when copying it failed in a way no lane has a code for (the other lanes are still copied). */
export const LANE_COPY_FAILED = "LANE_COPY_FAILED";

/** The keys a new project names the lanes it copies by. */
export const BUILT_IN_LANE_KEYS = [
  "issue-to-pr",
  "review-a-pull-request",
] as const;
export type BuiltInLaneKey = (typeof BUILT_IN_LANE_KEYS)[number];

export const isBuiltInLaneKey = (value: unknown): value is BuiltInLaneKey =>
  typeof value === "string" &&
  (BUILT_IN_LANE_KEYS as readonly string[]).includes(value);

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

export const REVIEW_INSTRUCTION =
  "Review branch {{implement.branch}} against this issue. Do not change anything.\n\n" +
  "Issue: {{trigger.ticket.title}}\n\n{{trigger.ticket.body}}\n\n" +
  "What the implementer reports it did. It names the answers people gave to its questions; those answers are binding, so do not report them as findings:\n" +
  "{{implement.summary}}";

function issueToPr(environment: string): Record<string, unknown> {
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
      {
        id: "fix",
        kind: "loop",
        maxRounds: 3,
        body: [
          {
            id: "implement",
            kind: "agent",
            profile: "implementer@1",
            environment,
            session: { continue: "implement" },
            instruction: {
              first: "{{trigger.ticket.title}}\n\n{{trigger.ticket.body}}",
              next: "Fix these review findings:\n{{previous.review.findings}}",
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
            profile: "reviewer@1",
            environment,
            session: "new",
            branch: "{{implement.branch}}",
            // #966: the reviewer has no other way to the issue, nor to the answers people gave the implementer (its summary names them).
            instruction: REVIEW_INSTRUCTION,
            result: FINDINGS,
          },
        ],
        until: { empty: "{{review.findings}}" },
      },
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

function reviewAPullRequest(environment: string): Record<string, unknown> {
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
        profile: "reviewer@1",
        environment,
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

/** The document of a built-in lane, with the environment its agent steps run in. */
export function builtInLaneDocument(
  key: BuiltInLaneKey,
  environment: string,
): Record<string, unknown> {
  return key === "issue-to-pr"
    ? issueToPr(environment)
    : reviewAPullRequest(environment);
}
