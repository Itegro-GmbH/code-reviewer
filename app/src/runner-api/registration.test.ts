// SPDX-License-Identifier: LicenseRef-Proprietary

// Which header is a customer's runner's (#854).
import { describe, expect, it } from "vitest";
import {
  newRegistrationToken,
  newRunnerCredential,
} from "../runner-identity/tokens.ts";
import { bearerRunnerCredential } from "./registration.ts";

describe("the credential of a customer's runner in a header", () => {
  // #854-T32
  it("is read from a bearer header only when it holds a runner credential", () => {
    const credential = newRunnerCredential();

    expect(bearerRunnerCredential(`Bearer ${credential}`)).toBe(credential);
    expect(bearerRunnerCredential(`bearer  ${credential}`)).toBe(credential);
    expect(bearerRunnerCredential(null)).toBeNull();
    expect(bearerRunnerCredential(credential)).toBeNull();
    expect(
      bearerRunnerCredential(`Bearer ${newRegistrationToken()}`),
    ).toBeNull();
    expect(bearerRunnerCredential("Bearer crj_" + "A".repeat(43))).toBeNull();
    expect(bearerRunnerCredential("Bearer a-shared-token")).toBeNull();
  });
});
