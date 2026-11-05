// SPDX-License-Identifier: LicenseRef-Proprietary

// The Engine section of docs/workflows.md (#844) must not drift from the code: every code a run, a step or a route can give has a row, and
// no row is left for a code that is gone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUN_FAILURE_CODES,
  STEP_FAILURE_CODES,
  WORKFLOW_RUN_ERROR_STATUS,
} from "./errors.ts";
import {
  MICRO_USD_PER_CENT,
  STEP_GIVE_UP_MS,
  TEMPLATE_VALUE_MAX_CHARS,
} from "./limits.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const docs = readFileSync(join(ROOT, "docs", "workflows.md"), "utf8");
const engine = docs.slice(
  docs.indexOf("\n## Engine\n"),
  docs.indexOf("\n## Error codes\n"),
);

function rows(start: string, end: string | undefined): string[][] {
  const from = engine.indexOf(start);
  if (from === -1) throw new Error(`the Engine section has no "${start}"`);
  const to = end === undefined ? engine.length : engine.indexOf(end, from);
  return [
    ...engine.slice(from, to).matchAll(/^\| `([A-Za-z_]+)` \| ([^|]+) \|/gm),
  ].map((match) => [match[1] as string, (match[2] as string).trim()]);
}

describe("the Engine section of docs/workflows.md", () => {
  // #844-T160
  it("has one row for each failure code of a run and of a step, each once, with the right owner", () => {
    const found = rows("### Failure codes", "### Errors of the run routes");

    expect(found.map(([code]) => code).toSorted()).toEqual(
      [...RUN_FAILURE_CODES, ...STEP_FAILURE_CODES].toSorted(),
    );
    for (const [code, owner] of found)
      expect(owner).toBe(
        (RUN_FAILURE_CODES as readonly string[]).includes(code)
          ? "run"
          : "step",
      );
  });

  // #844-T161
  it("has one row for each error code of the run routes, each once, with its status", () => {
    const found = rows("### Errors of the run routes", undefined);

    expect(found.map(([code]) => code).toSorted()).toEqual(
      Object.keys(WORKFLOW_RUN_ERROR_STATUS).toSorted(),
    );
    for (const [code, status] of found)
      expect(Number(status)).toBe(
        WORKFLOW_RUN_ERROR_STATUS[
          code as keyof typeof WORKFLOW_RUN_ERROR_STATUS
        ],
      );
  });

  // #844-T162
  it("states the numbers the code keeps", () => {
    for (const text of [
      `${TEMPLATE_VALUE_MAX_CHARS.toLocaleString("en-US")} characters`,
      `If the budget cannot pay one cent`.slice(0, 0),
      "20,000 characters",
      "an hour",
    ])
      expect(engine).toContain(text);
    expect(MICRO_USD_PER_CENT).toBe(10_000);
    expect(STEP_GIVE_UP_MS).toBe(60 * 60 * 1000);
  });

  // #844-T163
  it("names the routes, the pinned version and the idempotent request id", () => {
    for (const text of [
      "POST /api/w/<slug>/workflows/<id>/runs",
      "clientRequestId",
      "pinned",
      "start_implementer_task",
    ])
      expect(engine).toContain(text);
  });
});
