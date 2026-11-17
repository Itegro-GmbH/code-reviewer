// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { identityFor } from "../../product-identity/identities.ts";
import { GENERIC_FAILURE } from "../../ui/transport-messages.ts";
import { MCP_ERROR_CODES, MCP_TEST_ERROR_CODES } from "../errors.ts";
import {
  describeMcpFailure,
  describeTestFailure,
  PAGE_COPY,
} from "./messages.ts";

const factory = identityFor("factory");

describe("the copy of the MCP page", () => {
  // #1050-T02
  it("has a sentence of its own for every error code of the routes, and none is the generic one", () => {
    for (const code of MCP_ERROR_CODES) {
      const sentence = describeMcpFailure(factory, { code });
      expect(sentence, code).not.toBe(GENERIC_FAILURE);
      expect(sentence.length, code).toBeGreaterThan(10);
    }
  });

  it("has a sentence of its own for every way a test can end", () => {
    for (const code of MCP_TEST_ERROR_CODES)
      expect(describeTestFailure(code), code).not.toBe("The test failed.");
    expect(describeTestFailure("mcp_test_from_the_future")).toBe(
      "The test failed.",
    );
    expect(describeTestFailure(null)).toBe("The test failed.");
  });

  // #1050-T03
  it("names the lanes of a server that is in use, with their projects", () => {
    expect(
      describeMcpFailure(factory, {
        code: "mcp_server_in_use",
        lanes: [
          { name: "Triage", projectName: "acme/app" },
          { name: "Review", projectName: null },
        ],
      }),
    ).toBe(PAGE_COPY.inUse("Triage (acme/app), Review"));
  });

  it("falls back to the transport sentences and the generic one for a code it does not know", () => {
    expect(describeMcpFailure(factory, { code: "NETWORK_ERROR" })).toContain(
      "could not be reached",
    );
    expect(describeMcpFailure(factory, { code: "WHATEVER" })).toBe(
      GENERIC_FAILURE,
    );
  });
});
