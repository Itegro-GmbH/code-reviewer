// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER, issueToPr, tiny } from "./test-fixtures.ts";
import { validateWorkflow, type ValidateOptions } from "./validate.ts";

type Json = Record<string, unknown>;

function run(document: unknown, options?: ValidateOptions) {
  return validateWorkflow(document, FAKE_RESOLVER, options);
}

/** `[path, code]` of every error. */
function codes(document: unknown, options?: ValidateOptions): string[][] {
  return run(document, options).errors.map((e) => [e.path, e.code]);
}

function change(base: Json, edit: (document: Json) => void): Json {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}

/** The tiny workflow with one more step after `work`. */
function withStep(step: Json, base: Json = tiny()): Json {
  return change(base, (d) => (d.steps as unknown[]).push(step));
}

const COMMENT = {
  id: "say",
  kind: "action",
  connector: "github.issue.comment",
  issue: 7,
  body: "x",
};

function comment(body: string): Json {
  return { ...COMMENT, body };
}

function agentSteps(doc: Json): Json[] {
  return doc.steps as Json[];
}

describe("the plan's example", () => {
  // #833-M1-T30
  it("validates clean, as format v1 states it", () => {
    const result = run(issueToPr());

    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({ valid: true, budgetUsd: 20, steps: 7 });
  });

  // #833-M1-T31
  it("breaks in the expected places when its pieces are broken", () => {
    const doc = issueToPr();
    const loop = agentSteps(doc)[1] as Json;
    const body = loop.body as Json[];
    (body[1] as Json).profile = "reviewer@9";
    (agentSteps(doc)[2]?.then as Json[])[0] = {
      id: "pr",
      kind: "action",
      connector: "github.pullRequest.open",
      head: "{{review.branch}}",
      title: "t",
    };
    loop.maxRounds = 30;

    expect(codes(doc)).toEqual([
      ["/steps/1/body/1/profile", "profile_version_unknown"],
      ["/steps/1/maxRounds", "limit_exceeded"],
      ["/steps/2/then/0/head", "reference_fact_unavailable"],
    ]);
  });
});

describe("the plan's example, broken in one place at a time", () => {
  const body = (d: Json): Json[] => (agentSteps(d)[1] as Json).body as Json[];
  const thenSteps = (d: Json): Json[] => agentSteps(d)[2]?.then as Json[];
  const elseSteps = (d: Json): Json[] => agentSteps(d)[2]?.else as Json[];

  const VARIANTS: Array<[string, (d: Json) => void, string[][]]> = [
    [
      "a step in the then-branch used in the else-branch",
      (d) => ((elseSteps(d)[0] as Json).body = "{{pr.url}}"),
      [["/steps/2/else/0/body", "reference_not_in_scope"]],
    ],
    [
      "a step in the then-branch used after the if",
      (d) =>
        agentSteps(d).push({
          ...COMMENT,
          id: "after",
          body: "{{pr.url}}",
        }),
      [["/steps/3/body", "reference_not_in_scope"]],
    ],
    [
      "previous.* in the first instruction of a loop",
      (d) =>
        ((body(d)[0] as Json).instruction = {
          first: "{{previous.review.findings}}",
          next: "n",
        }),
      [["/steps/1/body/0/instruction/first", "previous_without_default"]],
    ],
    [
      "previous.* with a default in the first instruction",
      (d) =>
        ((body(d)[0] as Json).instruction = {
          first: "{{previous.review.findings | default []}}",
          next: "n",
        }),
      [],
    ],
    [
      "a summary that is not required, used in the pull request",
      (d) => delete ((body(d)[0] as Json).result as Json).required,
      [["/steps/2/then/0/body", "reference_optional_field"]],
    ],
    [
      "a loop without maxRounds",
      (d) => delete (agentSteps(d)[1] as Json).maxRounds,
      [["/steps/1/maxRounds", "missing_field"]],
    ],
    [
      "an until that uses a step that comes later",
      (d) =>
        ((agentSteps(d)[1] as Json).until = {
          equals: ["{{done.taken}}", "then"],
        }),
      [["/steps/1/until/equals/0", "reference_to_later_step"]],
    ],
    [
      "a comparison of the loop's exit with a reason it never has",
      (d) =>
        ((agentSteps(d)[2] as Json).when = {
          equals: ["{{fix.exit}}", "timeout"],
        }),
      [["/steps/2/when/equals/1", "condition_value_not_in_enum"]],
    ],
    [
      "an agent without an environment",
      (d) => delete (body(d)[1] as Json).environment,
      [["/steps/1/body/1/environment", "missing_field"]],
    ],
    [
      "an environment that does not exist",
      (d) => ((body(d)[1] as Json).environment = "cobol"),
      [["/steps/1/body/1/environment", "environment_unknown"]],
    ],
    [
      "an issue given as its title",
      (d) => ((agentSteps(d)[0] as Json).issue = "{{trigger.issue.title}}"),
      [["/steps/0/issue", "target_from_untrusted_value"]],
    ],
    [
      "a result field that is a platform fact",
      (d) =>
        ((((body(d)[0] as Json).result as Json).properties as Json).branch = {
          type: "string",
        }),
      [["/steps/1/body/0/result/properties/branch", "result_field_reserved"]],
    ],
    [
      "a reserved kind",
      (d) => ((agentSteps(d)[0] as Json).kind = "forEach"),
      [["/steps/0/kind", "kind_not_supported"]],
    ],
    [
      "two steps with the id pr",
      (d) => ((elseSteps(d)[0] as Json).id = "pr"),
      [["/steps/2/else/0/id", "duplicate_id"]],
    ],
    [
      "a session that continues a step that comes later",
      (d) => ((body(d)[0] as Json).session = { continue: "review" }),
      [["/steps/1/body/0/session/continue", "session_target_invalid"]],
    ],
    [
      "a reviewer that may not push, whose branch is used",
      (d) => ((body(d)[1] as Json).instruction = "Review {{review.branch}}"),
      [["/steps/1/body/1/instruction", "reference_to_later_step"]],
    ],
    [
      "the pull request from the branch of the reviewer",
      (d) => ((thenSteps(d)[0] as Json).head = "{{review.branch}}"),
      [["/steps/2/then/0/head", "reference_fact_unavailable"]],
    ],
    [
      "a pull request that names a base from a number",
      (d) => ((thenSteps(d)[0] as Json).base = 3),
      [["/steps/2/then/0/base", "wrong_type"]],
    ],
    [
      "a comment with a field the connector does not have",
      (d) => ((elseSteps(d)[0] as Json).labels = ["x"]),
      [["/steps/2/else/0/labels", "unknown_field"]],
    ],
    [
      "a trigger that is a webhook",
      (d) => (d.trigger = { kind: "webhook", url: "x" }),
      [["/trigger/kind", "unknown_trigger_kind"]],
    ],
    [
      "a budget above the operator's maximum",
      (d) => (d.budgetUsd = 500),
      [["/budgetUsd", "budget_above_maximum"]],
    ],
  ];

  // #833-M1-T253
  it.each(VARIANTS)("%s", (_name, edit, expected) => {
    const doc = issueToPr();
    edit(doc);

    expect(codes(doc)).toEqual(expected);
  });
});

describe("the document", () => {
  // #833-M1-T32
  it("refuses what is no object", () => {
    expect(codes([])).toEqual([["", "wrong_type"]]);
    expect(codes(null)).toEqual([["", "wrong_type"]]);
    expect(codes("x")).toEqual([["", "wrong_type"]]);
  });

  // #833-M1-T33
  it("refuses a field it does not know, and names those that exist", () => {
    const result = run(change(tiny(), (d) => (d.nope = 1)));

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/nope",
        code: "unknown_field",
        available: [
          "version",
          "name",
          "description",
          "trigger",
          "triggers",
          "budgetUsd",
          "turnTimeLimitMinutes",
          "steps",
          "onFailure",
        ],
      }),
    ]);
  });

  // #833-M1-T34
  it("needs version, name, trigger and steps", () => {
    expect(codes({})).toEqual([
      ["/name", "missing_field"],
      ["/steps", "missing_field"],
      ["/trigger", "missing_field"],
      ["/version", "missing_field"],
    ]);
  });

  // #833-M1-T35
  it("knows format version 1 only", () => {
    expect(codes(change(tiny(), (d) => (d.version = 2)))).toEqual([
      ["/version", "invalid_value"],
    ]);
  });

  // #833-M1-T36
  it("checks name and description", () => {
    expect(
      codes(
        change(tiny(), (d) => {
          d.name = "";
          d.description = 4;
        }),
      ),
    ).toEqual([
      ["/description", "wrong_type"],
      ["/name", "invalid_value"],
    ]);
  });

  // #833-M1-T37
  it("returns every error, sorted by path, not only the first", () => {
    const doc = change(tiny(), (d) => {
      d.version = 3;
      d.zzz = true;
      d.trigger = { kind: "cron" };
      (agentSteps(d)[0] as Json).profile = "nobody";
    });

    expect(codes(doc)).toEqual([
      ["/steps/0/profile", "profile_unknown"],
      ["/trigger/kind", "unknown_trigger_kind"],
      ["/version", "invalid_value"],
      ["/zzz", "unknown_field"],
    ]);
  });

  // #833-M1-T38
  it("sorts steps by number, not as text", () => {
    const doc = change(tiny(), (d) => {
      const steps = agentSteps(d);
      for (let i = 0; i < 11; i++)
        steps.push({ ...COMMENT, id: `s${i}`, kind: "nope" });
    });

    const paths = run(doc).errors.map((e) => e.path);
    expect(paths.slice(0, 3)).toEqual([
      "/steps/1/kind",
      "/steps/2/kind",
      "/steps/3/kind",
    ]);
    expect(paths.indexOf("/steps/10/kind")).toBeGreaterThan(
      paths.indexOf("/steps/9/kind"),
    );
  });

  // #833-M1-T39
  it("does not throw on odd values wherever they sit", () => {
    const odd = [null, 7, "x", [], {}, true];
    const places = (doc: Json): Json[] => {
      const found: Json[] = [];
      const visit = (value: unknown): void => {
        if (typeof value !== "object" || value === null) return;
        if (!Array.isArray(value)) found.push(value as Json);
        for (const child of Object.values(value)) visit(child);
      };
      visit(doc);
      return found;
    };
    const base = issueToPr();
    const count = places(base).length;
    for (let n = 0; n < count; n++)
      for (const keyIndex of [0, 1, 2, 3])
        for (const value of odd) {
          const doc = structuredClone(base);
          const target = places(doc)[n] as Json;
          const key = Object.keys(target)[keyIndex];
          if (key === undefined) continue;
          target[key] = value;
          expect(() => run(doc)).not.toThrow();
        }
  });
});

describe("the trigger", () => {
  // #833-M1-T40
  it("names the triggers that exist when the kind is wrong", () => {
    const result = run(
      change(tiny(), (d) => (d.trigger = { kind: "webhook" })),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/trigger/kind",
        code: "unknown_trigger_kind",
        available: [
          "manual",
          "api",
          "ticket.labeled",
          "pullRequest.pushed",
          "schedule",
          "github.issueLabeled",
        ],
      }),
    ]);
  });

  // #833-M1-T41
  it("needs the label of github.issueLabeled and refuses fields of the other trigger", () => {
    expect(
      codes(
        change(tiny(), (d) => (d.trigger = { kind: "github.issueLabeled" })),
      ),
    ).toEqual([["/trigger/label", "missing_field"]]);
    expect(
      codes(
        change(
          tiny(),
          (d) =>
            (d.trigger = {
              kind: "github.issueLabeled",
              label: "x",
              input: {},
            }),
        ),
      ),
    ).toEqual([["/trigger/input", "unknown_field"]]);
    expect(
      codes(
        change(
          tiny(),
          (d) =>
            (d.trigger = {
              ...(d.trigger as Json),
              label: "x",
            }),
        ),
      ),
    ).toEqual([["/trigger/label", "unknown_field"]]);
  });

  // #833-M1-T42
  it("types what a manual trigger is started with, and checks its schema", () => {
    const manual = (input: unknown) =>
      change(tiny(), (d) => {
        d.trigger = { kind: "manual", input };
        (agentSteps(d)[0] as Json).instruction =
          "Task: {{trigger.input.task}} {{trigger.input.n}}";
      });
    const schema = {
      type: "object",
      required: ["repo", "task"],
      properties: {
        repo: { type: "string" },
        task: { type: "string" },
        n: { type: "number" },
      },
    };

    expect(codes(manual(schema))).toEqual([
      ["/steps/0/instruction", "reference_optional_field"],
    ]);
    expect(
      codes(manual({ ...schema, required: ["repo", "task", "n"] })),
    ).toEqual([]);
    expect(codes(manual({ type: "list" }))).toEqual([
      ["/trigger/input/type", "invalid_value"],
    ]);
  });

  // #833-M1-T43
  it("hands an issue and a repository to a github.issueLabeled workflow", () => {
    const doc = issueToPr();
    expect(
      codes(
        change(
          doc,
          (d) =>
            (((agentSteps(d)[1]?.body as Json[])[0] as Json).instruction =
              "{{trigger.repo.nope}}"),
        ),
      ),
    ).toEqual([["/steps/1/body/0/instruction", "reference_unknown_field"]]);
  });
});

describe("the steps: form", () => {
  // #833-M1-T44
  it("needs a list, not empty, of objects", () => {
    expect(codes(change(tiny(), (d) => (d.steps = {})))).toEqual([
      ["/steps", "wrong_type"],
    ]);
    expect(codes(change(tiny(), (d) => (d.steps = [])))).toEqual([
      ["/steps", "invalid_value"],
    ]);
    expect(codes(change(tiny(), (d) => (d.steps = [3])))).toEqual([
      ["/steps/0", "wrong_type"],
    ]);
  });

  // #833-M1-T45
  it("needs an id of the right form, and not trigger or previous", () => {
    const first = (edit: (step: Json) => void) =>
      codes(change(tiny(), (d) => edit(agentSteps(d)[0] as Json)));

    expect(first((s) => delete s.id)).toEqual([
      ["/steps/0/id", "missing_field"],
    ]);
    expect(first((s) => (s.id = 3))).toEqual([["/steps/0/id", "wrong_type"]]);
    expect(first((s) => (s.id = "1st"))).toEqual([
      ["/steps/0/id", "invalid_value"],
    ]);
    expect(first((s) => (s.id = "trigger"))).toEqual([
      ["/steps/0/id", "invalid_value"],
    ]);
    expect(first((s) => (s.id = "previous"))).toEqual([
      ["/steps/0/id", "invalid_value"],
    ]);
  });

  // #833-M1-T46
  it("needs a kind that exists, and names the kinds", () => {
    expect(codes(withStep({ id: "x" }))).toEqual([
      ["/steps/1/kind", "missing_field"],
    ]);
    const result = run(withStep({ id: "x", kind: "parallel" }));
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/1/kind",
        code: "unknown_kind",
        available: ["agent", "action", "if", "loop"],
      }),
    ]);
  });

  // #833-M1-T47
  it.each(["forEach", "approval", "workflow"])(
    "refuses the reserved kind %s with its own code, and reports no more about it",
    (kind) => {
      const doc = withStep({
        id: "later",
        kind,
        anything: [1, 2],
        more: { x: 1 },
      });
      (doc.steps as Json[]).push(comment("{{later.result}}"));

      expect(codes(doc)).toEqual([["/steps/1/kind", "kind_not_supported"]]);
      expect(run(doc).errors[0]?.message).toContain(
        "reserved for a later version",
      );
    },
  );

  // #833-M1-T48
  it("refuses two steps with one id, also inside a branch or a loop", () => {
    const doc = withStep({
      id: "gate",
      kind: "if",
      when: { equals: ["{{work.summary}}", "x"] },
      then: [{ ...COMMENT, id: "work" }],
    });

    expect(codes(doc)).toEqual([["/steps/1/then/0/id", "duplicate_id"]]);
    expect(run(doc).errors[0]?.message).toContain("/steps/0");
  });

  // #833-M1-T49
  it("refuses more steps than the limit", () => {
    const doc = change(tiny(), (d) => {
      for (let i = 0; i < 50; i++)
        agentSteps(d).push({ ...COMMENT, id: `c${i}` });
    });

    expect(codes(doc)).toEqual([["/steps", "too_many_steps"]]);
  });

  // #833-M1-T50
  it("refuses if and loop nested deeper than the limit", () => {
    let inner: Json = { ...COMMENT, id: "deep" };
    for (let i = 5; i >= 1; i--)
      inner = {
        id: `g${i}`,
        kind: "if",
        when: { equals: ["{{work.summary}}", "x"] },
        then: [inner],
      };

    expect(codes(withStep(inner))).toEqual([
      ["/steps/1/then/0/then/0/then/0/then/0", "nesting_too_deep"],
    ]);
  });

  // #833-M1-T51
  it("allows a loop in a loop and refuses a third level", () => {
    const loop = (id: string, body: Json[]): Json => ({
      id,
      kind: "loop",
      maxRounds: 2,
      body,
      until: { equals: ["{{work.summary}}", "done"] },
    });
    const two = loop("outer", [loop("inner", [{ ...COMMENT, id: "c" }])]);
    const three = loop("l1", [
      loop("l2", [loop("l3", [{ ...COMMENT, id: "c" }])]),
    ]);

    expect(codes(withStep(two))).toEqual([]);
    expect(codes(withStep(three))).toEqual([
      ["/steps/1/body/0/body/0", "nesting_too_deep"],
    ]);
  });
});

describe("the agent step", () => {
  const first = (edit: (step: Json) => void, base: Json = tiny()) =>
    codes(change(base, (d) => edit(agentSteps(d)[0] as Json)));

  // #833-M1-T52
  it("needs profile, environment and instruction, and refuses a field it does not know", () => {
    expect(
      first((s) => {
        delete s.profile;
        delete s.environment;
        delete s.instruction;
        s.model = "x";
      }),
    ).toEqual([
      ["/steps/0/environment", "missing_field"],
      ["/steps/0/instruction", "missing_field"],
      ["/steps/0/model", "unknown_field"],
      ["/steps/0/profile", "missing_field"],
    ]);
  });

  // #833-M1-T53
  it("names the profiles that exist, and their versions", () => {
    const unknown = run(
      change(tiny(), (d) => ((agentSteps(d)[0] as Json).profile = "ghost")),
    );
    expect(unknown.errors).toEqual([
      expect.objectContaining({
        code: "profile_unknown",
        available: ["implementer", "reviewer"],
      }),
    ]);
    const version = run(
      change(
        tiny(),
        (d) => ((agentSteps(d)[0] as Json).profile = "implementer@7"),
      ),
    );
    expect(version.errors).toEqual([
      expect.objectContaining({
        code: "profile_version_unknown",
        available: ["1", "2"],
      }),
    ]);
    expect(first((s) => (s.profile = "Implementer"))).toEqual([
      ["/steps/0/profile", "invalid_value"],
    ]);
    expect(first((s) => (s.profile = "implementer@2"))).toEqual([]);
    expect(first((s) => (s.profile = "implementer@latest"))).toEqual([
      ["/steps/0/profile", "invalid_value"],
    ]);
  });

  // #833-M1-T54
  it("names the environments of the workspace; the name is not case sensitive", () => {
    const result = run(
      change(tiny(), (d) => ((agentSteps(d)[0] as Json).environment = "rust")),
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "environment_unknown",
        available: ["node", "Python"],
      }),
    ]);
    expect(first((s) => (s.environment = "python"))).toEqual([]);
  });

  // #833-M1-T56
  it("takes the instruction as a text or as first and next", () => {
    expect(first((s) => (s.instruction = 5))).toEqual([
      ["/steps/0/instruction", "wrong_type"],
    ]);
    expect(first((s) => (s.instruction = { first: "a" }))).toEqual([
      ["/steps/0/instruction/next", "missing_field"],
    ]);
    expect(first((s) => (s.instruction = { first: "a", third: "c" }))).toEqual([
      ["/steps/0/instruction/next", "missing_field"],
      ["/steps/0/instruction/third", "unknown_field"],
    ]);
  });

  // #833-M1-T57
  it("refuses 'next' in a step outside a loop", () => {
    expect(first((s) => (s.instruction = { first: "a", next: "b" }))).toEqual([
      ["/steps/0/instruction/next", "instruction_next_outside_loop"],
    ]);
  });

  // #833-M1-T58
  it("takes a session that is new or continues an agent step that ran before", () => {
    const two = (session: unknown) =>
      withStep({
        id: "second",
        kind: "agent",
        profile: "implementer",
        environment: "node",
        instruction: "go",
        session,
      });

    expect(codes(two("new"))).toEqual([]);
    expect(codes(two({ continue: "work" }))).toEqual([]);
    expect(codes(two("old"))).toEqual([["/steps/1/session", "wrong_type"]]);
    expect(codes(two({ continue: "second" }))).toEqual([
      ["/steps/1/session/continue", "session_target_invalid"],
    ]);
    const ghost = run(two({ continue: "ghost" }));
    expect(ghost.errors).toEqual([
      expect.objectContaining({
        code: "session_target_invalid",
        available: ["work"],
      }),
    ]);
    expect(codes(two({}))).toEqual([
      ["/steps/1/session/continue", "missing_field"],
    ]);
  });

  // #833-M1-T59
  it("refuses to continue the session of an action or of a step that comes later", () => {
    const doc = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).session = { continue: "second" };
      agentSteps(d).push(
        {
          id: "second",
          kind: "agent",
          profile: "implementer",
          environment: "node",
          instruction: "go",
        },
        { ...COMMENT, id: "act" },
        {
          id: "third",
          kind: "agent",
          profile: "implementer",
          environment: "node",
          instruction: "go",
          session: { continue: "act" },
        },
      );
    });

    expect(codes(doc)).toEqual([
      ["/steps/0/session/continue", "session_target_invalid"],
      ["/steps/3/session/continue", "session_target_invalid"],
    ]);
  });

  // #833-M1-T60
  it("checks the result schema where it is written", () => {
    expect(
      first(
        (s) =>
          (s.result = { type: "object", properties: { a: { type: "list" } } }),
      ),
    ).toEqual([["/steps/0/result/properties/a/type", "invalid_value"]]);
  });

  // #833-M1-T61
  it("refuses a result field the platform fills in itself", () => {
    const result = run(
      change(tiny(), (d) => {
        (agentSteps(d)[0] as Json).result = {
          type: "object",
          properties: {
            branch: { type: "string" },
            costUsd: { type: "number" },
            ok: { type: "boolean" },
          },
        };
      }),
    );

    expect(result.errors.map((e) => [e.path, e.code])).toEqual([
      ["/steps/0/result/properties/branch", "result_field_reserved"],
      ["/steps/0/result/properties/costUsd", "result_field_reserved"],
    ]);
    expect(result.errors[0]?.available).toEqual([
      "costUsd",
      "branch",
      "commits",
      "headCommit",
      "pushed",
    ]);
  });

  // #833-M1-T62
  it("lets a step go without a result schema; it then yields the facts only", () => {
    const doc = change(tiny(), (d) => {
      delete (agentSteps(d)[0] as Json).result;
      agentSteps(d).push(
        comment("cost {{work.costUsd}} on {{work.branch}}"),
        comment("{{work.summary}}"),
      );
    });
    (doc.steps as Json[])[1] = { ...(doc.steps as Json[])[1], id: "a" };
    (doc.steps as Json[])[2] = { ...(doc.steps as Json[])[2], id: "b" };

    expect(codes(doc)).toEqual([["/steps/2/body", "reference_unknown_field"]]);
  });
});

describe("the action", () => {
  // #833-M1-T63
  it("names the connectors that exist", () => {
    const result = run(
      withStep({ id: "x", kind: "action", connector: "slack.post" }),
    );
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/1/connector",
        code: "unknown_connector",
        available: [
          "github.issue.comment",
          "github.issue.labels",
          "github.pullRequest.open",
          "ticket.comment",
          "ticket.labels",
        ],
      }),
    ]);
    expect(codes(withStep({ id: "x", kind: "action" }))).toEqual([
      ["/steps/1/connector", "missing_field"],
    ]);
  });

  // #833-M1-T64
  it("refuses an input the connector does not take, and names the inputs", () => {
    const result = run(withStep({ ...COMMENT, labels: ["x"] }));
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/1/labels",
        code: "unknown_field",
        available: ["id", "kind", "description", "connector", "issue", "body"],
      }),
    ]);
  });

  // #833-M1-T65
  it("needs the required inputs", () => {
    expect(
      codes(
        withStep({
          id: "x",
          kind: "action",
          connector: "github.issue.comment",
        }),
      ),
    ).toEqual([
      ["/steps/1/body", "missing_field"],
      ["/steps/1/issue", "missing_field"],
    ]);
    expect(
      codes(
        withStep({
          id: "x",
          kind: "action",
          connector: "github.issue.labels",
          issue: 1,
        }),
      ),
    ).toEqual([["/steps/1", "missing_field"]]);
  });

  // #833-M1-T67
  it("holds literal inputs to the types of the connector", () => {
    expect(codes(withStep({ ...COMMENT, body: 5 }))).toEqual([
      ["/steps/1/body", "wrong_type"],
    ]);
    expect(codes(withStep({ ...COMMENT, body: ["a"] }))).toEqual([
      ["/steps/1/body", "wrong_type"],
    ]);
    expect(codes(withStep({ ...COMMENT, issue: "seven" }))).toEqual([
      ["/steps/1/issue", "wrong_type"],
    ]);
    expect(codes(withStep({ ...COMMENT, issue: 7 }))).toEqual([]);
    expect(codes(withStep({ ...COMMENT, issue: { number: 7 } }))).toEqual([
      ["/steps/1/issue", "wrong_type"],
    ]);
    expect(
      codes(
        withStep({
          id: "x",
          kind: "action",
          connector: "github.issue.labels",
          issue: 1,
          add: "bug",
        }),
      ),
    ).toEqual([["/steps/1/add", "wrong_type"]]);
    expect(
      codes(
        withStep({
          id: "x",
          kind: "action",
          connector: "github.issue.labels",
          issue: 1,
          add: [1],
        }),
      ),
    ).toEqual([["/steps/1/add/0", "wrong_type"]]);
  });

  // #833-M1-T68
  it("holds a reference to the type the input expects", () => {
    const doc = (extra: Json) =>
      change(
        withStep({
          id: "x",
          kind: "action",
          connector: "github.pullRequest.open",
          head: "h",
          title: "t",
          ...extra,
        }),
        () => {},
      );

    expect(codes(doc({ draft: "{{work.costUsd}}" }))).toEqual([
      ["/steps/1/draft", "reference_type_mismatch"],
    ]);
    expect(codes(doc({ title: "{{work.costUsd}}" }))).toEqual([]);
    expect(codes(doc({ title: "{{work}}" }))).toEqual([
      ["/steps/1/title", "reference_type_mismatch"],
    ]);
    expect(codes(doc({ draft: true }))).toEqual([]);
    expect(codes(doc({ draft: "yes" }))).toEqual([
      ["/steps/1/draft", "wrong_type"],
    ]);
  });

  // #833-M1-T69
  it("takes an issue as a number, an object or a reference to either", () => {
    const labeled = change(
      tiny(),
      (d) => (d.trigger = { kind: "github.issueLabeled", label: "go" }),
    );
    const issue = (value: unknown) =>
      codes(
        withStep(
          {
            id: "x",
            kind: "action",
            connector: "github.issue.comment",
            body: "b",
            issue: value,
          },
          labeled,
        ),
      );

    expect(issue("{{trigger.issue}}")).toEqual([]);
    expect(issue("{{trigger.issue.number}}")).toEqual([]);
    expect(issue("{{trigger.issue.title}}")).toEqual([
      ["/steps/1/issue", "target_from_untrusted_value"],
    ]);
    expect(issue("{{trigger.repo}}")).toEqual([
      ["/steps/1/issue", "target_from_untrusted_value"],
    ]);
  });

  // #833-M1-T70
  it("gives the output of the action to the steps after it", () => {
    const doc = change(tiny(), (d) => {
      agentSteps(d).push(
        {
          id: "pr",
          kind: "action",
          connector: "github.pullRequest.open",
          head: "h",
          title: "t",
        },
        {
          ...COMMENT,
          id: "say",
          body: "PR {{pr.number}} at {{pr.url}} {{pr.nope}}",
        },
      );
    });

    expect(codes(doc)).toEqual([["/steps/2/body", "reference_unknown_field"]]);
    expect(run(doc).errors[0]?.available).toEqual([
      "number",
      "url",
      "existing",
    ]);
  });
});

describe("references", () => {
  // #833-M1-T71
  it("names the steps in reach when a reference starts with an unknown name", () => {
    const result = run(withStep(comment("{{ghost.x}}")));

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/1/body",
        code: "reference_unknown_step",
        available: ["trigger", "work"],
      }),
    ]);
  });

  // #833-M1-T72
  it("refuses a reference to a step that comes later, or to the step itself", () => {
    const later = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).instruction = "see {{after.url}}";
      agentSteps(d).push({
        id: "after",
        kind: "action",
        connector: "github.pullRequest.open",
        head: "h",
        title: "t",
      });
    });
    const self = change(
      tiny(),
      (d) => ((agentSteps(d)[0] as Json).instruction = "{{work.summary}}"),
    );

    expect(codes(later)).toEqual([
      ["/steps/0/instruction", "reference_to_later_step"],
    ]);
    expect(codes(self)).toEqual([
      ["/steps/0/instruction", "reference_to_later_step"],
    ]);
  });

  // #833-M1-T73
  it("can use a step inside a branch only in that branch", () => {
    const doc = change(tiny(), (d) => {
      agentSteps(d).push(
        {
          id: "gate",
          kind: "if",
          when: { equals: ["{{work.summary}}", "x"] },
          then: [{ ...COMMENT, id: "in_then" }, comment("{{in_then.url}}")].map(
            (s, i) => (i === 1 ? { ...s, id: "also_then" } : s),
          ),
          else: [{ ...COMMENT, id: "in_else", body: "{{in_then.url}}" }],
        },
        {
          ...COMMENT,
          id: "after",
          body: "{{in_then.url}} {{in_else.url}} {{gate.taken}}",
        },
      );
    });

    expect(codes(doc)).toEqual([
      ["/steps/1/else/0/body", "reference_not_in_scope"],
      ["/steps/2/body", "reference_not_in_scope"],
      ["/steps/2/body", "reference_not_in_scope"],
    ]);
    const messages = run(doc).errors.map((e) => e.message);
    expect(messages[0]).toContain(
      "'in_then' is in the 'then' branch of the if 'gate'",
    );
    expect(messages[1]).toContain("'in_else' is in the 'else' branch");
    expect(messages[2]).toContain("'in_then' is in the 'then' branch");
  });

  // #833-M1-T74
  it("gives only the if itself to the steps after it: gate.taken", () => {
    const doc = change(tiny(), (d) => {
      agentSteps(d).push(
        {
          id: "gate",
          kind: "if",
          when: { equals: ["{{work.summary}}", "x"] },
          then: [{ ...COMMENT, id: "a" }],
        },
        { ...COMMENT, id: "b", body: "{{gate.taken}} {{gate.nope}}" },
      );
    });

    expect(codes(doc)).toEqual([["/steps/2/body", "reference_unknown_field"]]);
    expect(run(doc).errors[0]?.available).toEqual(["taken"]);
  });

  // #833-M1-T75
  it("keeps what ran before the if available inside both branches", () => {
    const doc = change(tiny(), (d) => {
      agentSteps(d).push({
        id: "gate",
        kind: "if",
        when: { notEmpty: "{{work.summary}}" },
        then: [{ ...COMMENT, id: "a", body: "{{work.summary}}" }],
        else: [{ ...COMMENT, id: "b", body: "{{work.summary}}" }],
      });
    });

    expect(codes(doc)).toEqual([]);
  });

  // #833-M1-T76
  it("names the fields of a step when the field is unknown", () => {
    const result = run(withStep(comment("{{work.sumary}}")));

    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "reference_unknown_field",
        available: [
          "summary",
          "notes",
          "costUsd",
          "branch",
          "commits",
          "headCommit",
          "pushed",
        ],
      }),
    ]);
  });

  // #833-M1-T77
  it("refuses to go into a text or a number", () => {
    const result = run(withStep(comment("{{work.summary.length}}")));

    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "reference_unknown_field",
        available: [],
      }),
    ]);
  });

  // #833-M1-T78
  it("refuses a field that is not required, unless it has a default", () => {
    expect(codes(withStep(comment("{{work.notes}}")))).toEqual([
      ["/steps/1/body", "reference_optional_field"],
    ]);
    expect(codes(withStep(comment('{{work.notes | default "none"}}')))).toEqual(
      [],
    );
    expect(codes(withStep(comment("{{work.summary}}")))).toEqual([]);
  });

  // #833-M1-T79
  it("checks that the default fits the value", () => {
    expect(codes(withStep(comment("{{work.notes | default 3}}")))).toEqual([
      ["/steps/1/body", "default_type_mismatch"],
    ]);
    expect(codes(withStep(comment("{{work.costUsd | default 0}}")))).toEqual(
      [],
    );
    expect(
      codes(withStep(comment('{{work.commits | default ["x"]}}'))),
    ).toEqual([]);
    expect(codes(withStep(comment('{{work.commits | default "x"}}')))).toEqual([
      ["/steps/1/body", "default_type_mismatch"],
    ]);
  });

  // #833-M1-T80
  it.each([
    ["{{ }}"],
    ["{{a..b}}"],
    ["{{work.summary"],
    ["{{work.summary | shout}}"],
    ["{{work.summary | default oops}}"],
  ])("reports a text with the syntax %s", (text) => {
    expect(codes(withStep(comment(text)))).toEqual([
      ["/steps/1/body", "template_syntax"],
    ]);
  });

  // #833-M1-T81
  it("writes a literal {{ with a backslash", () => {
    expect(codes(withStep(comment("use \\{{not_a_reference}} here")))).toEqual(
      [],
    );
  });

  // #833-M1-T82
  it("refuses an object inside a text and names its fields", () => {
    const labeled = change(
      tiny(),
      (d) => (d.trigger = { kind: "github.issueLabeled", label: "go" }),
    );
    const result = run(withStep(comment("see {{trigger.issue}}"), labeled));

    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "reference_type_mismatch",
        available: ["number", "title", "body", "url", "labels"],
      }),
    ]);
  });

  // #833-M1-T83
  it("puts a list into a text, one entry per line", () => {
    const doc = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).result = {
        type: "object",
        required: ["tags"],
        properties: { tags: { type: "array", items: { type: "string" } } },
      };
      agentSteps(d).push(comment("{{work.tags}} and {{work.commits}}"));
    });

    expect(codes(doc)).toEqual([]);
  });

  // #833-M1-T84
  it("does not report a mistake again at every use of a step that already failed", () => {
    const doc = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).profile = "ghost";
      agentSteps(d).push(comment("{{work.branch}} {{work.summary}}"));
    });

    expect(codes(doc)).toEqual([["/steps/0/profile", "profile_unknown"]]);
  });

  // #833-M1-T325
  it("binds the fields of a result schema that failed its check as unknown, and reports the schema only", () => {
    const doc = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).result = {
        type: "object",
        required: ["ghost"],
        properties: { summary: { type: "string" } },
      };
      agentSteps(d).push(
        comment("{{work.summary}} {{work.other.deep}} {{work.branch}}"),
      );
    });

    expect(codes(doc)).toEqual([
      ["/steps/0/result/required/0", "required_field_unknown"],
    ]);
  });

  // #833-M1-T326
  it("keeps the facts of such a step: a profile that may not push still has no branch", () => {
    const doc = change(tiny(), (d) => {
      const step = agentSteps(d)[0] as Json;
      step.profile = "reviewer";
      step.result = { type: "object", properties: {} };
      agentSteps(d).push(comment("{{work.anything}} {{work.branch}}"));
    });

    expect(codes(doc)).toEqual([
      ["/steps/0/result/properties", "invalid_value"],
      ["/steps/1/body", "reference_fact_unavailable"],
    ]);
  });
});

describe("names that every object has", () => {
  // #833-M1-T250
  it.each(["__proto__", "constructor", "toString", "hasOwnProperty"])(
    "does not take %s for a field of a step or of a result",
    (name) => {
      expect(codes(withStep(comment(`{{work.${name}}}`)))).toEqual([
        ["/steps/1/body", "reference_unknown_field"],
      ]);
      expect(codes(withStep(comment(`{{${name}.x}}`)))).toEqual([
        ["/steps/1/body", "reference_unknown_step"],
      ]);
    },
  );

  // #833-M1-T251
  it("lets a result field be called __proto__ without changing what a type is", () => {
    const doc = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).result = {
        type: "object",
        required: ["__proto__"],
        properties: JSON.parse('{"__proto__": {"type": "string"}}'),
      };
    });
    (doc.steps as Json[]).push(
      comment("{{work.__proto__}} {{work.constructor}}"),
    );

    expect(codes(doc)).toEqual([["/steps/1/body", "reference_unknown_field"]]);
    expect(({} as Record<string, unknown>).type).toBeUndefined();
  });

  // #833-M1-T252
  it("takes a document that carries __proto__ as a key as an unknown field", () => {
    const doc = JSON.parse(
      '{"__proto__": {"x": 1}, "version": 1, "name": "n", "trigger": {"kind": "manual", "input": {"type": "object", "required": ["repo"], "properties": {"repo": {"type": "string"}}}}, "steps": [{"id": "a", "kind": "action", "connector": "github.issue.comment", "issue": 1, "body": "b"}]}',
    ) as unknown;

    expect(codes(doc)).toEqual([["/__proto__", "unknown_field"]]);
  });
});

describe("facts the agent does not report", () => {
  const reviewer = (base: Json = tiny()) =>
    change(base, (d) => ((agentSteps(d)[0] as Json).profile = "reviewer"));

  // #833-M1-T85
  it("gives branch, commits and cost to a profile that may push", () => {
    expect(
      codes(
        withStep(comment("{{work.branch}} {{work.commits}} {{work.costUsd}}")),
      ),
    ).toEqual([]);
  });

  // #833-M1-T86
  it("gives the cost, but not branch or commits, to a profile that may not push", () => {
    const doc = withStep(comment("{{work.branch}}"), reviewer());
    const result = run(doc);

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/1/body",
        code: "reference_fact_unavailable",
        available: ["summary", "notes", "costUsd"],
      }),
    ]);
    expect(result.errors[0]?.message).toContain("may not push");
    expect(codes(withStep(comment("{{work.commits}}"), reviewer()))).toEqual([
      ["/steps/1/body", "reference_fact_unavailable"],
    ]);
    expect(
      codes(withStep(comment("{{work.costUsd}} {{work.summary}}"), reviewer())),
    ).toEqual([]);
  });

  // #844-T220
  it("gives headCommit and pushed to a profile that may push, with the types of a text and of true/false", () => {
    expect(
      codes(withStep(comment("{{work.headCommit}} {{work.pushed}}"))),
    ).toEqual([]);
  });

  // #844-T221
  it("refuses headCommit and pushed of a profile that may not push, like branch and commits", () => {
    for (const fact of ["headCommit", "pushed"])
      expect(codes(withStep(comment(`{{work.${fact}}}`), reviewer()))).toEqual([
        ["/steps/1/body", "reference_fact_unavailable"],
      ]);
  });

  // #844-T222
  it("reserves headCommit and pushed as result fields of a step", () => {
    const doc = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).result = {
        type: "object",
        properties: {
          headCommit: { type: "string" },
          pushed: { type: "boolean" },
        },
      };
    });

    expect(codes(doc)).toEqual([
      ["/steps/0/result/properties/headCommit", "result_field_reserved"],
      ["/steps/0/result/properties/pushed", "result_field_reserved"],
    ]);
  });

  // #833-M1-T87
  it("holds a pull request to the branch of a step that may push", () => {
    const pr = (head: string) =>
      withStep(
        {
          id: "pr",
          kind: "action",
          connector: "github.pullRequest.open",
          head,
          title: "t",
        },
        reviewer(),
      );

    expect(codes(pr("{{work.branch}}"))).toEqual([
      ["/steps/1/head", "reference_fact_unavailable"],
    ]);
    expect(codes(pr("literal-branch"))).toEqual([]);
  });
});

describe("loops", () => {
  const loop = (edit: (node: Json) => void = () => {}, body?: Json[]): Json => {
    const node: Json = {
      id: "again",
      kind: "loop",
      maxRounds: 3,
      body: body ?? [
        {
          id: "write",
          kind: "agent",
          profile: "implementer",
          environment: "node",
          instruction: {
            first: "go",
            next: "again, after {{previous.check.verdict}}",
          },
          result: {
            type: "object",
            required: ["draft"],
            properties: { draft: { type: "string" } },
          },
        },
        {
          id: "check",
          kind: "agent",
          profile: "reviewer",
          environment: "node",
          instruction: "review {{write.draft}}",
          result: {
            type: "object",
            required: ["verdict", "problems"],
            properties: {
              verdict: { type: "string", enum: ["ok", "redo"] },
              problems: { type: "array", items: { type: "string" } },
              note: { type: "string" },
            },
          },
        },
      ],
      until: { equals: ["{{check.verdict}}", "ok"] },
    };
    edit(node);
    return node;
  };

  // #833-M1-T88
  it("accepts a loop with a previous reference in next, an until over the body, and the body after the loop", () => {
    const doc = withStep(loop());
    (doc.steps as Json[]).push({
      ...COMMENT,
      id: "after",
      body: "{{again.exit}} {{again.rounds}} {{write.draft}} {{check.problems}}",
    });

    expect(codes(doc)).toEqual([]);
  });

  // #833-M1-T89
  it("needs maxRounds, a whole number from 1 to the cap", () => {
    expect(codes(withStep(loop((n) => delete n.maxRounds)))).toEqual([
      ["/steps/1/maxRounds", "missing_field"],
    ]);
    expect(codes(withStep(loop((n) => (n.maxRounds = 0))))).toEqual([
      ["/steps/1/maxRounds", "invalid_value"],
    ]);
    expect(codes(withStep(loop((n) => (n.maxRounds = 11))))).toEqual([
      ["/steps/1/maxRounds", "limit_exceeded"],
    ]);
    expect(codes(withStep(loop((n) => (n.maxRounds = 2.5))))).toEqual([
      ["/steps/1/maxRounds", "wrong_type"],
    ]);
    expect(codes(withStep(loop((n) => (n.maxRounds = "3"))))).toEqual([
      ["/steps/1/maxRounds", "wrong_type"],
    ]);
    expect(codes(withStep(loop((n) => (n.maxRounds = 10))))).toEqual([]);
  });

  // #833-M1-T90
  it("needs a body and an until", () => {
    expect(codes(withStep(loop((n) => delete n.body)))).toEqual([
      ["/steps/1/body", "missing_field"],
    ]);
    expect(codes(withStep(loop((n) => (n.body = []))))).toEqual([
      ["/steps/1/body", "invalid_value"],
    ]);
    expect(codes(withStep(loop((n) => delete n.until)))).toEqual([
      ["/steps/1/until", "missing_field"],
    ]);
  });

  // #833-M1-T91
  it("can use in the until only what the body made", () => {
    expect(
      codes(withStep(loop((n) => (n.until = { empty: "{{ghost.x}}" })))),
    ).toEqual([["/steps/1/until/empty", "reference_unknown_step"]]);
    expect(
      codes(withStep(loop((n) => (n.until = { empty: "{{check.problems}}" })))),
    ).toEqual([]);
  });

  // #833-M1-T92
  it("gives previous.* to the next instruction in round two, never to round one", () => {
    const first = (text: string) =>
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[0] as Json).instruction = {
                first: text,
                next: "n",
              }),
          ),
        ),
      );

    expect(first("x {{previous.check.verdict}}")).toEqual([
      ["/steps/1/body/0/instruction/first", "previous_without_default"],
    ]);
    expect(first('x {{previous.check.verdict | default "ok"}}')).toEqual([]);
    expect(first('x {{previous.check.verdict | default "none"}}')).toEqual([
      ["/steps/1/body/0/instruction/first", "default_type_mismatch"],
    ]);
  });

  // #833-M1-T93
  it("refuses previous.* in a plain instruction without a default: round one has no previous round", () => {
    expect(
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[0] as Json).instruction =
                "x {{previous.check.verdict}}"),
          ),
        ),
      ),
    ).toEqual([["/steps/1/body/0/instruction", "previous_without_default"]]);
  });

  // #833-M1-T94
  it("refuses previous.* outside a loop", () => {
    expect(
      codes(withStep(comment('{{previous.work.summary | default "x"}}'))),
    ).toEqual([["/steps/1/body", "previous_outside_loop"]]);
    const result = run(withStep(comment("{{previous.work.summary}}")));
    expect(result.errors[0]?.code).toBe("previous_outside_loop");
  });

  // #833-M1-T95
  it("names the steps of the body when previous.* names none of them", () => {
    const result = run(
      withStep(
        loop(
          (n) =>
            (((n.body as Json[])[0] as Json).instruction = {
              first: "a",
              next: "{{previous.ghost.x}}",
            }),
        ),
      ),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "previous_unknown_step",
        available: ["write", "check"],
      }),
    ]);
  });

  // #833-M1-T96
  it("refuses previous.* for a step inside an if of the body, which may not have run", () => {
    const body: Json[] = [
      {
        id: "write",
        kind: "agent",
        profile: "implementer",
        environment: "node",
        instruction: { first: "a", next: "{{previous.inner.url}}" },
      },
      {
        id: "gate",
        kind: "if",
        when: { equals: ["{{write.costUsd}}", 1] },
        then: [{ ...COMMENT, id: "inner" }],
      },
    ];

    expect(
      codes(
        withStep(
          loop((n) => (n.until = { equals: ["{{gate.taken}}", "then"] }), body),
        ),
      ),
    ).toEqual([["/steps/1/body/0/instruction/next", "previous_unknown_step"]]);
  });

  // #833-M1-T97
  it("types previous.* like the step's own value", () => {
    expect(
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[0] as Json).instruction = {
                first: "a",
                next: "{{previous.check.nope}}",
              }),
          ),
        ),
      ),
    ).toEqual([
      ["/steps/1/body/0/instruction/next", "reference_unknown_field"],
    ]);
    expect(
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[0] as Json).instruction = {
                first: "a",
                next: "{{previous.check.note}}",
              }),
          ),
        ),
      ),
    ).toEqual([
      ["/steps/1/body/0/instruction/next", "reference_optional_field"],
    ]);
  });

  // #833-M1-T98
  it("cannot use the loop's own result inside its body", () => {
    expect(
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[1] as Json).instruction = "{{again.exit}}"),
          ),
        ),
      ),
    ).toEqual([["/steps/1/body/1/instruction", "reference_to_later_step"]]);
  });

  // #833-M1-T99
  it("cannot use in the body a step of the body that comes later", () => {
    expect(
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[0] as Json).instruction =
                "{{check.verdict}}"),
          ),
        ),
      ),
    ).toEqual([["/steps/1/body/0/instruction", "reference_to_later_step"]]);
  });

  // #833-M1-T100
  it("gives exit to the steps after the loop, with the three reasons", () => {
    const doc = withStep(loop());
    (doc.steps as Json[]).push({
      id: "gate",
      kind: "if",
      when: {
        all: [
          { equals: ["{{again.exit}}", "maxRounds"] },
          { not: { equals: ["{{again.exit}}", "budget"] } },
        ],
      },
      then: [{ ...COMMENT, id: "stop" }],
    });
    expect(codes(doc)).toEqual([]);
    (doc.steps as Json[])[2] = {
      ...((doc.steps as Json[])[2] as Json),
      when: { equals: ["{{again.exit}}", "timeout"] },
    };
    const result = run(doc);
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "condition_value_not_in_enum",
        available: ["until", "maxRounds", "budget"],
      }),
    ]);
  });

  // #833-M1-T101
  it("lets a step continue its own session in a loop, and not outside one", () => {
    expect(
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[0] as Json).session = { continue: "write" }),
          ),
        ),
      ),
    ).toEqual([]);
    // `check` runs another profile than `write`: a session cannot go over to it.
    expect(
      codes(
        withStep(
          loop(
            (n) =>
              (((n.body as Json[])[1] as Json).session = { continue: "write" }),
          ),
        ),
      ),
    ).toEqual([["/steps/1/body/1/session/continue", "session_target_invalid"]]);
  });

  describe("session.continue", () => {
    const agent = (id: string, extra: Json = {}): Json => ({
      id,
      kind: "agent",
      profile: "implementer",
      environment: "node",
      instruction: "go",
      ...extra,
    });
    const inLoop = (body: Json[]): Json =>
      withStep({
        id: "again",
        kind: "loop",
        maxRounds: 2,
        body,
        until: { empty: "{{trigger.input.repo}}" },
      });
    const gate = (then: Json[]): Json => ({
      id: "gate",
      kind: "if",
      when: { notEmpty: "{{trigger.input.repo}}" },
      then,
    });

    // #833-M1-T320
    it("goes on in its own session only as a direct step of a loop body", () => {
      expect(
        codes(inLoop([agent("a", { session: { continue: "a" } })])),
      ).toEqual([]);
      expect(
        codes(inLoop([gate([agent("a", { session: { continue: "a" } })])])),
      ).toEqual([
        ["/steps/1/body/0/then/0/session/continue", "session_target_invalid"],
      ]);
      expect(
        codes(withStep(gate([agent("a", { session: { continue: "a" } })]))),
      ).toEqual([
        ["/steps/1/then/0/session/continue", "session_target_invalid"],
      ]);
    });

    // #833-M1-T321
    it("goes on in a loop inside an if, where the step is still a direct step of the body", () => {
      const loopInIf = gate([
        {
          id: "again",
          kind: "loop",
          maxRounds: 2,
          body: [agent("a", { session: { continue: "a" } })],
          until: { empty: "{{trigger.input.repo}}" },
        },
      ]);

      expect(codes(withStep(loopInIf))).toEqual([]);
    });

    // #833-M1-T322
    it("goes on in the session of another step only with the same profile", () => {
      expect(
        codes(
          withStep(
            agent("b", { profile: "reviewer", session: { continue: "work" } }),
          ),
        ),
      ).toEqual([["/steps/1/session/continue", "session_target_invalid"]]);
      expect(
        codes(
          withStep(
            agent("b", {
              profile: "implementer@2",
              session: { continue: "work" },
            }),
          ),
        ),
      ).toEqual([]);
    });

    // #833-M1-T323
    it("goes on in the session of another step only in the same environment, whatever its case", () => {
      const result = run(
        withStep(
          agent("b", { environment: "Python", session: { continue: "work" } }),
        ),
      );

      expect(result.errors).toEqual([
        expect.objectContaining({
          path: "/steps/1/session/continue",
          code: "session_target_invalid",
          message: expect.stringContaining("environment"),
        }),
      ]);
      expect(
        codes(
          withStep(
            agent("b", { environment: "NODE", session: { continue: "work" } }),
          ),
        ),
      ).toEqual([]);
    });

    // #833-M1-T324
    it("refuses an id that is no step id, as the schema does", () => {
      expect(
        codes(withStep(agent("b", { session: { continue: "1a" } }))),
      ).toEqual([["/steps/1/session/continue", "invalid_value"]]);
      expect(
        codes(withStep(agent("b", { session: { continue: "trigger" } }))),
      ).toEqual([["/steps/1/session/continue", "invalid_value"]]);
    });
  });

  // #833-M1-T102
  it("does not hand the steps of a loop that was refused to the code after it", () => {
    const doc = withStep(loop((n) => (n.maxRounds = 99)));
    (doc.steps as Json[]).push({
      ...COMMENT,
      id: "after",
      body: "{{write.draft}}",
    });

    expect(codes(doc)).toEqual([["/steps/1/maxRounds", "limit_exceeded"]]);
  });
});

describe("conditions", () => {
  const when = (condition: unknown) =>
    codes(
      withStep({
        id: "gate",
        kind: "if",
        when: condition,
        then: [{ ...COMMENT, id: "a" }],
      }),
    );

  // #833-M1-T103
  it("takes empty and notEmpty over lists and texts, and refuses a number", () => {
    const doc = change(tiny(), (d) => {
      (agentSteps(d)[0] as Json).result = {
        type: "object",
        required: ["tags", "text"],
        properties: {
          tags: { type: "array", items: { type: "string" } },
          text: { type: "string" },
        },
      };
    });
    const gate = (condition: unknown) =>
      codes(
        withStep(
          {
            id: "gate",
            kind: "if",
            when: condition,
            then: [{ ...COMMENT, id: "a" }],
          },
          doc,
        ),
      );

    expect(gate({ empty: "{{work.tags}}" })).toEqual([]);
    expect(gate({ notEmpty: "{{work.text}}" })).toEqual([]);
    expect(gate({ empty: "{{work.costUsd}}" })).toEqual([
      ["/steps/1/when/empty", "condition_operand_type"],
    ]);
    expect(gate({ empty: "{{work}}" })).toEqual([
      ["/steps/1/when/empty", "condition_operand_type"],
    ]);
  });

  // #833-M1-T104
  it("compares a text with a text, a number with a number", () => {
    expect(when({ equals: ["{{work.summary}}", "ok"] })).toEqual([]);
    expect(when({ notEquals: ["{{work.costUsd}}", 3] })).toEqual([]);
    expect(when({ equals: ["{{work.costUsd}}", "3"] })).toEqual([
      ["/steps/1/when/equals", "condition_operand_type"],
    ]);
    expect(when({ equals: ["{{work.summary}}", true] })).toEqual([
      ["/steps/1/when/equals", "condition_operand_type"],
    ]);
    expect(when({ equals: ["{{work.commits}}", "x"] })).toEqual([
      ["/steps/1/when/equals", "condition_operand_type"],
    ]);
  });

  // #833-M1-T105
  it("takes exactly two operands in a comparison", () => {
    expect(when({ equals: ["a"] })).toEqual([
      ["/steps/1/when/equals", "invalid_value"],
    ]);
    expect(when({ equals: "a" })).toEqual([
      ["/steps/1/when/equals", "wrong_type"],
    ]);
    expect(when({ equals: [{}, "a"] })).toEqual([
      ["/steps/1/when/equals/0", "wrong_type"],
    ]);
  });

  // #833-M1-T106
  it("takes one operator per condition and names the operators", () => {
    expect(when({})).toEqual([["/steps/1/when", "missing_field"]]);
    expect(
      when({ empty: "{{work.commits}}", notEmpty: "{{work.commits}}" }),
    ).toEqual([["/steps/1/when", "invalid_value"]]);
    const bad = run(
      withStep({
        id: "gate",
        kind: "if",
        when: { greater: [1, 2] },
        then: [{ ...COMMENT, id: "a" }],
      }),
    );
    expect(bad.errors).toEqual([
      expect.objectContaining({
        path: "/steps/1/when/greater",
        code: "unknown_field",
        available: [
          "empty",
          "notEmpty",
          "equals",
          "notEquals",
          "all",
          "any",
          "not",
        ],
      }),
    ]);
    expect(when("yes")).toEqual([["/steps/1/when", "wrong_type"]]);
  });

  // #833-M1-T107
  it("combines conditions with all, any and not, and checks inside", () => {
    expect(
      when({
        any: [
          { empty: "{{work.commits}}" },
          { not: { equals: ["{{work.summary}}", "x"] } },
        ],
      }),
    ).toEqual([]);
    expect(when({ all: [] })).toEqual([["/steps/1/when/all", "invalid_value"]]);
    expect(when({ all: [{ empty: "{{ghost.x}}" }] })).toEqual([
      ["/steps/1/when/all/0/empty", "reference_unknown_step"],
    ]);
  });

  // #833-M1-T108
  it("limits how deep conditions nest", () => {
    const nested = (levels: number): unknown => {
      let condition: unknown = { empty: "{{work.commits}}" };
      for (let i = 0; i < levels; i++) condition = { not: condition };
      return condition;
    };

    expect(when(nested(3))).toEqual([]);
    expect(when(nested(4))).toEqual([
      ["/steps/1/when/not/not/not/not", "nesting_too_deep"],
    ]);
  });

  // #833-M1-T109
  it("needs a condition and a then-branch in an if, and an else-branch is optional", () => {
    expect(
      codes(
        withStep({ id: "gate", kind: "if", then: [{ ...COMMENT, id: "a" }] }),
      ),
    ).toEqual([["/steps/1/when", "missing_field"]]);
    expect(
      codes(
        withStep({
          id: "gate",
          kind: "if",
          when: { empty: "{{work.commits}}" },
        }),
      ),
    ).toEqual([["/steps/1/then", "missing_field"]]);
    expect(
      codes(
        withStep({
          id: "gate",
          kind: "if",
          when: { empty: "{{work.commits}}" },
          then: [],
        }),
      ),
    ).toEqual([["/steps/1/then", "invalid_value"]]);
  });
});

describe("the turn time limit", () => {
  // #918-T01
  it("falls back to 60 minutes when the workflow names none, and says so", () => {
    expect(run(tiny()).turnTimeLimitMinutes).toBe(60);
    expect(
      run(change(tiny(), (d) => (d.turnTimeLimitMinutes = 15)))
        .turnTimeLimitMinutes,
    ).toBe(15);
    expect(
      run(change(tiny(), (d) => (d.turnTimeLimitMinutes = 120)))
        .turnTimeLimitMinutes,
    ).toBe(120);
  });

  // #918-T02
  it("refuses a limit out of 15 to 120 or not a whole number as invalid_value", () => {
    for (const value of [14, 121, 0, -5, 30.5])
      expect(
        codes(change(tiny(), (d) => (d.turnTimeLimitMinutes = value))),
      ).toEqual([["/turnTimeLimitMinutes", "invalid_value"]]);
    expect(
      run(change(tiny(), (d) => (d.turnTimeLimitMinutes = 14))).errors[0]
        ?.message,
    ).toContain("15 to 120");
  });

  // #918-T03
  it("refuses a limit that is not a number", () => {
    expect(
      codes(change(tiny(), (d) => (d.turnTimeLimitMinutes = "60"))),
    ).toEqual([["/turnTimeLimitMinutes", "wrong_type"]]);
  });
});

describe("the budget", () => {
  // #833-M1-T110
  it("falls back to 20 USD when the workflow names none, and says so", () => {
    expect(run(tiny()).budgetUsd).toBe(20);
    expect(run(change(tiny(), (d) => (d.budgetUsd = 7.5))).budgetUsd).toBe(7.5);
  });

  // #833-M1-T111
  it("refuses a budget of zero or less, and one that is not a number", () => {
    expect(codes(change(tiny(), (d) => (d.budgetUsd = 0)))).toEqual([
      ["/budgetUsd", "invalid_value"],
    ]);
    expect(codes(change(tiny(), (d) => (d.budgetUsd = -1)))).toEqual([
      ["/budgetUsd", "invalid_value"],
    ]);
    expect(codes(change(tiny(), (d) => (d.budgetUsd = "20")))).toEqual([
      ["/budgetUsd", "wrong_type"],
    ]);
  });

  // #833-M1-T112
  it("holds the budget to the operator's maximum, which is passed in", () => {
    const doc = change(tiny(), (d) => (d.budgetUsd = 50));

    expect(codes(doc, { maxBudgetUsd: 40 })).toEqual([
      ["/budgetUsd", "budget_above_maximum"],
    ]);
    expect(run(doc, { maxBudgetUsd: 40 }).errors[0]?.message).toContain("40");
    expect(codes(doc, { maxBudgetUsd: 50 })).toEqual([]);
    expect(codes(change(tiny(), (d) => (d.budgetUsd = 101)))).toEqual([
      ["/budgetUsd", "budget_above_maximum"],
    ]);
  });
});

describe("the branch an agent step starts from (#846)", () => {
  const reviewer = (extra: Json): Json => ({
    id: "look",
    kind: "agent",
    profile: "reviewer",
    environment: "node",
    session: "new",
    instruction: "look",
    result: {
      type: "object",
      required: ["verdict"],
      properties: { verdict: { type: "string" } },
    },
    ...extra,
  });
  const after = (extra: Json): Json => withStep(reviewer(extra));

  // #846-T64
  it("takes a literal, an input of the trigger or the branch of an earlier agent step that may push", () => {
    for (const branch of [
      "release/1",
      "{{work.branch}}",
      "{{trigger.input.repo}}",
    ])
      expect(codes(after({ branch }))).toEqual([]);
  });

  // #846-T65
  it("refuses a branch that is text an agent wrote, text around a reference or a value of another kind", () => {
    const refused = (branch: unknown) => codes(after({ branch }));

    expect(refused("{{work.summary}}")).toEqual([
      ["/steps/1/branch", "target_from_untrusted_value"],
    ]);
    expect(refused("x/{{work.branch}}")).toEqual([
      ["/steps/1/branch", "target_from_untrusted_value"],
    ]);
    expect(refused('{{work.branch | default "main"}}')).toEqual([]);
    expect(refused(7)).toEqual([["/steps/1/branch", "wrong_type"]]);
    expect(refused("  ")).toEqual([["/steps/1/branch", "invalid_value"]]);
  });

  // #846-T66
  it("takes no branch of a step that may not push, nor of one that is not certain to have run", () => {
    const gate = (inner: Json): Json => ({
      id: "gate",
      kind: "if",
      when: { notEmpty: "{{trigger.input.repo}}" },
      then: [inner],
    });
    const pushing = (id: string): Json => ({
      id,
      kind: "agent",
      profile: "implementer",
      environment: "node",
      instruction: "go",
    });
    const read = withStep(reviewer({ id: "first" }));
    const readThenAsk = change(read, (d) =>
      agentSteps(d).push(
        reviewer({ id: "second", branch: "{{first.branch}}" }),
      ),
    );
    const branched = change(withStep(gate(pushing("inner"))), (d) =>
      agentSteps(d).push(reviewer({ id: "late", branch: "{{inner.branch}}" })),
    );

    expect(codes(readThenAsk)).toEqual([
      ["/steps/2/branch", "reference_fact_unavailable"],
    ]);
    expect(codes(branched)).toEqual([
      ["/steps/2/branch", "reference_not_in_scope"],
    ]);
  });

  // #846-T67
  it("is not for a step that goes on in a session: that session keeps its branch", () => {
    expect(
      codes(
        withStep({
          id: "more",
          kind: "agent",
          profile: "implementer",
          environment: "node",
          instruction: "go on",
          session: { continue: "work" },
          branch: "{{work.branch}}",
        }),
      ),
    ).toEqual([["/steps/1/branch", "session_target_invalid"]]);
  });
});
