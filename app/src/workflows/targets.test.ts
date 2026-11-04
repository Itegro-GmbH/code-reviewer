// SPDX-License-Identifier: LicenseRef-Proprietary

// Where a run works and what it acts on (#833): one repository per run, and the inputs that decide a TARGET (the issue, the
// branches, the labels, the environment) take a literal or one reference to a value the platform or the trigger vouches for, never
// a value an agent reported. An agent's result is data, not a command (docs/workflows.md, "Targets").
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER, issueToPr, tiny } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

function codes(document: unknown): string[][] {
  return validateWorkflow(document, FAKE_RESOLVER).errors.map((e) => [
    e.path,
    e.code,
  ]);
}

function messages(document: unknown): string[] {
  return validateWorkflow(document, FAKE_RESOLVER).errors.map((e) => e.message);
}

function change(base: Json, edit: (document: Json) => void): Json {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}

const steps = (document: Json): Json[] => document.steps as Json[];
const loopBody = (document: Json): Json[] =>
  (steps(document)[1] as Json).body as Json[];
const implement = (document: Json): Json => loopBody(document)[0] as Json;
const pr = (document: Json): Json =>
  ((steps(document)[2] as Json).then as Json[])[0] as Json;

/** The example with an action on the labels after the loop and the pull request, where everything the loop made is in reach. */
function labels(edit: Json): Json {
  return change(issueToPr(), (d) =>
    steps(d).push({
      id: "tag",
      kind: "action",
      connector: "github.issue.labels",
      issue: "{{trigger.issue}}",
      add: ["x"],
      ...edit,
    }),
  );
}

/** The example with the pull request action changed: `/steps/2/then/0/<input>`. */
function pullRequest(edit: Json): Json {
  return change(issueToPr(), (d) => Object.assign(pr(d), edit));
}

const PR = "/steps/2/then/0";
const LABELS = "/steps/3";

/** A manual workflow whose input declares more fields, with one comment action after the agent step. */
function manual(
  fields: Record<string, unknown>,
  action: Json,
  required: string[] = [],
): Json {
  return change(tiny(), (d) => {
    const input = (d.trigger as Json).input as Json;
    Object.assign(input.properties as Json, fields);
    (input.required as string[]).push(...required);
    steps(d).push({
      id: "act",
      kind: "action",
      connector: "github.issue.comment",
      ...action,
    });
  });
}

describe("one repository per run", () => {
  // #833-M1-T280
  it("is the repository of the issue for the label trigger, and an action or agent step names none", () => {
    expect(codes(issueToPr())).toEqual([]);
    expect(codes(labels({ repo: "acme/api" }))).toEqual([
      [`${LABELS}/repo`, "unknown_field"],
    ]);
    const issue = validateWorkflow(labels({ repo: "acme/api" }), FAKE_RESOLVER);
    expect(issue.errors[0]?.available).not.toContain("repo");
    expect(
      codes(change(issueToPr(), (d) => (implement(d).repo = "acme/api"))),
    ).toEqual([["/steps/1/body/0/repo", "unknown_field"]]);
  });

  // #833-M1-T281
  it("is the input repo of a manual trigger, which must declare it as a required text", () => {
    expect(codes(tiny())).toEqual([]);
    const input = (document: Json): Json =>
      (document.trigger as Json).input as Json;
    const properties = (document: Json): Json =>
      input(document).properties as Json;

    expect(
      codes(change(tiny(), (d) => delete (d.trigger as Json).input)),
    ).toEqual([["/trigger", "repo_required"]]);
    expect(
      codes(
        change(tiny(), (d) => {
          input(d).properties = { other: { type: "string" } };
          input(d).required = ["other"];
        }),
      ),
    ).toEqual([["/trigger/input", "repo_required"]]);
    expect(codes(change(tiny(), (d) => delete input(d).required))).toEqual([
      ["/trigger/input", "repo_required"],
    ]);
    expect(
      codes(change(tiny(), (d) => (properties(d).repo = { type: "number" }))),
    ).toEqual([["/trigger/input/properties/repo", "repo_required"]]);
    expect(
      codes(
        change(
          tiny(),
          (d) => (properties(d).repo = { type: "string", maxLength: 80 }),
        ),
      ),
    ).toEqual([]);
  });

  // #833-M1-T282
  it("reports the schema's own problem and nothing about repo when the input schema is broken", () => {
    const document = change(
      tiny(),
      (d) => ((d.trigger as Json).input = { type: "list" }),
    );

    expect(codes(document)).toEqual([["/trigger/input/type", "invalid_value"]]);
  });

  // #833-M1-T283
  it("lets a step read the repository as trigger.input.repo, and an issue trigger as trigger.repo", () => {
    expect(
      codes(manual({}, { issue: 1, body: "in {{trigger.input.repo}}" })),
    ).toEqual([]);
    expect(
      codes(
        change(issueToPr(), (d) =>
          Object.assign(pr(d), { body: "{{trigger.repo.fullName}}" }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("a target input", () => {
  // #833-M1-T284
  it("takes the branch of an agent step that may push, or a literal, as the head of a pull request", () => {
    expect(codes(pullRequest({ head: "{{implement.branch}}" }))).toEqual([]);
    expect(codes(pullRequest({ head: "agent/fix-7" }))).toEqual([]);
  });

  // #833-M1-T285
  it.each([
    ["a result field of an agent", "{{implement.summary}}"],
    ["the commits of an agent", "{{implement.commits}}"],
    ["a field of the loop", "{{fix.exit}}"],
    ["a field of the trigger", "{{trigger.issue.title}}"],
    ["text around the branch", "agent/{{implement.branch}}"],
    ["two references", "{{implement.branch}}{{implement.summary}}"],
    ["a reference with spaces around it", " {{implement.branch}}"],
    ["previous", "{{previous.implement.branch}}"],
  ])("refuses as the head: %s", (_name, head) => {
    expect(codes(pullRequest({ head }))).toEqual([
      [`${PR}/head`, "target_from_untrusted_value"],
    ]);
  });

  // #833-M1-T286
  it("says in the message which values a target takes", () => {
    const [message] = messages(pullRequest({ head: "{{implement.summary}}" }));

    expect(message).toMatch(/'head'/);
    expect(message).toMatch(/\.branch/);
    expect(message).toMatch(/literal/i);

    const [baseMessage] = messages(
      pullRequest({ base: "{{implement.summary}}" }),
    );
    expect(baseMessage).toMatch(/'base'/);
    expect(baseMessage).toMatch(/trigger\./);
  });

  // #833-M1-T287
  it("takes a literal or a field of the trigger as the base, and refuses the branch of an agent", () => {
    expect(codes(pullRequest({ base: "develop" }))).toEqual([]);
    expect(
      codes(pullRequest({ base: "{{trigger.repo.defaultBranch}}" })),
    ).toEqual([]);
    for (const base of [
      "{{implement.branch}}",
      "{{implement.summary}}",
      "release/{{trigger.repo.defaultBranch}}",
    ])
      expect(codes(pullRequest({ base }))).toEqual([
        [`${PR}/base`, "target_from_untrusted_value"],
      ]);
  });

  // #833-M1-T288
  it("reports an unknown step as an unknown step, not as an untrusted value", () => {
    expect(codes(pullRequest({ head: "{{ghost.branch}}" }))).toEqual([
      [`${PR}/head`, "reference_unknown_step"],
    ]);
    expect(codes(pullRequest({ head: "{{review.branch}}" }))).toEqual([
      [`${PR}/head`, "reference_fact_unavailable"],
    ]);
  });

  // #833-M1-T289
  it("takes the issue as a positive whole number, the issue of the trigger or its number", () => {
    for (const issue of [7, "{{trigger.issue}}", "{{trigger.issue.number}}"])
      expect(codes(labels({ issue }))).toEqual([]);
  });

  // #833-M1-T290
  it.each([
    [0, "invalid_value"],
    [-4.5, "invalid_value"],
    [1.5, "invalid_value"],
    [-1, "invalid_value"],
    ["7", "wrong_type"],
    [true, "wrong_type"],
    [[7], "wrong_type"],
    [{ number: 7 }, "wrong_type"],
    [null, "wrong_type"],
  ])("refuses the issue %j", (issue, code) => {
    expect(codes(labels({ issue }))).toEqual([[`${LABELS}/issue`, code]]);
  });

  // #833-M1-T291
  it.each([
    ["a result of an agent", "{{implement.summary}}"],
    ["an action output", "{{start.labels}}"],
  ])("refuses as the issue: %s", (_name, issue) => {
    expect(codes(labels({ issue }))).toEqual([
      [`${LABELS}/issue`, "target_from_untrusted_value"],
    ]);
  });

  // #833-M1-T292
  it("refuses an issue that is not a number or the issue object, however it is referred to", () => {
    expect(codes(labels({ issue: "#{{trigger.issue.number}}" }))).toEqual([
      [`${LABELS}/issue`, "wrong_type"],
    ]);
    expect(codes(labels({ issue: "{{trigger.issue.title}}" }))).toEqual([
      [`${LABELS}/issue`, "reference_type_mismatch"],
    ]);
    expect(codes(labels({ issue: "{{trigger.issue.labels}}" }))).toEqual([
      [`${LABELS}/issue`, "reference_type_mismatch"],
    ]);
  });

  // #833-M1-T293
  it("takes labels as a list of literals and references to the trigger, or one reference to a list of the trigger", () => {
    expect(codes(labels({ add: ["bug", "{{trigger.issue.title}}"] }))).toEqual(
      [],
    );
    expect(codes(labels({ add: "{{trigger.issue.labels}}" }))).toEqual([]);
    expect(codes(labels({ remove: ["x"] }))).toEqual([]);
  });

  // #833-M1-T294
  it.each([
    ["add", ["{{implement.summary}}"], `${LABELS}/add/0`],
    ["add", ["bug", "tag {{trigger.issue.title}}"], `${LABELS}/add/1`],
    ["remove", "{{review.findings}}", `${LABELS}/remove`],
    ["remove", ["{{fix.exit}}"], `${LABELS}/remove/0`],
  ])("refuses as %s: %j", (input, value, path) => {
    expect(codes(labels({ [input]: value }))).toEqual([
      [path, "target_from_untrusted_value"],
    ]);
  });

  // #833-M1-T295
  it("refuses a number, a list or true/false where a label or branch is wanted, by value and by reference", () => {
    expect(codes(labels({ add: [3] }))).toEqual([
      [`${LABELS}/add/0`, "wrong_type"],
    ]);
    expect(codes(labels({ add: ["{{trigger.issue.number}}"] }))).toEqual([
      [`${LABELS}/add/0`, "reference_type_mismatch"],
    ]);
    expect(codes(labels({ add: ["{{trigger.issue.labels}}"] }))).toEqual([
      [`${LABELS}/add/0`, "reference_type_mismatch"],
    ]);
    expect(codes(labels({ add: "{{trigger.issue.number}}" }))).toEqual([
      [`${LABELS}/add`, "reference_type_mismatch"],
    ]);
    expect(codes(pullRequest({ base: "{{trigger.issue.number}}" }))).toEqual([
      [`${PR}/base`, "reference_type_mismatch"],
    ]);
    expect(codes(pullRequest({ base: "{{trigger.issue.labels}}" }))).toEqual([
      [`${PR}/base`, "reference_type_mismatch"],
    ]);
    expect(codes(pullRequest({ head: 7 }))).toEqual([
      [`${PR}/head`, "wrong_type"],
    ]);
  });

  // #833-M1-T296
  it("takes what the caller of a manual trigger hands in, by its type", () => {
    const fields = {
      issueNo: { type: "number" },
      branchName: { type: "string" },
      names: { type: "array", items: { type: "string" } },
    };
    const all = ["issueNo", "branchName", "names"];

    expect(
      codes(
        manual(fields, { issue: "{{trigger.input.issueNo}}", body: "x" }, all),
      ),
    ).toEqual([]);
    expect(
      codes(
        manual(
          fields,
          {
            connector: "github.issue.labels",
            issue: 3,
            add: "{{trigger.input.names}}",
          },
          all,
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        manual(
          fields,
          { issue: "{{trigger.input.branchName}}", body: "x" },
          all,
        ),
      ),
    ).toEqual([["/steps/1/issue", "reference_type_mismatch"]]);
    expect(
      codes(
        manual(
          fields,
          {
            connector: "github.pullRequest.open",
            title: "t",
            head: "{{work.branch}}",
            base: "{{trigger.input.branchName}}",
          },
          all,
        ),
      ),
    ).toEqual([]);
  });

  // #833-M1-T297
  it("accepts text of every kind and an agent's result in the free-text inputs", () => {
    expect(
      codes(
        pullRequest({
          title: "{{implement.summary}}",
          body: "{{review.findings}} on {{fix.rounds}} rounds: {{trigger.issue.labels}}",
        }),
      ),
    ).toEqual([]);
    expect(
      codes(
        change(issueToPr(), (d) => {
          implement(d).instruction =
            "{{start.labels}} {{trigger.issue.number}}";
        }),
      ),
    ).toEqual([]);
  });
});

describe("the environment of an agent step", () => {
  const environmentOf = (environment: unknown): Json =>
    change(tiny(), (d) => ((steps(d)[0] as Json).environment = environment));

  // #833-M1-T298
  it("is the literal name of an environment of the workspace, whatever its case", () => {
    expect(codes(environmentOf("node"))).toEqual([]);
    expect(codes(environmentOf("PYTHON"))).toEqual([]);
    expect(codes(environmentOf("cobol"))).toEqual([
      ["/steps/0/environment", "environment_unknown"],
    ]);
  });

  // #833-M1-T299
  it.each([
    ["a reference to the trigger", "{{trigger.input.repo}}"],
    ["a reference to a result", "{{work.summary}}"],
    ["a name with a reference in it", "node-{{trigger.input.repo}}"],
  ])("refuses %s", (_name, environment) => {
    expect(codes(environmentOf(environment))).toEqual([
      ["/steps/0/environment", "target_from_untrusted_value"],
    ]);
  });

  // #833-M1-T300
  it("compares the text of an escaped brace as it is written, and does not skip the check for it", () => {
    expect(codes(environmentOf("node\\{{x"))).toEqual([
      ["/steps/0/environment", "environment_unknown"],
    ]);
  });
});

describe("a label that starts the workflow", () => {
  const retrigger = (add: unknown): Json => labels({ add });

  // #833-M1-T301
  it("may not be added by the workflow, in any case", () => {
    expect(codes(retrigger(["ready for agent"]))).toEqual([
      [`${LABELS}/add/0`, "label_retriggers_workflow"],
    ]);
    expect(codes(retrigger(["bug", "Ready For Agent"]))).toEqual([
      [`${LABELS}/add/1`, "label_retriggers_workflow"],
    ]);
  });

  // #833-M1-T302
  it("may be removed, and another label may be added", () => {
    expect(
      codes(labels({ add: ["agent working"], remove: ["ready for agent"] })),
    ).toEqual([]);
  });

  // #833-M1-T303
  it("is only a rule for the trigger that has a label", () => {
    expect(
      codes(
        manual(
          {},
          {
            connector: "github.issue.labels",
            issue: 1,
            add: ["ready for agent"],
          },
        ),
      ),
    ).toEqual([]);
  });
});
