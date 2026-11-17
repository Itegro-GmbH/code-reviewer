// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { challengeOf, createPkce } from "./pkce.ts";

describe("PKCE", () => {
  it("derives the S256 challenge of RFC 7636 appendix B from a verifier", () => {
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("makes a verifier of 43 URL-safe characters whose challenge matches, and a different one each time", () => {
    const first = createPkce();
    const second = createPkce();

    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.challenge).toBe(challengeOf(first.verifier));
    expect(first.verifier).not.toBe(second.verifier);
  });
});
