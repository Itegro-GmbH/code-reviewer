// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { formatScopeList, parseScopeList, scopeSatisfies } from "./scopes.ts";

describe("scopes", () => {
  // #1144-T01
  it("reads a list of our scopes and refuses anything else", () => {
    expect(parseScopeList("factory:read factory:control")).toEqual([
      "factory:read",
      "factory:control",
    ]);
    expect(parseScopeList("  factory:read   factory:read ")).toEqual([
      "factory:read",
    ]);
    expect(parseScopeList("")).toEqual([]);
    expect(parseScopeList(null)).toEqual([]);
    expect(parseScopeList("factory:read admin")).toBeNull();
    expect(parseScopeList("openid")).toBeNull();
  });

  // #1144-T02
  it("formats in the fixed order", () => {
    expect(formatScopeList(["factory:control", "factory:read"])).toBe(
      "factory:read factory:control",
    );
  });

  // #1144-T03
  it("lets control do what read does, and never the other way round", () => {
    expect(scopeSatisfies(["factory:control"], "factory:read")).toBe(true);
    expect(scopeSatisfies(["factory:control"], "factory:control")).toBe(true);
    expect(scopeSatisfies(["factory:read"], "factory:read")).toBe(true);
    expect(scopeSatisfies(["factory:read"], "factory:control")).toBe(false);
    expect(scopeSatisfies([], "factory:read")).toBe(false);
  });
});
