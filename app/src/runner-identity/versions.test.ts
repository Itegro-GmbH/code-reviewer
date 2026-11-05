// SPDX-License-Identifier: LicenseRef-Proprietary

// The minimum version of the base (#854).
import { describe, expect, it } from "vitest";
import { meetsMinimum } from "./versions.ts";

describe("the minimum version of the base", () => {
  // #854-T20
  it.each([
    ["1.4.0", "1.4.0", true],
    ["1.4.1", "1.4.0", true],
    ["1.5.0", "1.4.9", true],
    ["2.0.0", "1.99.99", true],
    ["1.3.9", "1.4.0", false],
    ["0.9.9", "1.0.0", false],
    ["1.10.0", "1.9.0", true],
    ["1.9.0", "1.10.0", false],
  ])("compares %s with %s numerically: %s", (version, minimum, enough) => {
    expect(meetsMinimum(version, minimum)).toBe(enough);
  });

  // #854-T21
  it("puts a pre-release below its release and above every smaller one", () => {
    expect(meetsMinimum("1.4.0-rc1", "1.4.0")).toBe(false);
    expect(meetsMinimum("1.4.0", "1.4.0-rc1")).toBe(true);
    expect(meetsMinimum("1.4.1-rc1", "1.4.0")).toBe(true);
    expect(meetsMinimum("1.4.0-rc2", "1.4.0-rc1")).toBe(true);
  });

  // #854-T22
  it("does not count a version that is not of the form, on either side", () => {
    expect(meetsMinimum("latest", "1.0.0")).toBe(false);
    expect(meetsMinimum("1.0", "1.0.0")).toBe(false);
    expect(meetsMinimum("1.0.0", "x")).toBe(false);
    expect(meetsMinimum("", "")).toBe(false);
  });
});
