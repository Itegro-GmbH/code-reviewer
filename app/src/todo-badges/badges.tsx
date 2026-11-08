// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The counts of open ToDos (#925): the badge on the sidebar's ToDos link and the one on the ToDos tab of a project, read from the app's own
// route when the page changes and again, fresh, when the ToDos page says that something changed (an answer, a review, or an open ToDo that
// appeared or went away), so a badge follows without a navigation. Nothing is shown for none, and nothing when the read fails: a badge that
// cannot be loaded is no badge, never an error in the navigation. A read that finishes after a newer one was started is thrown away.
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { readTodoCounts, type TodoCounts } from "./reader.ts";
import { TODOS_CHANGED_EVENT } from "./events.ts";

function useTodoCounts(
  workspaceSlug: string,
  pathname: string | null,
): TodoCounts | null {
  const [counts, setCounts] = useState<TodoCounts | null>(null);
  useEffect(() => {
    let current = true;
    let newest = 0;
    async function load(fresh: boolean) {
      newest += 1;
      const mine = newest;
      const read = await readTodoCounts(workspaceSlug, fresh);
      if (current && mine === newest && read !== null) setCounts(read);
    }
    void load(false);
    const onChanged = () => void load(true);
    window.addEventListener(TODOS_CHANGED_EVENT, onChanged);
    return () => {
      current = false;
      window.removeEventListener(TODOS_CHANGED_EVENT, onChanged);
    };
  }, [workspaceSlug, pathname]);
  return counts;
}

export function TodoCount({
  workspaceSlug,
  pathname,
}: {
  workspaceSlug: string;
  /** The current page: the count is read again when it changes, so answering a ToDo is seen in the next page. */
  pathname: string | null;
}) {
  const open = useTodoCounts(workspaceSlug, pathname)?.open ?? 0;
  if (open === 0) return null;
  return (
    <span className="ml-auto rounded-full border border-warning bg-warning-soft px-2 text-xs leading-4 font-semibold text-warning">
      <span className="sr-only">Open: </span>
      {open}
    </span>
  );
}

/** The number on the ToDos tab of a project: the open ToDos of that project, from the same read as the sidebar's. */
export function ProjectTodoBadge({
  workspaceSlug,
  projectId,
}: {
  workspaceSlug: string;
  /** The project's id; none for a repository that is not a project yet, which has no ToDos. */
  projectId: string | null;
}) {
  const counts = useTodoCounts(workspaceSlug, usePathname());
  const open = projectId === null ? 0 : (counts?.projects[projectId] ?? 0);
  if (open === 0) return null;
  return (
    <span className="ml-2 rounded-full border border-warning bg-warning-soft px-2 text-xs leading-4 font-semibold text-warning">
      <span className="sr-only">Open: </span>
      {open}
    </span>
  );
}
