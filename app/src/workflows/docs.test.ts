// SPDX-License-Identifier: LicenseRef-Proprietary

// docs/workflows.md (#833) must not drift from the code: the first workflow in it is the example of the contract, every error code
// the validator and the routes can give has a row, and every connector and trigger is named.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import { WORKFLOW_ERROR_CODES } from "./errors.ts";
import {
  FORM_ISSUE_CODES,
  ISSUE_CODES,
  SEMANTIC_ISSUE_CODES,
} from "./issues.ts";
import {
  ERRORS_MAX,
  LOOP_ROUNDS_MAX,
  VERSIONS_PER_WORKFLOW_MAX,
  WORKFLOWS_PER_WORKSPACE_MAX,
} from "./limits.ts";
import { createResolver } from "./resolver.ts";
import { TRIGGER_KINDS } from "./triggers.ts";
import { validateWorkflow } from "./validate.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const docs = readFileSync(join(ROOT, "docs", "workflows.md"), "utf8");

function jsonBlocks(text: string): unknown[] {
  return [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1] as string),
  );
}

/** The codes in the first column of the tables between two markers of the document. */
function codesBetween(start: string, end: string | undefined): string[] {
  const from = docs.indexOf(start);
  if (from === -1) throw new Error(`docs/workflows.md has no "${start}"`);
  const to = end === undefined ? docs.length : docs.indexOf(end, from);
  return [...docs.slice(from, to).matchAll(/^\| `([A-Za-z_]+)` \|/gm)].map(
    (match) => match[1] as string,
  );
}

describe("docs/workflows.md", () => {
  // #833-M1-T240
  it("holds the example of the contract, and it validates clean", () => {
    const example = JSON.parse(
      readFileSync(
        join(ROOT, "contracts", "examples", "workflow", "Workflow.json"),
        "utf8",
      ),
    ) as unknown;

    expect(jsonBlocks(docs)).toContainEqual(example);
    expect(
      validateWorkflow(
        example,
        createResolver({ environments: [{ name: "node" }] }),
      ).errors,
    ).toEqual([]);
  });

  // #833-M1-T241
  it.each([...ISSUE_CODES, ...WORKFLOW_ERROR_CODES])(
    "has a row for the code %s",
    (code) => {
      expect(docs).toContain(`| \`${code}\` |`);
    },
  );

  // #833-M1-T244
  it.each([
    ["form", "Form (the JSON Schema", "Beyond the form:", FORM_ISSUE_CODES],
    ["semantic", "Beyond the form:", "### Of the routes", SEMANTIC_ISSUE_CODES],
    ["route", "### Of the routes", undefined, WORKFLOW_ERROR_CODES],
  ] as const)(
    "has the %s codes in their own table, each once, and no row for a code that is gone",
    (_name, start, end, expected) => {
      const found = codesBetween(start, end);

      expect(found.toSorted()).toEqual([...expected].toSorted());
    },
  );

  // #833-M1-T242
  it("names every connector and trigger", () => {
    for (const name of [
      ...BUILT_IN_CONNECTORS.map((c) => c.name),
      ...TRIGGER_KINDS,
    ])
      expect(docs).toContain(`\`${name}\``);
  });

  // #833-M1-T243
  it("names the reserved kinds, the cap of the loop and the default budget", () => {
    for (const text of [
      "forEach",
      "approval",
      "`workflow`",
      "1 to 10",
      "20 when left out",
    ])
      expect(docs).toContain(text);
  });

  // #833-M1-T360
  it("states the numbers the code keeps: workflows, versions, errors in an answer, rounds of a loop", () => {
    for (const text of [
      `${WORKFLOWS_PER_WORKSPACE_MAX} workflows`,
      `${VERSIONS_PER_WORKFLOW_MAX} versions`,
      `**${ERRORS_MAX} errors at most**`,
      `from **1 to ${LOOP_ROUNDS_MAX}**`,
    ])
      expect(docs).toContain(text);
  });
});
