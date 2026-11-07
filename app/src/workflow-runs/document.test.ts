// SPDX-License-Identifier: LicenseRef-Proprietary

// #844: the workflow document as the engine reads it.
import { describe, expect, it } from "vitest";
import { forTrigger, readRunDocument, triggerOf } from "./document.ts";

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
      triggers: [{ id: "manual", kind: "manual", steps: [] }],
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

const LANE = {
  version: 1,
  name: "lane",
  triggers: [
    { id: "labeled", kind: "ticket.labeled", label: "go", steps: [] },
    {
      id: "by-hand",
      kind: "manual",
      input: { type: "object" },
      steps: [{ id: "mark", kind: "action" }],
    },
    { id: "old", kind: "github.issueLabeled", label: "stop" },
  ],
  steps: [{ id: "a", kind: "agent" }],
};

describe("the triggers of a document (#916)", () => {
  // #916-T90
  it("reads the list of triggers with their pre-steps, the old name of the label trigger as the new one", () => {
    const document = readRunDocument(JSON.stringify(LANE));

    expect(document?.triggers).toEqual([
      { id: "labeled", kind: "ticket.labeled", label: "go", steps: [] },
      {
        id: "by-hand",
        kind: "manual",
        input: { type: "object" },
        steps: [{ id: "mark", kind: "action" }],
      },
      { id: "old", kind: "ticket.labeled", label: "stop", steps: [] },
    ]);
    expect(document?.steps.map((step) => step.id)).toEqual(["a"]);
  });

  // #916-T91
  it("reads the single trigger of before as a list of one without pre-steps, with the id of its kind", () => {
    const labeled = readRunDocument(
      JSON.stringify({
        ...GOOD,
        trigger: { kind: "github.issueLabeled", label: "go" },
      }),
    );

    expect(labeled?.triggers).toEqual([
      { id: "labeled", kind: "ticket.labeled", label: "go", steps: [] },
    ]);
  });

  // #916-T92
  it("puts the pre-steps of the trigger that fired in front of the shared steps, and finds the trigger of an old run by its kind", () => {
    const document = readRunDocument(JSON.stringify(LANE));
    if (document === undefined) throw new Error("not read");

    const ids = (ref: { id: string | null; kind: string }) =>
      forTrigger(document, ref)?.steps.map((step) => step.id);
    expect(ids({ id: "by-hand", kind: "manual" })).toEqual(["mark", "a"]);
    expect(ids({ id: "labeled", kind: "ticket.labeled" })).toEqual(["a"]);
    // A run written before triggers had ids: the first trigger of its kind, whichever name the row has.
    expect(ids({ id: null, kind: "manual" })).toEqual(["mark", "a"]);
    expect(
      triggerOf(document, { id: null, kind: "github.issueLabeled" })?.id,
    ).toBe("labeled");
    expect(ids({ id: "gone", kind: "manual" })).toBeUndefined();
    expect(ids({ id: null, kind: "schedule" })).toBeUndefined();
  });

  // #916-T93
  it("answers undefined for a list that is not usable", () => {
    for (const triggers of [
      [],
      "no",
      [null],
      [{ kind: "manual" }],
      [{ id: "x", kind: "cron" }],
      [{ id: "x", kind: "manual", steps: "no" }],
      [{ id: "x", kind: "manual", steps: [{ id: 1, kind: "agent" }] }],
    ])
      expect(
        readRunDocument(
          JSON.stringify({ ...GOOD, trigger: undefined, triggers }),
        ),
      ).toBeUndefined();
  });
});
