// SPDX-License-Identifier: LicenseRef-Proprietary

// The secrets of a customer's runner (#854).
import { describe, expect, it } from "vitest";
import {
  hashSecret,
  newRegistrationToken,
  newRunnerCredential,
  REGISTRATION_TOKEN_PATTERN,
  RUNNER_CREDENTIAL_PATTERN,
} from "./tokens.ts";

describe("the registration token and the runner credential", () => {
  // #854-T30
  it("have the form the contract gives them, and are new each time", () => {
    const token = newRegistrationToken();
    const credential = newRunnerCredential();

    expect(token).toMatch(REGISTRATION_TOKEN_PATTERN);
    expect(credential).toMatch(RUNNER_CREDENTIAL_PATTERN);
    expect(newRegistrationToken()).not.toBe(token);
    expect(newRunnerCredential()).not.toBe(credential);
    // One cannot be taken for the other.
    expect(token).not.toMatch(RUNNER_CREDENTIAL_PATTERN);
    expect(credential).not.toMatch(REGISTRATION_TOKEN_PATTERN);
  });

  // #854-T31
  it("are kept as a hash that does not contain them", () => {
    const token = newRegistrationToken();

    expect(hashSecret(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret(token)).toBe(hashSecret(token));
    expect(hashSecret(token)).not.toContain(token.slice(4));
    expect(hashSecret(token)).not.toBe(hashSecret(newRegistrationToken()));
  });
});
