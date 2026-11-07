// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/tracker-resync, called once a night by the platform's cron (`vercel.json`; #932): the full sync of the ticket mirror
// (#923) for every active project. The webhooks keep the mirror current, but a delivery can be missed (an App that does not subscribe to
// `issues`, `sub_issues` or `check_suite`, a delivery GitHub gave up on), and nothing else heals that: the sync is the one thing that
// rebuilds the cache from GitHub (`docs/ticket-mirror.md`). It is the same sync as the Resync route; this file only walks the projects.
//
//  - One project's failure never stops the others: each one is tried on its own and logged by its repository id and the code of its failure.
//  - The run has a budget (the function's time limit is longer): projects are taken the one synced longest ago first, a project the budget
//    ends in the middle of keeps its position (the sync is resumable) and the next run continues it, and the projects not reached are
//    counted as `deferred` and come first the next night.
//  - A deployment without the factory (`implementer`) reads the mirror nowhere: nothing is asked of GitHub there and the answer is `skipped`.
//  - Overlapping runs are safe: the sync is claimed in the database, a second caller continues the sync that is there.
// The answer carries counts only.
import "server-only";
import { refuseUnlessCron } from "./auth.ts";

export const TRACKER_RESYNC_ERROR_CODES = ["TRACKER_RESYNC_FAILED"] as const;

/** How long one run reads before it stops starting or continuing syncs (the function may run 300 seconds). */
export const RESYNC_BUDGET_MS = 240_000;
/** How long one call of the sync reads before it answers `partial`. */
export const RESYNC_CALL_MS = 20_000;

/** An active project whose repository the mirror holds. */
export type ResyncTarget = {
  workspaceId: string;
  repositoryId: string;
  /** When its last full sync ended (ISO 8601); null for a project that never had one. */
  lastFullSyncAt: string | null;
};

type Dependencies = {
  env: Readonly<Record<string, string | undefined>>;
  /** False in a deployment that has no use for the mirror. */
  enabled: () => boolean;
  targets: () => Promise<ResyncTarget[]>;
  /** One call of the sync of one project until `deadline` (milliseconds since the epoch); throws what the sync throws. */
  resync: (
    target: ResyncTarget,
    deadline: number,
  ) => Promise<{ status: "done" | "partial" }>;
  now?: () => number;
  budgetMs?: number;
  /** The line of a project that failed; default: console.error. */
  logFailure?: (line: string) => void;
};

export type ResyncCounts = {
  projects: number;
  done: number;
  partial: number;
  failed: number;
  deferred: number;
};

/** The code of a failure for the log: never its message, which may carry what the platform answered. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error)
    return String((error as { code: unknown }).code).slice(0, 64);
  return error instanceof Error ? error.name : "unknown";
}

/** Walks the projects, the one synced longest ago first; every project is its own try. */
export async function resyncProjects(
  targets: readonly ResyncTarget[],
  options: Pick<Dependencies, "resync" | "now" | "budgetMs" | "logFailure">,
): Promise<ResyncCounts> {
  const now = options.now ?? (() => Date.now());
  const logFailure =
    options.logFailure ?? ((line: string) => console.error(line));
  const stopAt = now() + (options.budgetMs ?? RESYNC_BUDGET_MS);
  const counts: ResyncCounts = {
    projects: targets.length,
    done: 0,
    partial: 0,
    failed: 0,
    deferred: 0,
  };
  const ordered = [...targets].sort((a, b) =>
    a.lastFullSyncAt === b.lastFullSyncAt
      ? a.repositoryId.localeCompare(b.repositoryId)
      : a.lastFullSyncAt === null
        ? -1
        : b.lastFullSyncAt === null
          ? 1
          : a.lastFullSyncAt.localeCompare(b.lastFullSyncAt),
  );
  for (const target of ordered) {
    if (now() >= stopAt) {
      counts.deferred += 1;
      continue;
    }
    try {
      let status: "done" | "partial" = "partial";
      while (status === "partial" && now() < stopAt) {
        const deadline = Math.min(now() + RESYNC_CALL_MS, stopAt);
        status = (await options.resync(target, deadline)).status;
      }
      if (status === "done") counts.done += 1;
      else counts.partial += 1;
    } catch (error) {
      counts.failed += 1;
      logFailure(
        `[tracker] TRACKER_RESYNC_PROJECT_FAILED: the nightly resync of repository=${target.repositoryId} failed (${codeOf(error)}); the other projects go on.`,
      );
    }
  }
  return counts;
}

export async function handleTrackerResyncCron(
  request: Request,
  { env, enabled, targets, resync, now, budgetMs, logFailure }: Dependencies,
): Promise<Response> {
  const refusal = refuseUnlessCron(request, env);
  if (refusal !== null) return refusal;
  const headers = { "cache-control": "no-store" };
  if (!enabled())
    return Response.json(
      { status: "skipped", reason: "not_enabled" },
      { headers },
    );
  try {
    const counts = await resyncProjects(await targets(), {
      resync,
      ...(now === undefined ? {} : { now }),
      ...(budgetMs === undefined ? {} : { budgetMs }),
      ...(logFailure === undefined ? {} : { logFailure }),
    });
    console.info(
      `[tracker] nightly resync done: ${String(counts.projects)} projects, ${String(counts.done)} done, ${String(counts.partial)} partial, ` +
        `${String(counts.failed)} failed, ${String(counts.deferred)} deferred`,
    );
    return Response.json({ status: "ok", ...counts }, { headers });
  } catch {
    // The cause is not repeated: it may carry a connection string. The platform shows the 500.
    console.error(
      "[tracker] TRACKER_RESYNC_FAILED: the nightly resync could not list the projects.",
    );
    return Response.json(
      { status: "error", code: "TRACKER_RESYNC_FAILED" },
      { status: 500, headers },
    );
  }
}
