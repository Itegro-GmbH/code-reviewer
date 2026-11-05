// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boundAgentResult } from "../db/agent-result.ts";
import {
  checkResultValue,
  validateResultSchema,
  type ResultSchema,
} from "./result-schema.ts";

// The cases the runner's check of a result agrees on (`runner/tests/unit/test_finish_tool.py` reads the same file): the app and
// the runner hold the same rules, and this file is where a difference shows.
const VECTORS = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "contracts",
      "result-check-vectors.json",
    ),
    "utf8",
  ),
) as {
  schemas: { name: string; schema: unknown; valid: boolean }[];
  values: {
    name: string;
    schema: ResultSchema;
    value: unknown;
    issues: [string, string][];
  }[];
  bounds: { name: string; parts: [string, number][]; bound: string | null }[];
};

const pairs = (issues: { path: string; code: string }[]) =>
  issues.map((i) => `${i.path} ${i.code}`).sort();

describe("the vectors of the result check, shared with the runner", () => {
  // #843-T40
  it.each(VECTORS.schemas)("judges the schema: $name", (vector) => {
    expect(validateResultSchema(vector.schema).issues.length === 0).toBe(
      vector.valid,
    );
  });

  // #843-T40
  it.each(VECTORS.values)("checks the value: $name", (vector) => {
    const expected = vector.issues.map(([path, code]) => `${path} ${code}`);

    expect(pairs(checkResultValue(vector.schema, vector.value))).toEqual(
      expected.sort(),
    );
  });

  // #843-T42
  it.each(VECTORS.bounds)("bounds the value: $name", (vector) => {
    // The runner scans these same texts (`scan_bounds`); an agent result the runner lets through and the app refuses would be lost with
    // the report it arrives in.
    const text = vector.parts.map(([part, times]) => part.repeat(times)).join("");

    const bounded = boundAgentResult(JSON.parse(text));

    expect(bounded.ok ? null : bounded.reason).toBe(vector.bound);
  });

  // #843-T40
  it("holds schemas and values of both kinds", () => {
    expect(VECTORS.schemas.some((v) => v.valid)).toBe(true);
    expect(VECTORS.schemas.some((v) => !v.valid)).toBe(true);
    expect(VECTORS.values.some((v) => v.issues.length === 0)).toBe(true);
    expect(VECTORS.values.some((v) => v.issues.length > 0)).toBe(true);
  });
});
