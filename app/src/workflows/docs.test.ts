// SPDX-License-Identifier: LicenseRef-Proprietary

// docs/workflows.md (#833) must not drift from the code: the first workflow in it is the example of the contract, every error code
// the validator and the routes can give has a row, and every connector and trigger is named.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import { WORKFLOW_ERROR_CODES } from "./errors.ts";
import { ISSUE_CODES } from "./issues.ts";
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
});
