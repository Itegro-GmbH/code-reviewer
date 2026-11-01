// SPDX-License-Identifier: LicenseRef-Proprietary

// Which job may report the implementer block, and when it must (#754): the block belongs to a turn of the Implementer and to
// no other job, and a turn that succeeded has to say what it did. A failed turn may have none (the runner failed before it had
// a repository).
import { describe, expect, it } from "vitest";
import type { RunnerResult } from "./contract.ts";
import { implementerBlockProblems } from "./implementer-report.ts";

const BLOCK = {
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  pushed: true,
  commits: [{ sha: "b".repeat(40), subject: "Add a health endpoint" }],
  filesChanged: [{ path: "src/health.ts", status: "added" as const }],
  summary: "Added a health endpoint.",
  opencode: null,
};

function resultOf(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    ok: true,
    durationMs: 1,
    commentUrl: null,
    errorCode: null,
    errorMessage: null,
    logTail: "",
    logTruncated: false,
    usage: null,
    ...overrides,
  };
}

describe("the implementer block and the kind of the job", () => {
  // #754-T03
  it("is required of a successful turn", () => {
    expect(implementerBlockProblems("implementer", resultOf())).toEqual([
      { field: "result.implementer", code: "required" },
    ]);
    expect(
      implementerBlockProblems("implementer", resultOf({ implementer: BLOCK })),
    ).toEqual([]);
  });

  // #754-T02
  it("is optional of a failed turn, which keeps it when it has one", () => {
    const failed = { ok: false, errorCode: "cost_limit_reached" };

    expect(implementerBlockProblems("implementer", resultOf(failed))).toEqual(
      [],
    );
    expect(
      implementerBlockProblems(
        "implementer",
        resultOf({ ...failed, implementer: BLOCK }),
      ),
    ).toEqual([]);
  });

  // #754-T03
  it.each(["diff", "dynamic"] as const)(
    "is refused for a %s job, success or failure",
    (kind) => {
      for (const result of [
        resultOf({ implementer: BLOCK }),
        resultOf({ ok: false, errorCode: "timeout", implementer: BLOCK }),
      ])
        expect(implementerBlockProblems(kind, result)).toEqual([
          { field: "result.implementer", code: "invalid" },
        ]);
      expect(implementerBlockProblems(kind, resultOf())).toEqual([]);
    },
  );
});
