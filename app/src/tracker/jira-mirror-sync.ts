// SPDX-License-Identifier: LicenseRef-Proprietary

// The slot where the full read of a Jira project into the mirror (`jira/resync.ts`, #1040) is registered for the process. The tracker module may
// not import `jira` (an import cycle: `jira` writes into the tracker), and eight routes and pages build a `TrackerService`, so the Jira part is
// registered once at the start of the process (`instrumentation.ts`) and found here with every service. Kept on `globalThis` under a symbol: the
// routes of a Next.js server are separate bundles of one process. Without a registration a Jira project is `TRACKER_SOURCE_NOT_MIRRORED`.
import type { JiraMirrorSync } from "./service.ts";

const SLOT = Symbol.for("code-reviewer.jira-mirror-sync");

type Factory = (workspaceId: string) => JiraMirrorSync;

export function registerJiraMirrorSync(factory: Factory): void {
  (globalThis as unknown as Record<symbol, unknown>)[SLOT] = factory;
}

/** The Jira sync of a workspace, or undefined when none was registered. */
export function registeredJiraMirrorSync(
  workspaceId: string,
): JiraMirrorSync | undefined {
  const factory = (globalThis as unknown as Record<symbol, unknown>)[SLOT];
  return typeof factory === "function"
    ? (factory as Factory)(workspaceId)
    : undefined;
}
