// SPDX-License-Identifier: LicenseRef-Proprietary

// #746, #753: the kinds of job the claim builds an input for, and who may be handed them. The Implementer's kind is built by the
// claim (`implementerInput` in claim.ts); it is only ever handed to a caller that advertised the engine `implementer`, as a Dynamic
// job is only handed to one that advertised `opencode`. A caller that did not is refused with a stable code before the guard,
// the key or a credential is looked at; the kind is never built as a Diff job, which is what a branch on `dynamic` alone would do.
import type { RunnerEngine } from "../jobs/runner-capabilities.ts";
import type { ReviewKind } from "./contract.ts";

/** The stable code of the refusal of a kind the caller cannot run. */
export const UNBUILT_KIND_CODE = "implementer_engine_unavailable";

/**
 * The refusal for a job of this kind, or null when the claim may go on. `engines` are the engines of the caller (null when that
 * was already decided at claim, as at the Worker's fetch).
 */
export function refusalForKind(
  kind: ReviewKind,
  engines: readonly RunnerEngine[] | null,
): typeof UNBUILT_KIND_CODE | null {
  if (kind !== "implementer") return null;
  return engines === null || engines.includes("implementer")
    ? null
    : UNBUILT_KIND_CODE;
}
