// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  CAPABILITY_OF_REVIEW_KIND,
  createCapabilitySet,
  requiredCapability,
} from "./capability.ts";

describe("the requirements between capabilities", () => {
  // #747-T04
  it("makes implementer need dynamic-review, which needs review", () => {
    expect(requiredCapability("implementer")).toBe("dynamic-review");
    expect(requiredCapability("dynamic-review")).toBe("review");
    expect(requiredCapability("review")).toBeUndefined();
  });
});

describe("the job kinds a capability set allows", () => {
  // #747-T05
  it("maps the job kind implementer to the capability of the same name", () => {
    expect(CAPABILITY_OF_REVIEW_KIND.implementer).toBe("implementer");
  });

  // #747-T05
  it("allows the kind implementer only in a set that has the capability", () => {
    expect(
      createCapabilitySet([
        "review",
        "dynamic-review",
        "implementer",
      ]).allowsReviewKind("implementer"),
    ).toBe(true);
    for (const members of [
      ["review"],
      ["review", "dynamic-review"],
      ["review", "dynamic-review", "billing"],
    ] as const)
      expect(
        createCapabilitySet(members).allowsReviewKind("implementer"),
        members.join(","),
      ).toBe(false);
  });

  // #747-T05
  it("does not change what the other kinds need", () => {
    const withImplementer = createCapabilitySet([
      "review",
      "dynamic-review",
      "implementer",
    ]);
    expect(withImplementer.allowsReviewKind("diff")).toBe(true);
    expect(withImplementer.allowsReviewKind("dynamic")).toBe(true);
    const reviewOnly = createCapabilitySet(["review"]);
    expect(reviewOnly.allowsReviewKind("diff")).toBe(true);
    expect(reviewOnly.allowsReviewKind("dynamic")).toBe(false);
  });
});
