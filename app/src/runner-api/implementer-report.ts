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
