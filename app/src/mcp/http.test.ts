// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceAccess } from "../workspaces/access.ts";
import { createMcpRouteHandlers } from "./http.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the handlers of the MCP routes when the service fails", () => {
  // #1050-T01
  it("answers `unavailable` and logs the class of the error, never its text", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const handlers = createMcpRouteHandlers({
      serviceFor: () => {
        throw new TypeError("password=hunter2 at https://mcp.example.com/key");
      },
    });
    const access = {
      user: { id: "u-1" },
      workspace: { id: "w-1" },
      role: "owner",
    } as unknown as WorkspaceAccess;

    const response = await handlers.list(
      new Request("http://app.test/api/mcp"),
      access,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(lines).toEqual([
      "[mcp] MCP_UNAVAILABLE: the request was not served (TypeError).",
    ]);
  });
});
