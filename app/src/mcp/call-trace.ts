// SPDX-License-Identifier: LicenseRef-Proprietary

// Where the MCP calls of a run are written down for its live view and trace (#1055, epic #1049). The proxy reports each call it made with its
// metadata (`onCall`); a refusal before the proxy arrives as a record (`recordCall`, `job-proxy.ts`). Both end in the job's record
// (`job-mcp-calls-repository.ts`) AFTER the answer went to the agent (`later`: Next's `after()` in the app), so the agent never waits for the
// database, and a database that fails costs the trace of that call and nothing else: one line with the job, never the error text (it may hold
// an address of the database).
//
// An event stream call is told when its stream ENDS, in a callback of the stream and not in the request any more: Next's `after()` may refuse to
// register there, and a write that nobody awaits can be frozen with the function. So the handler, still inside its request, calls `holdOpen()`
// before it returns the stream: that registers one promise with `keepAlive` (`after(() => promise)`), which settles when the stream has ended
// and every write that was started has finished, and in any case after `TRACE_HOLD_MS`, so a stream that never ends cannot hold a function for
// ever. The write itself starts at once where `later` could not defer it.
import type {
  JobMcpCallsRepository,
  McpCallRecord,
} from "../db/repositories/job-mcp-calls-repository.ts";
import { recordOfMeta } from "./call-record.ts";
import type { McpCallMeta } from "./proxy.ts";

/** How long a function is held open for the records of its streams at the most (a stream that does not end, a database that does not answer). */
export const TRACE_HOLD_MS = 15_000;

export type CallTrace = {
  /** The proxy's `onCall`: a call that reached the server's address or failed on its way. */
  onCall(meta: McpCallMeta): void;
  /** A refusal before the proxy. */
  recordCall(jobId: string, record: McpCallRecord): void;
  /**
   * For an event stream answer: called in the request, before the response is returned. Keeps the function alive for the record of the stream's
   * call; the returned function says the stream has ended (read to the end, cancelled or broken), once. A no-op where there is no `keepAlive`.
   */
  holdOpen(): () => void;
};

export function createCallTrace(deps: {
  repository: Pick<JobMcpCallsRepository, "record">;
  /** Runs the work after the response was sent; never rejects. */
  later: (work: () => Promise<void>) => void;
  /** Keeps the function alive until the promise settles (`after(() => promise)` in the app); the promise never rejects. */
  keepAlive?: (held: Promise<void>) => void;
  /** For a test. */
  holdMs?: number;
  log: (line: string) => void;
}): CallTrace {
  // The writes that were handed to `later` and are not done: a stream's hold waits for them.
  const pending = new Set<Promise<void>>();

  function recordCall(jobId: string, record: McpCallRecord): void {
    let written!: () => void;
    const done = new Promise<void>((resolve) => {
      written = resolve;
    });
    pending.add(done);
    deps.later(async () => {
      try {
        await deps.repository.record(jobId, record);
      } catch {
        deps.log(`[mcp-proxy] job=${jobId} the call could not be recorded`);
      } finally {
        pending.delete(done);
        written();
      }
    });
  }
  return {
    recordCall,
    onCall(meta) {
      if (meta.jobId === null) return;
      recordCall(meta.jobId, recordOfMeta(meta));
    },
    holdOpen() {
      if (deps.keepAlive === undefined) return () => {};
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const timer = setTimeout(release, deps.holdMs ?? TRACE_HOLD_MS);
      timer.unref();
      deps.keepAlive(held);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        // The stream told its call before it ended (that is what ends it), so the write is already in `pending`.
        void Promise.allSettled([...pending]).then(() => {
          clearTimeout(timer);
          release();
        });
      };
    },
  };
}
