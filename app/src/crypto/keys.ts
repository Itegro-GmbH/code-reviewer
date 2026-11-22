// SPDX-License-Identifier: LicenseRef-Proprietary

// Key derivation: one key per purpose, derived from `APP_SECRET` with HKDF-SHA256. No code uses the
// secret itself as a key (the one exception is Better Auth, which is given the secret as it is so
// that the sessions and the encrypted tokens of an installation from before `APP_SECRET` stay valid).
// A key per purpose means that a value signed for one purpose is worthless for another, and that
// the key that encrypts stored credentials is never the key that signs a cookie.
import { hkdfSync } from "node:crypto";

/**
 * Every use of the secret has a label. A new use adds a label here, never reuses one.
 * - `setup-session`: the signature of the cookie that carries the first-run wizard.
 * - `state-signing`: signed state values of round trips (for example to GitHub and back).
 * - `setup-code`: the keyed hash of the first-run setup code kept in the database of a serverless deployment.
 * - `secret-encryption`: AES-256-GCM of the credentials stored in the database.
 * - `jira-webhook-address`: the secret in the address of the Jira webhooks of a connection, derived per connection and generation (#1131).
 */
export const KEY_PURPOSES = [
  "setup-session",
  "state-signing",
  "secret-encryption",
  "setup-code",
  "jira-webhook-address",
] as const;
export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/** The version new secrets are encrypted with. Stored with every secret so a rotation can follow. */
export const CURRENT_KEY_VERSION = 1;

/** The key versions this build can derive a key for. */
export const SUPPORTED_KEY_VERSIONS: readonly number[] = [1];

// A fixed, public, application specific salt: HKDF does not need it to be secret, and the secret
// itself is the input key material.
const HKDF_SALT = Buffer.from("code-reviewer/hkdf-salt/v1", "utf8");
const KEY_LENGTH = 32;

/** The 32 byte key for a purpose (and key version) from the app secret. Deterministic. */
export function deriveKey(
  appSecret: string,
  purpose: KeyPurpose,
  keyVersion: number = CURRENT_KEY_VERSION,
): Buffer {
  const info = Buffer.from(`code-reviewer/${purpose}/v${keyVersion}`, "utf8");
  return Buffer.from(
    hkdfSync("sha256", appSecret, HKDF_SALT, info, KEY_LENGTH),
  );
}
