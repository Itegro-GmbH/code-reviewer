// SPDX-License-Identifier: LicenseRef-Proprietary

// PKCE (RFC 7636), method S256 only: the verifier stays on the server with the state of the flow, the challenge goes to the authorization server.
import { createHash, randomBytes } from "node:crypto";

export type Pkce = { verifier: string; challenge: string };

/** The challenge of a verifier: `BASE64URL(SHA256(verifier))`. */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** A fresh verifier of 43 characters (32 random bytes, base64url) and its challenge. */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeOf(verifier) };
}
