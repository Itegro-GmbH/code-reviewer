// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  JobMcpCallsRepository,
  McpCallRecord,
} from "../db/repositories/job-mcp-calls-repository.ts";
import { createCallTrace, TRACE_HOLD_MS } from "./call-trace.ts";
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

  describe("an event stream call, whose record is written after the handler has returned", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /** `later` as `runAfterResponse` is where `after()` throws (the stream's callback has no request any more): the work simply starts. */
    function streamSetup(options: { failing?: boolean } = {}) {
      const stored: { jobId: string; record: McpCallRecord }[] = [];
      let finishWrite: (() => void) | undefined;
      const kept: Promise<void>[] = [];
      const repository: Pick<JobMcpCallsRepository, "record"> = {
        record: (jobId, record) =>
          new Promise((resolve, reject) => {
            finishWrite = () => {
              if (options.failing === true) {
                reject(new Error("database down"));
                return;
              }
              stored.push({ jobId, record });
              resolve("stored");
            };
          }),
      };
      const trace = createCallTrace({
        repository,
        later: (work) => {
          void work();
        },
        keepAlive: (held) => kept.push(held),
        log: () => {},
      });
      const isSettled = async (promise: Promise<void>): Promise<boolean> =>
        Promise.race([promise.then(() => true), Promise.resolve(false)]);
      return {
        trace,
        stored,
        kept,
        isSettled,
        finishWrite: () => finishWrite?.(),
      };
    }

    // #1055-T01
    it("holds the function open until the write is done: the registered promise settles after the stream has ended AND the record is stored", async () => {
      const { trace, stored, kept, isSettled, finishWrite } = streamSetup();

      // The handler, before it returns the stream: one registration, in the request.
      const ended = trace.holdOpen();
      expect(kept).toHaveLength(1);
      // The stream's callback, later: the call is told, the write starts (and takes its time).
      trace.onCall(meta());
      ended();
      await Promise.resolve();
      expect(await isSettled(kept[0]!)).toBe(false);
      expect(stored).toEqual([]);

      finishWrite();
      await kept[0];
      expect(stored).toMatchObject([
        { jobId: "job-1", record: { tool: "list_issues" } },
      ]);
    });

    // #1055-T08
    it("settles when the write fails (and says nothing of the error)", async () => {
      const { trace, kept, finishWrite } = streamSetup({ failing: true });
      const ended = trace.holdOpen();
      trace.onCall(meta());
      ended();

      finishWrite();

      await expect(kept[0]).resolves.toBeUndefined();
    });

    // #1055-T08
    it("cannot hold the function for ever: a stream that never ends lets go after the bound", async () => {
      vi.useFakeTimers();
      const { trace, kept } = streamSetup();
      trace.holdOpen();
      let settled = false;
      void kept[0]!.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(TRACE_HOLD_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
    });

    // #1055-T08
    it("cannot hold the function for ever: a write that never finishes lets go after the bound too", async () => {
      vi.useFakeTimers();
      const { trace, kept } = streamSetup();
      const ended = trace.holdOpen();
      trace.onCall(meta());
      ended();
      let settled = false;
      void kept[0]!.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(TRACE_HOLD_MS + 1);

      expect(settled).toBe(true);
    });

    it("registers nothing where there is no way to keep the function alive (a test, a script)", () => {
      const trace = createCallTrace({
        repository: { record: () => Promise.resolve("stored") },
        later: (work) => {
          void work();
        },
        log: () => {},
      });

      expect(() => trace.holdOpen()()).not.toThrow();
    });
  });
});
