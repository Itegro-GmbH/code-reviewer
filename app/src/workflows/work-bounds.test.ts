// SPDX-License-Identifier: LicenseRef-Proprietary

// What a hostile document costs (#833): the validator stops collecting problems once it has more than it will list, a list of names in
// an answer is cut to a few names, a name in a path or a list is cut to the length of a name, and nothing below a name that is already
// refused is looked at. A document of 200 KB must not cost seconds or gigabytes, whatever it is made of.
import { describe, expect, it } from "vitest";
import { ECHO_MAX_LENGTH } from "./issues.ts";
import { ERRORS_MAX, NAMES_LISTED_MAX } from "./limits.ts";
import { FAKE_RESOLVER, tiny } from "./test-fixtures.ts";
import { validateWorkflow, type ValidationResult } from "./validate.ts";

type Json = Record<string, unknown>;

function run(document: unknown): ValidationResult {
  return validateWorkflow(document, FAKE_RESOLVER);
}

function timed(document: unknown): { result: ValidationResult; ms: number } {
  const started = performance.now();
  const result = run(document);
  return { result, ms: performance.now() - started };
}

const agentStep = (id: string): Json => ({
  id,
  kind: "agent",
  profile: "implementer",
  environment: "node",
  instruction: "Do the thing.",
});
const comment = (id: string, body: string): Json => ({
  id,
  kind: "action",
  connector: "github.issue.comment",
  issue: 1,
  body,
});

/** Thousands of steps, then a few texts that are nothing but references to a step that does not exist. */
function manyStepsManyReferences(
  count: number,
  agents: (id: string) => Json,
): Json {
  const document = tiny();
  const steps: Json[] = [];
  for (let i = 0; i < count; i++) steps.push(agents(`a${i}`));
  for (let i = 0; i < 6; i++)
    steps.push(comment(`c${i}`, "{{z}}".repeat(4000)));
  document.steps = steps;
  return document;
}

function expectSmall(result: ValidationResult): void {
  expect(result.errors.length).toBeLessThanOrEqual(ERRORS_MAX);
  expect(result.truncated).toBe(true);
  for (const found of result.errors) {
    expect(found.message.length).toBeLessThan(1000);
    expect(found.available?.length ?? 0).toBeLessThanOrEqual(NAMES_LISTED_MAX);
  }
  expect(JSON.stringify(result).length).toBeLessThan(150_000);
}

describe("the work is bounded by what the answer can hold", () => {
  // #833-M1-T340
  it.each([
    ["valid steps", agentStep],
    ["steps that lack their fields", (id: string) => ({ id, kind: "agent" })],
  ])(
    "validates thousands of steps and tens of thousands of unknown references in well under 1.5 s (%s)",
    (_name, agents) => {
      const { result, ms } = timed(manyStepsManyReferences(3000, agents));

      expect(ms).toBeLessThan(1500);
      expectSmall(result);
    },
  );

  // #833-M1-T341
  it("lists a few names of what is in reach, and says how many more there are", () => {
    const { result } = timed(manyStepsManyReferences(500, agentStep));
    const unknown = result.errors.filter(
      (e) => e.code === "reference_unknown_step",
    );

    expect(unknown.length).toBeGreaterThan(0);
    for (const found of unknown) {
      expect(found.available).toHaveLength(NAMES_LISTED_MAX);
      expect(found.message).toMatch(/and \d+ more/);
      expect(found.message.length).toBeLessThan(600);
    }
  });

  // #833-M1-T342
  it("stops collecting at the cap and keeps the problems it found first", () => {
    const { result } = timed(manyStepsManyReferences(10, agentStep));

    expect(result.truncated).toBe(true);
    expect(result.errors).toHaveLength(ERRORS_MAX);
    expect(result.errors.every((e) => e.path.startsWith("/steps/"))).toBe(true);
  });
});

describe("a name in an answer is the length of a name", () => {
  const HUGE = "k".repeat(100_000);
  const segments = (result: ValidationResult): string[] =>
    result.errors.flatMap((e) => e.path.split("/").slice(1));

  // #833-M1-T343
  it("does not look below a field name that is refused, and cuts every name in a path", () => {
    const document = tiny();
    const children = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`bad name ${i}`, { type: "nope" }]),
    );
    (document.trigger as Json).input = {
      type: "object",
      required: ["repo"],
      properties: {
        repo: { type: "string" },
        [HUGE]: { type: "object", properties: children },
      },
    };
    for (let i = 0; i < 40; i++)
      (document.steps as Json[])[0]![`${HUGE}${i}`] = 1;

    const result = run(document);

    expect(result.valid).toBe(false);
    const refused = result.errors.filter((e) => e.code === "invalid_value");
    expect(refused).toHaveLength(1);
    expect(result.errors.some((e) => e.path.includes("bad name"))).toBe(false);
    for (const segment of segments(result))
      expect(segment.length).toBeLessThanOrEqual(ECHO_MAX_LENGTH + 1);
    expect(JSON.stringify(result).length).toBeLessThan(30_000);
  });

  // #833-M1-T344
  it("cuts a long id in the lists of session and previous steps", () => {
    const document = tiny();
    const long = "s".repeat(100_000);
    (document.steps as Json[]).push({
      id: "again",
      kind: "loop",
      maxRounds: 2,
      until: { empty: "{{previous.nope.x | default []}}" },
      body: [
        { ...agentStep(long), session: { continue: "nothing" } },
        { ...agentStep("inner"), session: { continue: "nothing" } },
      ],
    });

    const result = run(document);

    for (const found of result.errors)
      for (const name of found.available ?? [])
        expect(Array.from(name).length).toBeLessThanOrEqual(
          ECHO_MAX_LENGTH + 1,
        );
    expect(JSON.stringify(result).length).toBeLessThan(20_000);
    expect(result.errors.some((e) => e.code === "session_target_invalid")).toBe(
      true,
    );
  });
});
