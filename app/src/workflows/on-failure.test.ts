// SPDX-License-Identifier: LicenseRef-Proprietary

// #902: `onFailure`, the steps that run once after a run ended `failed` or `cancelled`. The validator holds them to non-agent actions
// (a comment, labels), gives them the facts of the failure (`{{failure.…}}`) and nothing of the steps that ran before.
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER, issueToPr, tiny } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const validate = (document: unknown) =>
  validateWorkflow(document, FAKE_RESOLVER);
const codes = (document: unknown): string[][] =>
  validate(document).errors.map((e) => [e.path, e.code]);

const COMMENT: Json = {
  id: "report",
  kind: "action",
  connector: "github.issue.comment",
  issue: "{{trigger.issue}}",
  body: "Stopped at {{failure.stepId}} ({{failure.code}}): {{failure.message}}",
};

const SWAP: Json = {
  id: "unlabel",
  kind: "action",
  connector: "github.issue.labels",
  issue: "{{trigger.issue}}",
  remove: ["agent working"],
  add: ["agent failed"],
};

function withOnFailure(onFailure: unknown, base: Json = issueToPr()): Json {
  const copy = structuredClone(base);
  copy.onFailure = onFailure;
  return copy;
}

describe("onFailure in a workflow", () => {
  // #902-T01
  it("validates clean with a comment and a label swap, and counts the steps", () => {
    const result = validate(withOnFailure([COMMENT, SWAP]));

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ valid: true, steps: 9 });
  });

  // #902-T02
  it("leaves a document without it as it was", () => {
    expect(validate(issueToPr())).toMatchObject({ valid: true, steps: 7 });
    expect(validate(tiny()).errors).toEqual([]);
  });

  // #902-T03
  it("reads the four facts of the failure, and no other field", () => {
    const facts = withOnFailure([
      {
        ...COMMENT,
        body: "{{failure.status}} {{failure.stepId}} {{failure.code}} {{failure.message}}",
      },
    ]);
    const unknown = withOnFailure([{ ...COMMENT, body: "{{failure.reason}}" }]);

    expect(validate(facts).errors).toEqual([]);
    expect(codes(unknown)).toEqual([
      ["/onFailure/0/body", "reference_unknown_field"],
    ]);
  });

  // #902-T04
  it("allows an if over the facts, with comments and labels inside", () => {
    const branching = withOnFailure([
      {
        id: "which",
        kind: "if",
        when: { equals: ["{{failure.status}}", "cancelled"] },
        then: [SWAP],
        else: [COMMENT],
      },
    ]);

    expect(validate(branching).errors).toEqual([]);
    expect(
      codes(
        withOnFailure([
          {
            id: "which",
            kind: "if",
            when: { equals: ["{{failure.status}}", "exploded"] },
            then: [SWAP],
          },
        ]),
      ),
    ).toEqual([["/onFailure/0/when/equals/1", "condition_value_not_in_enum"]]);
  });

  // #902-T05
  it("refuses an agent step, a loop and a pull request, also inside an if", () => {
    const agent: Json = {
      id: "again",
      kind: "agent",
      profile: "implementer@1",
      environment: "node",
      instruction: "Try again.",
    };
    const loop: Json = {
      id: "retry",
      kind: "loop",
      maxRounds: 2,
      body: [COMMENT],
      until: { empty: "{{failure.message}}" },
    };
    const pr: Json = {
      id: "open-pr",
      kind: "action",
      connector: "github.pullRequest.open",
      head: "main",
      title: "x",
    };
    const inside: Json = {
      id: "which",
      kind: "if",
      when: { notEmpty: "{{failure.message}}" },
      then: [{ ...agent, id: "again2" }],
    };

    expect(codes(withOnFailure([agent, loop, pr, inside]))).toEqual([
      ["/onFailure/0/kind", "on_failure_step_not_allowed"],
      ["/onFailure/1/kind", "on_failure_step_not_allowed"],
      ["/onFailure/2/connector", "on_failure_step_not_allowed"],
      ["/onFailure/3/then/0/kind", "on_failure_step_not_allowed"],
    ]);
  });

  // #902-T06
  it("reaches the trigger and the failure, not a step of the workflow", () => {
    const reaching = withOnFailure([
      { ...COMMENT, body: "Branch {{implement.branch}}" },
      { ...COMMENT, id: "second", body: "{{fix.rounds}} {{done.taken}}" },
    ]);

    expect(codes(reaching)).toEqual([
      ["/onFailure/0/body", "reference_not_in_scope"],
      ["/onFailure/1/body", "reference_not_in_scope"],
      ["/onFailure/1/body", "reference_not_in_scope"],
    ]);
  });

  // #902-T07
  it("reaches an earlier onFailure step, but a step of the workflow cannot reach one", () => {
    const earlier = withOnFailure([
      COMMENT,
      { ...SWAP, id: "later", add: ["x"], remove: ["y"] },
      {
        ...COMMENT,
        id: "third",
        body: "Commented at {{report.url}}",
      },
    ]);
    const backwards = withOnFailure([COMMENT]);
    const steps = backwards.steps as Json[];
    (steps[2]?.else as Json[])[0] = {
      id: "stuck",
      kind: "action",
      connector: "github.issue.comment",
      issue: "{{trigger.issue}}",
      body: "{{report.url}} {{failure.code}}",
    };

    expect(validate(earlier).errors).toEqual([]);
    expect(codes(backwards)).toEqual([
      ["/steps/2/else/0/body", "reference_not_in_scope"],
      ["/steps/2/else/0/body", "reference_unknown_step"],
    ]);
  });

  // #902-T08
  it("does not take a fact of the failure as a target", () => {
    const targets = withOnFailure([
      { ...SWAP, add: ["{{failure.code}}"] },
      { ...COMMENT, id: "second", issue: "{{failure.stepId}}" },
    ]);

    expect(codes(targets)).toEqual([
      ["/onFailure/0/add/0", "target_from_untrusted_value"],
      ["/onFailure/1/issue", "target_from_untrusted_value"],
    ]);
  });

  // #902-T09
  it("needs a list of at least one step, and closes every node", () => {
    expect(codes(withOnFailure([]))).toEqual([["/onFailure", "invalid_value"]]);
    expect(codes(withOnFailure("comment"))).toEqual([
      ["/onFailure", "wrong_type"],
    ]);
    expect(codes(withOnFailure([{ ...COMMENT, repo: "a/b" }]))).toEqual([
      ["/onFailure/0/repo", "unknown_field"],
    ]);
  });

  // #902-T10
  it("shares the ids of the document: no repeat, and 'failure' is taken", () => {
    const repeated = withOnFailure([{ ...COMMENT, id: "start" }]);
    const taken = withOnFailure([{ ...COMMENT, id: "failure" }]);

    expect(codes(repeated)).toEqual([["/onFailure/0/id", "duplicate_id"]]);
    expect(codes(taken)).toEqual([["/onFailure/0/id", "invalid_value"]]);
    // A step of the workflow may still be called failure: documents that exist keep working.
    const old = issueToPr();
    (old.steps as Json[])[0] = { ...(old.steps as Json[])[0], id: "failure" };
    expect(validate(old).errors).toEqual([]);
  });

  // #902-T11
  it("has no failure to read in the steps of the workflow", () => {
    const doc = withOnFailure([COMMENT]);
    ((doc.steps as Json[])[2]?.else as Json[])[0] = {
      id: "stuck",
      kind: "action",
      connector: "github.issue.comment",
      issue: "{{trigger.issue}}",
      body: "{{failure.code}}",
    };

    expect(codes(doc)).toEqual([
      ["/steps/2/else/0/body", "reference_unknown_step"],
    ]);
  });

  // #902-T12
  it("counts its steps with the others against the limit of 50", () => {
    const many = Array.from({ length: 43 }, (_, index) => ({
      ...COMMENT,
      id: `report${String(index)}`,
    }));

    expect(validate(withOnFailure(many)).errors).toEqual([]);
    expect(
      codes(withOnFailure([...many, { ...COMMENT, id: "one-more" }])),
    ).toEqual([["/steps", "too_many_steps"]]);
  });

  // #902-T13
  it("may not add the label that starts the workflow", () => {
    expect(
      codes(withOnFailure([{ ...SWAP, add: ["Ready for agent"] }])),
    ).toEqual([["/onFailure/0/add/0", "label_retriggers_workflow"]]);
  });
});
