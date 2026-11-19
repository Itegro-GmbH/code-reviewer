// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  IMAGE_GATED_CLAIM_FEATURES,
  imageClaimFeatures,
} from "./claim-features.ts";

describe("the claim features that depend on the Worker image", () => {
  // #1098-T03
  it("names implementer_multi_repo only when the image lists it", () => {
    expect(
      imageClaimFeatures("implementer_ask,implementer_multi_repo"),
    ).toEqual(["implementer_multi_repo"]);
    expect(imageClaimFeatures(["implementer_multi_repo"])).toEqual([
      "implementer_multi_repo",
    ]);
  });

  // #1098-T03
  it.each([
    ["no list (an old snapshot)", undefined],
    ["none", "none"],
    ["a list without it", "implementer_ask,implementer_mcp"],
    ["a list nobody can read", "implementer_multi_repo,not valid"],
  ])("names nothing for %s", (_name, list) => {
    expect(imageClaimFeatures(list)).toEqual([]);
  });

  // #1098-T03
  it("gates the claim features the contract has for the image and no others", () => {
    expect(IMAGE_GATED_CLAIM_FEATURES).toEqual(["implementer_multi_repo"]);
  });
});
