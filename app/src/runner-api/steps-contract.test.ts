// SPDX-License-Identifier: LicenseRef-Proprietary

// #745: the steps call of the contract (contracts/runner-api.v1.json, worker-api.v1.json). The schema and the examples are checked
// against each other (Ajv, no database), the hand-written parser gives the same verdict as the schema for a set of good and bad
// bodies, and the lists and bounds the app keeps in TypeScript are the file's. The runner's half is
// runner/tests/contract/test_steps_contract.py.
import { describe, expect, it } from "vitest";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../test-support/runner-contract.ts";
import {
  APP_FEATURES,
  STEP_KINDS,
  STEPS_BATCH_BYTES,
  STEPS_LIMITS,
  RUNNER_MAX_BODY_BYTES,
} from "./contract.ts";
import { parseStepsRequest, parseWorkerStepsRequest } from "./steps-request.ts";

const contract = createContractValidator();
const workerContract = createContractValidator("worker-api.v1.json");

type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

function example(file: "runner" | "worker", name: string): Document {
  const found = readExamples(
    file === "runner" ? "examples" : "examples/worker-api",
  ).find((entry) => entry.definition === name);
  if (found === undefined) throw new Error(`no example ${name}`);
  return structuredClone(found.document) as Document;
}

const request = () => example("runner", "StepsRequest");
const record = (kind: string) => {
  const found = (request().records as Document[]).find(
    (entry) => entry.kind === kind,
  );
  if (found === undefined) throw new Error(`no ${kind} record`);
  return found;
};

describe("the examples of the steps call", () => {
  // #745-T40
  it.each([
    ["StepsRequest", "runner", contract],
    ["StepsResponse", "runner", contract],
    ["WorkerStepsRequest", "worker", workerContract],
    ["WorkerStepsResponse", "worker", workerContract],
  ] as const)("%s is valid", (name, file, validator) => {
    expect(validator.check(name, example(file, name))).toStrictEqual({
      valid: true,
      errors: "",
    });
  });

  // #745-T40
  it("hold a record of every kind the app stores, and the parser reads them", () => {
    expect(
      new Set((request().records as Document[]).map((entry) => entry.kind)),
    ).toStrictEqual(new Set(STEP_KINDS));
    const parsed = parseStepsRequest(request());
    expect(parsed.ok && parsed.value.records).toHaveLength(5);
    expect(
      parseWorkerStepsRequest(example("worker", "WorkerStepsRequest")).ok,
    ).toBe(true);
  });
});

describe("the lists and bounds the app keeps", () => {
  // #745-T41
  it("are the file's: the kinds, the bounds of a record, the size of a batch", () => {
    const schema = readContract();
    const properties = (schema.$defs["StepRecord"] as Document).properties;
    expect([...STEP_KINDS].sort()).toStrictEqual(
      [...(schema.$defs["KnownStepKind"]?.enum ?? [])].sort(),
    );
    expect(properties.text.maxLength).toBe(STEPS_LIMITS.textChars);
    expect(properties.input.maxLength).toBe(STEPS_LIMITS.inputChars);
    expect(properties.error.maxLength).toBe(STEPS_LIMITS.errorChars);
    expect(properties.title.maxLength).toBe(STEPS_LIMITS.titleChars);
    expect(properties.tool.maxLength).toBe(STEPS_LIMITS.toolChars);
    expect(properties.status.maxLength).toBe(STEPS_LIMITS.statusChars);
    expect(properties.reason.maxLength).toBe(STEPS_LIMITS.reasonChars);
    expect(properties.seq.maximum).toBe(STEPS_LIMITS.seq);
    expect(properties.startedAt.maximum).toBe(STEPS_LIMITS.epochMs);
    expect(properties.cost.maximum).toBe(STEPS_LIMITS.cost);
    expect(properties.tokens.$ref).toBe("#/$defs/StepTokens");
    expect(
      (schema.$defs["StepTokens"] as Document).properties.input.maximum,
    ).toBe(STEPS_LIMITS.count);
    expect(
      (schema.$defs["StepsRequest"] as Document).properties.records.maxItems,
    ).toBe(STEPS_LIMITS.records);
    expect(new RegExp(properties.partId.pattern).source).toContain("256");
    // A batch of at most 48 KiB leaves the lease token and the escaping of the sender's JSON room within the body limit.
    expect(STEPS_BATCH_BYTES).toBeLessThan(RUNNER_MAX_BODY_BYTES);
  });

  // #745-T41
  it("list the feature that says the call exists", () => {
    expect(APP_FEATURES).toContain("implementer_steps");
    expect(readContract().$defs["KnownAppFeature"]?.enum).toContain(
      "implementer_steps",
    );
  });
});

/** Bodies the schema and the parser must judge alike: a name, the body, and whether it is valid. */
function bodies(): Array<[string, Document, boolean]> {
  const edited = (edit: (body: Document) => void): Document => {
    const body = request();
    edit(body);
    return body;
  };
  const withRecord = (change: (entry: Document) => void): Document =>
    edited((body) => change(body.records[0]));
  const long = (length: number) => "x".repeat(length);
  return [
    ["the example", request(), true],
    ["no lease token", edited((body) => delete body.leaseToken), false],
    [
      "a short lease token",
      edited((body) => (body.leaseToken = "short")),
      false,
    ],
    [
      "a lease token that is a number",
      edited((body) => (body.leaseToken = 12345678)),
      false,
    ],
    ["no records", edited((body) => delete body.records), false],
    ["an empty batch", edited((body) => (body.records = [])), false],
    [
      "records that are not a list",
      edited((body) => (body.records = {})),
      false,
    ],
    [
      "50 records",
      edited((body) => {
        body.records = Array.from({ length: 50 }, (_, index) => ({
          ...record("text"),
          partId: `prt_${String(index)}`,
          seq: index + 1,
        }));
      }),
      true,
    ],
    [
      "51 records",
      edited((body) => {
        body.records = Array.from({ length: 51 }, (_, index) => ({
          ...record("text"),
          partId: `prt_${String(index)}`,
          seq: index + 1,
        }));
      }),
      false,
    ],
    [
      "a field it does not know",
      withRecord((entry) => (entry.output = "x")),
      true,
    ],
    [
      "a kind it does not know",
      withRecord((entry) => (entry.kind = "patch")),
      true,
    ],
    ["a kind in capitals", withRecord((entry) => (entry.kind = "Text")), false],
    ["no kind", withRecord((entry) => delete entry.kind), false],
    ["no part id", withRecord((entry) => delete entry.partId), false],
    [
      "a part id with a space",
      withRecord((entry) => (entry.partId = "prt 1")),
      false,
    ],
    [
      "a part id of 256 characters",
      withRecord((entry) => (entry.partId = long(256))),
      true,
    ],
    [
      "a part id of 257 characters",
      withRecord((entry) => (entry.partId = long(257))),
      false,
    ],
    ["no seq", withRecord((entry) => delete entry.seq), false],
    ["seq 0", withRecord((entry) => (entry.seq = 0)), false],
    [
      "a seq that is a fraction",
      withRecord((entry) => (entry.seq = 1.5)),
      false,
    ],
    [
      "the largest seq",
      withRecord((entry) => (entry.seq = STEPS_LIMITS.seq)),
      true,
    ],
    [
      "a seq past the largest",
      withRecord((entry) => (entry.seq = STEPS_LIMITS.seq + 1)),
      false,
    ],
    ["a negative start", withRecord((entry) => (entry.startedAt = -1)), false],
    [
      "a start that is text",
      withRecord((entry) => (entry.startedAt = "1")),
      false,
    ],
    [
      "a text of the longest length",
      withRecord((entry) => (entry.text = long(STEPS_LIMITS.textChars))),
      true,
    ],
    [
      "a text one character too long",
      withRecord((entry) => (entry.text = long(STEPS_LIMITS.textChars + 1))),
      false,
    ],
    ["text that is a number", withRecord((entry) => (entry.text = 5)), false],
    [
      "a reasoning record without text",
      withRecord((entry) => delete entry.text),
      false,
    ],
    [
      "a tool record without a tool",
      edited((body) => delete body.records[1].tool),
      false,
    ],
    [
      "a tool record without a status",
      edited((body) => delete body.records[1].status),
      false,
    ],
    [
      "a tool record without a title or an input",
      edited((body) => {
        delete body.records[1].title;
        delete body.records[1].input;
      }),
      true,
    ],
    [
      "a long input",
      edited((body) => (body.records[1].input = long(STEPS_LIMITS.inputChars))),
      true,
    ],
    [
      "an input one character too long",
      edited(
        (body) => (body.records[1].input = long(STEPS_LIMITS.inputChars + 1)),
      ),
      false,
    ],
    [
      "an error one character too long",
      edited(
        (body) => (body.records[1].error = long(STEPS_LIMITS.errorChars + 1)),
      ),
      false,
    ],
    [
      "a title one character too long",
      edited(
        (body) => (body.records[1].title = long(STEPS_LIMITS.titleChars + 1)),
      ),
      false,
    ],
    [
      "a step record without tokens",
      edited((body) => delete body.records[4].tokens),
      false,
    ],
    [
      "tokens without a field",
      edited((body) => delete body.records[4].tokens.cacheWrite),
      false,
    ],
    [
      "a negative token count",
      edited((body) => (body.records[4].tokens.input = -1)),
      false,
    ],
    [
      "a token count that is a fraction",
      edited((body) => (body.records[4].tokens.output = 0.5)),
      false,
    ],
    ["a negative cost", edited((body) => (body.records[4].cost = -0.1)), false],
    ["no cost", edited((body) => delete body.records[4].cost), true],
    [
      "a cost that is text",
      edited((body) => (body.records[4].cost = "0.1")),
      false,
    ],
    [
      "a record that is not an object",
      edited((body) => (body.records[0] = "text")),
      false,
    ],
    ["a body that is a list", [] as unknown as Document, false],
  ];
}

describe("the parser of the app and the schema", () => {
  // #745-T42
  it.each(bodies().map((entry) => [entry[0], entry] as const))(
    "judge %s alike",
    (_name, [, body, valid]) => {
      const schema = contract.check("StepsRequest", body).valid;
      const parsed = parseStepsRequest(body).ok;

      expect({ schema, parsed }).toStrictEqual({
        schema: valid,
        parsed: valid,
      });
    },
  );

  // #745-T42
  it("judge the Worker's body alike (the same records, no lease token)", () => {
    for (const [name, body, valid] of bodies()) {
      if (typeof body.leaseToken !== "string" && name !== "the example")
        continue;
      if (name.includes("lease token")) continue;
      const workerBody: Document = Array.isArray(body)
        ? body
        : { records: body.records };
      expect(
        {
          name,
          schema: workerContract.check("WorkerStepsRequest", workerBody).valid,
          parsed: parseWorkerStepsRequest(workerBody).ok,
        },
        name,
      ).toStrictEqual({ name, schema: valid, parsed: valid });
    }
  });

  // #745-T42
  it("name the field of a refusal and never its value", () => {
    const body = request();
    body.records[2].status = "x".repeat(40);
    body.records[2].title = "a-secret-title-" + "y".repeat(600);

    const parsed = parseStepsRequest(body);

    expect(parsed).toStrictEqual({
      ok: false,
      fields: [
        { field: "records[2].status", code: "too_long" },
        { field: "records[2].title", code: "too_long" },
      ],
    });
  });

  // #745-T42
  it("counts a record of another kind and keeps the others", () => {
    const body = request();
    body.records[0].kind = "patch";

    const parsed = parseStepsRequest(body);

    expect(
      parsed.ok && [parsed.value.records.length, parsed.value.unknownKind],
    ).toStrictEqual([4, 1]);
  });

  // #745-T42
  it("keeps only the fields the contract knows", () => {
    const body = request();
    body.records[1].output = "secret output";
    body.records[1].something = { nested: true };

    const parsed = parseStepsRequest(body);

    expect(parsed.ok && JSON.stringify(parsed.value.records)).not.toContain(
      "secret output",
    );
    expect(parsed.ok && JSON.stringify(parsed.value.records)).not.toContain(
      "nested",
    );
  });
});
