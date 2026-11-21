// SPDX-License-Identifier: LicenseRef-Proprietary

// The exit code of `pnpm lanes:convert` (#1105, ADR 0007), as one pure function of the report, so a script that gates release B on it and the
// text the operator reads cannot disagree. Only 0 means "nothing is left to do"; every other code means something is left, or the job did
// not finish. The gate of release B is a **real run over all workspaces** that exits 0.
export const LANE_CONVERSION_EXIT = {
  /** Nothing is left: no lane would change or is listed, and no workspace failed. (A real run over all workspaces: the gate of release B.) */
  done: 0,
  /** The job could not run (the configuration, the database, an unknown workspace), or it ended early. A partial report may still be out. */
  failed: 1,
  /** Lanes are on the list of release A (or a workspace failed): a person must act, and run it again. */
  listed: 2,
  /** A dry run only: the real run would convert or archive lanes, so the release is not ready; run it without `--dry-run`. */
  pending: 3,
} as const;

type ExitInput = {
  dryRun: boolean;
  complete: boolean;
  workspaceFailures: readonly unknown[];
  notConverted: readonly unknown[];
  counts: { would_convert: number; would_archive_without_project: number };
};

/** The exit code of a report: 1 over 2 over 3 over 0. */
export function exitCodeOf(report: ExitInput): number {
  if (!report.complete) return LANE_CONVERSION_EXIT.failed;
  if (report.notConverted.length > 0 || report.workspaceFailures.length > 0)
    return LANE_CONVERSION_EXIT.listed;
  if (
    report.dryRun &&
    report.counts.would_convert + report.counts.would_archive_without_project >
      0
  )
    return LANE_CONVERSION_EXIT.pending;
  return LANE_CONVERSION_EXIT.done;
}
