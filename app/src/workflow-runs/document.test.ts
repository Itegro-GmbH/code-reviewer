// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the workflow document as the engine reads it.
import { describe, expect, it } from "vitest";
import { readRunDocument } from "./document.ts";

const GOOD = {
  version: 1,
  name: "x",
  trigger: { kind: "manual" },
  steps: [{ id: "a", kind: "agent" }],
};

describe("the document of a run", () => {
  // #844-T210
  it("reads the nodes in order, with 20 USD when the document names no budget", () => {
    expect(readRunDocument(JSON.stringify(GOOD))).toMatchObject({
      budgetUsd: 20,
      trigger: { kind: "manual" },
      steps: [{ id: "a", kind: "agent" }],
    });
    expect(
      readRunDocument(JSON.stringify({ ...GOOD, budgetUsd: 2.5 }))?.budgetUsd,
    ).toBe(2.5);
  });

  // #844-T211
  it("answers undefined for text that is not a workflow, and never throws", () => {
    for (const text of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...GOOD, trigger: null }),
      JSON.stringify({ ...GOOD, trigger: {} }),
      JSON.stringify({ ...GOOD, steps: "no" }),
      JSON.stringify({ ...GOOD, steps: [{ id: 1, kind: "agent" }] }),
      JSON.stringify({ ...GOOD, steps: [null] }),
      JSON.stringify({ ...GOOD, budgetUsd: -1 }),
      JSON.stringify({ ...GOOD, budgetUsd: "20" }),
    ])
      expect(readRunDocument(text)).toBeUndefined();
  });
});
