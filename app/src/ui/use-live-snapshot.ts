// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Keeps a page's data fresh without a reload: the server renders the first snapshot, the browser asks
// for newer ones while something can still change. Three rules make it safe with Cache Components,
// which keeps a page that was left mounted (hidden) instead of dropping it:
//
// - The snapshot the server rendered is the truth; a snapshot fetched later is shown only while the
//   server's one is the same object it was fetched next to. When the page is rendered again with new
//   data (a filter, `router.refresh()`), the new server data wins and the fetched one is dropped.
// - Polling lives in an effect, and a hidden page runs the cleanup: it stops while the page is not
//   shown and starts again (with one request at once) when it is shown.
// - A failed request keeps the last data on screen and sets `failed`; the next attempt runs on the
//   normal schedule, and the wait doubles with every further failure in a row (up to a minute), so a
//   server that is down is not hammered. A failure that cannot get better by asking again (the
//   session ended, the person is not allowed, the thing is gone) stops polling for good: `stopped`.
import { useEffect, useRef, useState } from "react";
import type { RequestResult } from "./json-request.ts";

export type LiveSnapshotOptions<T> = {
  /** What the server rendered. A new object means new server data. */
  initial: T;
  fetchLatest: () => Promise<RequestResult<T>>;
  /** True when nothing is going to change any more (no run waiting or running). */
  isSettled: (data: T) => boolean;
  /** The wait between requests while something can still change. */
  activeIntervalMs: number;
  /** The wait between requests once everything is settled; null stops polling then. */
  idleIntervalMs: number | null;
};

/** Failures that asking again does not fix: polling stops, the page says why. */
export const PERMANENT_FAILURE_CODES = [
  "UNAUTHENTICATED",
  "ACCESS_DENIED",
  "RUN_NOT_FOUND",
  /** A run of a workflow, or its workflow, that is gone (#873). */
  "WORKFLOW_RUN_NOT_FOUND",
  "WORKFLOW_RUN_WORKFLOW_NOT_FOUND",
  /** The answer of a workspace route for a person who is not (or no longer) a member (src/workspaces/access-response.ts). */
  "not_found",
] as const;

/** The longest wait after repeated failures. */
export const MAX_BACKOFF_MS = 60_000;

export type LiveSnapshot<T> = {
  data: T;
  /** The last request failed; the data on screen is the one before it. */
  failed: boolean;
  /** The code of the last failure (a transport code or the route's), or null. */
  failureCode: string | null;
  /** Polling ended because the failure is permanent; the data on screen will not change. */
  stopped: boolean;
};

export function useLiveSnapshot<T>(
  options: LiveSnapshotOptions<T>,
): LiveSnapshot<T> {
  const { initial, fetchLatest, isSettled, activeIntervalMs, idleIntervalMs } =
    options;
  const [live, setLive] = useState<{ from: T; data: T } | null>(null);
  // Tied to the server data like the fetched snapshot: new server data starts without a failure.
  const [failureOf, setFailure] = useState<{
    from: T;
    code: string;
    stopped: boolean;
  } | null>(null);
  const failure =
    failureOf !== null && failureOf.from === initial ? failureOf : null;
  const data = live !== null && live.from === initial ? live.data : initial;

  // The effect reads the newest data and callbacks without being restarted by every change.
  const dataRef = useRef(data);
  const callbacks = useRef({ fetchLatest, isSettled });
  useEffect(() => {
    dataRef.current = data;
    callbacks.current = { fetchLatest, isSettled };
  });

  // True once polling has started at least once: a later start is a page that is shown again or one
  // with new server data, and it asks at once instead of waiting a whole interval.
  const startedBefore = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let failuresInARow = 0;

    function delayNow(): number | null {
      return callbacks.current.isSettled(dataRef.current)
        ? idleIntervalMs
        : activeIntervalMs;
    }

    function schedule() {
      if (stopped) return;
      clearTimeout(timer);
      const delay = delayNow();
      if (delay === null) return;
      // The first failure retries on schedule; every further one doubles the wait.
      const backoff = 2 ** Math.max(0, failuresInARow - 1);
      timer = setTimeout(
        () => void poll(),
        Math.min(delay * backoff, Math.max(delay, MAX_BACKOFF_MS)),
      );
    }

    async function poll() {
      // A page nobody looks at (another tab) does not ask; it asks as soon as it is shown again.
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return;
      }
      if (inFlight) return;
      inFlight = true;
      const result = await callbacks.current.fetchLatest();
      inFlight = false;
      if (stopped) return;
      if (result.ok) {
        failuresInARow = 0;
        dataRef.current = result.data;
        setLive({ from: initial, data: result.data });
        setFailure(null);
      } else {
        failuresInARow += 1;
        const stop = (PERMANENT_FAILURE_CODES as readonly string[]).includes(
          result.code,
        );
        setFailure({ from: initial, code: result.code, stopped: stop });
        if (stop) {
          stopped = true;
          return;
        }
      }
      schedule();
    }

    function onVisible() {
      if (document.hidden || stopped) return;
      if (delayNow() === null) return;
      clearTimeout(timer);
      void poll();
    }

    if (startedBefore.current && delayNow() !== null) void poll();
    else schedule();
    startedBefore.current = true;
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [initial, activeIntervalMs, idleIntervalMs]);

  return {
    data,
    failed: failure !== null,
    failureCode: failure?.code ?? null,
    stopped: failure?.stopped ?? false,
  };
}
