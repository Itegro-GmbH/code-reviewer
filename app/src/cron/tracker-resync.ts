// SPDX-License-Identifier: LicenseRef-Proprietary

// GET /api/internal/tracker-resync, called once a night by the platform's cron (`vercel.json`; #932): the full sync of the ticket mirror
// (#923) for every active project. The webhooks keep the mirror current, but a delivery can be missed (an App that does not subscribe to
// `issues`, `sub_issues` or `check_suite`, a delivery GitHub gave up on), and nothing else heals that: the sync is the one thing that
// rebuilds the cache from GitHub (`docs/ticket-mirror.md`). It is the same sync as the Resync route; this file only walks the projects.
//
//  - One project's failure never stops the others: each one is tried on its own and logged by its repository id and the code of its failure
//    (the platform's own code when it has one). A rate limit of the platform also skips the rest of that installation in this run.
//  - The run has a budget (the function's time limit is longer), and the clock starts when the handler is entered. Every project gets a fair
//    slice of what is left (the rest of the budget divided by the projects still to go, but not less than `RESYNC_MIN_SLICE_MS`), so one
//    huge project cannot use up the night for the others.
//  - Projects whose last sync ended (or never ran) come first, the one attempted longest ago first; a project whose last sync did not end
//    comes after them, so it neither goes first every night nor starves the rest. The projects the budget does not reach are counted
//    `deferred`; they keep their old attempt time and so come first the next night.
//  - A sync the slice ends in the middle of CONTINUES the next night (the cron asks the sync to `resume`; `RESUME_STALE_AFTER_MS` in
//    `sync.ts`): a project too big for one slice is `partial` for a few nights, completes, and only then applies the rebuild rule (what
//    GitHub no longer has is removed). The rebuild counts from the start of the whole sync, not of the last night. A sync that has not
//    moved for a week starts again from the first page.
//  - A page in flight is aborted a little after the slice ends (`RESYNC_ABORT_GRACE_MS`) and never later than `RESYNC_HARD_LIMIT_MS`
//    into the run, so a slow answer of GitHub cannot take the function past its limit and the counts line is always logged. A project
//    whose page was aborted that way counts `partial` (the sync stands where it was), not `failed`.
//  - A deployment without the factory (`implementer`) reads the mirror nowhere: nothing is asked of GitHub there and the answer is `skipped`.
//  - Overlapping runs are safe: the sync is claimed in the database, a second caller continues the sync that is there.
// The answer carries counts only.
import "server-only";
import type { ResyncTarget } from "../tracker/resync-targets.ts";
import { refuseUnlessCron } from "./auth.ts";

export const TRACKER_RESYNC_ERROR_CODES = ["TRACKER_RESYNC_FAILED"] as const;

/** How long one run reads before it stops starting or continuing syncs (the function may run 300 seconds). */
export const RESYNC_BUDGET_MS = 240_000;
/** How long one call of the sync reads before it answers `partial`. */
export const RESYNC_CALL_MS = 20_000;

/** How long after the end of its slice the page of a project that is in flight may still be answered. */
export const RESYNC_ABORT_GRACE_MS = 30_000;
/** The latest, from the start of the run, that a page in flight is aborted: the function's 300 seconds less a margin to log and answer. */
export const RESYNC_HARD_LIMIT_MS = 285_000;

/** The least a project gets of the budget (a call of the sync reads at least one page), unless the budget itself is smaller. */
export const RESYNC_MIN_SLICE_MS = 10_000;

/** The codes of a platform's failure that say the installation is out of calls for now: asking for another project of it is pointless. */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  "INTEGRATION_ACCESS_RATE_LIMITED",
  "GITHUB_APP_RATE_LIMITED",
]);

type Dependencies = {
  env: Readonly<Record<string, string | undefined>>;
  /** False in a deployment that has no use for the mirror. */
  enabled: () => boolean;
  targets: () => Promise<ResyncTarget[]>;
  /**
   * One call of the sync of one project until `deadline` (milliseconds since the epoch); throws what the sync throws. The signal aborts
   * the page in flight a little after the slice of the project is over.
   */
  resync: (
    target: ResyncTarget,
    deadline: number,
    signal: AbortSignal,
  ) => Promise<{ status: "done" | "partial" }>;
  now?: () => number;
  budgetMs?: number;
  /** The least of the budget a project gets; default `RESYNC_MIN_SLICE_MS`. */
  minSliceMs?: number;
  /** The line of a project that failed; default: console.error. */
  logFailure?: (line: string) => void;
  /** The line with the counts of the run; default: console.info. */
  log?: (line: string) => void;
};

export type ResyncCounts = {
  projects: number;
  done: number;
  partial: number;
  failed: number;
  deferred: number;
};

/** The code of a failure for the log: the platform's own when the failure has one, never a message, which may carry what the platform answered. */
function codeOf(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { providerCode, code } = error as {
      providerCode?: unknown;
      code?: unknown;
    };
    if (typeof providerCode === "string") return providerCode.slice(0, 64);
    if (code !== undefined) return String(code).slice(0, 64);
  }
  return error instanceof Error ? error.name : "unknown";
}

/** Projects whose last sync ended (or never ran) first, then by the last attempt, the longest ago first (never: before any). */
function byTurn(a: ResyncTarget, b: ResyncTarget): number {
  if (a.unfinished !== b.unfinished) return a.unfinished ? 1 : -1;
  if (a.lastAttemptAt === b.lastAttemptAt)
    return a.repositoryId < b.repositoryId
      ? -1
      : a.repositoryId > b.repositoryId
        ? 1
        : 0;
  if (a.lastAttemptAt === null) return -1;
  if (b.lastAttemptAt === null) return 1;
  return a.lastAttemptAt < b.lastAttemptAt ? -1 : 1;
}

/** In how many milliseconds the page in flight of a project is aborted (at least 1): after the end of its slice, never past the hard limit. */
export function abortDelayMs(
  projectStopAt: number,
  startedAt: number,
  now: number,
): number {
  const abortAt = Math.min(
    projectStopAt + RESYNC_ABORT_GRACE_MS,
    startedAt + RESYNC_HARD_LIMIT_MS,
  );
  return Math.max(1, abortAt - now);
}

/**
 * Walks the projects in their turn; every project is its own try. `startedAt` is when the budget began (default: now). The line with the
 * counts is logged in every case, also when something other than a project's failure ends the walk.
 */
export async function resyncProjects(
  targets: readonly ResyncTarget[],
  options: Pick<
    Dependencies,
    "resync" | "now" | "budgetMs" | "minSliceMs" | "logFailure" | "log"
  > & { startedAt?: number },
): Promise<ResyncCounts> {
  const now = options.now ?? (() => Date.now());
  const logFailure =
    options.logFailure ?? ((line: string) => console.error(line));
  const minSliceMs = options.minSliceMs ?? RESYNC_MIN_SLICE_MS;
  const log = options.log ?? ((line: string) => console.info(line));
  const startedAt = options.startedAt ?? now();
  const stopAt = startedAt + (options.budgetMs ?? RESYNC_BUDGET_MS);
  const counts: ResyncCounts = {
    projects: targets.length,
    done: 0,
    partial: 0,
    failed: 0,
    deferred: 0,
  };
  const rateLimited = new Set<string>();
  try {
    const ordered = [...targets].sort(byTurn);
    for (const [index, target] of ordered.entries()) {
      if (now() >= stopAt || rateLimited.has(target.integrationId)) {
        counts.deferred += 1;
        continue;
      }
      // A fair share of what is left, for this project and the ones still to come (those of a rate limited installation are not counted
      // out: they are skipped one by one, and what they leave is the next project's).
      const slice = Math.max(
        minSliceMs,
        Math.floor((stopAt - now()) / (ordered.length - index)),
      );
      const projectStopAt = Math.min(now() + slice, stopAt);
      const signal = AbortSignal.timeout(
        abortDelayMs(projectStopAt, startedAt, now()),
      );
      try {
        let status: "done" | "partial" = "partial";
        while (status === "partial" && now() < projectStopAt) {
          const deadline = Math.min(now() + RESYNC_CALL_MS, projectStopAt);
          status = (await options.resync(target, deadline, signal)).status;
        }
        if (status === "done") counts.done += 1;
        else counts.partial += 1;
      } catch (error) {
        // The slice's own end aborted the page in flight: the sync stands where it was and goes on tomorrow, which is `partial`, not a failure.
        if (signal.aborted) {
          counts.partial += 1;
          continue;
        }
        counts.failed += 1;
        const code = codeOf(error);
        if (RATE_LIMIT_CODES.has(code)) rateLimited.add(target.integrationId);
        logFailure(
          `[tracker] TRACKER_RESYNC_PROJECT_FAILED: the nightly resync of repository=${target.repositoryId} failed (${code}); the other projects go on${RATE_LIMIT_CODES.has(code) ? ", those of the same installation are left for the next run" : ""}.`,
        );
      }
    }
  } finally {
    log(
      `[tracker] nightly resync done: ${String(counts.projects)} projects, ${String(counts.done)} done, ${String(counts.partial)} partial, ` +
        `${String(counts.failed)} failed, ${String(counts.deferred)} deferred`,
    );
  }
  return counts;
}

export async function handleTrackerResyncCron(
  request: Request,
  {
    env,
    enabled,
    targets,
    resync,
    now,
    budgetMs,
    minSliceMs,
    logFailure,
    log,
  }: Dependencies,
): Promise<Response> {
  // The budget runs from here: listing the projects is part of what the function's time limit pays for.
  const startedAt = (now ?? (() => Date.now()))();
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
      startedAt,
      ...(minSliceMs === undefined ? {} : { minSliceMs }),
      ...(now === undefined ? {} : { now }),
      ...(budgetMs === undefined ? {} : { budgetMs }),
      ...(logFailure === undefined ? {} : { logFailure }),
      ...(log === undefined ? {} : { log }),
    });
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
