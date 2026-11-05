// SPDX-License-Identifier: LicenseRef-Proprietary

// The two secrets of a customer's runner (#854): the registration token a member of the workspace makes (short lived, usable once)
// and the credential the runner gets in exchange (its own, renewable, revocable). Both are 256 random bits; what the database keeps is
// a SHA-256 of them. A hash of 256 random bits cannot be turned back and leaks nothing about a near miss, so a fast hash is enough and
// the lookup is by hash. Neither value is ever logged.
import "server-only";
import { createHash, randomBytes } from "node:crypto";

export const REGISTRATION_TOKEN_PREFIX = "crt_";
export const REGISTRATION_TOKEN_PATTERN = /^crt_[A-Za-z0-9_-]{43}$/;
export const RUNNER_CREDENTIAL_PREFIX = "crc_";
export const RUNNER_CREDENTIAL_PATTERN = /^crc_[A-Za-z0-9_-]{43}$/;

/** How long a registration token can be exchanged. */
export const REGISTRATION_TOKEN_TTL_SECONDS = 3600;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Shown once, to the member who asked for it. */
export function newRegistrationToken(): string {
  return `${REGISTRATION_TOKEN_PREFIX}${randomToken()}`;
}

/** Shown once, in the answer of the exchange or the renewal. */
export function newRunnerCredential(): string {
  return `${RUNNER_CREDENTIAL_PREFIX}${randomToken()}`;
}

/** What the database stores for either secret. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}
