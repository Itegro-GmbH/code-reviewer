// SPDX-License-Identifier: LicenseRef-Proprietary

// The identity of each product and the way a deployment picks its own (#740). `PRODUCT_ID` is the one setting: the identity
// follows the product of the capability set (`capabilities/products.ts`), there is no second selector.
//
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CapabilityConfigError } from "../capabilities/shared.ts";
import { PRODUCT_IDS } from "../capabilities/products.ts";
import { getProductIdentity } from "./current.ts";
import { IDENTITIES, identityFor } from "./identities.ts";

describe("the identities of the products", () => {
  // #740-T03
  it("has one for every product of the capability set, and each says its own name", () => {
    expect(Object.keys(IDENTITIES).sort()).toEqual([...PRODUCT_IDS].sort());
    expect(identityFor("code-review-com").name).toBe("code-review.com");
    expect(identityFor("factory").name).toBe("Factory");
  });

  // #740-T02
  it("share no word of one product's brand with another", () => {
    const names = Object.values(IDENTITIES).flatMap((identity) => [
      identity.name,
      identity.mailSenderNamePlaceholder,
      identity.checkName,
      identity.githubAppName,
    ]);
    const factory = Object.values({ ...identityFor("factory") }).join(" ");

    expect(new Set(names).size).toBeGreaterThan(1);
    expect(factory).not.toMatch(/code-review\.com|code\s+reviewer/i);
  });

  // #757-T03
  it("name the QA area as each product calls it: Projects for code-review.com, QA for the factory", () => {
    expect(identityFor("code-review-com").qaAreaName).toBe("Projects");
    expect(identityFor("code-review-com").qaAreaNameInSentence).toBe(
      "projects",
    );
    expect(identityFor("factory").qaAreaName).toBe("QA");
    expect(identityFor("factory").qaAreaNameInSentence).toBe("QA");
    for (const identity of Object.values(IDENTITIES)) {
      expect(identity.qaAreaName.trim()).not.toBe("");
      expect(identity.qaAreaNameInSentence.trim()).not.toBe("");
    }
  });

  // #740-T04
  it("keep the name of the GitHub App short enough for the host to follow it", () => {
    for (const identity of Object.values(IDENTITIES))
      expect(identity.githubAppName.length).toBeLessThanOrEqual(20);
  });
});

describe("the identity of a deployment", () => {
  // #740-T03
  it("is code-review.com while PRODUCT_ID is not set", () => {
    expect(getProductIdentity({})).toBe(identityFor("code-review-com"));
    expect(getProductIdentity({ PRODUCT_ID: "" })).toBe(
      identityFor("code-review-com"),
    );
  });

  // #740-T03
  it("follows PRODUCT_ID", () => {
    expect(getProductIdentity({ PRODUCT_ID: "factory" })).toBe(
      identityFor("factory"),
    );
    expect(getProductIdentity({ PRODUCT_ID: "code-review-com" })).toBe(
      identityFor("code-review-com"),
    );
  });

  // #740-T03
  it("refuses an unknown product instead of guessing a brand", () => {
    expect(() =>
      getProductIdentity({ PRODUCT_ID: "software-factory" }),
    ).toThrow(CapabilityConfigError);
  });
});
