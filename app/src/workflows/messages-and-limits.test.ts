// SPDX-License-Identifier: LicenseRef-Proprietary

// What the validator says and how it counts (#833): a message repeats at most a name of what the user wrote, lengths are counted in
// characters (code points) as the JSON Schema counts them, the list of errors is bounded, and a text that is not exactly one
// reference is not taken where a reference is wanted.
import { describe, expect, it } from "vitest";
import { ERRORS_MAX } from "./limits.ts";
import { FAKE_RESOLVER, issueToPr, tiny } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

function run(document: unknown) {
  return validateWorkflow(document, FAKE_RESOLVER);
}

function codes(document: unknown): string[][] {
  return run(document).errors.map((e) => [e.path, e.code]);
}

function change(base: Json, edit: (document: Json) => void): Json {
  const copy = structuredClone(base);
  edit(copy);
  return copy;
}

const steps = (document: Json): Json[] => document.steps as Json[];
const work = (document: Json): Json => steps(document)[0] as Json;
const COMMENT: Json = {
  id: "say",
  kind: "action",
  connector: "github.issue.comment",
  issue: 1,
  body: "x",
};

describe("the list of errors", () => {
  // #833-M1-T330
  it("holds 200 errors at most, says so, and keeps the first ones by path", () => {
    const document = change(tiny(), (d) => {
      for (let i = 0; i < 300; i++)
        steps(d).push({ id: `s${i}`, kind: "action", connector: "nope" });
    });

    const result = run(document);

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(ERRORS_MAX);
    expect(result.truncated).toBe(true);
    expect(ERRORS_MAX).toBe(200);
    expect(result.errors[0]?.path).toBe("/steps");
  });

  // #833-M1-T331
  it("is not truncated when it fits, and when the document is valid", () => {
    expect(run(tiny()).truncated).toBe(false);
    expect(
      run(change(tiny(), (d) => delete work(d).instruction)).truncated,
    ).toBe(false);
  });
});

describe("a message repeats at most the length of a name", () => {
  const LONG = "x".repeat(5000);
  const CASES: Array<[string, (document: Json) => void]> = [
    ["a key", (d) => (work(d)[LONG] = 1)],
    ["a key of the document", (d) => (d[LONG] = 1)],
    ["a key of the trigger", (d) => ((d.trigger as Json)[LONG] = 1)],
    ["a kind", (d) => steps(d).push({ id: "a", kind: LONG })],
    ["an id", (d) => steps(d).push({ ...COMMENT, id: LONG })],
    [
      "an id that is used twice",
      (d) => steps(d).push({ ...COMMENT, id: LONG }, { ...COMMENT, id: LONG }),
    ],
    ["a profile", (d) => (work(d).profile = LONG)],
    ["an environment", (d) => (work(d).environment = LONG)],
    ["a trigger kind", (d) => (d.trigger = { kind: LONG })],
    ["a connector", (d) => steps(d).push({ ...COMMENT, connector: LONG })],
    ["a session", (d) => (work(d).session = { continue: LONG })],
    ["a step in a reference", (d) => (work(d).instruction = `{{${LONG}.x}}`)],
    [
      "an id used in a reference where it comes later",
      (d) => {
        work(d).instruction = `{{${LONG}.x}}`;
        steps(d).push({ ...COMMENT, id: LONG });
      },
    ],
    [
      "an id of an if used in a reference outside its branch",
      (d) => {
        steps(d).push({
          id: LONG,
          kind: "if",
          when: { empty: "{{trigger.input.repo}}" },
          then: [{ ...COMMENT, id: "inside" }],
        });
        steps(d).push({ ...COMMENT, id: "after", body: "{{inside.url}}" });
      },
    ],
    [
      "a field in a reference",
      (d) => (work(d).instruction = `{{work.${LONG}}}`),
    ],
    [
      "a reference that is no reference",
      (d) => (work(d).instruction = `{{${LONG} !}}`),
    ],
    [
      "a reference with a default that is no JSON",
      (d) => (work(d).instruction = `{{work.summary | default ${LONG}}}`),
    ],
    [
      "a field name of a result",
      (d) =>
        (work(d).result = {
          type: "object",
          properties: { [LONG]: { type: "string" } },
        }),
    ],
    [
      "a required name",
      (d) =>
        (work(d).result = {
          type: "object",
          required: [LONG],
          properties: { a: { type: "string" } },
        }),
    ],
    [
      "an enum value that is listed twice",
      (d) =>
        (work(d).result = {
          type: "object",
          properties: { a: { type: "string", enum: [LONG, LONG] } },
        }),
    ],
    [
      "a keyword of a result",
      (d) =>
        (work(d).result = {
          type: "object",
          properties: { a: { type: "string", [LONG]: 1 } },
        }),
    ],
    [
      "a condition operator",
      (d) =>
        steps(d).push({
          id: "g",
          kind: "if",
          when: { [LONG]: 1 },
          then: [COMMENT],
        }),
    ],
    [
      "a text compared with a choice of names",
      (d) =>
        steps(d).push({
          id: "g",
          kind: "if",
          when: { equals: ["{{work.kind}}", LONG] },
          then: [COMMENT],
        }),
    ],
    [
      "a reference where a number is wanted",
      (d) => steps(d).push({ ...COMMENT, issue: `{{work.${LONG}}}` }),
    ],
  ];

  // #833-M1-T332
  it.each(CASES)("%s", (_name, edit) => {
    const document = change(tiny(), (d) => {
      (work(d).result as Json).properties = {
        ...((work(d).result as Json).properties as Json),
        kind: { type: "string", enum: ["a", "b"] },
      };
      edit(d);
    });

    const result = run(document);

    expect(result.valid).toBe(false);
    for (const found of result.errors) {
      expect(found.message.length).toBeLessThan(1000);
      expect(found.message).not.toContain("x".repeat(200));
      for (const name of found.available ?? [])
        expect(name.length).toBeLessThanOrEqual(70);
    }
  });
});

describe("lengths are counted in characters, as the JSON Schema counts them", () => {
  const EMOJI = "\u{1F600}";

  // #833-M1-T333
  it("takes a name of 100 characters of two UTF-16 units each, and refuses 101", () => {
    expect(codes(change(tiny(), (d) => (d.name = EMOJI.repeat(100))))).toEqual(
      [],
    );
    expect(codes(change(tiny(), (d) => (d.name = EMOJI.repeat(101))))).toEqual([
      ["/name", "invalid_value"],
    ]);
  });

  // #833-M1-T334
  it("counts a description, a step description, a label and a text the same way", () => {
    expect(
      codes(change(tiny(), (d) => (d.description = EMOJI.repeat(1000)))),
    ).toEqual([]);
    expect(
      codes(change(tiny(), (d) => (d.description = EMOJI.repeat(1001)))),
    ).toEqual([["/description", "limit_exceeded"]]);
    expect(
      codes(change(tiny(), (d) => (work(d).description = EMOJI.repeat(1001)))),
    ).toEqual([["/steps/0/description", "limit_exceeded"]]);
    expect(
      codes(change(tiny(), (d) => (work(d).instruction = EMOJI.repeat(20000)))),
    ).toEqual([]);
    expect(
      codes(change(tiny(), (d) => (work(d).instruction = EMOJI.repeat(20001)))),
    ).toEqual([["/steps/0/instruction", "limit_exceeded"]]);
    expect(
      codes(
        change(
          issueToPr(),
          (d) =>
            (d.trigger = {
              kind: "github.issueLabeled",
              label: EMOJI.repeat(100),
            }),
        ),
      ),
    ).toEqual([]);
    expect(
      codes(
        change(
          issueToPr(),
          (d) =>
            (d.trigger = {
              kind: "github.issueLabeled",
              label: EMOJI.repeat(101),
            }),
        ),
      ),
    ).toEqual([["/trigger/label", "invalid_value"]]);
  });

  // #833-M1-T335
  it("counts the length of an enum value, a result description and the value of a result", () => {
    const withSchema = (properties: Json): Json =>
      change(tiny(), (d) => {
        work(d).result = { type: "object", properties };
      });

    expect(
      codes(withSchema({ a: { type: "string", enum: [EMOJI.repeat(200)] } })),
    ).toEqual([]);
    expect(
      codes(withSchema({ a: { type: "string", enum: [EMOJI.repeat(201)] } })),
    ).toEqual([["/steps/0/result/properties/a/enum/0", "invalid_value"]]);
    expect(
      codes(
        withSchema({
          a: { type: "string", description: EMOJI.repeat(501) },
        }),
      ),
    ).toEqual([["/steps/0/result/properties/a/description", "limit_exceeded"]]);
  });

  // #833-M1-T336
  it("refuses a name and a trigger label that are only spaces", () => {
    expect(codes(change(tiny(), (d) => (d.name = "   ")))).toEqual([
      ["/name", "invalid_value"],
    ]);
    expect(codes(change(tiny(), (d) => (d.name = "\t\n ")))).toEqual([
      ["/name", "invalid_value"],
    ]);
    expect(
      codes(
        change(
          issueToPr(),
          (d) => (d.trigger = { kind: "github.issueLabeled", label: "  " }),
        ),
      ),
    ).toEqual([["/trigger/label", "invalid_value"]]);
  });
});

describe("a text where something other than a text is wanted", () => {
  const labels = (extra: Json): Json =>
    change(issueToPr(), (d) =>
      steps(d).push({
        id: "tag",
        kind: "action",
        connector: "github.issue.labels",
        issue: 1,
        add: ["x"],
        ...extra,
      }),
    );

  // #833-M1-T337
  it.each([
    ["a reference that is never closed", "{{trigger.issue"],
    ["two references", "{{trigger.issue}} {{trigger.issue}}"],
    ["a reference and text", "{{trigger.issue}} x"],
    ["spaces around a reference", " {{trigger.issue}}"],
    ["a text", "seven"],
  ])(
    "refuses %s as the issue, as the form and not as a syntax error",
    (_name, issue) => {
      expect(codes(labels({ issue }))).toEqual([
        ["/steps/3/issue", "wrong_type"],
      ]);
    },
  );

  // #833-M1-T338
  it("refuses the same for a list and for true/false", () => {
    expect(codes(labels({ add: "{{trigger.issue.labels}} " }))).toEqual([
      ["/steps/3/add", "wrong_type"],
    ]);
    expect(
      codes(
        change(issueToPr(), (d) => {
          const pr = ((steps(d)[2] as Json).then as Json[])[0] as Json;
          pr.draft = "{{a}} {{b}}";
        }),
      ),
    ).toEqual([["/steps/2/then/0/draft", "wrong_type"]]);
  });

  // #833-M1-T339
  it("takes a reference with a default that holds braces", () => {
    expect(
      codes(labels({ add: '{{trigger.issue.labels | default {"a":{}}}}' })),
    ).toEqual([["/steps/3/add", "default_type_mismatch"]]);
    expect(
      codes(labels({ add: "{{trigger.issue.labels | default []}}" })),
    ).toEqual([]);
  });
});

describe("an escaped brace is part of a literal", () => {
  // #833-M1-T340
  it("compares the text without the escape with the names of a choice", () => {
    const document = (other: string): Json =>
      change(tiny(), (d) => {
        (work(d).result as Json).properties = {
          ...((work(d).result as Json).properties as Json),
          kind: { type: "string", enum: ["a", "b"] },
        };
        (work(d).result as Json).required = ["summary", "kind"];
        steps(d).push({
          id: "g",
          kind: "if",
          when: { equals: ["{{work.kind}}", other] },
          then: [COMMENT],
        });
      });

    expect(codes(document("a"))).toEqual([]);
    expect(codes(document("a\\{{x"))).toEqual([
      ["/steps/1/when/equals/1", "condition_value_not_in_enum"],
    ]);
    expect(codes(document("a {{work.summary}}"))).toEqual([]);
  });
});

describe("previous names the steps of the innermost loop body that always run", () => {
  const agent = (id: string, extra: Json = {}): Json => ({
    id,
    kind: "agent",
    profile: "implementer",
    environment: "node",
    instruction: "go",
    result: {
      type: "object",
      required: ["x"],
      properties: { x: { type: "string" } },
    },
    ...extra,
  });
  const nestedLoops = (inner: Json[]): Json =>
    change(tiny(), (d) =>
      steps(d).push({
        id: "outer",
        kind: "loop",
        maxRounds: 2,
        body: [
          agent("a"),
          {
            id: "inner",
            kind: "loop",
            maxRounds: 2,
            body: inner,
            until: { empty: "{{trigger.input.repo}}" },
          },
        ],
        until: { empty: "{{trigger.input.repo}}" },
      }),
    );

  // #833-M1-T341
  it("says that a step of an outer loop is not named, and which loop previous is about", () => {
    const result = run(
      nestedLoops([
        agent("b", { instruction: { first: "go", next: "{{previous.a.x}}" } }),
      ]),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/1/body/1/body/0/instruction/next",
        code: "previous_unknown_step",
        message: expect.stringMatching(/outer loop 'outer'.*innermost/),
      }),
    ]);
  });

  // #833-M1-T342
  it("says that a step inside an if of the body may not have run", () => {
    const result = run(
      nestedLoops([
        {
          id: "gate",
          kind: "if",
          when: { notEmpty: "{{trigger.input.repo}}" },
          then: [agent("c")],
        },
        agent("b", { instruction: { first: "go", next: "{{previous.c.x}}" } }),
      ]),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "previous_unknown_step",
        message: expect.stringMatching(/inside an if.*may not have run/),
      }),
    ]);
  });

  // #833-M1-T343
  it("says that a name is no step of the body at all", () => {
    const result = run(
      nestedLoops([
        agent("b", {
          instruction: { first: "go", next: "{{previous.zzz.x}}" },
        }),
      ]),
    );

    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "previous_unknown_step",
        message: expect.stringMatching(
          /no step of the body of the loop 'inner'/,
        ),
      }),
    ]);
  });
});
