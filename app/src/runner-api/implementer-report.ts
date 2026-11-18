// SPDX-License-Identifier: LicenseRef-Proprietary

// Which job may report the implementer block of a result (#754). The parser reads the block like the contract does; it does not
// know the job. Here the block is held to the kind of the job: it belongs to a turn of the Implementer and to no other job, and a
// turn that succeeded has to say what it did. A turn that failed may have no block: the runner failed before it had a repository
// (`clone_failed`, `setup_failed`, ...). Pure.
import type { FieldError } from "./contract.ts";
import type { RunnerResult } from "./contract.ts";
import type { JobKind } from "../job-kind/job-kind.ts";

/** The refusals (none when the result is fine) of the result of a job of this kind. Field names only, never a value. */
export function implementerBlockProblems(
  kind: JobKind,
  result: Pick<RunnerResult, "ok" | "implementer">,
): FieldError[] {
  const has = result.implementer !== undefined;
  if (kind !== "implementer")
    return has ? [{ field: "result.implementer", code: "invalid" }] : [];
  return result.ok && !has
    ? [{ field: "result.implementer", code: "required" }]
    : [];
}

/** What the report of a repository has to say about the repository of the job it belongs to (the stored resolution of the session). */
type JobRepo = { name: string; fullName: string; base: string; branch: string };

/**
 * #1092, ADR 0006: the `repos` of a report are held to the job (`ImplementerRepoResult` in the contract). A job of several repositories gets
 * exactly one entry for each, in the order of the job, with the job's `name`, `fullName`, `base` and `branch`, and the old fields of the
 * block are the first entry's copy (`baseCommit`, `headCommit`, `pushed`); a job of one repository gets no `repos`. A block that fails
 * this is refused whole: what the workflow reads from it (`{{step.repos}}`, the head commits, `resume.repos` by name, the pull requests of
 * a later step) would drop or swap repositories silently. `jobRepos` is null for a session of one repository. Field names only, never a value.
 */
export function implementerReposProblems(
  jobRepos: readonly JobRepo[] | null,
  block: RunnerResult["implementer"],
): FieldError[] {
  if (block === undefined) return [];
  const where = "result.implementer.repos";
  if (jobRepos === null)
    return block.repos === undefined ? [] : [{ field: where, code: "invalid" }];
  const reported = block.repos;
  if (reported === undefined) return [{ field: where, code: "required" }];
  if (reported.length !== jobRepos.length)
    return [{ field: where, code: "invalid" }];
  const problems: FieldError[] = [];
  jobRepos.forEach((expected, index) => {
    const entry = reported[index];
    if (entry === undefined) return;
    for (const key of ["name", "fullName", "base", "branch"] as const)
      if (entry[key] !== expected[key])
        problems.push({
          field: `${where}[${String(index)}].${key}`,
          code: "invalid",
        });
  });
  const first = reported[0];
  if (first !== undefined)
    for (const key of ["baseCommit", "headCommit", "pushed"] as const)
      if (first[key] !== block[key])
        problems.push({ field: `result.implementer.${key}`, code: "invalid" });
  return problems;
}
