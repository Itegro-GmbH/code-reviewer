// SPDX-License-Identifier: LicenseRef-Proprietary

// What a hostile document costs (#833): the validator stops collecting problems once it has more than it will list, a list of names in
// an answer is cut to a few names, a name in a path or a list is cut to the length of a name, and nothing below a name that is already
// refused is looked at. A document of 200 KB must not cost seconds or gigabytes, whatever it is made of.
import { describe, expect, it } from "vitest";
import { ECHO_MAX_LENGTH } from "./issues.ts";
import {
  ERRORS_MAX,
  NAMES_LISTED_MAX,
  RESULT_PROPERTIES_MAX,
} from "./limits.ts";
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

function expectSmall(result: ValidationResult, truncated = true): void {
  expect(result.errors.length).toBeLessThanOrEqual(ERRORS_MAX);
  expect(result.truncated).toBe(truncated);
  for (const found of result.errors) {
    expect(found.message.length).toBeLessThan(1000);
    expect(found.available?.length ?? 0).toBeLessThanOrEqual(NAMES_LISTED_MAX);
  }
  expect(JSON.stringify(result).length).toBeLessThan(150_000);
}

describe("the work is bounded by what the answer can hold", () => {
  // #833-M1-T380
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

  // #833-M1-T381
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

  // #833-M1-T382
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

  // #833-M1-T383
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

  // #833-M1-T384
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

describe("a result schema costs what its size costs, not its size times itself", () => {
  const FIELDS = 5000;
  const properties = (count: number, value: unknown): Json =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`p${i}`, value]),
    );
  const unknownNames = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `q${i}`);
  const agentWith = (result: Json): Json => ({
    ...agentStep("a"),
    result,
  });
  const inLoop = (step: Json): Json[] => [
    {
      id: "again",
      kind: "loop",
      maxRounds: 2,
      body: [step],
      until: { empty: '{{a.x | default ""}}' },
    },
  ];
  const withSteps = (list: Json[]): Json => ({ ...tiny(), steps: list });

  // #833-M1-T385
  it.each([
    [
      "the most fields and required names that are none of them",
      agentWith({
        type: "object",
        properties: properties(RESULT_PROPERTIES_MAX, { type: "string" }),
        required: unknownNames(20_000),
      }),
    ],
    [
      "thousands of fields that are not schemas and required names that are none of them",
      agentWith({
        type: "object",
        properties: properties(8000, 1),
        required: unknownNames(20_000),
      }),
    ],
    [
      "required names that are not text",
      agentWith({
        type: "object",
        properties: { a: { type: "string" } },
        required: Array.from({ length: 30_000 }, () => 1),
      }),
    ],
  ])(
    "validates %s in well under 1.5 s, with a capped list",
    (_name, step) => {
      const { result, ms } = timed(withSteps([step]));

      expect(ms).toBeLessThan(1500);
      expectSmall(result);
    },
    60_000,
  );

  // #833-M1-T385a
  it("looks no further at the required names of an object that has too many fields: it is refused for that", () => {
    const step = agentWith({
      type: "object",
      properties: properties(FIELDS, { type: "string" }),
      required: unknownNames(16_000),
    });

    const { result, ms } = timed(withSteps([step]));

    expect(ms).toBeLessThan(1500);
    expect(result.errors.map((e) => e.code)).toEqual([
      "result_schema_too_large",
      "limit_exceeded",
    ]);
    expectSmall(result, false);
  }, 60_000);

  // #833-M1-T386
  it("does so also inside a loop, where the step is looked at again", () => {
    const step = agentWith({
      type: "object",
      properties: properties(8000, 1),
      required: unknownNames(20_000),
    });

    const { result, ms } = timed(withSteps(inLoop(step)));

    expect(ms).toBeLessThan(1500);
    expectSmall(result);
  }, 60_000);

  // #833-M1-T387
  it("does so for the input of a manual trigger", () => {
    const document = tiny();
    (document.trigger as Json).input = {
      type: "object",
      properties: properties(8000, 1),
      required: ["repo", ...unknownNames(20_000)],
    };

    const { result, ms } = timed(document);

    expect(ms).toBeLessThan(1500);
    expectSmall(result);
  }, 60_000);
});

describe("a type in a message is listed like any other names", () => {
  // The shape of a hostile result: an enum of 50 values of 200 characters, an object of 50 fields with names of 64.
  const enumValues = Array.from(
    { length: 50 },
    (_, i) => `${String(i).padStart(3, "0")}${"e".repeat(197)}`,
  );
  const names = Array.from(
    { length: 50 },
    (_, i) => `f${String(i).padStart(2, "0")}${"n".repeat(60)}`,
  );

  function usesOfBigTypes(count: number): Json {
    const document = tiny();
    const steps: Json[] = [
      {
        ...agentStep("a"),
        result: {
          type: "object",
          required: ["k", "o"],
          properties: {
            k: { type: "string", enum: enumValues },
            o: {
              type: "object",
              required: names,
              properties: Object.fromEntries(
                names.map((name) => [name, { type: "string" }]),
              ),
            },
          },
        },
      },
    ];
    for (let i = 0; i < count; i++)
      steps.push({
        id: `c${i}`,
        kind: "action",
        connector: "github.pullRequest.open",
        head: "dev",
        title: "t",
        draft: i % 2 === 0 ? "{{a.k}}" : "{{a.o}}",
      });
    document.steps = steps;
    return document;
  }

  // #833-M1-T388
  it("names a few of the values of an enum and of the fields of an object, and counts the rest", () => {
    const document = usesOfBigTypes(260);

    const { result } = timed(document);

    expect(result.errors.length).toBeGreaterThan(100);
    // 200 problems, each with up to 20 names of 64 characters in its message and in `available`: 1.5 KB at most. Unbounded, this
    // document gave 1.4 MB, messages of 10 KB.
    expect(JSON.stringify(result).length).toBeLessThan(400_000);
    for (const found of result.errors)
      expect(found.message.length).toBeLessThan(1700);
    const about = result.errors.filter((e) =>
      /one of|object with/.test(e.message),
    );
    expect(about.length).toBeGreaterThan(100);
    for (const found of about) expect(found.message).toMatch(/and 30 more/);
  });

  // #833-M1-T389
  it("keeps the whole list for a type of a few names", () => {
    const document = tiny();
    (document.steps as Json[]).push({
      id: "c",
      kind: "action",
      connector: "github.pullRequest.open",
      head: "dev",
      title: "t",
      draft: "{{work.summary}}",
    });
    (document.steps as Json[])[0] = {
      ...agentStep("work"),
      result: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string", enum: ["bug", "risk"] } },
      },
    };

    const messages = run(document).errors.map((e) => e.message);

    expect(messages.some((m) => m.includes("one of 'bug', 'risk'"))).toBe(true);
  });
});

describe("entering a branch or a loop does not copy the steps in reach", () => {
  // #833-M1-T393
  it("validates a thousand steps followed by a thousand ifs and loops in well under 1.5 s", () => {
    const label = (id: string): Json => ({
      id,
      kind: "action",
      connector: "github.issue.labels",
      issue: 1,
      add: ["x"],
    });
    const list: Json[] = [];
    for (let i = 0; i < 1000; i++) list.push(label(`s${i}`));
    for (let i = 0; i < 500; i++)
      list.push({
        id: `i${i}`,
        kind: "if",
        when: { empty: "x" },
        then: [comment(`t${i}`, "x")],
        else: [comment(`e${i}`, "x")],
      });
    for (let i = 0; i < 500; i++)
      list.push({
        id: `l${i}`,
        kind: "loop",
        maxRounds: 2,
        body: [comment(`b${i}`, "x")],
        until: { empty: "x" },
      });

    const document = tiny();
    document.steps = list;
    const { result, ms } = timed(document);

    expect(ms).toBeLessThan(1500);
    expect(result.errors.map((e) => e.code)).toEqual(["too_many_steps"]);
  });
});
