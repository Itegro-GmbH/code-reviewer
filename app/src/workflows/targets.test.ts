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
  it("takes a literal, the default branch of the repository or an input of the caller as the base, and refuses the rest", () => {
    expect(codes(pullRequest({ base: "develop" }))).toEqual([]);
    expect(
      codes(pullRequest({ base: "{{trigger.repo.defaultBranch}}" })),
    ).toEqual([]);
    for (const base of [
      "{{implement.branch}}",
      "{{implement.summary}}",
      "release/{{trigger.repo.defaultBranch}}",
      "{{trigger.issue.title}}",
      "{{trigger.issue.body}}",
      "{{trigger.repo.name}}",
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
    for (const issue of [
      7,
      2147483647,
      "{{trigger.issue}}",
      "{{trigger.issue.number}}",
    ])
      expect(codes(labels({ issue }))).toEqual([]);
  });

  // #833-M1-T290
  it.each([
    [0, "invalid_value"],
    [-4.5, "invalid_value"],
    [1.5, "invalid_value"],
    [-1, "invalid_value"],
    [2147483648, "invalid_value"],
    [9007199254740993, "invalid_value"],
    [1e21, "invalid_value"],
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
    ["the title of the issue", "{{trigger.issue.title}}"],
    ["the labels of the issue", "{{trigger.issue.labels}}"],
    ["the body of the issue", "{{trigger.issue.body}}"],
  ])("refuses as the issue: %s", (_name, issue) => {
    expect(codes(labels({ issue }))).toEqual([
      [`${LABELS}/issue`, "target_from_untrusted_value"],
    ]);
  });

  // #833-M1-T292
  it("refuses an issue that is text around a reference", () => {
    expect(codes(labels({ issue: "#{{trigger.issue.number}}" }))).toEqual([
      [`${LABELS}/issue`, "wrong_type"],
    ]);
  });

  // #833-M1-T293
  it("takes labels as a list of literals, or one reference to a list of the caller of a manual trigger", () => {
    expect(codes(labels({ add: ["bug", "agent working"] }))).toEqual([]);
    expect(codes(labels({ remove: ["x"] }))).toEqual([]);
    const fields = {
      name: { type: "string" },
      names: { type: "array", items: { type: "string" } },
    };
    const label = (extra: Json): Json =>
      manual(fields, { connector: "github.issue.labels", issue: 1, ...extra }, [
        "name",
        "names",
      ]);
    expect(codes(label({ add: ["{{trigger.input.name}}", "bug"] }))).toEqual(
      [],
    );
    expect(codes(label({ remove: "{{trigger.input.names}}" }))).toEqual([]);
  });

  // #833-M1-T293a
  it.each([
    ["add", ["{{trigger.issue.title}}"], `${LABELS}/add/0`],
    ["remove", ["{{trigger.issue.title}}"], `${LABELS}/remove/0`],
    ["add", ["{{trigger.issue.body}}"], `${LABELS}/add/0`],
    ["add", "{{trigger.issue.labels}}", `${LABELS}/add`],
    ["remove", "{{trigger.issue.labels}}", `${LABELS}/remove`],
    ["add", ["{{trigger.repo.name}}"], `${LABELS}/add/0`],
    ["add", ["{{implement.branch}}"], `${LABELS}/add/0`],
  ])(
    "refuses a label from the free text of whoever opened the issue, or from the issue at all: %s %j",
    (input, value, path) => {
      expect(codes(labels({ [input]: value }))).toEqual([
        [path, "target_from_untrusted_value"],
      ]);
    },
  );

  // #833-M1-T293b
  it("names the roots an input takes in the message", () => {
    const [labelsMessage] = messages(
      labels({ add: ["{{trigger.issue.title}}"] }),
    );
    expect(labelsMessage).toMatch(/'add'/);
    expect(labelsMessage).toMatch(/trigger\.input/);
    expect(labelsMessage).not.toMatch(/trigger\.issue\.\*/);
    const [issueMessage] = messages(
      labels({ issue: "{{trigger.issue.title}}" }),
    );
    expect(issueMessage).toMatch(/trigger\.issue\.number/);
    expect(issueMessage).toMatch(/trigger\.input/);
    const [baseMessage] = messages(
      pullRequest({ base: "{{trigger.issue.body}}" }),
    );
    expect(baseMessage).toMatch(/trigger\.repo\.defaultBranch/);
    expect(baseMessage).toMatch(/trigger\.input/);
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
      [`${LABELS}/add/0`, "target_from_untrusted_value"],
    ]);
    expect(codes(pullRequest({ base: "{{trigger.issue.number}}" }))).toEqual([
      [`${PR}/base`, "target_from_untrusted_value"],
    ]);
    expect(codes(pullRequest({ base: "{{trigger.issue.labels}}" }))).toEqual([
      [`${PR}/base`, "target_from_untrusted_value"],
    ]);
    expect(codes(pullRequest({ head: 7 }))).toEqual([
      [`${PR}/head`, "wrong_type"],
    ]);
    const fields = {
      count: { type: "integer" },
      names: { type: "array", items: { type: "string" } },
    };
    expect(
      codes(
        manual(
          fields,
          {
            connector: "github.issue.labels",
            issue: 1,
            add: ["{{trigger.input.count}}"],
          },
          ["count", "names"],
        ),
      ),
    ).toEqual([["/steps/1/add/0", "reference_type_mismatch"]]);
    expect(
      codes(
        manual(
          fields,
          {
            connector: "github.issue.labels",
            issue: 1,
            add: ["{{trigger.input.names}}"],
          },
          ["count", "names"],
        ),
      ),
    ).toEqual([["/steps/1/add/0", "reference_type_mismatch"]]);
  });

  // #833-M1-T295a
  it("refuses a labels action that adds and removes nothing", () => {
    expect(codes(labels({ add: [], remove: [] }))).toEqual([
      [LABELS, "missing_field"],
    ]);
    expect(codes(labels({ add: [] }))).toEqual([[LABELS, "missing_field"]]);
    expect(codes(labels({ add: [], remove: ["x"] }))).toEqual([]);
  });

  // #833-M1-T296
  it("takes what the caller of a manual trigger hands in, by its type", () => {
    const fields = {
      issueNo: { type: "integer" },
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

  // #833-M1-T296a
  it("needs an input of type integer for the issue: a number is not enough, because the validator cannot guarantee a whole one", () => {
    const issueFrom = (type: string): Json =>
      manual({ n: { type } }, { issue: "{{trigger.input.n}}", body: "x" }, [
        "n",
      ]);

    expect(codes(issueFrom("integer"))).toEqual([]);
    expect(codes(issueFrom("number"))).toEqual([
      ["/steps/1/issue", "reference_type_mismatch"],
    ]);
    expect(messages(issueFrom("number"))[0]).toMatch(/integer/);
  });

  // #833-M1-T296b
  it.each([
    ["{{trigger.issue.number | default -3}}", "invalid_value"],
    ["{{trigger.issue.number | default 1.5}}", "default_type_mismatch"],
    ["{{trigger.issue.number | default 0}}", "invalid_value"],
    ["{{trigger.issue.number | default 2147483648}}", "invalid_value"],
    ['{{trigger.issue.number | default "7"}}', "default_type_mismatch"],
    ["{{trigger.issue.number | default 7}}", undefined],
  ])(
    "holds the default of a reference in %s to the rule of a literal",
    (issue, code) => {
      expect(codes(labels({ issue }))).toEqual(
        code === undefined ? [] : [[`${LABELS}/issue`, code]],
      );
    },
  );

  // #833-M1-T296c
  it("holds the default of an input of the caller to the rule of a literal", () => {
    const issueFrom = (fallback: string): Json =>
      manual(
        { n: { type: "integer" } },
        { issue: `{{trigger.input.n | default ${fallback}}}`, body: "x" },
      );

    expect(codes(issueFrom("5"))).toEqual([]);
    for (const [fallback, code] of [
      ["0", "invalid_value"],
      ["-1", "invalid_value"],
      ["2147483648", "invalid_value"],
      ["2.5", "default_type_mismatch"],
      ["1e21", "default_type_mismatch"],
    ] as const)
      expect(codes(issueFrom(fallback))).toEqual([["/steps/1/issue", code]]);
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
