// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down `contracts/workflow.v1.json` and `contracts/result-schema.v1.json` (#833) from the app's side, the only reader: the
// examples are valid, the JSON Schema and the validator in src/workflows/ agree on the FORM of a document (the schema refuses a
// document exactly when the validator reports a form issue), and the numbers and names the app keeps in TypeScript equal those in
// the files. What the schema cannot say (references, types, ids, limits across the document, the names of profiles and
// environments) is the validator's and is proven in src/workflows/validate.test.ts.
import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "../../src/workflows/connectors.ts";
import { isFormIssue } from "../../src/workflows/issues.ts";
import {
  LOOP_ROUNDS_MAX,
  NAME_MAX_LENGTH,
  RESULT_ENUM_VALUES_MAX,
  RESULT_PROPERTIES_MAX,
} from "../../src/workflows/limits.ts";
import { validateResultSchema } from "../../src/workflows/result-schema.ts";
import { createResolver } from "../../src/workflows/resolver.ts";
import { TRIGGER_KINDS } from "../../src/workflows/triggers.ts";
import { validateWorkflow } from "../../src/workflows/validate.ts";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../../src/test-support/runner-contract.ts";

const workflowContract = createContractValidator("workflow.v1.json");
const resultContract = createContractValidator("result-schema.v1.json");
const resolver = createResolver({ environments: [{ name: "node" }] });

type Json = Record<string, unknown>;

function example(folder: string, definition: string): Json {
  const found = readExamples(folder).find((e) => e.definition === definition);
  if (found === undefined) throw new Error(`No example ${definition}`);
  return structuredClone(found.document) as Json;
}

function steps(document: Json): Json[] {
  return document.steps as Json[];
}

describe("the workflow contract", () => {
  // #833-M1-T120
  it("accepts its examples, and the validator accepts the workflow example with the built-in resolver", () => {
    const document = example("examples/workflow", "Workflow");

    expect(workflowContract.check("Workflow", document)).toEqual({
      valid: true,
      errors: "",
    });
    expect(validateWorkflow(document, resolver).errors).toEqual([]);
    expect(
      resultContract.check(
        "ResultSchema",
        example("examples/result-schema", "ResultSchema"),
      ),
    ).toEqual({ valid: true, errors: "" });
  });

  // #833-M1-T121
  it("lists the connectors, their inputs and which are required, as the app's registry does", () => {
    const contract = readContract("workflow.v1.json");
    const defs = contract.$defs as Record<string, Json>;
    const byConnector = new Map<string, Json>();
    for (const name of [
      "PullRequestOpenAction",
      "IssueCommentAction",
      "IssueLabelsAction",
    ]) {
      const def = defs[name] as Json;
      const properties = def.properties as Record<string, Json>;
      byConnector.set((properties.connector as Json).const as string, def);
    }

    expect([...byConnector.keys()].sort()).toEqual(
      BUILT_IN_CONNECTORS.map((c) => c.name).sort(),
    );
    for (const spec of BUILT_IN_CONNECTORS) {
      const def = byConnector.get(spec.name) as Json;
      const inputs = Object.keys(def.properties as Json).filter(
        (key) => !["id", "kind", "description", "connector"].includes(key),
      );
      expect(inputs.sort()).toEqual(Object.keys(spec.inputs).sort());
      const required = (def.required as string[]).filter(
        (key) => !["id", "kind", "connector"].includes(key),
      );
      expect(required.sort()).toEqual(
        Object.entries(spec.inputs)
          .filter(([, input]) => input.required)
          .map(([name]) => name)
          .sort(),
      );
    }
  });

  // #833-M1-T122
  it("states the trigger kinds, the caps and the limits that the app keeps as numbers", () => {
    const defs = readContract("workflow.v1.json").$defs as Record<string, Json>;
    const resultDefs = readContract("result-schema.v1.json").$defs as Record<
      string,
      Json
    >;
    const triggerKinds = (
      ["ManualTrigger", "IssueLabeledTrigger"] as const
    ).map(
      (name) => (((defs[name] as Json).properties as Json).kind as Json).const,
    );

    expect(triggerKinds.sort()).toEqual([...TRIGGER_KINDS].sort());
    const loopRounds = ((defs.LoopStep as Json).properties as Json)
      .maxRounds as Json;
    expect(loopRounds).toMatchObject({ minimum: 1, maximum: LOOP_ROUNDS_MAX });
    expect(((defs.Workflow as Json).properties as Json).name).toMatchObject({
      maxLength: NAME_MAX_LENGTH,
    });
    const objectProps = ((resultDefs.ObjectSchema as Json).properties as Json)
      .properties as Json;
    expect(objectProps.maxProperties).toBe(RESULT_PROPERTIES_MAX);
    const enumDef = ((resultDefs.StringSchema as Json).properties as Json)
      .enum as Json;
    expect(enumDef.maxItems).toBe(RESULT_ENUM_VALUES_MAX);
  });

  // #833-M1-T123
  it("names the reserved kinds, which the schema accepts and the validator refuses", () => {
    const document = example("examples/workflow", "Workflow");
    steps(document).push({
      id: "each",
      kind: "forEach",
      items: "{{start.labels}}",
    });

    expect(workflowContract.check("Workflow", document).valid).toBe(true);
    expect(
      validateWorkflow(document, resolver).errors.map((e) => e.code),
    ).toEqual(["kind_not_supported"]);
  });
});

type Case = [name: string, edit: (document: Json) => void];

const first = (document: Json): Json => steps(document)[0] as Json;
const loop = (document: Json): Json => steps(document)[1] as Json;
const implement = (document: Json): Json =>
  (loop(document).body as Json[])[0] as Json;
const review = (document: Json): Json =>
  (loop(document).body as Json[])[1] as Json;
const gate = (document: Json): Json => steps(document)[2] as Json;
const reviewSchema = (document: Json): Json => review(document).result as Json;
const findings = (document: Json): Json =>
  ((reviewSchema(document).properties as Json).findings as Json).items as Json;

const WORKFLOW_CASES: Case[] = [
  ["the version is 2", (d) => (d.version = 2)],
  ["no version", (d) => delete d.version],
  ["no name", (d) => delete d.name],
  ["an empty name", (d) => (d.name = "")],
  ["a name of numbers", (d) => (d.name = 4)],
  ["a key it does not know", (d) => (d.extra = 1)],
  ["no trigger", (d) => delete d.trigger],
  ["no steps", (d) => delete d.steps],
  ["an empty list of steps", (d) => (d.steps = [])],
  ["steps that are no list", (d) => (d.steps = {})],
  ["a budget of zero", (d) => (d.budgetUsd = 0)],
  ["a budget that is a text", (d) => (d.budgetUsd = "20")],
  ["a description that is a number", (d) => (d.description = 5)],
  ["a trigger of an unknown kind", (d) => (d.trigger = { kind: "cron" })],
  ["a trigger without a kind", (d) => (d.trigger = {})],
  [
    "an issue trigger without a label",
    (d) => (d.trigger = { kind: "github.issueLabeled" }),
  ],
  [
    "an issue trigger with an empty label",
    (d) => (d.trigger = { kind: "github.issueLabeled", label: "" }),
  ],
  [
    "a manual trigger with a label",
    (d) => (d.trigger = { kind: "manual", label: "x" }),
  ],
  [
    "a manual trigger with an input schema",
    (d) =>
      (d.trigger = {
        kind: "manual",
        input: { type: "object", properties: { a: { type: "string" } } },
      }),
  ],
  [
    "a manual trigger with a bad input schema",
    (d) => (d.trigger = { kind: "manual", input: { type: "list" } }),
  ],
  ["a step that is no object", (d) => (steps(d)[0] = 3 as unknown as Json)],
  ["a step without an id", (d) => delete first(d).id],
  ["a step with the id trigger", (d) => (first(d).id = "trigger")],
  ["a step with an id that starts with a digit", (d) => (first(d).id = "1a")],
  ["a step without a kind", (d) => delete first(d).kind],
  ["a step of an unknown kind", (d) => (first(d).kind = "parallel")],
  ["an action with a key it does not know", (d) => (first(d).colour = "red")],
  [
    "an action of an unknown connector",
    (d) => (first(d).connector = "slack.post"),
  ],
  ["an action without a connector", (d) => delete first(d).connector],
  [
    "labels without add or remove",
    (d) => {
      delete first(d).add;
      delete first(d).remove;
    },
  ],
  ["labels with a text where a list is wanted", (d) => (first(d).add = "bug")],
  ["labels with a number in the list", (d) => (first(d).add = [1])],
  ["an issue that is a plain text", (d) => (first(d).issue = "seven")],
  [
    "an issue that is an object without a number",
    (d) => (first(d).issue = { id: 3 }),
  ],
  ["an issue that is a number", (d) => (first(d).issue = 7)],
  ["an issue object with a number", (d) => (first(d).issue = { number: 7 })],
  ["a repo that is not owner/name", (d) => (first(d).repo = "nope")],
  ["a repo that is owner/name", (d) => (first(d).repo = "acme/api")],
  ["an agent without a profile", (d) => delete implement(d).profile],
  [
    "an agent with a profile in capitals",
    (d) => (implement(d).profile = "Implementer"),
  ],
  [
    "an agent with a profile version 0",
    (d) => (implement(d).profile = "implementer@0"),
  ],
  ["an agent without an environment", (d) => delete implement(d).environment],
  ["an agent without an instruction", (d) => delete implement(d).instruction],
  [
    "an agent with first but no next",
    (d) => (implement(d).instruction = { first: "a" }),
  ],
  [
    "an agent with an instruction that is a number",
    (d) => (implement(d).instruction = 5),
  ],
  [
    "an agent with a session that is a word",
    (d) => (implement(d).session = "old"),
  ],
  [
    "an agent with a session without continue",
    (d) => (implement(d).session = {}),
  ],
  [
    "an agent with a session continue that is a number",
    (d) => (implement(d).session = { continue: 5 }),
  ],
  ["an agent with a key it does not know", (d) => (implement(d).model = "x")],
  [
    "an agent with a result that is no object schema",
    (d) => (implement(d).result = { type: "string" }),
  ],
  ["a loop without maxRounds", (d) => delete loop(d).maxRounds],
  ["a loop with maxRounds 0", (d) => (loop(d).maxRounds = 0)],
  ["a loop with maxRounds over the cap", (d) => (loop(d).maxRounds = 11)],
  ["a loop with maxRounds that is not whole", (d) => (loop(d).maxRounds = 2.5)],
  ["a loop with maxRounds that is a text", (d) => (loop(d).maxRounds = "3")],
  ["a loop with an empty body", (d) => (loop(d).body = [])],
  ["a loop without until", (d) => delete loop(d).until],
  ["an if without when", (d) => delete gate(d).when],
  ["an if without then", (d) => delete gate(d).then],
  ["an if with an empty else", (d) => (gate(d).else = [])],
  ["a condition with no operator", (d) => (gate(d).when = {})],
  [
    "a condition with two operators",
    (d) => (gate(d).when = { empty: "{{a.b}}", notEmpty: "{{a.b}}" }),
  ],
  [
    "a condition with an operator it does not know",
    (d) => (gate(d).when = { greater: [1, 2] }),
  ],
  ["a comparison with one operand", (d) => (gate(d).when = { equals: ["a"] })],
  [
    "a comparison with three operands",
    (d) => (gate(d).when = { equals: ["a", "b", "c"] }),
  ],
  [
    "a comparison with an object as operand",
    (d) => (gate(d).when = { equals: [{}, "a"] }),
  ],
  ["an empty all", (d) => (gate(d).when = { all: [] })],
  [
    "a nested condition",
    (d) =>
      (gate(d).when = { not: { any: [{ empty: "{{review.findings}}" }] } }),
  ],
  ["an operand that is a number", (d) => (gate(d).when = { empty: 3 })],
  [
    "the id of a reference to a missing step",
    (d) => (gate(d).when = { empty: "{{ghost.x}}" }),
  ],
  [
    "a field that is a number where text is wanted",
    (d) => (first(d).add = [1, 2]),
  ],
  [
    "a pull request without a head",
    (d) => delete ((gate(d).then as Json[])[0] as Json).head,
  ],
  [
    "a pull request with a draft that is a word",
    (d) => (((gate(d).then as Json[])[0] as Json).draft = "yes"),
  ],
  [
    "a pull request with a draft that is a reference",
    (d) => (((gate(d).then as Json[])[0] as Json).draft = "{{trigger.issue}}"),
  ],
  [
    "a pull request with a draft that is true",
    (d) => (((gate(d).then as Json[])[0] as Json).draft = true),
  ],
  [
    "a pull request with a body that is a number",
    (d) => (((gate(d).then as Json[])[0] as Json).body = 5),
  ],
];

const RESULT_CASES: Case[] = [
  [
    "a field type that does not exist",
    (d) => ((reviewSchema(d).properties as Json).findings = { type: "list" }),
  ],
  [
    "an array without items",
    (d) => delete ((reviewSchema(d).properties as Json).findings as Json).items,
  ],
  [
    "maxItems 0",
    (d) =>
      (((reviewSchema(d).properties as Json).findings as Json).maxItems = 0),
  ],
  [
    "maxItems over the cap",
    (d) =>
      (((reviewSchema(d).properties as Json).findings as Json).maxItems = 1001),
  ],
  ["an object without properties", (d) => delete findings(d).properties],
  ["an object with no fields", (d) => (findings(d).properties = {})],
  ["an open object", (d) => (findings(d).additionalProperties = true)],
  ["a closed object", (d) => (findings(d).additionalProperties = false)],
  [
    "a field name with a space",
    (d) => ((findings(d).properties as Json)["a b"] = { type: "string" }),
  ],
  [
    "a duplicate required entry",
    (d) => (findings(d).required = ["type", "type"]),
  ],
  [
    "a required entry that is not a property",
    (d) => (findings(d).required = ["ghost"]),
  ],
  ["required that is not a list", (d) => (findings(d).required = "type")],
  [
    "an empty enum",
    (d) => (((findings(d).properties as Json).type as Json).enum = []),
  ],
  [
    "a duplicate enum value",
    (d) => (((findings(d).properties as Json).type as Json).enum = ["a", "a"]),
  ],
  [
    "an enum value that is a number",
    (d) => (((findings(d).properties as Json).type as Json).enum = [1]),
  ],
  [
    "maxLength 0",
    (d) => (((findings(d).properties as Json).name as Json).maxLength = 0),
  ],
  [
    "maxLength over the cap",
    (d) => (((findings(d).properties as Json).name as Json).maxLength = 100001),
  ],
  [
    "a maxLength on a number",
    (d) =>
      ((findings(d).properties as Json).name = {
        type: "number",
        maxLength: 3,
      }),
  ],
  [
    "a number field",
    (d) =>
      ((findings(d).properties as Json).score = {
        type: "number",
        description: "0 to 10",
      }),
  ],
  [
    "a boolean field",
    (d) => ((findings(d).properties as Json).fatal = { type: "boolean" }),
  ],
  [
    "a description that is too long",
    (d) =>
      (((findings(d).properties as Json).name as Json).description = "x".repeat(
        501,
      )),
  ],
  [
    "a keyword it does not know",
    (d) => (((findings(d).properties as Json).name as Json).pattern = "^a"),
  ],
];

function verdicts(document: Json) {
  const schemaValid = workflowContract.check("Workflow", document).valid;
  const issues = validateWorkflow(document, resolver).errors;
  return { schemaValid, formIssues: issues.filter(isFormIssue), issues };
}

describe("the JSON Schema and the validator agree on the form of a workflow", () => {
  // #833-M1-T124
  it.each([...WORKFLOW_CASES, ...RESULT_CASES])("%s", (_name, edit) => {
    const document = example("examples/workflow", "Workflow");
    edit(document);

    const { schemaValid, formIssues, issues } = verdicts(document);

    // The schema refuses the document exactly when the validator found a problem of the form.
    expect({
      schemaValid,
      formIssues: formIssues.map((i) => `${i.path} ${i.code}`),
    }).toEqual({
      schemaValid: formIssues.length === 0,
      formIssues: formIssues.map((i) => `${i.path} ${i.code}`),
    });
    // And a document the schema accepts has only issues that need more than the schema.
    if (schemaValid) expect(formIssues).toEqual([]);
    else expect(issues.length).toBeGreaterThan(0);
  });

  // #833-M1-T125
  it("has cases on both sides: some the schema refuses, some it accepts", () => {
    const outcomes = [...WORKFLOW_CASES, ...RESULT_CASES].map(([, edit]) => {
      const document = example("examples/workflow", "Workflow");
      edit(document);
      return verdicts(document).schemaValid;
    });

    expect(outcomes.filter(Boolean).length).toBeGreaterThan(8);
    expect(outcomes.filter((valid) => !valid).length).toBeGreaterThan(50);
  });
});

describe("the JSON Schema and the validator agree on a result schema", () => {
  const RESULT_ONLY: Array<[string, unknown]> = [
    [
      "a plain object schema",
      { type: "object", properties: { a: { type: "string" } } },
    ],
    ["no type", { properties: { a: { type: "string" } } }],
    ["type string at the root", { type: "string" }],
    ["a list at the root", []],
    [
      "a nested object",
      {
        type: "object",
        properties: {
          a: { type: "object", properties: { b: { type: "number" } } },
        },
      },
    ],
    [
      "too many properties",
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 51 }, (_, i) => [`f${i}`, { type: "string" }]),
        ),
      },
    ],
    [
      "too many enum values",
      {
        type: "object",
        properties: {
          a: {
            type: "string",
            enum: Array.from({ length: 51 }, (_, i) => `v${i}`),
          },
        },
      },
    ],
  ];

  // #833-M1-T126
  it.each(RESULT_ONLY)("%s", (_name, schema) => {
    const schemaValid = resultContract.check("ResultSchema", schema).valid;
    const formIssues = validateResultSchema(schema).issues.filter(isFormIssue);

    expect(schemaValid).toBe(formIssues.length === 0);
  });
});
