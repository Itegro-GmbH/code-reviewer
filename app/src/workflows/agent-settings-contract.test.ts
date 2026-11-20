// SPDX-License-Identifier: LicenseRef-Proprietary

// #1105: the JSON Schema (`contracts/workflow.v1.json`) and the validator agree on the FORM of an agent step with settings of its own: the schema
// refuses a document exactly when the validator reports a form issue. What the schema cannot say (a profile and settings together or neither,
// whether the workspace can run the model, the environment's kind, a host that is no name) is the validator's, with a code of its own.
import { describe, expect, it } from "vitest";
import {
  createContractValidator,
  readContract,
} from "../test-support/runner-contract.ts";
import { INLINE_SETTING_KEYS } from "./agent-settings.ts";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import { isFormIssue } from "./issues.ts";
import type { WorkflowResolver } from "./resolver.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const contract = createContractValidator("workflow.v1.json");
const resolver: WorkflowResolver = {
  profiles: () => [
    { name: "implementer", versions: [1], facts: { 1: { canPush: true } } },
  ],
  environments: () => [{ name: "node", kind: "hosted" }],
  connectors: () => BUILT_IN_CONNECTORS,
};

function lane(step: Json): Json {
  return {
    version: 1,
    name: "Inline",
    trigger: { kind: "github.issueLabeled", label: "ready" },
    steps: [
      {
        id: "work",
        kind: "agent",
        environment: "node",
        instruction: "Do it.",
        ...step,
      },
    ],
  };
}

const INLINE = {
  model: { provider: "anthropic", model: "claude-sonnet-5-5" },
  canPush: true,
};

const CASES: [name: string, step: Json][] = [
  ["the settings of the step", INLINE],
  ["a managed model", { ...INLINE, model: { entryId: "e1" } }],
  [
    "every setting",
    {
      ...INLINE,
      harness: "opencode",
      instructions: "Be brief.\n\tAnd careful.",
      setupScript: "npm ci\n",
      network: { mode: "list", hosts: ["registry.npmjs.org"] },
    },
  ],
  ["a network rule that is open", { ...INLINE, network: { mode: "open" } }],
  ["a profile", { profile: "implementer" }],
  ["no profile and no settings", {}],
  ["a profile with settings", { profile: "implementer", ...INLINE }],
  ["a model that is a text", { ...INLINE, model: "sonnet" }],
  [
    "a model with both shapes",
    { ...INLINE, model: { entryId: "a", model: "b" } },
  ],
  [
    "a model with an entry id of white space",
    { ...INLINE, model: { entryId: "  " } },
  ],
  [
    "a model with an empty provider",
    { ...INLINE, model: { provider: "", model: "m" } },
  ],
  [
    "a model with a line break in its name",
    { ...INLINE, model: { provider: "a", model: "m\nn" } },
  ],
  [
    "a model field of 201 characters",
    { ...INLINE, model: { entryId: "x".repeat(201) } },
  ],
  ["no model", { canPush: true }],
  ["no canPush", { model: INLINE.model }],
  ["canPush as a text", { ...INLINE, canPush: "yes" }],
  ["a harness it does not know", { ...INLINE, harness: "codex" }],
  ["instructions of white space", { ...INLINE, instructions: " \n " }],
  ["empty instructions", { ...INLINE, instructions: "" }],
  [
    "instructions with a control character",
    { ...INLINE, instructions: "a\u0001b" },
  ],
  [
    "instructions of 20,001 characters",
    { ...INLINE, instructions: "x".repeat(20_001) },
  ],
  ["instructions that are no text", { ...INLINE, instructions: 5 }],
  ["a setup script with a NUL byte", { ...INLINE, setupScript: "a\u0000b" }],
  [
    "a setup script of 65,537 characters",
    { ...INLINE, setupScript: "x".repeat(65_537) },
  ],
  ["a network rule that is a text", { ...INLINE, network: "open" }],
  ["a network rule without a mode", { ...INLINE, network: {} }],
  [
    "a network rule with a mode it does not know",
    { ...INLINE, network: { mode: "wide" } },
  ],
  [
    "a network rule with a key it does not know",
    { ...INLINE, network: { mode: "off", ports: [] } },
  ],
  ["a list rule without hosts", { ...INLINE, network: { mode: "list" } }],
  [
    "a list rule with no hosts",
    { ...INLINE, network: { mode: "list", hosts: [] } },
  ],
  [
    "hosts with another mode",
    { ...INLINE, network: { mode: "open", hosts: ["a.example.com"] } },
  ],
  [
    "a host that is empty",
    { ...INLINE, network: { mode: "list", hosts: [""] } },
  ],
  [
    "a host that is a number",
    { ...INLINE, network: { mode: "list", hosts: [4] } },
  ],
  [
    "101 hosts",
    {
      ...INLINE,
      network: {
        mode: "list",
        hosts: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`),
      },
    },
  ],
  [
    "a host of white space among others (the engine skips it)",
    { ...INLINE, network: { mode: "list", hosts: ["  ", "a.example.com"] } },
  ],
  [
    "a host that is an address (only the validator knows)",
    { ...INLINE, network: { mode: "list", hosts: ["10.0.0.1"] } },
  ],
];

describe("the schema and the validator agree on a step with settings of its own", () => {
  it.each(CASES)("%s", (_name, step) => {
    const document = lane(step);
    const schemaValid = contract.check("Workflow", document).valid;
    const issues = validateWorkflow(document, resolver).errors;
    const formIssues = issues.filter(isFormIssue);

    // The schema refuses the document exactly when the validator found a problem of the form.
    expect(schemaValid).toBe(formIssues.length === 0);
    // And a document the schema accepts has only issues that need more than the schema.
    if (!schemaValid) expect(issues.length).toBeGreaterThan(0);
  });

  // The one documented gap: the schema's pattern is an ECMAScript regular expression and cannot see a lone surrogate half, which the
  // validator refuses (`invalid_value`). The gap is pinned here so it is closed on purpose, not by accident.
  it("pins the gap: a lone surrogate passes the schema and is refused by the validator", () => {
    const document = lane({ ...INLINE, instructions: "a\ud800b" });

    expect(contract.check("Workflow", document).valid).toBe(true);
    expect(
      validateWorkflow(document, resolver).errors.map((e) => [e.path, e.code]),
    ).toEqual([["/steps/0/instructions", "invalid_value"]]);
  });

  it("has cases on both sides", () => {
    const verdicts = CASES.map(
      ([, step]) => contract.check("Workflow", lane(step)).valid,
    );
    expect(verdicts.filter(Boolean).length).toBeGreaterThan(5);
    expect(verdicts.filter((valid) => !valid).length).toBeGreaterThan(20);
  });

  it("lists the settings the validator knows as the properties of the step, apart from the profile", () => {
    const defs = readContract("workflow.v1.json").$defs as Record<string, Json>;
    const properties = (defs.AgentStep as Json).properties as Json;
    for (const key of INLINE_SETTING_KEYS)
      expect(properties).toHaveProperty(key);
    expect((defs.AgentStep as Json).required).toEqual([
      "id",
      "kind",
      "instruction",
    ]);
  });
});
