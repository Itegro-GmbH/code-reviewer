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
    expect(codeOf("nope")).toBe("mcp_name_invalid");
  });

  // #1051-T01
  it("accepts OAuth without a client (the server registers itself) and with one entered by hand", () => {
    const parse = (auth: unknown, allowKeep = false) =>
      parseMcpServerInput(
        {
          name: "Linear",
          transport: "streamable-http",
          url: "https://mcp.example.com/mcp",
          auth,
        },
        { allowKeep, allowTestEndpoints: false },
      );

    expect(parse({ kind: "oauth" })).toMatchObject({
      ok: true,
      value: { auth: { kind: "oauth", client: null } },
    });
    expect(
      parse({ kind: "oauth", clientId: "", clientSecret: "" }),
    ).toMatchObject({
      ok: true,
      value: { auth: { kind: "oauth", client: null } },
    });
    expect(
      parse({
        kind: "oauth",
        clientId: "c-1",
        issuer: "https://auth.example.com/",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        auth: {
          client: {
            clientId: "c-1",
            issuer: "https://auth.example.com",
            secret: null,
          },
        },
      },
    });
    expect(
      parse({
        kind: "oauth",
        clientId: "c-1",
        issuer: "https://auth.example.com/",
        clientSecret: "s3cret",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        auth: { client: { clientId: "c-1", secret: { value: "s3cret" } } },
      },
    });
    expect(
      parse(
        {
          kind: "oauth",
          clientId: "c-1",
          issuer: "https://auth.example.com/",
          keepClientSecret: true,
        },
        true,
      ),
    ).toMatchObject({
      ok: true,
      value: { auth: { client: { secret: { keep: true } } } },
    });
  });

  it("refuses an OAuth client that is malformed, a secret without an id, and a kept secret on a new server", () => {
    const code = (auth: unknown, allowKeep = false) => {
      const result = parseMcpServerInput(
        {
          name: "Linear",
          transport: "streamable-http",
          url: "https://mcp.example.com/mcp",
          auth,
        },
        { allowKeep, allowTestEndpoints: false },
      );
      return result.ok ? "ok" : result.code;
    };

    expect(code({ kind: "oauth", clientSecret: "s" })).toBe(
      "mcp_oauth_client_invalid",
    );
    const issuer = "https://auth.example.com";
    expect(code({ kind: "oauth", clientId: "a b", issuer })).toBe(
      "mcp_oauth_client_invalid",
    );
    expect(code({ kind: "oauth", clientId: "x".repeat(513), issuer })).toBe(
      "mcp_oauth_client_invalid",
    );
    expect(code({ kind: "oauth", clientId: 7, issuer })).toBe(
      "mcp_oauth_client_invalid",
    );
    expect(
      code({
        kind: "oauth",
        clientId: "c",
        issuer,
        clientSecret: "line\nbreak",
      }),
    ).toBe("mcp_oauth_client_invalid");
    expect(
      code({ kind: "oauth", clientId: "c", issuer, keepClientSecret: true }),
    ).toBe("mcp_oauth_client_invalid");
    expect(
      code(
        {
          kind: "oauth",
          clientId: "c",
          issuer,
          clientSecret: "s",
          keepClientSecret: true,
        },
        true,
      ),
    ).toBe("mcp_oauth_client_invalid");
    // An issuer without a client is a form that contradicts itself.
    expect(code({ kind: "oauth", issuer })).toBe("mcp_oauth_client_invalid");
  });

  // #1051-T01
  it("requires the issuer of an OAuth client an Owner entered: https, no credentials, query or fragment", () => {
    const code = (auth: unknown, allowTestEndpoints = false) => {
      const result = parseMcpServerInput(
        {
          name: "Linear",
          transport: "streamable-http",
          url: "https://mcp.example.com/mcp",
          auth,
        },
        { allowKeep: false, allowTestEndpoints },
      );
      return result.ok ? "ok" : result.code;
    };
    const client = { kind: "oauth", clientId: "c", clientSecret: "s" };

    expect(code(client)).toBe("mcp_oauth_issuer_invalid");
    expect(code({ ...client, issuer: "not a url" })).toBe(
      "mcp_oauth_issuer_invalid",
    );
    for (const issuer of [
      "http://auth.example.com",
      "https://user:pw@auth.example.com",
      "https://auth.example.com?x=1",
      "https://auth.example.com#frag",
      "ftp://auth.example.com",
    ])
      expect(code({ ...client, issuer })).toBe("mcp_oauth_issuer_invalid");
    expect(code({ ...client, issuer: 7 })).toBe("mcp_oauth_issuer_invalid");
    // Plain http only for the test flag.
    expect(code({ ...client, issuer: "http://127.0.0.1:9" }, true)).toBe("ok");
    // The issuer is kept in the form discovery gives (no trailing slash, path kept).
    const parsed = parseMcpServerInput(
      {
        name: "Linear",
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
        auth: { ...client, issuer: " https://Auth.Example.com/tenant/ " },
      },
      { allowKeep: false, allowTestEndpoints: false },
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        auth: { client: { issuer: "https://auth.example.com/tenant" } },
      },
    });
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
