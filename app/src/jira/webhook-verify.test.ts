// SPDX-License-Identifier: LicenseRef-Proprietary

// How a delivery of a Jira dynamic webhook is verified (#1039): the per-registration secret in the URL, and Atlassian's bearer token
// (signed with the app's client secret) when the delivery carries one.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveWebhookSecret,
  hashWebhookSecret,
  newWebhookSecret,
  verifyJiraDelivery,
} from "./webhook-verify.ts";

const CLIENT_SECRET = "the-client-secret";
const NOW = new Date("2026-11-14T12:00:00Z");

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(
  claims: Record<string, unknown>,
  options: { alg?: string; secret?: string; headerAlg?: string } = {},
) {
  const alg = options.alg ?? "HS256";
  const head = b64({ alg: options.headerAlg ?? alg, typ: "JWT" });
  const body = b64(claims);
  const hmac =
    alg === "none"
      ? ""
      : createHmac(
          alg === "HS512" ? "sha512" : alg === "HS384" ? "sha384" : "sha256",
          options.secret ?? CLIENT_SECRET,
        )
          .update(`${head}.${body}`)
          .digest("base64url");
  return `${head}.${body}.${hmac}`;
}

const secret = newWebhookSecret();
const stored = hashWebhookSecret(secret);
const verify = (over: Partial<Parameters<typeof verifyJiraDelivery>[0]> = {}) =>
  verifyJiraDelivery({
    urlSecret: secret,
    storedSecretHash: stored,
    authorization: null,
    clientSecret: CLIENT_SECRET,
    now: NOW,
    ...over,
  });

describe("the secret of a registration", () => {
  // #1039-T02
  it("is long, random and only its hash is compared", () => {
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newWebhookSecret()).not.toBe(secret);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toContain(secret);
  });
});

describe("verifyJiraDelivery", () => {
  // #1039-T01
  it("accepts a delivery with the right URL secret and no bearer token", () => {
    expect(verify()).toEqual({ ok: true, bearer: "absent" });
  });

  // #1039-T02
  it("refuses a missing or wrong URL secret", () => {
    expect(verify({ urlSecret: null })).toEqual({
      ok: false,
      reason: "secret_missing",
    });
    expect(verify({ urlSecret: newWebhookSecret() })).toEqual({
      ok: false,
      reason: "secret_mismatch",
    });
    expect(verify({ urlSecret: "" })).toMatchObject({ ok: false });
  });

  // #1039-T02
  it("accepts a bearer token signed with the client secret", () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 300;
    for (const alg of ["HS256", "HS384", "HS512"])
      expect(
        verify({ authorization: `Bearer ${jwt({ exp }, { alg })}` }),
      ).toEqual({ ok: true, bearer: "verified" });
  });

  // #1039-T02
  it("refuses a bearer token that is signed with another secret, unsigned, of another algorithm, expired or no token", () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 300;
    const past = Math.floor(NOW.getTime() / 1000) - 3600;
    const cases: [string, string][] = [
      ["bearer_invalid", `Bearer ${jwt({ exp }, { secret: "other" })}`],
      ["bearer_invalid", `Bearer ${jwt({ exp }, { alg: "none" })}`],
      ["bearer_invalid", `Bearer ${jwt({ exp }, { headerAlg: "RS256" })}`],
      ["bearer_expired", `Bearer ${jwt({ exp: past })}`],
      ["bearer_invalid", "Bearer not.a.jwt"],
      ["bearer_invalid", "Bearer"],
      ["bearer_invalid", "Basic abc"],
    ];
    for (const [reason, authorization] of cases)
      expect(verify({ authorization })).toEqual({ ok: false, reason });
  });

  // #1039-T02
  it("does not let a good bearer token stand in for the URL secret", () => {
    const exp = Math.floor(NOW.getTime() / 1000) + 300;
    expect(
      verify({ urlSecret: null, authorization: `Bearer ${jwt({ exp })}` }),
    ).toEqual({ ok: false, reason: "secret_missing" });
  });
});

describe("trust on first use of the bearer token", () => {
  const exp = Math.floor(NOW.getTime() / 1000) + 300;
  const seconds = Math.floor(NOW.getTime() / 1000);

  // #1039
  it("refuses a delivery without a token once a token was seen for the registration, and still accepts one without while none was", () => {
    expect(verify({ bearerSeen: false })).toEqual({
      ok: true,
      bearer: "absent",
    });
    expect(verify({ bearerSeen: true })).toEqual({
      ok: false,
      reason: "bearer_missing",
    });
    expect(
      verify({ bearerSeen: true, authorization: `Bearer ${jwt({ exp })}` }),
    ).toEqual({ ok: true, bearer: "verified" });
  });

  // #1039
  it("refuses an invalid token whether or not one was seen before", () => {
    const bad = `Bearer ${jwt({ exp }, { secret: "other" })}`;
    for (const bearerSeen of [false, true])
      expect(verify({ bearerSeen, authorization: bad })).toEqual({
        ok: false,
        reason: "bearer_invalid",
      });
  });

  // #1039
  it("accepts a token without `exp` (its signature proves the client secret) and counts it as a token seen", () => {
    expect(verify({ authorization: `Bearer ${jwt({})}` })).toEqual({
      ok: true,
      bearer: "verified",
    });
  });

  // #1039
  it("refuses a token issued or valid only in the future beyond the clock skew and accepts one within it", () => {
    expect(
      verify({ authorization: `Bearer ${jwt({ exp, iat: seconds + 30 })}` }),
    ).toMatchObject({ ok: true });
    expect(
      verify({ authorization: `Bearer ${jwt({ exp, iat: seconds + 600 })}` }),
    ).toEqual({ ok: false, reason: "bearer_not_yet_valid" });
    expect(
      verify({ authorization: `Bearer ${jwt({ exp, nbf: seconds + 600 })}` }),
    ).toEqual({ ok: false, reason: "bearer_not_yet_valid" });
  });

  // #1039
  it("takes either the current secret or the pending one of a registration under way", () => {
    const next = newWebhookSecret();
    const both = { pendingSecretHash: hashWebhookSecret(next) };
    expect(verify({ ...both, urlSecret: next })).toMatchObject({ ok: true });
    expect(verify({ ...both, urlSecret: secret })).toMatchObject({ ok: true });
    expect(verify({ ...both, urlSecret: newWebhookSecret() })).toMatchObject({
      ok: false,
    });
  });
});

describe("the derived secret of the address of a connection (#1131)", () => {
  // #1131-T09
  it("is the same for one connection and generation and differs between connections, generations and app secrets", () => {
    const secret = deriveWebhookSecret("app-secret", "conn-1", 1);
    expect(deriveWebhookSecret("app-secret", "conn-1", 1)).toBe(secret);
    expect(deriveWebhookSecret("app-secret", "conn-2", 1)).not.toBe(secret);
    expect(deriveWebhookSecret("app-secret", "conn-1", 2)).not.toBe(secret);
    expect(deriveWebhookSecret("another-app-secret", "conn-1", 1)).not.toBe(
      secret,
    );
    // 256 bits, safe in a query string, and not a prefix of the input.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).not.toContain("app-secret");
  });

  // #1131-T09
  it("cannot be built by joining the connection and the generation another way", () => {
    expect(deriveWebhookSecret("s", "a", 11)).not.toBe(
      deriveWebhookSecret("s", "a1", 1),
    );
  });

  // #1131-T03
  it("verifies against the hash of the derived secret like any other secret", () => {
    const secret = deriveWebhookSecret("app-secret", "conn-1", 1);
    const base = {
      storedSecretHash: hashWebhookSecret(secret),
      authorization: null,
      clientSecret: CLIENT_SECRET,
      now: NOW,
    };
    expect(verifyJiraDelivery({ ...base, urlSecret: secret })).toEqual({
      ok: true,
      bearer: "absent",
    });
    expect(
      verifyJiraDelivery({
        ...base,
        urlSecret: deriveWebhookSecret("app-secret", "conn-1", 2),
      }),
    ).toEqual({ ok: false, reason: "secret_mismatch" });
  });
});
