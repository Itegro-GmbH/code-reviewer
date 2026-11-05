// SPDX-License-Identifier: LicenseRef-Proprietary

// #846: the conditions of an `if` and of the `until` of a loop, evaluated against the values of a run.
import { describe, expect, it } from "vitest";
import { ConditionError, conditionHolds } from "./conditions.ts";
import { TemplateError, type RunValues } from "./templates.ts";

const values: RunValues = {
  trigger: { issue: { number: 7, title: "Fix the cache" } },
  steps: {
    review: { findings: [{ type: "bug", name: "x", description: "y" }] },
    clean: { findings: [], note: "", count: 0, ok: true },
    fix: { exit: "until", rounds: 2 },
  },
  agentSteps: new Set(["review", "clean"]),
};

describe("the conditions of a workflow", () => {
  // #846-T50
  it("asks whether a list or a text is empty", () => {
    expect(conditionHolds({ empty: "{{clean.findings}}" }, values)).toBe(true);
    expect(conditionHolds({ empty: "{{review.findings}}" }, values)).toBe(
      false,
    );
    expect(conditionHolds({ notEmpty: "{{review.findings}}" }, values)).toBe(
      true,
    );
    expect(conditionHolds({ empty: "{{clean.note}}" }, values)).toBe(true);
    expect(
      conditionHolds({ notEmpty: "{{trigger.issue.title}}" }, values),
    ).toBe(true);
  });

  // #846-T51
  it("compares two texts, two numbers or two true/false values", () => {
    expect(conditionHolds({ equals: ["{{fix.exit}}", "until"] }, values)).toBe(
      true,
    );
    expect(
      conditionHolds({ equals: ["{{fix.exit}}", "maxRounds"] }, values),
    ).toBe(false);
    expect(
      conditionHolds({ notEquals: ["{{fix.exit}}", "maxRounds"] }, values),
    ).toBe(true);
    expect(conditionHolds({ equals: ["{{fix.rounds}}", 2] }, values)).toBe(
      true,
    );
    expect(conditionHolds({ equals: ["{{clean.ok}}", true] }, values)).toBe(
      true,
    );
    expect(conditionHolds({ equals: ["{{fix.rounds}}", 3] }, values)).toBe(
      false,
    );
  });

  // #846-T52
  it("combines conditions with all, any and not", () => {
    const until = { equals: ["{{fix.exit}}", "until"] };
    const empty = { empty: "{{review.findings}}" };
    expect(conditionHolds({ all: [until, { not: empty }] }, values)).toBe(true);
    expect(conditionHolds({ all: [until, empty] }, values)).toBe(false);
    expect(conditionHolds({ any: [empty, until] }, values)).toBe(true);
    expect(conditionHolds({ any: [empty, { not: until }] }, values)).toBe(
      false,
    );
  });

  // #846-T53
  it("takes a default for a value the run does not have, and fails without one", () => {
    expect(
      conditionHolds({ empty: "{{later.findings | default []}}" }, values),
    ).toBe(true);
    expect(() =>
      conditionHolds({ empty: "{{later.findings}}" }, values),
    ).toThrow(TemplateError);
  });

  // #846-T54
  it("reads previous.* as the value of the round before", () => {
    const round2: RunValues = {
      ...values,
      previous: { review: { findings: [] } },
    };
    expect(
      conditionHolds({ empty: "{{previous.review.findings}}" }, round2),
    ).toBe(true);
    expect(
      conditionHolds(
        { empty: "{{previous.review.findings | default [1]}}" },
        values,
      ),
    ).toBe(false);
  });

  // #846-T55
  it("never reads a value as a template: braces in a result compare as the text they are", () => {
    const tricky: RunValues = {
      trigger: { secret: "leaked" },
      steps: { review: { verdict: "{{trigger.secret}}" } },
      agentSteps: new Set(["review"]),
    };
    expect(
      conditionHolds({ equals: ["{{review.verdict}}", "leaked"] }, tricky),
    ).toBe(false);
    expect(
      conditionHolds(
        { equals: ["{{review.verdict}}", "{{review.verdict}}"] },
        tricky,
      ),
    ).toBe(true);
    expect(conditionHolds({ notEmpty: "{{review.verdict}}" }, tricky)).toBe(
      true,
    );
  });

  // #846-T56
  it("refuses what is not a condition", () => {
    for (const bad of [
      null,
      "yes",
      {},
      { empty: "a", notEmpty: "b" },
      { equals: ["a"] },
      { all: [] },
      { any: "x" },
      { sometimes: [] },
      { empty: "{{fix.rounds}}" },
      { equals: [{}, 1] },
    ])
      expect(() => conditionHolds(bad, values)).toThrow();
    expect(() => conditionHolds({ empty: 3 }, values)).toThrow(ConditionError);
  });

  // #846-T57
  it("stops at the nesting the format allows", () => {
    let nested: unknown = { empty: "{{clean.findings}}" };
    for (let i = 0; i < 8; i += 1) nested = { not: nested };
    expect(() => conditionHolds(nested, values)).toThrow(ConditionError);
  });
});
