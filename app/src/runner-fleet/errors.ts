// SPDX-License-Identifier: LicenseRef-Proprietary

// Stable error codes of the runner list and the registration token routes of a workspace (#854). The UI translates a code to a
// sentence, never the other way round. The message names the code's meaning only, never a value from the request.
export const RUNNER_FLEET_ERROR_CODES = [
  /** The request is from another site. */
  "RUNNER_FLEET_CROSS_SITE_REQUEST",
  /** No such runner in this workspace (another workspace's looks the same), or it was revoked already. */
  "RUNNER_FLEET_NOT_FOUND",
  /** The workspace holds the most unused registration tokens it may. */
  "RUNNER_FLEET_TOKEN_LIMIT_REACHED",
] as const;
export type RunnerFleetErrorCode = (typeof RUNNER_FLEET_ERROR_CODES)[number];

export const RUNNER_FLEET_ERROR_STATUS: Record<RunnerFleetErrorCode, number> = {
  RUNNER_FLEET_CROSS_SITE_REQUEST: 403,
  RUNNER_FLEET_NOT_FOUND: 404,
  RUNNER_FLEET_TOKEN_LIMIT_REACHED: 409,
};

export class RunnerFleetError extends Error {
  readonly code: RunnerFleetErrorCode;
  /** On `RUNNER_FLEET_TOKEN_LIMIT_REACHED`: how many unused tokens a workspace may hold. */
  readonly maximum: number | undefined;
  readonly safeMessage = true as const;

  constructor(
    code: RunnerFleetErrorCode,
    message: string,
    details: { maximum?: number } = {},
  ) {
    super(message);
    this.name = "RunnerFleetError";
    this.code = code;
    this.maximum = details.maximum;
  }
}
