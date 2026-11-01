// SPDX-License-Identifier: LicenseRef-Proprietary

// The name the form prefills for the new branch (#756): `implementer/` and six lowercase letters or digits, and always a name the
// server accepts.
import { describe, expect, it } from "vitest";
import { checkBranchName } from "../branch-name.ts";
import { suggestBranchName } from "./branch-suggestion.ts";

describe("the suggested branch name", () => {
  // #756-T04
  it("is implementer/ and six random lowercase letters or digits", () => {
    for (let i = 0; i < 200; i += 1)
      expect(suggestBranchName()).toMatch(/^implementer\/[a-z0-9]{6}$/);
  });

  // #756-T04
  it("takes its characters from the random source it is given, so a test can pin them, and varies by default", () => {
    expect(suggestBranchName(() => 0)).toBe("implementer/aaaaaa");
    expect(suggestBranchName(() => 0.999999)).toBe("implementer/999999");
    const seen = new Set(Array.from({ length: 50 }, () => suggestBranchName()));
    expect(seen.size).toBeGreaterThan(40);
  });

  // #756-T04
  it("is a valid name for the rules of the server, whatever the base branch", () => {
    for (let i = 0; i < 100; i += 1) {
      const name = suggestBranchName();
      expect(checkBranchName(name, "main").ok).toBe(true);
      expect(checkBranchName(name, "implementer/abc123").ok).toBe(true);
    }
  });
});
