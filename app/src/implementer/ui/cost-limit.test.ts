// SPDX-License-Identifier: LicenseRef-Proprietary

// The cost limit field of the Implementer form (#756): dollars as a person types them, whole cents as the route takes them, and
// a value above the operator's maximum is refused before anything is sent.
import { describe, expect, it } from "vitest";
import {
  costLimitPlaceholder,
  effectiveMaximumCents,
  parseCostLimit,
} from "./cost-limit.ts";

describe("the cost limit of a task", () => {
  // #756-T10
  it.each([
    ["", { ok: true, cents: null }],
    ["   ", { ok: true, cents: null }],
    ["2", { ok: true, cents: 200 }],
    ["1.50", { ok: true, cents: 150 }],
    [".5", { ok: true, cents: 50 }],
    ["$3", { ok: true, cents: 300 }],
    [" 0.01 ", { ok: true, cents: 1 }],
    ["5.00", { ok: true, cents: 500 }],
  ])("reads %j as %j", (text, expected) => {
    expect(parseCostLimit(text, 500)).toEqual(expected);
  });

  // #756-T10
  it.each([
    ["abc", "invalid"],
    ["1,50", "invalid"],
    ["-1", "invalid"],
    ["1.234", "invalid"],
    ["0", "invalid"],
    ["0.00", "invalid"],
    ["1e2", "invalid"],
  ])("refuses %j as not an amount", (text, code) => {
    expect(parseCostLimit(text, 500)).toEqual({ ok: false, code });
  });

  // #756-T10
  it("refuses an amount above the operator maximum and names the maximum, but accepts exactly the maximum", () => {
    expect(parseCostLimit("5.01", 500)).toEqual({
      ok: false,
      code: "above_maximum",
      maximumCents: 500,
    });
    expect(parseCostLimit("5.00", 500)).toEqual({ ok: true, cents: 500 });
    expect(parseCostLimit("100", 10_000)).toEqual({ ok: true, cents: 10_000 });
  });

  // #756-T10 (review of #793)
  it("shows and checks the lower of the operator's maximum and the route's $100, and names that maximum", () => {
    expect(effectiveMaximumCents(20_000)).toBe(10_000);
    expect(effectiveMaximumCents(500)).toBe(500);
    expect(parseCostLimit("150", 20_000)).toEqual({
      ok: false,
      code: "above_maximum",
      maximumCents: 10_000,
    });
    expect(parseCostLimit("100.01", 20_000)).toEqual({
      ok: false,
      code: "above_maximum",
      maximumCents: 10_000,
    });
    expect(parseCostLimit("100", 20_000)).toEqual({ ok: true, cents: 10_000 });
    expect(costLimitPlaceholder(20_000)).toBe("Max $100.00");
  });

  // #756-T10
  it("shows the maximum as the placeholder", () => {
    expect(costLimitPlaceholder(500)).toBe("Max $5.00");
    expect(costLimitPlaceholder(125)).toBe("Max $1.25");
  });
});
