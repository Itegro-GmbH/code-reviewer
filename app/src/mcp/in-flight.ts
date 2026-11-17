// SPDX-License-Identifier: LicenseRef-Proprietary

// How many MCP calls of one job are in flight at the same moment on this instance (#1053). A call is in flight from the moment the route
// accepts it until its answer has been read to the end (an event stream answer counts until the stream ends or the consumer goes away).
//
// Best effort, per instance: the app runs as many function instances, each with its own count, so the cap bounds what ONE instance does for
// ONE job; the count of calls per claim (`jobs.mcp_calls`, `countMcpCall`) is the bound that holds across instances. Documented in
// `docs/mcp-runtime.md`. Nothing is stored: an instance that goes away takes its counts with it.

export const MCP_MAX_CONCURRENT_CALLS_PER_JOB = 4;
/** How many calls one claim may make in all (`jobs.mcp_calls`): a turn runs at most a few hours, so this is generous for an agent and a wall for a loop. */
export const MCP_MAX_CALLS_PER_CLAIM = 2000;

export type InFlightGate = {
  /** Takes a place for a call of the job; `undefined` when the job has all its places taken. The function gives the place back (once). */
  enter(jobId: string): (() => void) | undefined;
  /** For tests. */
  inFlight(jobId: string): number;
};

export function createInFlightGate(
  max: number = MCP_MAX_CONCURRENT_CALLS_PER_JOB,
): InFlightGate {
  const counts = new Map<string, number>();
  return {
    enter(jobId) {
      const now = counts.get(jobId) ?? 0;
      if (now >= max) return undefined;
      counts.set(jobId, now + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (counts.get(jobId) ?? 1) - 1;
        if (left <= 0) counts.delete(jobId);
        else counts.set(jobId, left);
      };
    },
    inFlight: (jobId) => counts.get(jobId) ?? 0,
  };
}

/** The gate of this instance, for the Worker API unless a test passes its own. */
export const instanceInFlightGate: InFlightGate = createInFlightGate();

/**
 * The same response. An event stream answer gives the place back when its body has ended: read to the end, cancelled by the consumer, or
 * broken by an error. Any other answer is already complete (the proxy read it whole, within its cap), so it gives the place back at once.
 */
export function releaseWhenDone(
  response: Response,
  release: () => void,
): Response {
  const streaming = (response.headers.get("content-type") ?? "")
    .toLowerCase()
    .startsWith("text/event-stream");
  if (response.body === null || !streaming) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
