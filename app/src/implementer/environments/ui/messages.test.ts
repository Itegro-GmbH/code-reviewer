// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { identityFor } from "../../../product-identity/identities.ts";
import {
  ENVIRONMENT_ERROR_CODES,
  ENVIRONMENT_ISSUE_CODES,
  ENVIRONMENT_ISSUE_FIELDS,
} from "../errors.ts";
import { GENERIC_FAILURE } from "../../../ui/transport-messages.ts";
import { describeEnvironmentFailure, describeFieldIssue } from "./messages.ts";

const factory = identityFor("factory");

describe("the copy of the environments page", () => {
  // #818-T11
  it("has a sentence of its own for every error code of the routes, and none is the generic one", () => {
    for (const code of ENVIRONMENT_ERROR_CODES) {
      const sentence = describeEnvironmentFailure(factory, { code });
      expect(sentence, code).not.toBe(GENERIC_FAILURE);
      expect(sentence.length, code).toBeGreaterThan(10);
    }
  });

  // #818-T11
  it("has a sentence for every field and code of an invalid body", () => {
    const seen = new Set<string>();
    for (const field of ENVIRONMENT_ISSUE_FIELDS)
      for (const code of ENVIRONMENT_ISSUE_CODES) {
        const sentence = describeFieldIssue(field, code);
        expect(sentence, `${field} ${code}`).not.toBe(GENERIC_FAILURE);
        seen.add(sentence);
      }
    expect(seen.size).toBeGreaterThan(5);
  });

  // #818-T11
  it("names the maximum when the workspace is full and never puts a value of the answer in a sentence", () => {
    expect(
      describeEnvironmentFailure(factory, {
        code: "ENVIRONMENT_LIMIT_REACHED",
        maximum: 50,
      }),
    ).toContain("50");
    expect(
      describeEnvironmentFailure(factory, {
        code: "ENVIRONMENT_NAME_TAKEN",
        message: "<script>alert(1)</script>",
      } as never),
    ).not.toContain("<script>");
  });

  // #818-T11
  it("falls back to the transport sentences and the generic one for a code it does not know", () => {
    expect(
      describeEnvironmentFailure(factory, { code: "NETWORK_ERROR" }),
    ).toContain("could not be reached");
    expect(describeEnvironmentFailure(factory, { code: "WHATEVER" })).toBe(
      GENERIC_FAILURE,
    );
  });
});
