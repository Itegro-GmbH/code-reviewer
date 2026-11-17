// SPDX-License-Identifier: LicenseRef-Proprietary

// The contract with #1052 (a lane names MCP servers): the key of the lane document is `mcp`. Removing a server is refused while a lane's
// document names it under this key, so #1052 has to write the field under exactly this name (or change the constant and this test together).
import { describe, expect, it } from "vitest";
import {
  MCP_LANE_DOCUMENT_KEY,
  mcpReferencesIn,
} from "../db/repositories/mcp-servers-repository.ts";

describe("the lane document key of the MCP servers a lane names", () => {
  // #1050-T03
  it("is `mcp`, and a server named under it is found at any depth", () => {
    expect(MCP_LANE_DOCUMENT_KEY).toBe("mcp");
    const document = {
      mcp: ["server-1"],
      steps: [{ mcp: [{ id: "server-2" }] }],
    };

    expect([...mcpReferencesIn(JSON.stringify(document))].sort()).toEqual([
      "server-1",
      "server-2",
    ]);
  });

  // #1050-T03
  it("does not read a server named under another key, so a lane that picked one cannot silently lose its protection", () => {
    for (const key of ["mcpServers", "mcp_servers", "servers", "MCP", "tools"])
      expect([
        ...mcpReferencesIn(JSON.stringify({ [key]: ["server-1"] })),
      ]).toEqual([]);
  });
});
