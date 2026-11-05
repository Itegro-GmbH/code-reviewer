// SPDX-License-Identifier: LicenseRef-Proprietary

// The harness rule (#854): the platform's catalog holds OpenCode only.
import { describe, expect, it } from "vitest";
import {
  CATALOG_HARNESSES,
  harnessNeedsRunner,
  harnessOfProfile,
  isCatalogHarness,
  OPENCODE_HARNESS,
  readyHarnesses,
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

  // #854-T182
  it("are ready only as the runner announced them", () => {
    expect(
      readyHarnesses({
        harnesses: {
          opencode: { version: "1", ready: true },
          "claude-code": { version: "2", ready: false },
          "custom/x": { version: "3", ready: true },
        },
        capabilities: [],
      }),
    ).toEqual(["custom/x", "opencode"]);
    expect(readyHarnesses({ harnesses: {}, capabilities: [] })).toEqual([]);
  });
});
