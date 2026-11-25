// SPDX-License-Identifier: LicenseRef-Proprietary

// Makes `guide.generated.json` from `docs/workflows.md`, `contracts/workflow.v1.json`, `contracts/result-schema.v1.json` and the example
// workflow of the contract. Run by `pnpm lane-guide:generate` (cli.ts) and by the drift test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitGuide, type GuideSection } from "./guide.ts";

export type GuideData = {
  /** Says where the file comes from, for a person who opens it. */
  generatedBy: string;
  intro: string;
  sections: GuideSection[];
  workflowSchema: unknown;
  resultSchema: unknown;
  example: unknown;
};

export const GENERATED_FILE = "guide.generated.json";

export function generateGuideData(repositoryRoot: string): GuideData {
  const read = (...path: string[]) =>
    readFileSync(join(repositoryRoot, ...path), "utf8");
  const guide = splitGuide(read("docs", "workflows.md"));
  return {
    generatedBy:
      "pnpm lane-guide:generate: docs/workflows.md, contracts/workflow.v1.json, contracts/result-schema.v1.json and contracts/examples/workflow/Workflow.json. Do not edit.",
    intro: guide.intro,
    sections: guide.sections,
    workflowSchema: JSON.parse(read("contracts", "workflow.v1.json")),
    resultSchema: JSON.parse(read("contracts", "result-schema.v1.json")),
    example: JSON.parse(
      read("contracts", "examples", "workflow", "Workflow.json"),
    ),
  };
}

export function renderGuideData(data: GuideData): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
