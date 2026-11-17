// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { StoredMcpCall } from "../db/repositories/job-mcp-calls-repository.ts";
import { MAX_MCP_CALLS_RECORDED_PER_JOB } from "../db/repositories/job-mcp-calls-repository.ts";
import {
  createRunMcpCallsService,
  parseMcpCallsQuery,
} from "./mcp-calls-service.ts";
import { MCP_CALLS_OVERLAP_ROWS } from "./mcp-calls-view.ts";

vi.mock("server-only", () => ({}));

const stored = (
  seq: number,
  over: Partial<StoredMcpCall> = {},
): StoredMcpCall => ({
  seq,
  suppressed: 0,
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
  options: {
    run?: boolean;
    count?: number;
    suppressed?: number;
    redact?: (text: string) => string;
  } = {},
) {
  const asked: {
    id: string;
    after: number;
    limit: number;
    overlap: number | undefined;
  }[] = [];
  let summaries = 0;
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
      // The overlap as the repository reads it: from that many rows of the job before the cursor.
      listAfter: (id, after, limit, overlap) => {
        asked.push({ id, after, limit, overlap });
        const older = rows
          .filter((row) => row.seq <= after)
          .slice(-(overlap ?? 0));
        const from = older.length === 0 ? after : older[0]!.seq - 1;
        return Promise.resolve(
          rows.filter((row) => row.seq > from).slice(0, limit),
        );
      },
      summary: () => {
        summaries += 1;
        return Promise.resolve({
          rows: options.count ?? rows.length,
          suppressed: options.suppressed ?? 0,
        });
      },
    },
    ...(options.redact === undefined ? {} : { redact: options.redact }),
  });
  return { service, asked, summaries: () => summaries };
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
        {
          seq: 1,
          serverName: "Linear",
          tool: "list_issues",
          durationMs: 120,
          outcome: "ok",
          status: 200,
        },
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
    // Nothing new: the answer holds only what is behind the cursor (read again for a late row), and the cursor stays.
    const none = await service.list(RUN, 3, 2);
    expect(none).toMatchObject({ cursor: 3, hasMore: false });
    expect(none?.calls.every((call) => call.seq <= 3)).toBe(true);
  });

  // #1055-T03: rows become visible out of the order of their seq, so the page asks again from some rows before its cursor
  it("answers from some rows before the cursor, so a row that became visible late is delivered (the page merges by seq)", async () => {
    const { service, asked } = setup([
      stored(1),
      stored(2),
      stored(3),
      stored(4),
    ]);

    const snapshot = await service.list(RUN, 3, 2);

    expect(asked[0]).toMatchObject({
      after: 3,
      overlap: MCP_CALLS_OVERLAP_ROWS,
    });
    expect(snapshot?.calls.map((call) => call.seq)).toEqual([1, 2, 3, 4]);
    // The cursor never goes back, and moves to the newest row.
    expect(snapshot?.cursor).toBe(4);
    expect(snapshot?.hasMore).toBe(false);
    // Nothing new: the cursor stays where it was.
    expect((await service.list(RUN, 9, 2))?.cursor).toBe(9);
  });

  // #1055-T03
  it("still makes progress when the overlap alone fills a page", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => stored(i + 1));
    const { service } = setup(rows);

    const first = await service.list(RUN, 200, 1);

    expect(first?.hasMore).toBe(true);
    expect(first?.cursor).toBeGreaterThan(200);
  });

  // #1055-T03
  it("reports the refusals that were counted and not stored, and asks for the summary only where it can differ from nothing", async () => {
    const withCount = setup([stored(1)], { suppressed: 7 });
    expect(await withCount.service.list(RUN, 0, 200)).toMatchObject({
      omitted: 7,
    });

    // A run that has no call at all (a lane without MCP): one read, no second statement.
    const none = setup([]);
    expect(await none.service.list(RUN, 0, 200)).toMatchObject({
      calls: [],
      omitted: 0,
      full: false,
    });
    expect(none.summaries()).toBe(0);
  });

  // #1055-T06
  it("shows a refusal as one: its code and status stay what the agent got", async () => {
    const { service } = setup([
      stored(1, {
        status: 404,
        outcome: "mcp_server_unavailable",
        serverName: "",
        durationMs: 0,
      }),
      stored(2, { status: 429, outcome: "mcp_too_many_concurrent_calls" }),
      stored(3, { status: 503, outcome: "mcp_credential_broken" }),
      stored(4, { status: 503, outcome: "mcp_proxy_timeout" }),
      stored(5, { status: 200, outcome: "cancelled" }),
    ]);

    const snapshot = await service.list(RUN, 0, 200);

    expect(
      snapshot?.calls.map((call) => [call.status, call.outcome, call.result]),
    ).toEqual([
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

    expect(snapshot?.calls[0]).toMatchObject({
      result: "failed",
      outcome: "unknown",
    });
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

    expect((await service.list(RUN, 0, 200))?.calls[0]?.tool).toBe(
      "use-[redacted]",
    );
  });

  // #1055-T03
  it("says when the job holds as many calls as the record keeps, so a list that ends there is not taken for the whole", async () => {
    const { service } = setup([stored(1)], {
      count: MAX_MCP_CALLS_RECORDED_PER_JOB,
    });
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

describe("the query of the MCP calls route", () => {
  // #1055-T03
  it("takes a cursor up to what a number holds exactly (the identity is table-wide, not the 32 bits of a step) and refuses anything else", () => {
    expect(parseMcpCallsQuery({ after: null, limit: null })).toEqual({
      ok: true,
      after: 0,
      limit: 200,
    });
    // Past the 32 bits of the steps' parser.
    expect(parseMcpCallsQuery({ after: "5000000000", limit: "10" })).toEqual({
      ok: true,
      after: 5_000_000_000,
      limit: 10,
    });
    expect(
      parseMcpCallsQuery({ after: String(Number.MAX_SAFE_INTEGER) }),
    ).toMatchObject({ ok: true, after: Number.MAX_SAFE_INTEGER });
    for (const after of [
      "9007199254740992",
      "99999999999999999",
      "-1",
      "1.5",
      "abc",
      "",
    ])
      expect(parseMcpCallsQuery({ after })).toEqual({ ok: false });
    expect(parseMcpCallsQuery({ limit: "0" })).toEqual({ ok: false });
    expect(parseMcpCallsQuery({ limit: "500" })).toMatchObject({ limit: 200 });
  });
});
