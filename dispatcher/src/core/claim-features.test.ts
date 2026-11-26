// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  claimFeaturesForPlacements,
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
    expect(IMAGE_GATED_CLAIM_FEATURES).toEqual([
      "implementer_multi_repo",
      "implementer_workspace_token",
      "implementer_push_allowlist",
    ]);
  });

  // #1177-T76
  it("names implementer_push_allowlist only when the image lists it: an older snapshot never gets a turn of a step that names its branch", () => {
    expect(
      imageClaimFeatures("implementer_multi_repo,implementer_push_allowlist"),
    ).toEqual(["implementer_multi_repo", "implementer_push_allowlist"]);
    expect(imageClaimFeatures("implementer_multi_repo")).toEqual([
      "implementer_multi_repo",
    ]);
    // One claim may be given a job of either placement: Cloudflare's image must list it too.
    expect(
      claimFeaturesForPlacements(
        ["implementer_multi_repo", "implementer_push_allowlist"],
        ["implementer_multi_repo"],
        true,
      ),
    ).toEqual(["implementer_multi_repo", "placement_cloudflare"]);
  });

  // #1150-T19
  it("names implementer_workspace_token only when the image lists it: a snapshot built before it never gets a hosted turn on the token", () => {
    expect(
      imageClaimFeatures("implementer_ask,implementer_workspace_token"),
    ).toEqual(["implementer_workspace_token"]);
    expect(imageClaimFeatures("implementer_multi_repo")).toEqual([
      "implementer_multi_repo",
    ]);
    expect(imageClaimFeatures(undefined)).toEqual([]);
  });
});

describe("the claim features of a Dispatcher with the Cloudflare placement (#1158)", () => {
  // #1158-F01
  it("names placement_cloudflare and keeps the Vercel features only where the Cloudflare image lists them too", () => {
    expect(
      claimFeaturesForPlacements(
        ["implementer_multi_repo", "implementer_workspace_token"],
        ["implementer_workspace_token"],
        true,
      ),
    ).toEqual(["implementer_workspace_token", "placement_cloudflare"]);
    expect(
      claimFeaturesForPlacements(
        ["implementer_multi_repo"],
        ["implementer_multi_repo", "implementer_workspace_token"],
        true,
      ),
    ).toEqual(["implementer_multi_repo", "placement_cloudflare"]);
  });

  // #1158-F02
  it("names nothing of the placement and every Vercel feature when Cloudflare is not usable", () => {
    expect(
      claimFeaturesForPlacements(
        ["implementer_multi_repo"],
        ["implementer_multi_repo"],
        false,
      ),
    ).toEqual(["implementer_multi_repo"]);
  });

  // #1158-F03
  it("names the placement and no image feature when the Cloudflare image lists none or its list is unreadable", () => {
    expect(
      claimFeaturesForPlacements(["implementer_multi_repo"], undefined, true),
    ).toEqual(["placement_cloudflare"]);
    expect(
      claimFeaturesForPlacements(
        ["implementer_multi_repo"],
        "not valid,",
        true,
      ),
    ).toEqual(["placement_cloudflare"]);
  });
});
