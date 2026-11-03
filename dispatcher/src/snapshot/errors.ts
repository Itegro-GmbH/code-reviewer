// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of the golden snapshot pipeline (#330). A caller (the CLI, the workflow, a test) branches
// on `code`; the text of an error never carries a value of the environment, a token or the output of the VM.
export const SNAPSHOT_ERROR_CODES = [
  "configuration_invalid",
  "builder_create_failed",
  "base_manifest_failed",
  "docker_install_failed",
  "docker_version_mismatch",
  "daemon_config_failed",
  "host_prepare_failed",
  // The two Sysbox steps never end a run (reviews do not use Sysbox): they name what a warning and `sysbox: "unproven"` of the record say.
  "sysbox_install_failed",
  "sysbox_probe_failed",
  "context_upload_failed",
  "image_build_failed",
  "image_digest_invalid",
  "image_digest_mismatch",
  "daemon_query_failed",
  "containers_present",
  "daemon_not_stopped",
  "snapshot_failed",
  "snapshot_region_mismatch",
  "check_vm_failed",
  "scan_unreadable",
  "scan_findings",
  "probe_failed",
  "probe_unreadable",
  "engine_missing",
  "record_invalid",
  "cancelled",
  "unexpected_error",
] as const;
export type SnapshotErrorCode = (typeof SNAPSHOT_ERROR_CODES)[number];

export class SnapshotPipelineError extends Error {
  readonly code: SnapshotErrorCode;
  readonly step: string;
  /** Short, already scrubbed context (a stable reason, a path, a count); never a secret. */
  readonly detail: readonly string[];
  /** Resources that could not be removed after the failure (a VM name, a snapshot id): the operator removes them. */
  cleanupFailures: readonly string[] = [];

  constructor(
    code: SnapshotErrorCode,
    step: string,
    detail: readonly string[] = [],
  ) {
    super(`${step}: ${code}`);
    this.name = "SnapshotPipelineError";
    this.code = code;
    this.step = step;
    this.detail = detail;
  }
}
