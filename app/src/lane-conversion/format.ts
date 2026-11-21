// SPDX-License-Identifier: LicenseRef-Proprietary

// The report of the lane conversion as lines an operator reads (the JSON form is the report itself). Pure. No secret is ever in a report:
// it holds ids, names the workspace chose, reason codes and the sentences of `convert.ts`.
import type { LaneConversionReport, LaneReportEntry } from "./types.ts";

const PREFIX = "[lanes:convert]";

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
  return lines;
}

/** The report as lines. The last line says whether release B may ship: the list of release A is empty. */
export function reportLines(report: LaneConversionReport): string[] {
  const { counts } = report;
  const lines = [
    report.dryRun
      ? `${PREFIX} dry run: nothing is saved or archived.`
      : `${PREFIX} conversion done.`,
    `${PREFIX} ${String(report.workspaces)} workspace(s), ${String(report.lanes.length)} lane(s) that are not archived: ` +
      `${String(counts.converted)} converted, ${String(counts.would_convert)} would be converted, ` +
      `${String(counts.already_inline)} already inline, ${String(counts.not_converted)} not converted, ` +
      `${String(counts.archived_without_project)} archived without a project, ${String(counts.would_archive_without_project)} would be archived without a project.`,
  ];
  if (report.archivedWithoutProject.length > 0) {
    lines.push(
      `${PREFIX} ${report.dryRun ? "Lanes without a project that would be archived" : "Lanes without a project, archived"}:`,
    );
    for (const entry of report.archivedWithoutProject)
      lines.push(...entryLines(entry));
  }
  if (report.notConverted.length > 0) {
    lines.push(
      `${PREFIX} THE LIST OF RELEASE A (lanes that still hold a profile or an environment and were not converted):`,
    );
    for (const entry of report.notConverted) lines.push(...entryLines(entry));
  }
  lines.push(
    report.notConverted.length === 0
      ? `${PREFIX} The list of release A is empty.`
      : `${PREFIX} The list of release A has ${String(report.notConverted.length)} lane(s): release B must not ship until it is empty.`,
  );
  return lines;
}
