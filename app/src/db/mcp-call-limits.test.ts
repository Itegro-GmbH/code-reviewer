// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { MCP_MAX_CALLS_PER_CLAIM } from "../mcp/in-flight.ts";
import { MAX_MCP_CALLS_RECORDED_PER_JOB } from "./mcp-call-limits.ts";

describe("the MCP call record's bound", () => {
  // #1055-T03
  it("is the number of calls a claim may make, so a run inside its limit is listed whole", () => {
    expect(MAX_MCP_CALLS_RECORDED_PER_JOB).toBe(MCP_MAX_CALLS_PER_CLAIM);
  });
});
