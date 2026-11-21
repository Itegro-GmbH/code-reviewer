// SPDX-License-Identifier: LicenseRef-Proprietary

// The report of the lane conversion as lines an operator reads (the JSON form is the report itself). Pure. No secret is ever in a report:
// it holds ids, names the workspace chose, reason codes, models by provider and id, and the sentences of `convert.ts` and `run.ts`.
//
// The last line is the verdict and is worded so it cannot be mistaken: "The list of release A is empty." appears only after a **real run
// over all workspaces** that finished with nothing left. A dry run, a run over one workspace, a run that ended early and a run with lanes
// on the list each say what they are instead.
import type {
  LaneConversionReport,
  LaneReportEntry,
  LaneWarning,
} from "./types.ts";

const PREFIX = "[lanes:convert]";

/** The one line printed for a lane as soon as it is done (outcomes of "already inline" print nothing). */
export function progressLine(entry: LaneReportEntry): string {
  const what = `workspace ${entry.workspaceId}, lane ${entry.laneId} "${entry.laneName}"`;
  switch (entry.outcome) {
    case "converted":
      return `${PREFIX} converted ${what} to version ${String(entry.version)}`;
    case "would_convert":
      return `${PREFIX} would convert ${what} to version ${String(entry.version)}`;
    case "archived_without_project":
      return `${PREFIX} archived ${what} (no project)`;
    case "would_archive_without_project":
      return `${PREFIX} would archive ${what} (no project)`;
    case "not_converted": {
      const codes = entry.reasons.map((reason) => reason.code).join(", ");
      return `${PREFIX} NOT converted ${what}: ${codes}`;
    }
    case "lane_gone":
      return `${PREFIX} lane gone while the run was going: ${what}`;
    case "already_inline":
      return `${PREFIX} already inline: ${what}`;
  }
}

function warningLines(warnings: readonly LaneWarning[]): string[] {
  return warnings.map(
    (warning) =>
      `${PREFIX}     ! ${warning.code}${warning.stepId === undefined ? "" : ` (step ${warning.stepId})`}: ${warning.message}`,
  );
}

function entryLines(entry: LaneReportEntry): string[] {
  const lines = [
    `${PREFIX}   workspace ${entry.workspaceId}, lane ${entry.laneId} "${entry.laneName}"`,
  ];
  for (const reason of entry.reasons) {
    lines.push(
      `${PREFIX}     - ${reason.code}${reason.stepId === undefined ? "" : ` (step ${reason.stepId})`}: ${reason.message}`,
    );
    for (const candidate of reason.candidates ?? [])
      lines.push(
        `${PREFIX}         candidate runner ${candidate.id} "${candidate.name}"`,
      );
    for (const found of reason.issues ?? [])
      lines.push(
        `${PREFIX}         issue ${found.code} at ${found.path === "" ? "/" : found.path}`,
      );
  }
  lines.push(...warningLines(entry.warnings));
  return lines;
}

/** The first two lines: what kind of run this was and what it covered, then the counts per outcome. */
function summaryLines(report: LaneConversionReport): string[] {
  const { counts } = report;
  const scope =
    report.scope.kind === "all"
      ? "all workspaces"
      : `ONLY workspace ${report.scope.workspaceId}`;
  const kind = report.dryRun
    ? "DRY RUN (nothing is saved or archived)"
    : "REAL RUN";
  const outcomes = report.dryRun
    ? [
        `${String(counts.would_convert)} would be converted`,
        `${String(counts.would_archive_without_project)} would be archived without a project`,
      ]
    : [
        `${String(counts.converted)} converted`,
        `${String(counts.archived_without_project)} archived without a project`,
      ];
  outcomes.push(
    `${String(counts.already_inline)} already inline`,
    `${String(counts.not_converted)} not converted (on the list)`,
    `${String(counts.lane_gone)} gone during the run`,
  );
  return [
    `${PREFIX} ${kind}, covering ${scope}: ${String(report.workspacesReached)} of ${String(report.workspaces)} workspace(s) reached, ${String(report.workspaceFailures.length)} failed.`,
    `${PREFIX} ${String(report.lanes.length)} lane(s) that are not archived were looked at: ${outcomes.join(", ")}; ${String(report.warned.length)} with a warning.`,
  ];
}

/** The verdict, the last line. */
function verdictLine(report: LaneConversionReport): string {
  const listed = report.notConverted.length;
  const failed = report.workspaceFailures.length;
  if (!report.complete)
    return `${PREFIX} THE RUN ENDED EARLY: the report above is partial and says nothing about release A. Run it again.`;
  if (listed > 0 || failed > 0)
    return `${PREFIX} The list of release A is NOT empty: ${String(listed)} lane(s) on the list, ${String(failed)} workspace(s) failed. Release B must not ship until it is empty.`;
  const pending =
    report.counts.would_convert + report.counts.would_archive_without_project;
  if (report.dryRun)
    return pending > 0
      ? `${PREFIX} Dry run, NOT the gate of release B: ${String(report.counts.would_convert)} lane(s) would be converted and ${String(report.counts.would_archive_without_project)} archived without a project. Run it without --dry-run.`
      : `${PREFIX} Dry run, NOT the gate of release B: nothing would be converted, archived or listed. Only a real run (without --dry-run) over all workspaces tells whether release B may ship.`;
  if (report.scope.kind === "workspace")
    return `${PREFIX} Workspace ${report.scope.workspaceId} only: nothing is left in this workspace. This run says nothing about the other workspaces and is NOT the gate of release B; run it without --workspace.`;
  return `${PREFIX} The list of release A is empty.`;
}

/** The report as lines. */
export function reportLines(report: LaneConversionReport): string[] {
  const lines = summaryLines(report);
  if (report.aborted !== undefined)
    lines.push(
      `${PREFIX} ENDED EARLY (${report.aborted.code}): ${report.aborted.message}`,
    );
  for (const failure of report.workspaceFailures)
    lines.push(
      `${PREFIX} WORKSPACE FAILED ${failure.workspaceId} (${failure.code}): ${failure.message}`,
    );
  if (report.archivedWithoutProject.length > 0) {
    lines.push(
      `${PREFIX} ${report.dryRun ? "Lanes without a project that would be archived" : "Lanes without a project, archived"}:`,
    );
    for (const entry of report.archivedWithoutProject)
      lines.push(...entryLines(entry));
  }
  if (report.gone.length > 0) {
    lines.push(
      `${PREFIX} Lanes deleted or archived by somebody while the run was going (nothing was done to them):`,
    );
    for (const entry of report.gone) lines.push(...entryLines(entry));
  }
  const converted = report.warned.filter(
    (entry) =>
      entry.outcome === "converted" || entry.outcome === "would_convert",
  );
  if (converted.length > 0) {
    lines.push(
      `${PREFIX} ${report.dryRun ? "Lanes that would be converted" : "Lanes converted"} with a model that was NOT checked against the workspace's model rule (a later save in the app may refuse it):`,
    );
    for (const entry of converted) lines.push(...entryLines(entry));
  }
  if (report.notConverted.length > 0) {
    lines.push(
      `${PREFIX} THE LIST OF RELEASE A (lanes that still hold a profile or an environment and were not converted):`,
    );
    for (const entry of report.notConverted) lines.push(...entryLines(entry));
  }
  lines.push(verdictLine(report));
  return lines;
}
