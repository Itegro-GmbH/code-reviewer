// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type {
  CurrentMcpServer,
  StoredMcpServer,
} from "../db/repositories/mcp-servers-repository.ts";
import { parseMcpServerInput } from "./input.ts";
import { openHeaders, planMcpUpdate, sealHeaders } from "./service.ts";

const SECRET = "test-app-secret-for-mcp-service-unit-0123456789";
const ID = "server-1";

function stored(over: Partial<StoredMcpServer> = {}): StoredMcpServer {
  return {
    id: ID,
    workspaceId: "w-1",
    name: "Linear",
    transport: "streamable-http",
    url: "https://mcp.example.com/mcp",
    authKind: "header",
    headerNames: ["Authorization", "X-Team"],
    revision: 3,
    testStatus: "ok",
    testedAt: null,
    testErrorCode: null,
    snapshot: null,
    createdBy: null,
    createdAt: "2026-11-17T10:00:00.000Z",
    updatedAt: "2026-11-17T10:00:00.000Z",
    ...over,
  };
}

const current = (
  over: Partial<StoredMcpServer> = {},
  oauth: CurrentMcpServer["oauth"] = null,
) => ({
  oauth,
  server: stored(over),
  sealed: sealHeaders(SECRET, ID, [
    { name: "Authorization", value: "Bearer stored" },
    { name: "X-Team", value: "team-7" },
  ]),
});

function parse(over: Record<string, unknown> = {}) {
  const result = parseMcpServerInput(
    {
      name: "Linear",
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      auth: {
        kind: "header",
        headers: [
          { name: "Authorization", keep: true },
          { name: "X-Team", keep: true },
        ],
      },
      ...over,
    },
    { allowKeep: true, allowTestEndpoints: false },
  );
  if (!result.ok) throw new Error(`the test form is refused: ${result.code}`);
  return result.value;
}

const plan = (
  input: ReturnType<typeof parse>,
  row: ReturnType<typeof current> = current(),
  lines: string[] = [],
) => planMcpUpdate(SECRET, ID, row, input, (line) => lines.push(line));

describe("a change of an MCP server that keeps its header values", () => {
  // #1050-T02
  it("keeps the sealed values as they are when only the name changes", () => {
    const change = plan(parse({ name: "Renamed" }));

    expect(change).toMatchObject({ name: "Renamed" });
    // Nothing is sealed again: the stored ciphertext stays.
    expect(change).not.toHaveProperty("sealed");
  });

  it("reads a kept value from the stored ones when another header is new", () => {
    const row = current();
    const change = plan(
      parse({
        auth: {
          kind: "header",
          headers: [
            { name: "Authorization", keep: true },
            { name: "X-New", value: "fresh" },
          ],
        },
      }),
      row,
    );

    expect(change).toHaveProperty("sealed");
    if ("refused" in change || change.sealed == null)
      throw new Error("not changed");
    expect(openHeaders(SECRET, ID, change.sealed)).toEqual([
      { name: "Authorization", value: "Bearer stored" },
      { name: "X-New", value: "fresh" },
    ]);
  });

  // #1050-T02
  it.each([
    ["the host", { url: "https://evil.example.net/mcp" }],
    ["the port", { url: "https://mcp.example.com:8443/mcp" }],
    ["the path", { url: "https://mcp.example.com/other" }],
    ["the transport", { transport: "sse" }],
  ])(
    "refuses to keep a stored value when %s changes, so a value cannot be sent to a place it was not entered for",
    (_what, over) => {
      expect(plan(parse(over))).toEqual({
        refused: "mcp_header_value_required",
      });
    },
  );

  it("accepts every value entered again when the address changes, and the keep of none", () => {
    const change = plan(
      parse({
        url: "https://other.example.com/mcp",
        auth: {
          kind: "header",
          headers: [{ name: "Authorization", value: "Bearer new" }],
        },
      }),
    );

    expect("refused" in change).toBe(false);
    if ("refused" in change || change.sealed == null)
      throw new Error("not changed");
    expect(openHeaders(SECRET, ID, change.sealed)).toEqual([
      { name: "Authorization", value: "Bearer new" },
    ]);
  });

  it("refuses to keep a header the server does not have, and logs a value that cannot be opened", () => {
    expect(
      plan(
        parse({
          auth: { kind: "header", headers: [{ name: "X-Other", keep: true }] },
        }),
      ),
    ).toEqual({ refused: "mcp_header_unknown" });

    const lines: string[] = [];
    const broken = {
      oauth: null,
      server: stored(),
      sealed: sealHeaders("another-secret-0123456789-0123456789", ID, [
        { name: "Authorization", value: "x" },
      ]),
    };
    expect(plan(parse(), broken, lines)).toEqual({
      refused: "mcp_header_unknown",
    });
    expect(lines.join("\n")).toContain("MCP_HEADERS_UNREADABLE");
    expect(lines.join("\n")).not.toContain("Bearer");
  });

  it("drops the sealed values when the authentication is none", () => {
    expect(plan(parse({ auth: { kind: "none" } }))).toMatchObject({
      authKind: "none",
      sealed: null,
    });
  });
});

describe("a change of an MCP server that uses OAuth", () => {
  const oauthServer = { authKind: "oauth", headerNames: [] };
  const form = (
    over: Record<string, unknown> = {},
    auth: Record<string, unknown> = {},
  ) => parse({ auth: { kind: "oauth", ...auth }, ...over });
  const manual = {
    clientSource: "manual",
    clientId: "c-1",
    registeredIssuer: "https://auth.example.com",
    hasClientSecret: true,
  } as const;

  // #1051-T01
  it("changes nothing about the connection when only the name changes", () => {
    const change = plan(form({ name: "Renamed" }), current(oauthServer, null));

    expect(change).toMatchObject({
      name: "Renamed",
      authKind: "oauth",
      sealed: null,
    });
    expect(change).not.toHaveProperty("oauth");
  });

  it("drops the connection when the address or the transport changes, and when the server stops using OAuth", () => {
    expect(
      plan(
        form({ url: "https://other.example.com/mcp" }),
        current(oauthServer, null),
      ),
    ).not.toHaveProperty("oauth");
    expect(
      plan(
        form({ url: "https://other.example.com/mcp" }),
        current(oauthServer, {
          clientSource: "dynamic",
          clientId: "d",
          registeredIssuer: "https://as.example.com",
          hasClientSecret: false,
        }),
      ),
    ).toMatchObject({ oauth: { kind: "drop" } });
    expect(
      plan(form({ transport: "sse" }), current(oauthServer, manual)),
    ).toMatchObject({ oauth: { kind: "drop" } });
    expect(
      plan(parse({ auth: { kind: "none" } }), current(oauthServer, manual)),
    ).toMatchObject({ authKind: "none", oauth: { kind: "drop" } });
    // A header server that becomes an OAuth server has no sealed headers any more.
    expect(plan(form({}), current({}, null))).toMatchObject({ sealed: null });
  });

  it("keeps a registered client when nothing about the address changes, and drops a client that was entered when it is taken away", () => {
    const dynamic = {
      clientSource: "dynamic",
      clientId: "d",
      registeredIssuer: "https://as.example.com",
      hasClientSecret: false,
    } as const;

    expect(plan(form(), current(oauthServer, dynamic))).not.toHaveProperty(
      "oauth",
    );
    expect(plan(form(), current(oauthServer, manual))).toMatchObject({
      oauth: { kind: "drop" },
    });
  });

  it("keeps a client secret only for the same address and client id, and replaces the client otherwise", () => {
    const keep = {
      clientId: "c-1",
      issuer: "https://auth.example.com",
      keepClientSecret: true,
    };

    expect(
      plan(form({}, keep), current(oauthServer, manual)),
    ).not.toHaveProperty("oauth");
    expect(
      plan(
        form({}, { ...keep, clientId: "c-2" }),
        current(oauthServer, manual),
      ),
    ).toEqual({
      refused: "mcp_oauth_secret_required",
    });
    expect(
      plan(
        form({ url: "https://other.example.com/mcp" }, keep),
        current(oauthServer, manual),
      ),
    ).toEqual({ refused: "mcp_oauth_secret_required" });
    expect(plan(form({}, keep), current(oauthServer, null))).toEqual({
      refused: "mcp_oauth_secret_required",
    });
    const replaced = plan(
      form(
        {},
        {
          clientId: "c-1",
          issuer: "https://auth.example.com",
          clientSecret: "new-secret",
        },
      ),
      current(oauthServer, manual),
    );
    expect(replaced).toMatchObject({
      oauth: {
        kind: "replace-manual",
        client: {
          source: "manual",
          clientId: "c-1",
          registeredIssuer: "https://auth.example.com",
          authMethod: "client_secret_basic",
        },
      },
    });
    // The secret is sealed, never in the change as text.
    expect(JSON.stringify(replaced)).not.toContain("new-secret");
  });

  // #1051-T01
  it("pins an entered client to its issuer: a kept secret does not follow the client to another authorization server", () => {
    const moved = {
      ...{ clientId: "c-1" },
      issuer: "https://other.example.com",
    };

    // The same client id at another issuer: the secret was entered for the first one.
    expect(
      plan(
        form({}, { ...moved, keepClientSecret: true }),
        current(oauthServer, manual),
      ),
    ).toEqual({ refused: "mcp_oauth_secret_required" });
    // Entering it again replaces the client, and the new client is pinned to the new issuer.
    expect(
      plan(
        form({}, { ...moved, clientSecret: "again" }),
        current(oauthServer, manual),
      ),
    ).toMatchObject({
      oauth: {
        kind: "replace-manual",
        client: {
          clientId: "c-1",
          registeredIssuer: "https://other.example.com",
        },
      },
    });
    // A public client (no secret) at another issuer is a different client too: the old grant goes.
    expect(
      plan(
        form({}, { ...moved }),
        current(oauthServer, { ...manual, hasClientSecret: false }),
      ),
    ).toMatchObject({ oauth: { kind: "replace-manual" } });
  });
});
