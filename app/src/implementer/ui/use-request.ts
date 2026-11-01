// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// Loads one thing from a route when the component shows (and again on request): the repositories, the models, the branches of the
// chosen repository. An answer for another key than the one shown (a repository that was left before its branches arrived) is
// not an answer yet, so a slow response can never overwrite a newer choice.
import { useCallback, useEffect, useState } from "react";
import type { RequestResult } from "../../ui/json-request.ts";

export type Loaded<T> =
  /** There is nothing to load yet (no key). */
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed"; failure: Extract<RequestResult<T>, { ok: false }> }
  | { state: "ready"; data: T };

/**
 * `select` must be a stable function (a module level one): it is a dependency of the effect. `key` names what is loaded, null for
 * nothing. The second value loads again.
 */
export function useRequest<Api, T>(
  api: Api,
  key: string | null,
  select: (api: Api, key: string) => Promise<RequestResult<T>>,
): [Loaded<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [done, setDone] = useState<{
    api: Api;
    key: string;
    attempt: number;
    result: RequestResult<T>;
  } | null>(null);
  useEffect(() => {
    if (key === null) return;
    let current = true;
    void select(api, key).then((result) => {
      if (current) setDone({ api, key, attempt, result });
    });
    return () => {
      current = false;
    };
  }, [api, key, select, attempt]);
  const reload = useCallback(() => {
    setAttempt((count) => count + 1);
  }, []);

  if (key === null) return [{ state: "idle" }, reload];
  if (
    done === null ||
    done.api !== api ||
    done.key !== key ||
    done.attempt !== attempt
  )
    return [{ state: "loading" }, reload];
  return [
    done.result.ok
      ? { state: "ready", data: done.result.data }
      : { state: "failed", failure: done.result },
    reload,
  ];
}
