// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Runs page reads of a stored part (#745, live view): plain text and numbers of the known kinds, nothing else.
import { describe, expect, it } from "vitest";
import type { StoredStep } from "../db/repositories/implementer-steps-repository.ts";
import { toStepView } from "./steps-view.ts";

const stored = (
  kind: string,
  payload: Record<string, unknown>,
): StoredStep => ({
  partId: "prt_1",
  seq: 4,
  ordinal: 2,
  kind,
  payload,
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:01.000Z",
});

describe("toStepView", () => {
  // #745-T64
  it("copies the known fields of a tool call", () => {
    const view = toStepView(
      stored("tool", {
        tool: "bash",
        status: "completed",
        title: "npm test",
        input: '{"command":"npm test"}',
        startedAt: 1000,
        endedAt: 13_000,
      }),
    );

    expect(view).toEqual({
      partId: "prt_1",
      seq: 4,
      ordinal: 2,
      kind: "tool",
      tool: "bash",
      status: "completed",
      title: "npm test",
      input: '{"command":"npm test"}',
      startedAt: 1000,
      endedAt: 13_000,
    });
  });

  // #745-T64
  it("leaves out fields of the wrong type and fields it does not know, and never passes an output on", () => {
    const view = toStepView(
      stored("tool", {
        tool: 7,
        status: "error",
        error: "boom",
        output: "the whole file",
        bytes: -1,
        startedAt: "yesterday",
        tokens: [],
        html: "<b>x</b>",
      }),
    );

    expect(view).toEqual({
      partId: "prt_1",
      seq: 4,
      ordinal: 2,
      kind: "tool",
      status: "error",
      error: "boom",
    });
  });

  // #745-T64
  it("reads the tokens of a model call and fills what is missing with zero", () => {
    const view = toStepView(
      stored("step", { tokens: { input: 10, output: "x" }, cost: 0.5 }),
    );

    expect(view).toMatchObject({
      kind: "step",
      cost: 0.5,
      tokens: {
        input: 10,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    });
  });

  // #745-T64
  it("skips a kind it does not know", () => {
    expect(toStepView(stored("diagram", { text: "x" }))).toBeUndefined();
  });

  // #745-T64
  it("cleans every text with the function it is given", () => {
    const view = toStepView(
      stored("text", { text: "key SECRET here" }),
      (text) => text.replace("SECRET", "[redacted]"),
    );

    expect(view?.text).toBe("key [redacted] here");
  });
});
