// SPDX-License-Identifier: LicenseRef-Proprietary

// Stable error codes of the storage of Implementer sessions and turns (#751). Callers branch on `code`, never on the message.
export const IMPLEMENTER_STORE_ERROR_CODES = [
  /** The repository already has a session on this branch (the unique index, checked under the repository lock first). */
  "IMPLEMENTER_BRANCH_TAKEN",
  /** The repository is not one of this workspace (or does not exist): nothing was written, the job was not made. */
  "IMPLEMENTER_REPOSITORY_NOT_FOUND",
  /** The job the queue made for the turn is not a job of this workspace: nothing was written. */
  "IMPLEMENTER_JOB_NOT_FOUND",
  /** The job is of this workspace but not the turn's: another repository, or a pull request number other than `-slot`. */
  "IMPLEMENTER_JOB_MISMATCH",
  /** The stored model choice of a turn is not one of the two shapes (damaged or written by something else). */
  "IMPLEMENTER_MODEL_CHOICE_UNREADABLE",
  /** A model choice handed in to be stored is not one of the two shapes. */
  "IMPLEMENTER_MODEL_CHOICE_INVALID",
] as const;

export type ImplementerStoreErrorCode =
  (typeof IMPLEMENTER_STORE_ERROR_CODES)[number];

export class ImplementerStoreError extends Error {
  readonly code: ImplementerStoreErrorCode;

  constructor(
    code: ImplementerStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImplementerStoreError";
    this.code = code;
  }
}
