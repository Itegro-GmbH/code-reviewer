// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  hashSecret,
  looksLikeSecret,
  newSecret,
  s256Challenge,
  verifyPkce,
} from "./tokens.ts";

describe("secrets", () => {
  // #1144-T20
  it("makes distinct secrets with the prefix of their kind, and stores only a hash", () => {
    const first = newSecret("access");
    const second = newSecret("access");
    expect(first).not.toBe(second);
    expect(first.startsWith("fmcp_at_")).toBe(true);
    expect(newSecret("refresh").startsWith("fmcp_rt_")).toBe(true);
    expect(newSecret("code").startsWith("fmcp_ac_")).toBe(true);
    expect(looksLikeSecret("access", first)).toBe(true);
    expect(looksLikeSecret("refresh", first)).toBe(false);
    expect(hashSecret(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(first)).not.toContain(first);
  });
});

describe("PKCE", () => {
  // RFC 7636 appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  // #1144-T21
  it("computes the S256 challenge of the specification's example", () => {
    expect(s256Challenge(verifier)).toBe(challenge);
  });

  // #1144-T22
  it("accepts the matching verifier and nothing else", () => {
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(`${verifier.slice(0, -1)}A`, challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
    // The challenge itself is not a verifier that works.
    expect(verifyPkce(challenge, challenge)).toBe(false);
  });
});
