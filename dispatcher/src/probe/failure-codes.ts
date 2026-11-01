// SPDX-License-Identifier: LicenseRef-Proprietary

// The closed list of the codes a probe that gave no verdict can name (`ProbeFailure` of
// contracts/probe-verdict.v1.json, a test holds the two equal): what the log, `POST /probe` and the deploy canary
// may say about why. A code that is not on it is `probe_error`, so a value that merely looks stable (a lowercase
// string in a platform's error) never reaches a log line or an answer.
export const PROBE_FAILURE_CODES = [
  // The probe itself.
  "probe_timeout",
  "probe_unreadable",
  "probe_error",
  "probe_exit_nonzero",
  "probe_exec_failed",
  "probe_aborted",
  "probe_not_supported",
  // The canary VM: the launch codes of a job VM (launchers/sandbox.ts).
  "sandbox_rate_limited",
  "sandbox_quota_exceeded",
  "sandbox_network",
  "sandbox_unavailable",
  "image_not_ready",
  "sandbox_snapshot_missing",
  "sandbox_region_mismatch",
  "sandbox_rejected",
  "sandbox_auth_failed",
  "sandbox_create_failed",
  "sandbox_config_invalid",
  "docker_not_ready",
  "vm_prepare_failed",
  "work_volume_failed",
  "image_missing",
  "image_mismatch",
] as const;
export type ProbeFailureCode = (typeof PROBE_FAILURE_CODES)[number];

/** The code if it is on the list, else `probe_error`. */
export function probeFailureCode(value: unknown): ProbeFailureCode {
  return PROBE_FAILURE_CODES.find((code) => code === value) ?? "probe_error";
}
