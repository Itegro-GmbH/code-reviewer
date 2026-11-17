// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { StoredMcpCall } from "../db/repositories/job-mcp-calls-repository.ts";
import { MAX_MCP_CALLS_RECORDED_PER_JOB } from "../db/repositories/job-mcp-calls-repository.ts";
import { createRunMcpCallsService } from "./mcp-calls-service.ts";

vi.mock("server-only", () => ({}));

const stored = (seq: number, over: Partial<StoredMcpCall> = {}): StoredMcpCall => ({
  seq,
  serverId: "11111111-1111-4111-8111-111111111111",
  serverName: "Linear",
  rpcMethod: "tools/call",
  tool: "list_issues",
  status: 200,
  outcome: "ok",
  durationMs: 120,
  requestBytes: 90,
  responseBytes: 4000,
  createdAt: "2026-11-17T08:00:00.000Z",
  ...over,
});

function setup(
  rows: StoredMcpCall[],
  options: { run?: boolean; count?: number; redact?: (text: string) => string } = {},
) {
  const asked: { id: string; after: number; limit: number }[] = [];
  const service = createRunMcpCallsService({
    runs: {
      implementerRun: (id) =>
        Promise.resolve(
          options.run === false || id !== "11111111-2222-4333-8444-555555555555"
            ? undefined
            : { onManagedKey: false },
        ),
    },
    calls: {
      listAfter: (id, after, limit) => {
        asked.push({ id, after, limit });
        return Promise.resolve(rows.filter((row) => row.seq > after).slice(0, limit));
      },
      count: () => Promise.resolve(options.count ?? rows.length),
    },
    ...(options.redact === undefined ? {} : { redact: options.redact }),
  });
  return { service, asked };
}

const RUN = "11111111-2222-4333-8444-555555555555";

describe("the MCP calls of a run for the live view", () => {
  // #1055-T01
  it("shows each call with the server, the tool, the duration and the outcome, in the order they were made", async () => {
    const { service } = setup([
      stored(1),
      stored(2, { serverName: "Sentry", tool: "get_event", durationMs: 30 }),
    ]);

    const snapshot = await service.list(RUN, 0, 200);

    expect(snapshot).toMatchObject({
      calls: [
        { seq: 1, serverName: "Linear", tool: "list_issues", durationMs: 120, outcome: "ok", status: 200 },
        { seq: 2, serverName: "Sentry", tool: "get_event", durationMs: 30 },
      ],
      cursor: 2,
      hasMore: false,
      full: false,
    });
  });

  // #1055-T01
  it("pages by a cursor and says when more waits", async () => {
    const { service } = setup([stored(1), stored(2), stored(3)]);

    const first = await service.list(RUN, 0, 2);
    expect(first).toMatchObject({ cursor: 2, hasMore: true });
    expect(first?.calls.map((call) => call.seq)).toEqual([1, 2]);

    const second = await service.list(RUN, first?.cursor ?? 0, 2);
    expect(second).toMatchObject({ cursor: 3, hasMore: false });
    expect(await service.list(RUN, 3, 2)).toMatchObject({ calls: [], cursor: 3 });
  });

  // #1055-T06
  it("shows a refusal as one: its code and status stay what the agent got", async () => {
    const { service } = setup([
      stored(1, { status: 404, outcome: "mcp_server_unavailable", serverName: "", durationMs: 0 }),
      stored(2, { status: 429, outcome: "mcp_too_many_concurrent_calls" }),
      stored(3, { status: 503, outcome: "mcp_credential_broken" }),
      stored(4, { status: 503, outcome: "mcp_proxy_timeout" }),
      stored(5, { status: 200, outcome: "cancelled" }),
    ]);

    const snapshot = await service.list(RUN, 0, 200);

    expect(snapshot?.calls.map((call) => [call.status, call.outcome, call.result])).toEqual([
      [404, "mcp_server_unavailable", "refused"],
      [429, "mcp_too_many_concurrent_calls", "refused"],
      [503, "mcp_credential_broken", "refused"],
      [503, "mcp_proxy_timeout", "failed"],
      [200, "cancelled", "cancelled"],
    ]);
  });

  // #1055-T06
  it("reads an outcome it does not know as a failure with a neutral code, never as text of the row", async () => {
    const { service } = setup([stored(1, { outcome: "something_new_here" })]);

    const snapshot = await service.list(RUN, 0, 200);

    expect(snapshot?.calls[0]).toMatchObject({ result: "failed", outcome: "unknown" });
  });

  // #1055-T02
  it("has no field for an argument or an answer, whatever the row holds", async () => {
    const row = {
      ...stored(1),
      arguments: "secret-argument",
      result: "secret-result",
    } as StoredMcpCall;
    const { service } = setup([row]);

    const snapshot = await service.list(RUN, 0, 200);

    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("secret-argument");
    expect(text).not.toContain("secret-result");
    expect(Object.keys(snapshot?.calls[0] ?? {}).sort()).toEqual([
      "at",
      "durationMs",
      "outcome",
      "requestBytes",
      "responseBytes",
      "result",
      "rpcMethod",
      "seq",
      "serverId",
      "serverName",
      "status",
      "tool",
    ]);
  });

  // #1055-T02
  it("takes secrets out of the names once more", async () => {
    const { service } = setup([stored(1, { tool: "use-TOKEN-123" })], {
      redact: (text) => text.replace("TOKEN-123", "[redacted]"),
    });

    expect((await service.list(RUN, 0, 200))?.calls[0]?.tool).toBe("use-[redacted]");
  });

  // #1055-T03
  it("says when the job holds as many calls as the record keeps, so a list that ends there is not taken for the whole", async () => {
    const { service } = setup([stored(1)], { count: MAX_MCP_CALLS_RECORDED_PER_JOB });
    expect(await service.list(RUN, 0, 200)).toMatchObject({ full: true });

    const half = setup([stored(1)], { count: 10 });
    expect(await half.service.list(RUN, 0, 200)).toMatchObject({ full: false });
  });

  // #1055-T04
  it("answers nothing for a run that is not a run of the Implementer of this workspace, and asks for no call then", async () => {
    const { service, asked } = setup([stored(1)], { run: false });

    expect(await service.list(RUN, 0, 200)).toBeUndefined();
    expect(await service.list("not-a-uuid", 0, 200)).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
