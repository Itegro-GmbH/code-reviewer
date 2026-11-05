// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  DESCRIPTION_MAX_LENGTH,
  INSTRUCTIONS_MAX_LENGTH,
  PROFILE_NAME_PATTERN,
} from "./limits.ts";
import { validateProfile } from "./validate.ts";

const FINDINGS = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
  },
};

function profile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "implementer",
    model: { entryId: "entry-1" },
    canPush: true,
    ...extra,
  };
}

function problems(body: unknown): Array<[string, string]> {
  return validateProfile(body).errors.map((e) => [e.path, e.code]);
}

describe("a profile document", () => {
  // #843-T01
  it("accepts the smallest profile and fills in what is left out", () => {
    const result = validateProfile(profile());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.profile).toEqual({
      name: "implementer",
      description: "",
      model: { entryId: "entry-1" },
      instructions: "",
      costLimitCents: null,
      canPush: true,
      defaultResult: null,
      harness: "opencode",
    });
  });

  // #843-T02
  it("accepts every field, on the workspace's own key too", () => {
    const result = validateProfile(
      profile({
        name: "reviewer-2",
        description: "Reads a branch and reports findings.",
        model: { provider: "anthropic", model: "claude-sonnet-5-5" },
        instructions: "Review the branch.\n\tDo not edit files.",
        costLimitCents: 250,
        canPush: false,
        defaultResult: FINDINGS,
      }),
    );
    expect(result.errors).toEqual([]);
    expect(result.profile).toMatchObject({
      name: "reviewer-2",
      model: { provider: "anthropic", model: "claude-sonnet-5-5" },
      costLimitCents: 250,
      canPush: false,
      defaultResult: FINDINGS,
    });
  });

  // #843-T03
  it("names the fields that are required", () => {
    expect(problems({})).toEqual([
      ["", "missing_field"],
      ["", "missing_field"],
      ["", "missing_field"],
    ]);
    const messages = validateProfile({}).errors.map((e) => e.message);
    expect(messages.join(" ")).toMatch(/name/);
    expect(messages.join(" ")).toMatch(/model/);
    expect(messages.join(" ")).toMatch(/canPush/);
  });

  // #843-T04
  it("refuses a body that is not an object", () => {
    for (const body of [null, "x", 3, [], true])
      expect(problems(body)).toEqual([["", "wrong_type"]]);
  });

  // #854-T194
  it("takes the harness opencode, or none, as OpenCode and refuses a name that is no harness", () => {
    const named = validateProfile(profile({ harness: "opencode" }));
    const none = validateProfile(profile({ harness: undefined }));
    expect(named.profile?.harness).toBe("opencode");
    expect(none.profile?.harness).toBe("opencode");

    const other = validateProfile(profile({ harness: "codex" }));
    const notText = validateProfile(profile({ harness: 3 }));

    expect(other.errors).toEqual([
      expect.objectContaining({
        path: "/harness",
        code: "invalid_value",
        available: ["opencode", "claude-code"],
      }),
    ]);
    expect(notText.errors).toEqual([
      expect.objectContaining({ path: "/harness", code: "wrong_type" }),
    ]);
  });

  // #856-T40
  it("takes the harness claude-code with a Claude Code model name", () => {
    const result = validateProfile(
      profile({
        harness: "claude-code",
        model: { provider: "claude-code", model: "claude-sonnet-5-5" },
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.profile).toEqual(
      expect.objectContaining({
        harness: "claude-code",
        model: { provider: "claude-code", model: "claude-sonnet-5-5" },
      }),
    );
  });

  // #856-T40
  it("refuses a model on the harness claude-code that is not a Claude Code model name", () => {
    for (const model of [
      { entryId: "e-1" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "claude-code", model: "--dangerously-skip-permissions" },
      { provider: "claude-code", model: "a b" },
      { provider: "claude-code", model: "x".repeat(101) },
    ])
      expect(
        problems(profile({ harness: "claude-code", model })),
        JSON.stringify(model),
      ).toEqual([["/model", "invalid_value"]]);
  });

  // #856-T40
  it("keeps the provider claude-code for the harness of that name", () => {
    expect(
      problems(
        profile({ model: { provider: "claude-code", model: "sonnet" } }),
      ),
    ).toEqual([["/model", "invalid_value"]]);
  });

  // #843-T05
  it("refuses a field the format does not have and lists those that exist", () => {
    const result = validateProfile(profile({ push: true }));
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/push",
        code: "unknown_field",
        available: [
          "name",
          "description",
          "model",
          "instructions",
          "costLimitCents",
          "canPush",
          "defaultResult",
          "harness",
        ],
      }),
    ]);
  });

  // #843-T06
  it("holds a name to the shape a workflow can refer to", () => {
    expect(PROFILE_NAME_PATTERN.test("implementer")).toBe(true);
    for (const name of ["Implementer", "", "-a", "a b", "x".repeat(65), "ä"])
      expect(problems(profile({ name }))).toEqual([["/name", "invalid_value"]]);
    expect(problems(profile({ name: 3 }))).toEqual([["/name", "wrong_type"]]);
    expect(validateProfile(profile({ name: "x".repeat(64) })).valid).toBe(true);
  });

  // #843-T07
  it("accepts exactly the two shapes of a model choice", () => {
    expect(problems(profile({ model: { entryId: "" } }))).toEqual([
      ["/model", "invalid_value"],
    ]);
    expect(problems(profile({ model: { provider: "openai" } }))).toEqual([
      ["/model", "invalid_value"],
    ]);
    expect(
      problems(profile({ model: { entryId: "e", provider: "p", model: "m" } })),
    ).toEqual([["/model", "invalid_value"]]);
    expect(problems(profile({ model: "gpt" }))).toEqual([
      ["/model", "wrong_type"],
    ]);
    expect(problems(profile({ model: { entryId: "a\nb" } }))).toEqual([
      ["/model", "invalid_value"],
    ]);
    expect(problems(profile({ model: { entryId: "x".repeat(201) } }))).toEqual([
      ["/model", "invalid_value"],
    ]);
  });

  // #843-T08
  it("bounds the cost limit like the form does and accepts null for none", () => {
    expect(validateProfile(profile({ costLimitCents: null })).valid).toBe(true);
    expect(validateProfile(profile({ costLimitCents: 1 })).valid).toBe(true);
    expect(validateProfile(profile({ costLimitCents: 10_000 })).valid).toBe(
      true,
    );
    for (const costLimitCents of [0, -5, 10_001, 1.5])
      expect(problems(profile({ costLimitCents }))).toEqual([
        ["/costLimitCents", "invalid_value"],
      ]);
    expect(problems(profile({ costLimitCents: "5" }))).toEqual([
      ["/costLimitCents", "wrong_type"],
    ]);
  });

  // #843-T09
  it("takes the push right as a boolean and nothing else", () => {
    for (const canPush of ["yes", 1, null])
      expect(problems(profile({ canPush }))).toEqual([
        ["/canPush", "wrong_type"],
      ]);
    expect(validateProfile(profile({ canPush: false })).profile?.canPush).toBe(
      false,
    );
  });

  // #843-T10
  it("bounds the instructions and the description in characters", () => {
    expect(
      validateProfile(
        profile({ instructions: "é".repeat(INSTRUCTIONS_MAX_LENGTH) }),
      ).valid,
    ).toBe(true);
    expect(
      problems(
        profile({ instructions: "x".repeat(INSTRUCTIONS_MAX_LENGTH + 1) }),
      ),
    ).toEqual([["/instructions", "limit_exceeded"]]);
    expect(
      problems(
        profile({ description: "x".repeat(DESCRIPTION_MAX_LENGTH + 1) }),
      ),
    ).toEqual([["/description", "limit_exceeded"]]);
    // Characters, not UTF-16 units: an emoji is one.
    expect(
      validateProfile(
        profile({ description: "😀".repeat(DESCRIPTION_MAX_LENGTH) }),
      ).valid,
    ).toBe(true);
    expect(problems(profile({ instructions: 4 }))).toEqual([
      ["/instructions", "wrong_type"],
    ]);
  });

  // #843-T137
  it("refuses instructions that are only white space: the text would be a heading over nothing", () => {
    for (const text of ["   ", "\n", " \t\r\n "])
      expect(problems(profile({ instructions: text }))).toEqual([
        ["/instructions", "invalid_value"],
      ]);
    expect(validateProfile(profile({ instructions: "" })).valid).toBe(true);
    expect(validateProfile(profile({ instructions: " a " })).valid).toBe(true);
    // The description may be anything the text rules allow.
    expect(validateProfile(profile({ description: "  " })).valid).toBe(true);
  });

  // #843-T11
  it("refuses control characters and lone surrogates in the texts, but not tabs and line breaks", () => {
    expect(validateProfile(profile({ instructions: "a\r\nb\tc" })).valid).toBe(
      true,
    );
    for (const text of ["a\u0000b", "a\u001bb", "a\ud800b", "a\udc00b"]) {
      expect(problems(profile({ instructions: text }))).toEqual([
        ["/instructions", "invalid_value"],
      ]);
      expect(problems(profile({ description: text }))).toEqual([
        ["/description", "invalid_value"],
      ]);
    }
  });

  // #843-T12
  it("checks the default result schema with the validator of the workflow format and points into it", () => {
    expect(validateProfile(profile({ defaultResult: FINDINGS })).valid).toBe(
      true,
    );
    const result = validateProfile(
      profile({
        defaultResult: {
          type: "object",
          properties: { a: { type: "set" } },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path.startsWith("/defaultResult/")).toBe(true);
    expect(problems(profile({ defaultResult: "no" }))).toEqual([
      ["/defaultResult", "wrong_type"],
    ]);
    expect(problems(profile({ defaultResult: { type: "array" } }))).toEqual([
      ["/defaultResult/type", "invalid_value"],
    ]);
  });

  // #844-T270
  it("refuses a default result field that is named like a fact of the platform, as a step's own result does", () => {
    const schema = (names: string[]) => ({
      type: "object",
      properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])),
    });

    expect(
      problems(
        profile({ defaultResult: schema(["branch", "summary", "costUsd"]) }),
      ),
    ).toEqual([
      ["/defaultResult/properties/branch", "result_field_reserved"],
      ["/defaultResult/properties/costUsd", "result_field_reserved"],
    ]);
    expect(
      validateProfile(profile({ defaultResult: schema(["summary"]) })).valid,
    ).toBe(true);
  });

  // #843-T13
  it("takes null for the optional fields as left out", () => {
    const result = validateProfile(
      profile({ description: null, instructions: null, defaultResult: null }),
    );
    expect(result.errors).toEqual([]);
    expect(result.profile).toMatchObject({
      description: "",
      instructions: "",
      defaultResult: null,
    });
  });

  // #843-T14
  it("reports every problem at once, in document order, and never throws", () => {
    const result = validateProfile({
      name: "Bad Name",
      model: 3,
      canPush: "x",
      costLimitCents: 0,
      extra: 1,
    });
    expect(result.errors.map((e) => e.path)).toEqual([
      "/canPush",
      "/costLimitCents",
      "/extra",
      "/model",
      "/name",
    ]);
    for (const junk of [undefined, Symbol.iterator, () => 1, BigInt(10)])
      expect(() => validateProfile(junk)).not.toThrow();
  });

  // #843-T15
  it("does not repeat a long value in a message", () => {
    const result = validateProfile(profile({ name: "N".repeat(5000) }));
    expect(JSON.stringify(result.errors).length).toBeLessThan(2000);
  });
});
