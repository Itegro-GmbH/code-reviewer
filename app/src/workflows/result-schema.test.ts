// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { ECHO_MAX_LENGTH } from "./issues.ts";
import {
  ERRORS_COLLECT_MAX,
  ERRORS_MAX,
  NAMES_LISTED_MAX,
  RESULT_PROPERTIES_MAX,
} from "./limits.ts";
import {
  checkResultValue,
  objectTypeOf,
  validateResultSchema,
  type ResultSchema,
} from "./result-schema.ts";

const FINDINGS: ResultSchema = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["type", "name"],
        properties: {
          type: { type: "string", enum: ["bug", "risk", "nit"] },
          name: { type: "string", maxLength: 120 },
          description: { type: "string" },
        },
      },
    },
  },
};

function codes(value: unknown) {
  return validateResultSchema(value).issues.map((i) => [i.path, i.code]);
}

describe("validateResultSchema", () => {
  // #833-M1-T01
  it("accepts a schema with every kind of field", () => {
    const result = validateResultSchema(FINDINGS);

    expect(result.issues).toEqual([]);
    expect(result.schema).toBe(FINDINGS);
  });

  // #833-M1-T02
  it("tells what a schema is when it is not an object", () => {
    expect(codes([])).toEqual([["", "wrong_type"]]);
    expect(codes({ type: "string" })).toEqual([["/type", "invalid_value"]]);
    expect(codes({ properties: { a: { type: "string" } } })).toEqual([
      ["/type", "missing_field"],
    ]);
  });

  // #833-M1-T03
  it("names the types that exist when one does not", () => {
    const { issues } = validateResultSchema({
      type: "object",
      properties: { tags: { type: "list" }, n: { type: "float" } },
    });

    expect(issues.map((i) => i.path)).toEqual([
      "/properties/n/type",
      "/properties/tags/type",
    ]);
    expect(issues[1]?.available).toEqual([
      "string",
      "number",
      "integer",
      "boolean",
      "array",
      "object",
    ]);
    expect(issues[1]?.message).toContain("'array'");
  });

  // #833-M1-T04
  it("refuses a keyword the type does not have, and says which it has", () => {
    const { issues } = validateResultSchema({
      type: "object",
      properties: { a: { type: "number", maxLength: 3 } },
    });

    expect(issues).toEqual([
      expect.objectContaining({
        path: "/properties/a/maxLength",
        code: "unknown_field",
        available: ["type", "description"],
      }),
    ]);
  });

  // #833-M1-T05
  it("checks the caps: whole, positive and below the format's maximum", () => {
    expect(
      codes({
        type: "object",
        properties: {
          a: { type: "string", maxLength: 0 },
          b: { type: "string", maxLength: 100001 },
          c: { type: "string", maxLength: 1.5 },
          d: { type: "array", items: { type: "string" }, maxItems: 1001 },
        },
      }),
    ).toEqual([
      ["/properties/a/maxLength", "invalid_value"],
      ["/properties/b/maxLength", "limit_exceeded"],
      ["/properties/c/maxLength", "wrong_type"],
      ["/properties/d/maxItems", "limit_exceeded"],
    ]);
  });

  // #833-M1-T06
  it("checks enum values: strings, no duplicates, not empty", () => {
    expect(
      codes({
        type: "object",
        properties: {
          a: { type: "string", enum: [] },
          b: { type: "string", enum: ["x", "x", 3] },
        },
      }),
    ).toEqual([
      ["/properties/a/enum", "invalid_value"],
      ["/properties/b/enum/1", "invalid_value"],
      ["/properties/b/enum/2", "wrong_type"],
    ]);
  });

  // #833-M1-T07
  it("checks that required names are properties", () => {
    const { issues } = validateResultSchema({
      type: "object",
      required: ["a", "z"],
      properties: { a: { type: "string" } },
    });

    expect(issues).toEqual([
      expect.objectContaining({
        path: "/required/1",
        code: "required_field_unknown",
        available: ["a"],
      }),
    ]);
  });

  // #833-M1-T07a
  it("reports a name listed twice in required also when it is no property: the schema says uniqueItems", () => {
    const { issues } = validateResultSchema({
      type: "object",
      required: ["ghost", "ghost"],
      properties: { a: { type: "string" } },
    });

    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["/required/0", "required_field_unknown"],
      ["/required/1", "invalid_value"],
    ]);
  });

  // #833-M1-T07b
  it("stops collecting problems at the cap and says so", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [`p${i}`, 1]),
    );

    const cut = validateResultSchema({ type: "object", properties });
    const whole = validateResultSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "b"],
    });

    expect(cut.issues.length).toBeLessThanOrEqual(ERRORS_COLLECT_MAX);
    expect(cut.issues.length).toBeGreaterThan(ERRORS_MAX);
    expect(cut.truncated).toBe(true);
    expect(cut.schema).toBeUndefined();
    expect(whole.truncated).toBe(false);
  });

  // #833-M1-T07c
  it("does not look at required when the object has more fields than it may have", () => {
    const properties = Object.fromEntries(
      Array.from({ length: RESULT_PROPERTIES_MAX + 1 }, (_, i) => [
        `p${i}`,
        { type: "string" },
      ]),
    );

    const { issues } = validateResultSchema({
      type: "object",
      properties,
      required: ["ghost", 3],
    });

    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["/properties", "limit_exceeded"],
    ]);
  });

  // #833-M1-T07d
  it("lists a few of the names a required entry could have been, each cut to the length of a name", () => {
    const long = "n".repeat(60);
    const properties = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`${long}${i}`, { type: "string" }]),
    );

    const { issues } = validateResultSchema({
      type: "object",
      properties,
      required: ["ghost"],
    });

    expect(issues).toHaveLength(1);
    expect(issues[0]?.available).toHaveLength(NAMES_LISTED_MAX);
    for (const name of issues[0]?.available ?? [])
      expect(Array.from(name).length).toBeLessThanOrEqual(ECHO_MAX_LENGTH + 1);
  });

  // #833-M1-T08
  it("refuses an object without properties, an open object, and a bad field name", () => {
    expect(
      codes({
        type: "object",
        properties: {
          a: { type: "object" },
          b: { type: "object", properties: {}, additionalProperties: true },
        },
      }),
    ).toEqual([
      ["/properties/a/properties", "missing_field"],
      ["/properties/b/additionalProperties", "invalid_value"],
      ["/properties/b/properties", "invalid_value"],
    ]);
    expect(
      codes({ type: "object", properties: { "a b": { type: "string" } } }),
    ).toEqual([["/properties/a b", "invalid_value"]]);
  });

  // #833-M1-T09
  it("refuses an array without items", () => {
    expect(
      codes({ type: "object", properties: { a: { type: "array" } } }),
    ).toEqual([["/properties/a/items", "missing_field"]]);
  });

  // #833-M1-T10
  it("limits the levels and the number of fields", () => {
    const deep = {
      type: "object",
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: {
                c: {
                  type: "object",
                  properties: {
                    d: {
                      type: "object",
                      properties: { e: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    expect(codes(deep)).toEqual([
      [
        "/properties/a/properties/b/properties/c/properties/d",
        "nesting_too_deep",
      ],
    ]);

    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 3 }, (_, g) => [
          `g${g}`,
          {
            type: "object",
            properties: Object.fromEntries(
              Array.from({ length: 40 }, (_, i) => [
                `f${i}`,
                { type: "string" },
              ]),
            ),
          },
        ]),
      ),
    };
    expect(codes(wide)).toEqual([["", "result_schema_too_large"]]);
  });
});

describe("objectTypeOf", () => {
  // #833-M1-T11
  it("describes a result for the references that follow", () => {
    expect(objectTypeOf(FINDINGS)).toEqual({
      kind: "object",
      fields: {
        findings: {
          required: true,
          type: {
            kind: "list",
            items: {
              kind: "object",
              fields: {
                type: {
                  required: true,
                  type: { kind: "enum", values: ["bug", "risk", "nit"] },
                },
                name: { required: true, type: { kind: "string" } },
                description: { required: false, type: { kind: "string" } },
              },
            },
          },
        },
      },
    });
  });
});

describe("checkResultValue", () => {
  // #833-M1-T12
  it("accepts a result of the declared shape", () => {
    expect(
      checkResultValue(FINDINGS, {
        findings: [{ type: "bug", name: "Lease", description: "x" }],
      }),
    ).toEqual([]);
  });

  // #833-M1-T13
  it("lists every problem with the pointer into the value", () => {
    const issues = checkResultValue(FINDINGS, {
      findings: [
        { type: "critical", name: 3 },
        { name: "ok", extra: true },
      ],
      other: 1,
    });

    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["/findings/0/name", "wrong_type"],
      ["/findings/0/type", "invalid_value"],
      ["/findings/1/extra", "unknown_field"],
      ["/findings/1/type", "missing_field"],
      ["/other", "unknown_field"],
    ]);
    expect(issues[1]?.available).toEqual(["bug", "risk", "nit"]);
  });

  // #833-M1-T14
  it("holds a value to the caps, with defaults where the schema sets none", () => {
    const issues = checkResultValue(
      {
        type: "object",
        properties: {
          s: { type: "string" },
          l: { type: "array", items: { type: "number" } },
          t: { type: "string", maxLength: 3 },
        },
      },
      {
        s: "x".repeat(10001),
        l: Array.from({ length: 101 }, () => 1),
        t: "abcd",
      },
    );

    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["/l", "limit_exceeded"],
      ["/s", "limit_exceeded"],
      ["/t", "limit_exceeded"],
    ]);
  });

  // #833-M1-T15
  it("refuses values of the wrong JSON type, and a missing result", () => {
    const schema: ResultSchema = {
      type: "object",
      properties: {
        n: { type: "number" },
        b: { type: "boolean" },
        o: { type: "object", properties: { x: { type: "string" } } },
        a: { type: "array", items: { type: "string" } },
      },
    };

    expect(
      checkResultValue(schema, { n: "1", b: 1, o: [], a: {} }).map(
        (i) => i.code,
      ),
    ).toEqual(["wrong_type", "wrong_type", "wrong_type", "wrong_type"]);
    expect(checkResultValue(schema, null)).toEqual([
      expect.objectContaining({ path: "", code: "wrong_type" }),
    ]);
  });

  // #833-M1-T15a
  it("lists no more problems than an answer holds, however many fields the value has", () => {
    const value = Object.fromEntries(
      Array.from({ length: 50_000 }, (_, i) => [`field${i}`, i]),
    );
    const started = performance.now();

    const issues = checkResultValue(FINDINGS, value);

    expect(issues.length).toBeLessThanOrEqual(ERRORS_COLLECT_MAX);
    expect(issues.some((i) => i.code === "missing_field")).toBe(true);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("the type integer", () => {
  const schema: ResultSchema = {
    type: "object",
    required: ["n"],
    properties: { n: { type: "integer", description: "A count." } },
  };

  // #833-M1-T16
  it("is a field type of its own, with a description and nothing else", () => {
    expect(validateResultSchema(schema).issues).toEqual([]);
    expect(
      codes({
        type: "object",
        properties: { n: { type: "integer", maximum: 5 } },
      }),
    ).toEqual([["/properties/n/maximum", "unknown_field"]]);
    expect(objectTypeOf(schema).fields.n).toEqual({
      type: { kind: "integer" },
      required: true,
    });
  });

  // #833-M1-T17
  it("holds a result to a whole number a computer holds exactly", () => {
    expect(checkResultValue(schema, { n: 7 })).toEqual([]);
    expect(checkResultValue(schema, { n: -3 })).toEqual([]);
    for (const n of [1.5, "7", 9007199254740993, 1e21, null])
      expect(checkResultValue(schema, { n }).map((i) => i.code)).toEqual([
        "wrong_type",
      ]);
  });
});
