// SPDX-License-Identifier: LicenseRef-Proprietary

// The kind of a job (#715, cut 1). A job row carries its review kind, and the queue, billing, the database
// repositories, the model catalog and the runner API all branch on it. It is a module of its own, without
// imports, so that none of them has to reach into `review-settings` (which owns the settings a project saves)
// or into `jobs` (the queue) for it, and so that it can move into the shared core as it is.

/**
 * The one review kind a project selects (#193, #194). Diff Review is the existing PR-Agent review;
 * Dynamic Review is the read-only agent of the epic. A project has exactly one.
 */
export const PROJECT_REVIEW_KINDS = ["diff", "dynamic"] as const;
export type ProjectReviewKind = (typeof PROJECT_REVIEW_KINDS)[number];

/**
 * Every kind a job row can carry (#752). A turn of the Implementer is a job of its own kind (`implementer`); a project never
 * selects it, so everything a project can choose or save stays `ProjectReviewKind`. A consumer that handles a job meets this
 * type: it handles the kind or fails closed, the compiler shows which.
 */
export const JOB_KINDS = [...PROJECT_REVIEW_KINDS, "implementer"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isProjectReviewKind(kind: JobKind): kind is ProjectReviewKind {
  return kind !== "implementer";
}

export function isJobKind(value: unknown): value is JobKind {
  return JOB_KINDS.some((kind) => kind === value);
}

/**
 * The project review kind a job of this kind follows where only those two exist: the plan's run limits, the rate of a minute,
 * the hold and the model catalog. A turn of the Implementer runs on the Dynamic engine, so it counts, costs and chooses its
 * model as a Dynamic Review. This is where that is said once; the kind itself stays `implementer` in every row.
 */
export function projectKindOf(kind: JobKind): ProjectReviewKind {
  return kind === "implementer" ? "dynamic" : kind;
}

/** A kind read from a stored row. A value this version does not know is a bug or a database from the future: it fails loudly. */
export function jobKindOf(stored: string): JobKind {
  if (!isJobKind(stored))
    throw new Error(`A stored job carries the unknown kind "${stored}".`);
  return stored;
}
