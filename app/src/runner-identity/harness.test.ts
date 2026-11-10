// SPDX-License-Identifier: LicenseRef-Proprietary

// The harness rule (#854): the platform's catalog holds OpenCode only.
import { describe, expect, it } from "vitest";
import {
  CATALOG_HARNESSES,
  harnessNeedsRunner,
  harnessOfProfile,
  isCatalogHarness,
  OPENCODE_HARNESS,
} from "./harness.ts";

describe("the harnesses", () => {
  // #854-T180
  it("hold only OpenCode in the catalog, and a profile that names none runs it", () => {
    expect(CATALOG_HARNESSES).toEqual(["opencode"]);
    expect(isCatalogHarness("opencode")).toBe(true);
    expect(isCatalogHarness("claude-code")).toBe(false);
    expect(harnessOfProfile()).toBe(OPENCODE_HARNESS);
    expect(harnessOfProfile({})).toBe(OPENCODE_HARNESS);
    expect(harnessOfProfile({ harness: "claude-code" })).toBe("claude-code");
  });

  // #854-T181
  it("need a runner when they are not OpenCode", () => {
    expect(harnessNeedsRunner("opencode")).toBe(false);
    expect(harnessNeedsRunner("claude-code")).toBe(true);
    expect(harnessNeedsRunner("custom/tool")).toBe(true);
  });
});
