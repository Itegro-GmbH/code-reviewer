// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { landingWithOauth, oauthRequestIdOf } from "./oauth-return.ts";

const ID = "A".repeat(32);

describe("carrying an authorization request through the sign in", () => {
  // #1144-T190
  it("goes to the consent page of a well formed request after the sign in", () => {
    expect(landingWithOauth("/", ID)).toBe(`/oauth/consent?request=${ID}`);
  });

  // #1144-T191
  it("keeps the page that says what is missing for a person who may not use the app yet", () => {
    expect(landingWithOauth("/verify-email", ID)).toBe("/verify-email");
    expect(landingWithOauth("/no-access", ID)).toBe("/no-access");
  });

  // #1144-T192
  it.each([
    "https://evil.example/phish",
    "//evil.example",
    "/admin",
    "short",
    `${ID}&next=https://evil.example`,
    `${ID}x`,
    "",
    null,
    undefined,
    42,
  ])("carries nothing that is not a request id: %s", (value) => {
    expect(oauthRequestIdOf(value)).toBeNull();
    expect(landingWithOauth("/", value)).toBe("/");
  });
});
