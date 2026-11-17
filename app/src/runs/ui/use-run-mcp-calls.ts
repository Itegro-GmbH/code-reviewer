// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Keeps the MCP calls of a run of the Implementer on the page (#1055). It rides on the poll of the run like the steps do (`use-run-steps.ts`):
// `tick` is the stamp of the newest snapshot of the run, and every new one makes a pull for the calls after the cursor, until nothing more is
// waiting. The snapshot that shows the run settled is a tick too, and it is the last one. A request never overlaps another (a tick that comes
// while one is out asks once more afterwards). A failed request keeps the calls on screen and sets `failure`; a failure that cannot get better by
// asking again stops the asking for good.
import { useCallback, useEffect, useRef, useState } from "react";
import { PERMANENT_FAILURE_CODES } from "../../ui/use-live-snapshot.ts";
import type { McpCallView } from "../mcp-calls-view.ts";
import type { RunsApi } from "./api.ts";
import { mergeMcpCalls } from "./mcp-calls-merge.ts";

/**
 * A refused query cannot get better by asking again with the same cursor (a cursor the route does not take): that stops the asking, like the
 * codes every live view stops on. Never expected (the cursor is a number the route handed out), so it must not turn into a request every tick.
 */
const PERMANENT_HERE = ["STEPS_QUERY_INVALID"] as const;

/** A guard against a loop that never ends: a pull goes on until nothing more is waiting (the record keeps 2000 calls, 200 a page). */
const MAX_PAGES_PER_PULL = 50;

export type RunMcpCalls = {
  calls: McpCallView[];
  /** The record holds as many calls as it keeps at most. */
  full: boolean;
  /** Refusals "too many calls at once" that were counted and not listed one by one. */
  omitted: number;
  /** The code of the last failed request, or null. */
  failure: string | null;
};

export function useRunMcpCalls({
  api,
  runId,
  tick,
}: {
  api: RunsApi;
  runId: string;
  /** Changes whenever the run was fetched again. */
  tick: string;
}): RunMcpCalls {
  const [calls, setCalls] = useState<McpCallView[]>([]);
  const [full, setFull] = useState(false);
  const [omitted, setOmitted] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const cursor = useRef(0);
  const busy = useRef(false);
  const askAgain = useRef(false);
  const stopped = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ api, runId });
  useEffect(() => {
    latest.current = { api, runId };
  });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pull = useCallback(async () => {
    if (stopped.current) return;
    if (busy.current) {
      askAgain.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        askAgain.current = false;
        for (let page = 0; page < MAX_PAGES_PER_PULL; page += 1) {
          const { api: current, runId: id } = latest.current;
          const result = await current.mcpCalls(id, cursor.current);
          if (!mounted.current) return;
          if (!result.ok) {
            setFailure(result.code);
            if (
              (PERMANENT_FAILURE_CODES as readonly string[]).includes(
                result.code,
              ) ||
              (PERMANENT_HERE as readonly string[]).includes(result.code)
            )
              stopped.current = true;
            break;
          }
          setFailure(null);
          setFull(result.data.full);
          setOmitted(result.data.omitted);
          const before = cursor.current;
          cursor.current = Math.max(before, result.data.cursor);
          if (result.data.calls.length > 0)
            setCalls((shown) => mergeMcpCalls(shown, result.data.calls));
          // A page that says more is waiting and does not move the cursor would be asked again for ever.
          if (!result.data.hasMore || cursor.current === before) break;
        }
      } while (askAgain.current && !stopped.current && mounted.current);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void pull();
  }, [tick, pull]);

  return { calls, full, omitted, failure };
}
