// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { normalizeHostEntry } from "./network.ts";
import { isSharedWildcard, SHARED_SUFFIXES } from "./shared-domains.ts";

describe("isSharedWildcard", () => {
  // #1126-T55
  it.each([
    "*.github.io",
    "*.pages.dev",
    "*.vercel.app",
    "*.githubusercontent.com",
    "*.co.uk",
    "*.com.au",
    "*.amazonaws.com",
  ])("refuses %s", (entry) => {
    expect(isSharedWildcard(entry)).toBe(true);
  });

  // #1126-T55
  it.each([
    "*.gstatic.com",
    "*.googleapis.com",
    "*.pythonhosted.org",
    "*.mine.github.io",
    "raw.githubusercontent.com",
    "github.io",
    "lateinorum.de",
  ])("takes %s", (entry) => {
    expect(isSharedWildcard(entry)).toBe(false);
  });

  // #1126-T55
  it("holds every suffix in the form a host entry is stored in", () => {
    for (const suffix of SHARED_SUFFIXES)
      expect(normalizeHostEntry(`*.${suffix}`)).toBe(`*.${suffix}`);
  });
});
