// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of the ticket mirror's routes (#923). The UI translates a code to copy; nothing else branches on a message.
export const TRACKER_ERROR_CODES = [
  /** The repository is not one of the workspace, or is not available on the platform any more. */
  "TRACKER_REPOSITORY_NOT_FOUND",
  /** `/projects/:id/issues` (#922): the workspace has no project with this id. */
  "TRACKER_PROJECT_NOT_FOUND",
  /** The repository has no active project: its tickets are not mirrored. */
  "TRACKER_PROJECT_NOT_ACTIVE",
  /** The installation of the repository is suspended, removed or disconnected, so the platform cannot be asked. */
  "TRACKER_INTEGRATION_UNAVAILABLE",
  /** The query of the list is not one the route knows (`state`, `limit`, `offset`). */
  "TRACKER_REQUEST_INVALID",
  /** The request does not come from this site (cross-site `Sec-Fetch-Site` or a foreign `Origin`). */
  "TRACKER_CROSS_SITE_REQUEST",
  /** The platform could not be asked or refused; the sync stands where it was and can be started again. */
  "TRACKER_SYNC_FAILED",
] as const;
export type TrackerErrorCode = (typeof TRACKER_ERROR_CODES)[number];

export const TRACKER_ERROR_STATUS: Record<TrackerErrorCode, number> = {
  TRACKER_REPOSITORY_NOT_FOUND: 404,
  TRACKER_PROJECT_NOT_FOUND: 404,
  TRACKER_PROJECT_NOT_ACTIVE: 409,
  TRACKER_INTEGRATION_UNAVAILABLE: 409,
  TRACKER_REQUEST_INVALID: 400,
  TRACKER_CROSS_SITE_REQUEST: 403,
  // Never a 502: a proxy swaps its body (#690).
  TRACKER_SYNC_FAILED: 503,
};

export class TrackerError extends Error {
  readonly safeMessage = true as const;
  readonly code: TrackerErrorCode;
  /**
   * For `TRACKER_SYNC_FAILED`: the code the platform's failure had (`INTEGRATION_ACCESS_RATE_LIMITED`, ...), for the log and for the
   * nightly resync to tell a rate limit. Never the message, which may carry what the platform answered.
   */
  readonly providerCode: string | undefined;

  constructor(
    code: TrackerErrorCode,
    message: string,
    options?: { providerCode?: string },
  ) {
    super(message);
    this.name = "TrackerError";
    this.code = code;
    this.providerCode = options?.providerCode;
  }
}
