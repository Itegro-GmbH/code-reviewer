// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { mcpTestEndpointsAllowed } from "./config.ts";
import { checkMcpUrl } from "./url.ts";

const PRODUCTION = { allowTestEndpoints: false } as const;
const TEST = { allowTestEndpoints: true } as const;

describe("the address of an MCP server", () => {
  // #1050-T02
  it("accepts an https address of a public host and returns it normalised", () => {
    expect(checkMcpUrl(" https://MCP.example.com/mcp ", PRODUCTION)).toEqual({
      ok: true,
      url: "https://mcp.example.com/mcp",
    });
  });

  // #1050-T02
  it("refuses plain http in production, with its own code", () => {
    expect(checkMcpUrl("http://mcp.example.com/mcp", PRODUCTION)).toEqual({
      ok: false,
      code: "mcp_url_not_https",
    });
  });

  // #1050-T02
  it.each([
    "https://127.0.0.1/mcp",
    "https://localhost/mcp",
    "https://10.0.0.5/mcp",
    "https://192.168.1.10/mcp",
    "https://172.16.0.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/mcp",
    "https://[fd00::1]/mcp",
    "https://[::ffff:169.254.169.254]/mcp",
    "https://2130706433/mcp",
    "https://0x7f.1/mcp",
    "https://metadata.google.internal/mcp",
    "https://intranet/mcp",
    "https://service.local/mcp",
  ])("refuses the private or internal address %s", (address) => {
    expect(checkMcpUrl(address, PRODUCTION)).toEqual({
      ok: false,
      code: "mcp_url_private",
    });
  });

  it("refuses text that is no address, a scheme other than http(s), a fragment and a too long address", () => {
    for (const text of [
      "",
      "not a url",
      "ftp://mcp.example.com/",
      "file:///etc/passwd",
      "https://mcp.example.com/#frag",
      `https://mcp.example.com/${"a".repeat(2100)}`,
    ])
      expect(checkMcpUrl(text, PRODUCTION)).toEqual({
        ok: false,
        code: "mcp_url_invalid",
      });
  });

  it("refuses credentials and a query string in the address", () => {
    expect(checkMcpUrl("https://user:pw@mcp.example.com/", PRODUCTION)).toEqual(
      { ok: false, code: "mcp_url_credentials" },
    );
    expect(checkMcpUrl("https://mcp.example.com/?key=abc", PRODUCTION)).toEqual(
      { ok: false, code: "mcp_url_query" },
    );
  });

  // #1050-T02
  it("accepts plain http and this machine only behind the test flag, and never a private network", () => {
    expect(checkMcpUrl("http://127.0.0.1:8123/mcp", TEST)).toEqual({
      ok: true,
      url: "http://127.0.0.1:8123/mcp",
    });
    expect(checkMcpUrl("http://localhost:8123/sse", TEST).ok).toBe(true);
    expect(checkMcpUrl("http://10.0.0.5/mcp", TEST)).toEqual({
      ok: false,
      code: "mcp_url_private",
    });
    expect(checkMcpUrl("http://169.254.169.254/", TEST)).toEqual({
      ok: false,
      code: "mcp_url_private",
    });
  });

  it("lets a redirect target keep its query string", () => {
    expect(
      checkMcpUrl("https://mcp.example.com/mcp?session=1", {
        ...PRODUCTION,
        allowQuery: true,
      }).ok,
    ).toBe(true);
  });
});

describe("the test flag", () => {
  it("is on only for exactly `true`", () => {
    expect(mcpTestEndpointsAllowed({ ALLOW_TEST_MCP_ENDPOINTS: "true" })).toBe(
      true,
    );
    expect(
      mcpTestEndpointsAllowed({ ALLOW_TEST_MCP_ENDPOINTS: " true " }),
    ).toBe(true);
    for (const value of ["TRUE", "1", "yes", "", undefined])
      expect(mcpTestEndpointsAllowed({ ALLOW_TEST_MCP_ENDPOINTS: value })).toBe(
        false,
      );
  });
});
