// SPDX-License-Identifier: LicenseRef-Proprietary

// Which job may report the implementer block, and when it must (#754): the block belongs to a turn of the Implementer and to
// no other job, and a turn that succeeded has to say what it did. A failed turn may have none (the runner failed before it had
// a repository).
import { describe, expect, it } from "vitest";
import type { RunnerResult } from "./contract.ts";
import {
  implementerBlockProblems,
  implementerReposProblems,
} from "./implementer-report.ts";

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

// #1092 (review finding 2): the repositories of a report are the job's.
describe("the repositories of a report and the repositories of the job", () => {
  const JOB = [
    { name: "api", fullName: "acme/api", base: "main", branch: "feat" },
    { name: "web", fullName: "acme/web", base: "main", branch: "main" },
  ];
  const entry = (repo: (typeof JOB)[number]) => ({
    ...repo,
    created: false,
    baseCommit: BLOCK.baseCommit,
    headCommit: BLOCK.headCommit,
    pushed: true,
    commits: [],
    filesChanged: [],
  });
  const block = (repos: unknown[] | undefined, over: object = {}) =>
    ({ ...BLOCK, ...over, ...(repos === undefined ? {} : { repos }) }) as never;

  it("accepts the job's repositories in the job's order, and a block without repos for a job of one repository", () => {
    expect(implementerReposProblems(JOB, block(JOB.map(entry)))).toEqual([]);
    expect(implementerReposProblems(null, block(undefined))).toEqual([]);
    expect(implementerReposProblems(JOB, undefined)).toEqual([]);
  });

  it("refuses repos for a job of one repository, and none for a job of several", () => {
    expect(implementerReposProblems(null, block(JOB.map(entry)))).toEqual([
      { field: "result.implementer.repos", code: "invalid" },
    ]);
    expect(implementerReposProblems(JOB, block(undefined))).toEqual([
      { field: "result.implementer.repos", code: "required" },
    ]);
  });

  it("refuses another count and another order, naming the field and never a value", () => {
    expect(implementerReposProblems(JOB, block([entry(JOB[0]!)]))).toEqual([
      { field: "result.implementer.repos", code: "invalid" },
    ]);
    const swapped = implementerReposProblems(
      JOB,
      block([entry(JOB[1]!), entry(JOB[0]!)]),
    );
    expect(swapped.map((problem) => problem.field)).toContain(
      "result.implementer.repos[0].name",
    );
    expect(swapped.map((problem) => problem.field)).toContain(
      "result.implementer.repos[1].fullName",
    );
  });

  it.each(["base", "branch", "fullName"] as const)(
    "refuses an entry whose %s is not the job's",
    (key) => {
      const changed = { ...entry(JOB[0]!), [key]: "other" };
      expect(
        implementerReposProblems(JOB, block([changed, entry(JOB[1]!)])),
      ).toEqual([
        { field: `result.implementer.repos[0].${key}`, code: "invalid" },
      ]);
    },
  );

  it("refuses old fields that are not the first repository's copy", () => {
    expect(
      implementerReposProblems(
        JOB,
        block(JOB.map(entry), { headCommit: "c".repeat(40) }),
      ),
    ).toEqual([{ field: "result.implementer.headCommit", code: "invalid" }]);
    expect(
      implementerReposProblems(JOB, block(JOB.map(entry), { pushed: false })),
    ).toEqual([{ field: "result.implementer.pushed", code: "invalid" }]);
  });
});
