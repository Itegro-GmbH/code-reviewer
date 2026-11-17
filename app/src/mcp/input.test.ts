// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { parseMcpServerInput } from "./input.ts";

const OPTIONS = { allowKeep: false, allowTestEndpoints: false } as const;

const valid = (overrides: Record<string, unknown> = {}) => ({
  name: "Linear",
  transport: "streamable-http",
  url: "https://mcp.example.com/mcp",
  auth: {
    kind: "header",
    headers: [{ name: "Authorization", value: "Bearer x" }],
  },
  ...overrides,
});

const headers = (list: unknown) =>
  valid({ auth: { kind: "header", headers: list } });

const codeOf = (
  raw: unknown,
  options: { allowKeep: boolean; allowTestEndpoints: boolean } = OPTIONS,
) => {
  const result = parseMcpServerInput(raw, options);
  return result.ok ? "ok" : result.code;
};

describe("the form of an MCP server", () => {
  it("accepts a server with one or more headers, and one without authentication", () => {
    expect(codeOf(valid())).toBe("ok");
    expect(
      codeOf(
        valid({
          auth: {
            kind: "header",
            headers: [
              { name: "X-Api-Key", value: "k" },
              { name: "X-Team", value: "t" },
            ],
          },
        }),
      ),
    ).toBe("ok");
    expect(codeOf(valid({ transport: "sse", auth: { kind: "none" } }))).toBe(
      "ok",
    );
  });

  it("refuses a bad name, transport, address and authentication, each with its own code", () => {
    expect(codeOf(valid({ name: "" }))).toBe("mcp_name_invalid");
    expect(codeOf(valid({ name: "a/b" }))).toBe("mcp_name_invalid");
    expect(codeOf(valid({ name: "x".repeat(65) }))).toBe("mcp_name_invalid");
    expect(codeOf(valid({ transport: "stdio" }))).toBe("mcp_transport_invalid");
    expect(codeOf(valid({ url: "http://mcp.example.com/" }))).toBe(
      "mcp_url_not_https",
    );
    expect(codeOf(valid({ url: "https://10.1.2.3/" }))).toBe("mcp_url_private");
    expect(codeOf(valid({ auth: { kind: "basic" } }))).toBe("mcp_auth_invalid");
    expect(codeOf(valid({ auth: { kind: "oauth" } }))).toBe(
      "mcp_auth_oauth_unavailable",
    );
    expect(codeOf("nope")).toBe("mcp_name_invalid");
  });

  it("refuses headers that are missing, too many, duplicated, forbidden or malformed", () => {
    expect(codeOf(headers([]))).toBe("mcp_headers_invalid");
    expect(codeOf(headers("x"))).toBe("mcp_headers_invalid");
    expect(
      codeOf(
        headers(
          Array.from({ length: 11 }, (_, index) => ({
            name: `X-${String(index)}`,
            value: "v",
          })),
        ),
      ),
    ).toBe("mcp_headers_invalid");
    expect(
      codeOf(
        headers([
          { name: "X-Key", value: "a" },
          { name: "x-key", value: "b" },
        ]),
      ),
    ).toBe("mcp_header_name_invalid");
    expect(codeOf(headers([{ name: "Bad Name", value: "a" }]))).toBe(
      "mcp_header_name_invalid",
    );
    for (const name of [
      "Host",
      "content-type",
      "Accept",
      "Mcp-Session-Id",
      "Proxy-Authorization",
      "Sec-Fetch-Mode",
    ])
      expect(codeOf(headers([{ name, value: "a" }]))).toBe(
        "mcp_header_name_forbidden",
      );
    for (const value of [
      "",
      "a\r\nX-Evil: 1",
      "a\nb",
      " padded ",
      "x".repeat(4097),
    ])
      expect(codeOf(headers([{ name: "X-Key", value }]))).toBe(
        "mcp_header_value_invalid",
      );
  });

  it("refuses a header value with a character a header cannot carry (above U+00FF, or a control character)", () => {
    for (const value of [
      "tok\u0151n",
      "tok\u20ac",
      "\u{1F511}",
      "a\u0085b",
      "a\u007fb",
    ])
      expect(codeOf(headers([{ name: "X-Key", value }]))).toBe(
        "mcp_header_value_invalid",
      );
    // Latin-1 text and a tab inside the value are fine.
    expect(codeOf(headers([{ name: "X-Key", value: "caf\u00e9\tau" }]))).toBe(
      "ok",
    );
  });

  it("lets an edit keep a header's stored value, and never a new server", () => {
    const keep = valid({
      auth: {
        kind: "header",
        headers: [{ name: "Authorization", keep: true }],
      },
    });
    expect(codeOf(keep, { ...OPTIONS, allowKeep: true })).toBe("ok");
    expect(codeOf(keep)).toBe("mcp_header_value_invalid");
  });

  it("accepts plain http to this machine only behind the test flag", () => {
    const local = valid({ url: "http://127.0.0.1:9999/mcp" });
    expect(codeOf(local)).toBe("mcp_url_not_https");
    expect(codeOf(local, { allowKeep: false, allowTestEndpoints: true })).toBe(
      "ok",
    );
  });
});
