// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type { StoredMcpServer } from "../db/repositories/mcp-servers-repository.ts";
import { createMcpCredentials } from "./credentials.ts";
import { sealHeaders } from "./service.ts";

const SECRET = "a".repeat(40);

function server(overrides: Partial<StoredMcpServer> = {}): StoredMcpServer {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: "w1",
    name: "Issues",
    transport: "streamable-http",
    url: "https://mcp.example.com/mcp",
    authKind: "header",
    headerNames: ["Authorization"],
    revision: 1,
    testStatus: "ok",
    testedAt: null,
    testErrorCode: null,
    snapshot: null,
    createdBy: null,
    createdAt: "2026-11-17T10:00:00Z",
    updatedAt: "2026-11-17T10:00:00Z",
    ...overrides,
  };
}

describe("the credentials of an MCP server", () => {
  it("opens the sealed headers of a header server", async () => {
    const row = server();
    const sealed = sealHeaders(SECRET, row.id, [
      { name: "Authorization", value: "Bearer dummy-token" },
      { name: "X-Org", value: "acme" },
    ]);
    const result = await createMcpCredentials({
      appSecret: SECRET,
    }).headersFor({ server: row, sealed });
    expect(result).toEqual({
      ok: true,
      headers: { Authorization: "Bearer dummy-token", "X-Org": "acme" },
    });
  });

  it("sends nothing for a server without authentication", async () => {
    const result = await createMcpCredentials({
      appSecret: SECRET,
    }).headersFor({ server: server({ authKind: "none" }), sealed: null });
    expect(result).toEqual({ ok: true, headers: {} });
  });

  it("is broken, not empty, when the sealed headers are missing or cannot be opened", async () => {
    const row = server();
    const credentials = createMcpCredentials({ appSecret: SECRET });
    expect(await credentials.headersFor({ server: row, sealed: null })).toEqual(
      { ok: false, code: "mcp_credential_broken" },
    );
    // Sealed for another row: the row id is bound into the ciphertext.
    const other = sealHeaders(SECRET, "another-id", [
      { name: "Authorization", value: "Bearer dummy-token" },
    ]);
    expect(
      await credentials.headersFor({ server: row, sealed: other }),
    ).toEqual({ ok: false, code: "mcp_credential_broken" });
    // A master key that changed.
    const sealed = sealHeaders(SECRET, row.id, [
      { name: "Authorization", value: "Bearer dummy-token" },
    ]);
    expect(
      await createMcpCredentials({ appSecret: "b".repeat(40) }).headersFor({
        server: row,
        sealed,
      }),
    ).toEqual({ ok: false, code: "mcp_credential_broken" });
  });

  it("refuses a kind it has no provider for, and takes a provider for it (the place OAuth plugs in)", async () => {
    const oauth = server({ authKind: "oauth", headerNames: [] });
    const without = createMcpCredentials({ appSecret: SECRET });
    expect(await without.headersFor({ server: oauth, sealed: null })).toEqual({
      ok: false,
      code: "mcp_credential_unsupported",
    });
    const withProvider = createMcpCredentials({
      appSecret: SECRET,
      providers: {
        oauth: {
          headersFor: () =>
            Promise.resolve({
              ok: true,
              headers: { Authorization: "Bearer fresh" },
            }),
        },
      },
    });
    expect(
      await withProvider.headersFor({ server: oauth, sealed: null }),
    ).toEqual({ ok: true, headers: { Authorization: "Bearer fresh" } });
  });
});
