// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  AGENT_RESULT_MAX_BYTES,
  AGENT_RESULT_MAX_DEPTH,
  AGENT_RESULT_MAX_VALUES,
  boundAgentResult,
} from "./agent-result.ts";

describe("the bounds of the result an agent hands in", () => {
  // #843-T90
  it("takes an object within the bounds and gives the compact JSON it is stored as", () => {
    const bounded = boundAgentResult({ summary: "ok", n: [1, 2, { a: null }] });

    expect(bounded).toEqual({
      ok: true,
      value: { summary: "ok", n: [1, 2, { a: null }] },
      text: '{"summary":"ok","n":[1,2,{"a":null}]}',
    });
  });

  // #843-T90
  it.each([[null], [[]], ["text"], [3], [undefined]])(
    "refuses %j: a result is an object",
    (value) => {
      expect(boundAgentResult(value)).toEqual({
        ok: false,
        reason: "not_an_object",
      });
    },
  );

  // #843-T91
  it("refuses a value nested deeper than the bound, however deep, without recursion", () => {
    let deep: unknown = {};
    for (let i = 0; i < 100_000; i += 1) deep = { a: deep };

    expect(boundAgentResult(deep)).toEqual({ ok: false, reason: "too_deep" });
    let edge: Record<string, unknown> = {};
    for (let i = 1; i < AGENT_RESULT_MAX_DEPTH; i += 1) edge = { a: edge };
    expect(boundAgentResult(edge).ok).toBe(true);
    expect(boundAgentResult({ a: edge })).toEqual({
      ok: false,
      reason: "too_deep",
    });
  });

  // #843-T91
  it("refuses a value of more values than the bound before it is serialised, however many keys it has", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 300_000 }, (_, i) => [`k${i}`, 1]),
    );
    const started = performance.now();

    expect(boundAgentResult(wide)).toEqual({
      ok: false,
      reason: "too_many_values",
    });
    expect(performance.now() - started).toBeLessThan(500);
    // The root, the list and the entries: the same count as the runner's (`test_finish_tool.py`), to the edge.
    const withEntries = (count: number) => ({
      findings: Array.from({ length: count }, () => 1),
    });
    expect(boundAgentResult(withEntries(AGENT_RESULT_MAX_VALUES - 2)).ok).toBe(
      true,
    );
    expect(boundAgentResult(withEntries(AGENT_RESULT_MAX_VALUES - 1))).toEqual({
      ok: false,
      reason: "too_many_values",
    });
    expect(boundAgentResult({ a: {}, b: [], c: [[], {}] }).ok).toBe(true);
  });

  // #843-T91
  it("refuses a value whose compact JSON is over the byte bound, counted in UTF-8", () => {
    const edge = AGENT_RESULT_MAX_BYTES - '{"t":""}'.length;

    expect(boundAgentResult({ t: "x".repeat(edge) }).ok).toBe(true);
    expect(boundAgentResult({ t: "x".repeat(edge + 1) })).toEqual({
      ok: false,
      reason: "too_large",
    });
    // Three bytes a character: a third of the characters is as large.
    expect(boundAgentResult({ t: "€".repeat(edge / 3 + 1) })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  // #843-T91
  it("refuses a number JSON does not have", () => {
    expect(boundAgentResult({ n: Number.POSITIVE_INFINITY })).toEqual({
      ok: false,
      reason: "not_json",
    });
    expect(boundAgentResult({ n: Number.NaN })).toEqual({
      ok: false,
      reason: "not_json",
    });
  });
});
