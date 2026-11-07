// SPDX-License-Identifier: LicenseRef-Proprietary

"use client";
// The count on the sidebar's ToDos link (#925): the number of open ToDos, read from the app's own route when the page changes. Nothing
// is shown for none, and nothing when the read fails: a badge that cannot be loaded is no badge, never an error in the navigation.
import { useEffect, useState } from "react";
import { workspaceApiPath } from "../workspaces/paths.ts";

export function TodoCount({
  workspaceSlug,
  pathname,
}: {
  workspaceSlug: string;
  /** The current page: the count is read again when it changes, so answering a ToDo is seen in the next page. */
  pathname: string | null;
}) {
  const [open, setOpen] = useState(0);
  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const response = await fetch(
          workspaceApiPath(workspaceSlug, "/todos/count"),
          { credentials: "same-origin" },
        );
        if (!response.ok) return;
        const body = (await response.json()) as { open?: unknown };
        if (current && typeof body.open === "number" && body.open >= 0)
          setOpen(body.open);
      } catch {
        // No badge.
      }
    }
    void load();
    return () => {
      current = false;
    };
  }, [workspaceSlug, pathname]);
  if (open === 0) return null;
  return (
    <span className="ml-auto rounded-full border border-warning bg-warning-soft px-2 text-xs leading-4 font-semibold text-warning">
      <span className="sr-only">Open: </span>
      {open}
    </span>
  );
}
