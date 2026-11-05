// SPDX-License-Identifier: LicenseRef-Proprietary

// Fixtures for the tests of the workflow format (#833): a fake resolver with a profile that may push and one that may not, and the
// plan's example workflow ("Issue to PR") written as format v1 has it.
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import type { ProfileInfo, WorkflowResolver } from "./resolver.ts";

export const FAKE_RESOLVER: WorkflowResolver = {
  profiles: (): readonly ProfileInfo[] => [
    {
      name: "implementer",
      versions: [1, 2],
      facts: { 1: { canPush: true }, 2: { canPush: true } },
    },
    { name: "reviewer", versions: [1], facts: { 1: { canPush: false } } },
  ],
  environments: () => [{ name: "node" }, { name: "Python" }],
  connectors: () => BUILT_IN_CONNECTORS,
};

type Json = Record<string, unknown>;

/** The first workflow of the plan (agent-workflows.md), as format v1 states it. */
export function issueToPr(): Json {
  return {
    version: 1,
    name: "Issue to PR",
    trigger: { kind: "github.issueLabeled", label: "ready for agent" },
    budgetUsd: 20,
    steps: [
      {
        id: "start",
        kind: "action",
        connector: "github.issue.labels",
        issue: "{{trigger.issue}}",
        remove: ["ready for agent"],
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
            environment: "node",
            session: { continue: "implement" },
            instruction: {
              first: "{{trigger.issue.title}}\n\n{{trigger.issue.body}}",
              next: "Fix these review findings:\n{{previous.review.findings}}",
            },
            result: {
              type: "object",
              required: ["summary"],
              properties: { summary: { type: "string" } },
            },
          },
          {
            id: "review",
            kind: "agent",
            profile: "reviewer@1",
            environment: "node",
            session: "new",
            branch: "{{implement.branch}}",
            instruction:
              "Review branch {{implement.branch}} against the issue.",
            result: {
              type: "object",
              required: ["findings"],
              properties: {
                findings: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["type", "name", "description"],
                    properties: {
                      type: { type: "string", enum: ["bug", "risk", "nit"] },
                      name: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
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
            title: "{{trigger.issue.title}}",
            body: "{{implement.summary}}\n\nCloses #{{trigger.issue.number}}",
          },
        ],
        else: [
          {
            id: "stuck",
            kind: "action",
            connector: "github.issue.comment",
            issue: "{{trigger.issue}}",
            body: "Stopped after 3 rounds. Open findings:\n{{review.findings}}",
          },
        ],
      },
    ],
  };
}

/** A small valid workflow to break one thing at a time. A manual trigger declares the repository the run works on: `repo`. */
export function tiny(): Json {
  return {
    version: 1,
    name: "Tiny",
    trigger: {
      kind: "manual",
      input: {
        type: "object",
        required: ["repo"],
        properties: { repo: { type: "string" } },
      },
    },
    steps: [
      {
        id: "work",
        kind: "agent",
        profile: "implementer",
        environment: "node",
        instruction: "Do the thing.",
        result: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    ],
  };
}
