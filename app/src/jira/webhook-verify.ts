// SPDX-License-Identifier: LicenseRef-Proprietary

// How a delivery of a Jira dynamic webhook is verified (#1039). What Atlassian documents for webhooks that an OAuth 2.0 (3LO) app registers
// through the REST API: "Webhooks for OAuth 2.0 apps are secured by bearer authentication. The token is present in the Authorization header
// and is signed with the app's client secret." The documentation names neither the algorithm nor the claims, and it documents no HMAC
// signature (`X-Hub-Signature`) for these webhooks (the `secret` field belongs to admin webhooks). Atlassian's developer community reports
// that OAuth-registered webhooks carry neither. So the factory does not rest on that token alone:
//
//  1. The registered address carries an unguessable secret of its own, one per registration (`newWebhookSecret`, 256 bits; only its SHA-256
//     is stored, `hashWebhookSecret`). A delivery without it, or with another one, is refused. This is the check that always applies.
//  2. When the delivery carries a bearer token, it must be a JWT (HS256, HS384 or HS512, never `none` or an asymmetric algorithm) signed with
//     the app's client secret, and not expired when it has an `exp`. A token that does not verify refuses the delivery, as Atlassian's
//     documentation asks ("Remember to verify the token"). A delivery without a token is accepted on the secret alone.
//
// Pure: no database, no network. Comparisons are constant time.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** A new secret for the address of a registration: 32 random bytes, base64url (43 characters). */
export const newWebhookSecret = (): string =>
  randomBytes(32).toString("base64url");

/** What is stored of a secret. A secret is random and long, so a plain SHA-256 is enough (nothing to brute-force). */
export const hashWebhookSecret = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");

export type JiraDeliveryRefusal =
  "secret_missing" | "secret_mismatch" | "bearer_invalid" | "bearer_expired";

export type JiraDeliveryVerdict =
  | { ok: true; bearer: "verified" | "absent" }
  | { ok: false; reason: JiraDeliveryRefusal };

export type VerifyDeliveryInput = {
  /** The secret the request's address carried, null for none. */
  urlSecret: string | null;
  /** The hash stored for the registration the address names. */
  storedSecretHash: string;
  /** The `Authorization` header, null for none. */
  authorization: string | null;
  /** The client secret of the factory's Atlassian app. */
  clientSecret: string;
  now: Date;
};

const HMAC_ALGORITHMS: Record<string, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

/** Seconds of clock difference between Atlassian and the server that an `exp` may be off by. */
const CLOCK_SKEW_SECONDS = 60;

function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeJson(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    );
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function verifyBearer(
  authorization: string,
  clientSecret: string,
  now: Date,
): "verified" | "invalid" | "expired" {
  const match =
    /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(
      authorization,
    );
  if (match === null) return "invalid";
  const [, head, body, signature] = match as unknown as [
    string,
    string,
    string,
    string,
  ];
  const header = decodeJson(head);
  const algorithm =
    typeof header?.alg === "string" ? HMAC_ALGORITHMS[header.alg] : undefined;
  if (algorithm === undefined) return "invalid";
  const expected = createHmac(algorithm, clientSecret)
    .update(`${head}.${body}`)
    .digest();
  if (!sameBytes(expected, Buffer.from(signature, "base64url")))
    return "invalid";
  const claims = decodeJson(body);
  if (claims === undefined) return "invalid";
  if (
    typeof claims.exp === "number" &&
    claims.exp + CLOCK_SKEW_SECONDS < now.getTime() / 1000
  )
    return "expired";
  return "verified";
}

export function verifyJiraDelivery(
  input: VerifyDeliveryInput,
): JiraDeliveryVerdict {
  if (input.urlSecret === null || input.urlSecret === "")
    return { ok: false, reason: "secret_missing" };
  const given = Buffer.from(hashWebhookSecret(input.urlSecret), "hex");
  const stored = Buffer.from(input.storedSecretHash, "hex");
  if (!sameBytes(given, stored))
    return { ok: false, reason: "secret_mismatch" };

  if (input.authorization === null) return { ok: true, bearer: "absent" };
  const bearer = verifyBearer(
    input.authorization,
    input.clientSecret,
    input.now,
  );
  if (bearer === "verified") return { ok: true, bearer };
  return {
    ok: false,
    reason: bearer === "expired" ? "bearer_expired" : "bearer_invalid",
  };
}
