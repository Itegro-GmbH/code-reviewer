// SPDX-License-Identifier: LicenseRef-Proprietary

// The secrets of the OAuth server and the PKCE check. Every secret is 256 random bits with a prefix that names its kind (so a secret
// scanner and a person reading a log can tell what leaked); the database keeps only the SHA-256 of it, so a copy of the table is no
// credential. PKCE is S256 only (OAuth 2.1): the verifier's hash must equal the challenge of the authorization request.
import { REQUEST_ID_PATTERN } from "../../auth/oauth-return.ts";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const SECRET_PREFIXES = {
  access: "fmcp_at_",
  refresh: "fmcp_rt_",
  code: "fmcp_ac_",
} as const;
export type SecretKind = keyof typeof SECRET_PREFIXES;

/** A new secret of the kind, with its prefix; shown once, never stored. */
export function newSecret(kind: SecretKind): string {
  return `${SECRET_PREFIXES[kind]}${randomBytes(32).toString("base64url")}`;
}

/** What is stored in place of a secret: the SHA-256 in hex. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** Whether a presented value has the shape of a secret of this kind (a cheap check before the database is asked). */
export function looksLikeSecret(kind: SecretKind, value: string): boolean {
  return (
    value.startsWith(SECRET_PREFIXES[kind]) &&
    /^[A-Za-z0-9_-]{43}$/.test(value.slice(SECRET_PREFIXES[kind].length))
  );
}

/** The id of a pending authorization request: 192 random bits, in the address of the consent page. */
export function newRequestId(): string {
  return randomBytes(24).toString("base64url");
}

export { REQUEST_ID_PATTERN };

export function newRowId(): string {
  return randomUUID();
}

/** The S256 challenge of a verifier (RFC 7636 section 4.2). */
export function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** RFC 7636 section 4.1: 43 to 128 characters of the unreserved set. */
export const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

/** A challenge is the base64url of a SHA-256: exactly 43 characters. */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER_PATTERN.test(verifier)) return false;
  const expected = Buffer.from(s256Challenge(verifier));
  const given = Buffer.from(challenge);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
