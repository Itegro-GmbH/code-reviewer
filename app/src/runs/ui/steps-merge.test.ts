// SPDX-License-Identifier: LicenseRef-Proprietary

// How the timeline keeps the agent's parts (#745, live view): the merge by part id, the cut into model calls, the newest calls
// that are rendered, the mark of a cut text and the sign of a shortened turn.
import { describe, expect, it } from "vitest";
import type { StepView } from "../steps-view.ts";
import {
  groupDurationMs,
  groupSteps,
  isShortened,
  mergeSteps,
  newestGroups,
  splitCut,
} from "./steps-merge.ts";

const part = (
  partId: string,
  seq: number,
  extra: Partial<StepView> = {},
): StepView => ({
  partId,
  seq,
  ordinal: seq,
  kind: "text",
  text: partId,
  ...extra,
});
const end = (partId: string, seq: number, extra: Partial<StepView> = {}) =>
  part(partId, seq, {
    kind: "step",
    tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    ...extra,
  });

describe("mergeSteps", () => {
  // #745-T60
  it("keeps a part once and puts a newer record in the place of the older one", () => {
    const tool = part("prt_t", 1, { kind: "tool", status: "running" });
    const later = part("prt_x", 2);
    const done = { ...tool, seq: 3, status: "completed" };

    const merged = mergeSteps([tool, later], [done]);

    expect(merged.map((s) => [s.partId, s.status])).toEqual([
      ["prt_t", "completed"],
      ["prt_x", undefined],
    ]);
  });

  // #745-T60
  it("ignores a record that is not newer: an answer that comes twice or late changes nothing", () => {
    const done = part("prt_t", 3, { kind: "tool", status: "completed" });
    const stale = { ...done, seq: 1, status: "running" };

    expect(mergeSteps([done], [stale])).toEqual([done]);
    expect(mergeSteps([done], [done])).toEqual([done]);
  });

  // #745-T60
  it("keeps the order the parts began in, whatever order the pages came in", () => {
    const merged = mergeSteps(
      [part("prt_b", 2)],
      [part("prt_c", 3), part("prt_a", 1)],
    );

    expect(merged.map((s) => s.partId)).toEqual(["prt_a", "prt_b", "prt_c"]);
  });

  it("returns a copy when there is nothing to merge", () => {
    const before = [part("prt_a", 1)];

    const merged = mergeSteps(before, []);

    expect(merged).toEqual(before);
    expect(merged).not.toBe(before);
  });
});

describe("groupSteps", () => {
  // #745-T61
  it("cuts the parts into model calls at each step record and leaves the last call open", () => {
    const groups = groupSteps([
      part("a", 1, { kind: "reasoning" }),
      part("b", 2),
      end("c", 3),
      part("d", 4, { kind: "tool" }),
      end("e", 5),
      part("f", 6),
    ]);

    expect(
      groups.map((g) => [
        g.number,
        g.items.map((i) => i.partId),
        g.end?.partId,
      ]),
    ).toEqual([
      [1, ["a", "b"], "c"],
      [2, ["d"], "e"],
      [3, ["f"], undefined],
    ]);
  });

  it("makes no call out of nothing", () => {
    expect(groupSteps([])).toEqual([]);
  });

  it("times a call from its first part to its end", () => {
    const [group] = groupSteps([
      part("a", 1, { startedAt: 1_000, endedAt: 4_000 }),
      end("b", 2, { endedAt: 9_000 }),
    ]);

    expect(group && groupDurationMs(group)).toBe(8_000);
  });

  it("gives no time when the clocks are missing", () => {
    const [group] = groupSteps([part("a", 1), end("b", 2)]);

    expect(group && groupDurationMs(group)).toBeUndefined();
  });
});

describe("newestGroups", () => {
  const many = (count: number) =>
    groupSteps(
      Array.from({ length: count }, (_, i) => [
        part(`t${String(i)}`, 2 * i + 1),
        end(`e${String(i)}`, 2 * i + 2),
      ]).flat(),
    );

  // #745-T62
  it("renders the newest calls up to the cap and says how many are held back", () => {
    const { shown, hidden } = newestGroups(many(10), 6);

    expect(shown.map((g) => g.number)).toEqual([8, 9, 10]);
    expect(hidden).toBe(7);
  });

  // #745-T62
  it("renders everything below the cap and at least one call", () => {
    expect(newestGroups(many(3), 100)).toMatchObject({ hidden: 0 });
    expect(newestGroups(many(3), 100).shown).toHaveLength(3);
    expect(newestGroups(many(3), 1).shown.map((g) => g.number)).toEqual([3]);
  });
});

describe("splitCut", () => {
  // #745-T63
  it("takes the mark of the runner off a cut text and gives the size", () => {
    expect(splitCut("The start of it\n[1234 bytes cut]")).toEqual({
      body: "The start of it",
      cutBytes: 1234,
    });
  });

  // #745-T63
  it("leaves a text that only looks like the mark in the middle", () => {
    const text = "see [5 bytes cut] in the text\nand more";

    expect(splitCut(text)).toEqual({ body: text, cutBytes: null });
  });
});

describe("isShortened", () => {
  // #745-T63
  it("is true once a tool call is kept as name and status only", () => {
    const full = part("a", 1, { kind: "tool", input: "{}" });
    const bare = part("b", 2, { kind: "tool" });

    expect(isShortened([full])).toBe(false);
    expect(isShortened([full, bare])).toBe(true);
    expect(isShortened([part("c", 3)])).toBe(false);
  });
});
