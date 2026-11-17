// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { peekCall, recordOfMeta } from "./call-record.ts";
import type { McpCallMeta } from "./proxy.ts";

const meta = (over: Partial<McpCallMeta> = {}): McpCallMeta => ({
  jobId: "job-1",
  serverId: "11111111-1111-4111-8111-111111111111",
  serverName: "Linear",
  transport: "streamable-http",
  rpcMethod: "tools/call",
  tool: "list_issues",
  status: 200,
  outcome: "ok",
  durationMs: 42,
  requestBytes: 100,
  responseBytes: 2000,
  ...over,
});

describe("the record of a call for the run's trace", () => {
  // #1055-T07
  it("keeps the fields of the metadata and nothing else", () => {
    expect(recordOfMeta(meta())).toEqual({
      serverId: "11111111-1111-4111-8111-111111111111",
      serverName: "Linear",
      rpcMethod: "tools/call",
      tool: "list_issues",
      status: 200,
      outcome: "ok",
      durationMs: 42,
      requestBytes: 100,
      responseBytes: 2000,
    });
  });

  // #1055-T07
  it("cleans and cuts the texts once more, so no line break or control character gets into the trace", () => {
    const record = recordOfMeta(
      meta({
        serverName: `Evil\nName‮${"x".repeat(300)}`,
        tool: `a\r\nb${"y".repeat(300)}`,
        rpcMethod: "tools/call\u0000",
      }),
    );
    expect(record.serverName.length).toBeLessThanOrEqual(200);
    expect(record.serverName).not.toMatch(/[\n‮]/);
    expect(record.tool?.length).toBeLessThanOrEqual(100);
    expect(record.tool).not.toMatch(/[\r\n]/);
    expect(record.rpcMethod).not.toContain("\u0000");
  });

  // #1055-T07
  it("takes a negative or fractional number as 0 and a whole one as it is, so the table's checks never refuse a row", () => {
    const record = recordOfMeta(
      meta({ durationMs: -3, requestBytes: 1.7, responseBytes: Number.NaN }),
    );
    expect(record).toMatchObject({
      durationMs: 0,
      requestBytes: 1,
      responseBytes: 0,
    });
  });
});

describe("what is read of a call that was refused before the proxy", () => {
  // #1055-T06
  it("is the method and the tool name of one JSON-RPC message, and nothing else", () => {
    expect(
      peekCall(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_issue", arguments: { a: "b" } },
        }),
      ),
    ).toEqual({ rpcMethod: "tools/call", tool: "get_issue" });
    expect(
      peekCall(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
    ).toEqual({ rpcMethod: "tools/list", tool: null });
  });

  // #1055-T06
  it("is nothing for a body that is not a message, a DELETE or an array", () => {
    for (const body of [null, "", "{", "[]", "1", '{"method":5}'])
      expect(peekCall(body)).toEqual({ rpcMethod: null, tool: null });
  });
});
