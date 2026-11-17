// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type {
  JobMcpCallsRepository,
  McpCallRecord,
} from "../db/repositories/job-mcp-calls-repository.ts";
import { createCallTrace } from "./call-trace.ts";
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
  durationMs: 5,
  requestBytes: 10,
  responseBytes: 20,
  ...over,
});

function setup(options: { failing?: boolean } = {}) {
  const stored: { jobId: string; record: McpCallRecord }[] = [];
  const lines: string[] = [];
  const later: Promise<void>[] = [];
  const repository: Pick<JobMcpCallsRepository, "record"> = {
    record: (jobId, record) => {
      if (options.failing === true)
        return Promise.reject(new Error("database down: postgres://secret"));
      stored.push({ jobId, record });
      return Promise.resolve("stored");
    },
  };
  const trace = createCallTrace({
    repository,
    later: (work) => {
      later.push(work());
    },
    log: (line) => lines.push(line),
  });
  return { trace, stored, lines, settled: () => Promise.all(later) };
}

describe("the trace of the MCP calls of a run", () => {
  // #1055-T01
  it("records each call the proxy reports, for its job, after the answer", async () => {
    const { trace, stored, settled } = setup();

    trace.onCall(meta());
    trace.onCall(meta({ tool: "get_issue", jobId: "job-2" }));
    await settled();

    expect(stored).toMatchObject([
      { jobId: "job-1", record: { serverName: "Linear", tool: "list_issues" } },
      { jobId: "job-2", record: { tool: "get_issue" } },
    ]);
  });

  // #1055-T01
  it("records nothing for a call that belongs to no job", async () => {
    const { trace, stored, settled } = setup();
    trace.onCall(meta({ jobId: null }));
    await settled();
    expect(stored).toEqual([]);
  });

  // #1055-T02
  it("never lets an argument or an answer reach the store: the record has the fields of the metadata only", async () => {
    const { trace, stored, settled } = setup();
    const withExtras = {
      ...meta(),
      arguments: { needle: "secret-argument" },
      result: "secret-result",
      headers: { authorization: "Bearer secret-header" },
    } as McpCallMeta;

    trace.onCall(withExtras);
    await settled();

    const text = JSON.stringify(stored);
    expect(text).not.toContain("secret-argument");
    expect(text).not.toContain("secret-result");
    expect(text).not.toContain("secret-header");
    expect(Object.keys(stored[0]?.record ?? {}).sort()).toEqual([
      "durationMs",
      "outcome",
      "requestBytes",
      "responseBytes",
      "rpcMethod",
      "serverId",
      "serverName",
      "status",
      "tool",
    ]);
  });

  // #1055-T08
  it("survives a database that fails: one line with the job, no error text, and nothing thrown", async () => {
    const { trace, lines, settled } = setup({ failing: true });

    expect(() => trace.onCall(meta())).not.toThrow();
    expect(() =>
      trace.recordCall("job-1", {
        serverId: "s",
        serverName: "",
        rpcMethod: null,
        tool: null,
        status: 404,
        outcome: "mcp_server_unavailable",
        durationMs: 0,
        requestBytes: 0,
        responseBytes: 0,
      }),
    ).not.toThrow();
    await settled();

    const text = lines.join("\n");
    expect(text).toContain("job=job-1");
    expect(text).not.toContain("postgres://");
  });
});
