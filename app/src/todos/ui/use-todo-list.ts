// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Reads the ToDo list and keeps it fresh (#925): at once when the page mounts, then slowly while the page is shown, and on demand
// after an answer or a review. Three states, so the page can say what it is doing: `loading` (nothing read yet), `ready` (the list, and
// whether the last read failed: the list on screen is then the one before it) and `error` (the first read failed: nothing to show).
// A hidden page does not ask; a failure that asking again does not fix (the session ended, the project is gone) stops the polling.
import { useCallback, useEffect, useRef, useState } from "react";
import { PERMANENT_FAILURE_CODES } from "../../ui/use-live-snapshot.ts";
import type { TodoList } from "../service.ts";
import { TODOS_POLL_MS, type TodosApi } from "./api.ts";

export type TodoListState =
  | { status: "loading" }
  | { status: "ready"; list: TodoList; failed: boolean }
  | {
      status: "error";
      code: string;
      httpStatus: number | null;
      stopped: boolean;
    };

const STOPPING_CODES: readonly string[] = [
  ...PERMANENT_FAILURE_CODES,
  "TODOS_PROJECT_NOT_FOUND",
];

export function useTodoList(
  api: TodosApi,
  projectId: string | undefined,
  { enabled = true }: { enabled?: boolean } = {},
): { state: TodoListState; refresh: () => Promise<void> } {
  const [state, setState] = useState<TodoListState>({ status: "loading" });
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  });
  // The effect's reader, for the callers that want a read now.
  const readNow = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    if (!enabled) return;
    let ended = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<void> | null = null;

    function schedule() {
      if (ended) return;
      clearTimeout(timer);
      timer = setTimeout(() => void read(), TODOS_POLL_MS);
    }

    function read(): Promise<void> {
      // A page nobody looks at asks again as soon as it is shown.
      if (typeof document !== "undefined" && document.hidden) {
        schedule();
        return Promise.resolve();
      }
      if (inFlight !== null) return inFlight;
      inFlight = (async () => {
        const result = await apiRef.current.list(projectId);
        inFlight = null;
        if (ended) return;
        if (result.ok) {
          setState({ status: "ready", list: result.data, failed: false });
        } else {
          const stopped = STOPPING_CODES.includes(result.code);
          setState((before) =>
            before.status === "ready"
              ? { ...before, failed: true }
              : {
                  status: "error",
                  code: result.code,
                  httpStatus: result.status,
                  stopped,
                },
          );
          if (stopped) {
            ended = true;
            return;
          }
        }
        schedule();
      })();
      return inFlight;
    }

    function onVisible() {
      if (document.hidden || ended) return;
      clearTimeout(timer);
      void read();
    }

    // A read that was already on its way may have started before what asked for this one (an answer): wait for it, then read again.
    readNow.current = async () => {
      clearTimeout(timer);
      if (inFlight !== null) await inFlight;
      if (!ended) await read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ended = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      readNow.current = () => Promise.resolve();
    };
  }, [projectId, enabled]);

  const refresh = useCallback(() => readNow.current(), []);
  return { state, refresh };
}
