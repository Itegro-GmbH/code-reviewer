// SPDX-License-Identifier: LicenseRef-Proprietary

// A document is untrusted and may be 256 KB of nesting (#833): no walk of the validator may recurse without a bound, because a
// RangeError would be a 500 instead of a list of problems. Every walk gets an input far deeper than its limit.
import { describe, expect, it } from "vitest";
import { FAKE_RESOLVER, tiny } from "./test-fixtures.ts";
import { validateResultSchema } from "./result-schema.ts";
import { parseTemplate } from "./template.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const DEPTH = 5000;

const LEAF: Json = {
  id: "leaf",
  kind: "action",
  connector: "github.issue.comment",
  issue: 1,
  body: "x",
};

function run(document: unknown) {
  return validateWorkflow(document, FAKE_RESOLVER);
}

function codesOf(document: unknown): string[] {
  return [...new Set(run(document).errors.map((e) => e.code))];
}

/** `levels` nodes of one kind, each holding the next, built from the inside out (no recursion in the test either). */
function nested(kind: "if" | "loop", levels: number): Json {
  let inner: Json = LEAF;
  for (let level = levels; level >= 1; level--)
    inner =
      kind === "if"
        ? {
            id: `n${level}`,
            kind: "if",
            when: { empty: "{{trigger.input.repo}}" },
            then: [inner],
          }
        : {
            id: `n${level}`,
            kind: "loop",
            maxRounds: 1,
            body: [inner],
            until: { empty: "{{trigger.input.repo}}" },
          };
  return inner;
}

function withSteps(steps: unknown[]): Json {
  return { ...tiny(), steps };
}

describe("a document nested far beyond its limits", () => {
  // #833-M1-T250
  it.each(["if", "loop"] as const)(
    "is refused with nesting_too_deep when %s is nested 5000 deep",
    (kind) => {
      const result = run(withSteps([nested(kind, DEPTH)]));

      expect(result.valid).toBe(false);
      expect(result.errors.map((e) => e.code)).toContain("nesting_too_deep");
    },
  );

  // #833-M1-T251
  it("is refused when if and loop alternate 5000 deep, and the steps are counted up to the bound", () => {
    let inner: Json = LEAF;
    for (let level = DEPTH; level >= 1; level--)
      inner =
        level % 2 === 0
          ? {
              id: `n${level}`,
              kind: "if",
              when: { empty: "{{trigger.input.repo}}" },
              then: [inner],
            }
          : {
              id: `n${level}`,
              kind: "loop",
              maxRounds: 1,
              body: [inner],
              until: { empty: "{{trigger.input.repo}}" },
            };

    expect(codesOf(withSteps([inner]))).toContain("nesting_too_deep");
  });

  // #833-M1-T252
  it("is refused when both branches of an if are 5000 deep", () => {
    const deep = nested("if", DEPTH);
    const document = withSteps([
      {
        id: "top",
        kind: "if",
        when: { empty: "{{trigger.input.repo}}" },
        then: [deep],
        else: [{ ...deep, id: "other" }],
      },
    ]);

    expect(codesOf(document)).toContain("nesting_too_deep");
  });

  // #833-M1-T253
  it("is refused when a condition is nested 5000 deep", () => {
    let when: Json = { empty: "{{trigger.input.repo}}" };
    for (let level = 0; level < DEPTH; level++) when = { not: when };

    const document = withSteps([
      { id: "gate", kind: "if", when, then: [LEAF] },
    ]);

    expect(codesOf(document)).toContain("nesting_too_deep");
  });

  // #833-M1-T254
  it.each(["object", "array"] as const)(
    "is refused when a result schema is nested 5000 deep through %s",
    (through) => {
      let schema: Json = { type: "string" };
      for (let level = 0; level < DEPTH; level++)
        schema =
          through === "object"
            ? { type: "object", properties: { a: schema } }
            : { type: "array", items: schema };
      const root: Json = {
        type: "object",
        properties: { deep: schema },
      };

      expect(validateResultSchema(root).issues.map((i) => i.code)).toContain(
        "nesting_too_deep",
      );
      const agent = {
        id: "work",
        kind: "agent",
        profile: "implementer",
        environment: "node",
        instruction: "x",
        result: root,
      };
      expect(codesOf(withSteps([agent, LEAF]))).toContain("nesting_too_deep");
      const trigger = { ...tiny(), trigger: { kind: "manual", input: root } };
      expect(codesOf(trigger)).toContain("nesting_too_deep");
    },
  );

  // #833-M1-T255
  it("is refused when a value in an input is nested 5000 deep", () => {
    let list: unknown = "x";
    let object: unknown = 1;
    for (let level = 0; level < DEPTH; level++) {
      list = [list];
      object = { number: object };
    }
    const labels = {
      id: "tag",
      kind: "action",
      connector: "github.issue.labels",
      issue: 1,
      add: list,
    };
    const comment = { ...LEAF, issue: object };

    expect(codesOf(withSteps([labels]))).not.toEqual([]);
    expect(codesOf(withSteps([comment]))).not.toEqual([]);
  });

  // #833-M1-T256
  it("is refused when a reserved step carries a field 5000 deep", () => {
    let value: unknown = 1;
    for (let level = 0; level < DEPTH; level++) value = { a: value };

    const document = withSteps([{ id: "each", kind: "forEach", items: value }]);

    expect(codesOf(document)).toEqual(["kind_not_supported"]);
  });

  // #833-M1-T257
  it("parses a text with 20000 characters of braces and quotes in linear time", () => {
    for (const piece of ['{{"', "{{{{", "}}}}", '{{a | default {"', "{{a|"]) {
      const text = piece.repeat(Math.floor(20_000 / piece.length));
      const started = Date.now();

      const parsed = parseTemplate(text);
      const result = run(withSteps([{ ...LEAF, body: text }]));

      expect(Array.isArray(parsed.problems)).toBe(true);
      expect(result.valid).toBe(false);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });
});
