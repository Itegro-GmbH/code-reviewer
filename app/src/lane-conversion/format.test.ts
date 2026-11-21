// SPDX-License-Identifier: LicenseRef-Proprietary

// #1105: the report lines and the exit code of the lane conversion are one verdict. "The list of release A is empty." is said only by a real
// run over all workspaces that finished with nothing left; a dry run, a run over one workspace, a run that ended early and a run with lanes
// on the list each say what they are, and the exit code never calls them done when something is left.
import { describe, expect, it } from "vitest";
import { exitCodeOf, LANE_CONVERSION_EXIT } from "./exit-code.ts";
import { progressLine, reportLines } from "./format.ts";
import {
  LANE_OUTCOMES,
  type LaneConversionReport,
  type LaneOutcome,
  type LaneReportEntry,
} from "./types.ts";

const EMPTY = "The list of release A is empty.";

function entry(
  outcome: LaneOutcome,
  rest: Partial<LaneReportEntry> = {},
): LaneReportEntry {
  return {
    workspaceId: "ws-1",
    laneId: `lane-${outcome}`,
    laneName: "Lane",
    projectId: "p-1",
    outcome,
    reasons: [],
    warnings: [],
    ...rest,
  };
}

function reportOf(
  lanes: LaneReportEntry[],
  rest: Partial<LaneConversionReport> = {},
): LaneConversionReport {
  return {
    dryRun: false,
    scope: { kind: "all" },
    complete: true,
    workspaces: 1,
    workspacesReached: 1,
    workspaceFailures: [],
    lanes,
    notConverted: lanes.filter((lane) => lane.outcome === "not_converted"),
    archivedWithoutProject: lanes.filter(
      (lane) =>
        lane.outcome === "archived_without_project" ||
        lane.outcome === "would_archive_without_project",
    ),
    warned: lanes.filter((lane) => lane.warnings.length > 0),
    gone: lanes.filter((lane) => lane.outcome === "lane_gone"),
    counts: Object.fromEntries(
      LANE_OUTCOMES.map((outcome) => [
        outcome,
        lanes.filter((lane) => lane.outcome === outcome).length,
      ]),
    ) as LaneConversionReport["counts"],
    ...rest,
  };
}

const text = (report: LaneConversionReport) => reportLines(report).join("\n");

describe("the verdict of the lane conversion", () => {
  // #1105-T330
  it("says the list is empty only after a real run over all workspaces with nothing left, and exits 0", () => {
    const report = reportOf([entry("converted"), entry("already_inline")]);

    expect(text(report)).toContain(EMPTY);
    expect(text(report)).toContain("REAL RUN, covering all workspaces");
    expect(exitCodeOf(report)).toBe(LANE_CONVERSION_EXIT.done);
  });

  // #1105-T331
  it("never says the list is empty after a dry run, and exits 3 when lanes would still change", () => {
    for (const outcome of [
      "would_convert",
      "would_archive_without_project",
    ] as const) {
      const report = reportOf([entry(outcome)], { dryRun: true });

      expect(text(report)).not.toContain(EMPTY);
      expect(text(report)).toContain("DRY RUN");
      expect(text(report)).toContain("NOT the gate of release B");
      expect(exitCodeOf(report)).toBe(LANE_CONVERSION_EXIT.pending);
    }
    const quiet = reportOf([entry("already_inline")], { dryRun: true });
    expect(text(quiet)).not.toContain(EMPTY);
    expect(exitCodeOf(quiet)).toBe(0);
  });

  // #1105-T332
  it("says a run over one workspace covered only that workspace and is not the gate", () => {
    const report = reportOf([entry("converted")], {
      scope: { kind: "workspace", workspaceId: "ws-1" },
    });

    expect(text(report)).not.toContain(EMPTY);
    expect(text(report)).toContain("ONLY workspace ws-1");
    expect(text(report)).toContain("NOT the gate of release B");
  });

  // #1105-T333
  it("exits 2 for lanes on the list or a failed workspace, and 1 for a run that ended early, which says so", () => {
    const listed = reportOf([
      entry("not_converted", {
        reasons: [{ code: "profile_missing", message: "x", stepId: "s" }],
      }),
    ]);
    const failed = reportOf([], {
      workspaceFailures: [{ workspaceId: "ws-2", code: "08006", message: "m" }],
    });
    const early = reportOf([entry("converted")], {
      complete: false,
      aborted: { code: "08006", message: "ended" },
    });

    expect(exitCodeOf(listed)).toBe(LANE_CONVERSION_EXIT.listed);
    expect(text(listed)).toContain("is NOT empty");
    expect(exitCodeOf(failed)).toBe(LANE_CONVERSION_EXIT.listed);
    expect(text(failed)).toContain("WORKSPACE FAILED ws-2");
    expect(exitCodeOf(early)).toBe(LANE_CONVERSION_EXIT.failed);
    expect(text(early)).toContain("THE RUN ENDED EARLY");
    expect(text(early)).not.toContain(EMPTY);
  });

  // #1105-T334
  it("lists the lanes that vanished, the lanes with an unchecked model and the lanes archived without a project, each with its warning", () => {
    const report = reportOf([
      entry("lane_gone", { laneId: "gone" }),
      entry("converted", {
        laneId: "conv",
        warnings: [
          {
            code: "model_unchecked",
            stepId: "implement",
            message: "not checked",
          },
        ],
      }),
      entry("archived_without_project", {
        laneId: "orphan",
        projectId: null,
        warnings: [{ code: "archived_without_project", message: "archived" }],
      }),
    ]);

    const lines = text(report);
    expect(lines).toContain("1 gone during the run");
    expect(lines).toContain("! model_unchecked (step implement)");
    expect(lines).toContain("! archived_without_project");
    expect(lines).toContain("Lanes deleted or archived");
    expect(progressLine(entry("converted", { version: 3 }))).toContain(
      "to version 3",
    );
    expect(exitCodeOf(report)).toBe(0);
  });
});
