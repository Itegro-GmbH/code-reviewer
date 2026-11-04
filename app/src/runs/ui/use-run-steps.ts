// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Keeps the steps of a run of the Implementer on the page (#745, live view). It rides on the poll of the run: `tick` is the stamp
// of the newest snapshot of the run (`generatedAt`), and every new one makes one request for the steps after the cursor, so there
// is no timer of its own. The snapshot that shows the run settled is a tick too, and it is the last one, so a finished run is
// fetched one more time and then not at all. A settled run that was opened later is fetched once when `enabled` turns true.
//
// The answers are merged by part id (`steps-merge.ts`); the cursor is kept in a ref, so a tick that comes while a request is out
// waits for it and asks once more afterwards, never two at a time. A failed request keeps the steps on screen and sets `failure`;
// the next tick asks again. A failure that cannot get better by asking again (the run is gone, the person is not a member any more)
// stops the asking for good.
import { useCallback, useEffect, useRef, useState } from "react";
import { PERMANENT_FAILURE_CODES } from "../../ui/use-live-snapshot.ts";
import type { StepView } from "../steps-view.ts";
import type { RunsApi } from "./api.ts";
import { mergeSteps } from "./steps-merge.ts";

/** The most pages one pull takes: a turn at the caps is 80 pages of 200, so the rest comes with the next tick. */
const MAX_PAGES_PER_PULL = 30;

export type RunSteps = {
  steps: StepView[];
  /** True once the first request has been answered (well or badly). */
  loaded: boolean;
  /** The code of the last failed request, or null. */
  failure: string | null;
};

export function useRunSteps({
  api,
  runId,
  enabled,
  tick,
}: {
  api: RunsApi;
  runId: string;
  /** False until the section is open: nothing is requested before. */
  enabled: boolean;
  /** Changes whenever the run was fetched again. */
  tick: string;
}): RunSteps {
  const [steps, setSteps] = useState<StepView[]>([]);
  const [loaded, setLoaded] = useState(false);
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
          const result = await current.steps(id, cursor.current);
          if (!mounted.current) return;
          if (!result.ok) {
            setFailure(result.code);
            if (
              (PERMANENT_FAILURE_CODES as readonly string[]).includes(
                result.code,
              )
            )
              stopped.current = true;
            break;
          }
          setFailure(null);
          cursor.current = Math.max(cursor.current, result.data.cursor);
          if (result.data.steps.length > 0)
            setSteps((before) => mergeSteps(before, result.data.steps));
          if (!result.data.hasMore) break;
        }
        if (mounted.current) setLoaded(true);
      } while (askAgain.current && !stopped.current && mounted.current);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (enabled) void pull();
  }, [enabled, tick, pull]);

  return { steps, loaded, failure };
}
