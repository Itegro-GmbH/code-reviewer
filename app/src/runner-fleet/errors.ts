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
  /** #1105: the new name of a runner is no name (one line of 1 to 80 characters). */
  "RUNNER_FLEET_NAME_INVALID",
  /** #1105: a runner that is not revoked, or a hosted runner ("Vercel Sandbox 4 vCPU"), has this name in the workspace, without regard to case. */
  "RUNNER_FLEET_NAME_TAKEN",
] as const;
export type RunnerFleetErrorCode = (typeof RUNNER_FLEET_ERROR_CODES)[number];

export const RUNNER_FLEET_ERROR_STATUS: Record<RunnerFleetErrorCode, number> = {
  RUNNER_FLEET_CROSS_SITE_REQUEST: 403,
  RUNNER_FLEET_NOT_FOUND: 404,
  RUNNER_FLEET_TOKEN_LIMIT_REACHED: 409,
  RUNNER_FLEET_NAME_INVALID: 400,
  RUNNER_FLEET_NAME_TAKEN: 409,
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
