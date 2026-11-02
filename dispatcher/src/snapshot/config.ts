// SPDX-License-Identifier: LicenseRef-Proprietary

// What the golden snapshot pipeline can be told (#330). Every value ends up in a shell script that runs as
// root in the builder VM, so each one is checked against a narrow pattern before any script is written; a
// refusal names the field, never the value.
import { SnapshotPipelineError } from "./errors.ts";
import { probeRunArguments } from "./probe-flags.ts";

export type PipelineConfig = {
  /** Snapshots are region-bound and there is no failover region: this is fixed, not an option. */
  region: "fra1";
  /** The builder VM size. The spike used 2 vCPU / 4 GB; the image build is the long step. */
  builderVcpus: number;
  /** The VM the restored snapshot is checked in. */
  checkVcpus: number;
  builderTimeoutMs: number;
  checkTimeoutMs: number;
  /** Pinned apt versions: `docker.io=<version>*`. Another version on the base image fails the run. */
  dockerVersion: string;
  buildxVersion: string;
  /**
   * Sysbox (plan implementer-sandbox, step 2): the release that is installed, and the sha256 of its package. The package is
   * downloaded from the project's GitHub release and refused unless it has this checksum.
   */
  sysboxVersion: string;
  sysboxSha256: string;
  /**
   * The image the snapshot's Sysbox proof runs a container of (a Docker daemon in a container), by digest, pulled in the
   * check VM only: it is not part of the snapshot, so reviews do not pay for it. `docker pull` by digest refuses any other content.
   */
  sysboxProbeImage: string;
  /** In the commit's tarball, and the build target of that Dockerfile. */
  dockerfile: string;
  target: string;
  imageTag: string;
  /** The engines the probe of the restored snapshot must advertise. */
  requiredEngines: readonly string[];
  /** The memory limit of the probe container (the spike used 1.5 GB). */
  probeMemory: string;
  /**
   * Whether the run removes older builders and their snapshots when it is done. The deployment pipeline (#403) turns
   * it off: it removes them itself, after the promotion, so that the snapshot production runs is never at risk.
   */
  retention: boolean;
  /** How many snapshots retention keeps (the current and the previous ones). */
  keep: number;
  /** Snapshot ids retention never removes: the one the Dispatcher is configured with. */
  pinnedSnapshotIds: readonly string[];
};

export const DEFAULT_CONFIG: PipelineConfig = {
  region: "fra1",
  builderVcpus: 2,
  checkVcpus: 2,
  builderTimeoutMs: 30 * 60 * 1000,
  checkTimeoutMs: 15 * 60 * 1000,
  // Ubuntu 26.04's docker.io and docker-buildx as the spike measured them (#317). A change of the base image
  // changes these; the install step then fails with `docker_version_mismatch` instead of snapshotting
  // something nobody tested.
  dockerVersion: "29.1.3",
  buildxVersion: "0.30.1",
  // Sysbox 0.7.1 (sysbox-ce_0.7.1.linux_amd64.deb) as measured on the platform VM; its digest is the one GitHub shows for the asset.
  sysboxVersion: "0.7.1",
  sysboxSha256:
    "9d6d5484f980d0a17f86c492c1262015c2afb66280bdb97215b79fde6a0261c5",
  // docker:29.9.2-dind (the index, all architectures).
  sysboxProbeImage:
    "docker.io/library/docker@sha256:9e79b879b177fbd72c34376a3dd3d91747da5db49e1f560f76aea59561471977",
  dockerfile: "runner/Dockerfile",
  target: "sandbox",
  imageTag: "code-reviewer-worker:golden",
  requiredEngines: ["pr-agent", "opencode"],
  probeMemory: "1536m",
  retention: true,
  keep: 2,
  pinnedSnapshotIds: [],
};

const VERSION = /^\d+\.\d+(\.\d+){0,2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST_IMAGE = /^[a-z0-9][a-z0-9._/-]{0,127}@sha256:[0-9a-f]{64}$/;
const PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const TARGET = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const IMAGE_TAG = /^[a-z0-9][a-z0-9._/-]{0,62}(:[A-Za-z0-9._-]{1,64})?$/;
const MEMORY = /^[1-9]\d{0,5}[mg]$/;
const ENGINE = /^[a-z][a-z0-9-]{0,31}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{3,128}$/;

function refuse(field: string): never {
  throw new SnapshotPipelineError("configuration_invalid", "configuration", [
    field,
  ]);
}

function text(field: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) refuse(field);
  return value;
}

function integer(
  field: string,
  value: unknown,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value)) refuse(field);
  if (value < min || value > max) refuse(field);
  return value;
}

function list(
  field: string,
  value: unknown,
  pattern: RegExp,
  min: number,
  max: number,
): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    refuse(field);
  return value.map((entry) => text(field, entry, pattern));
}

/** The defaults with the given overrides, every value checked. Throws `configuration_invalid` naming the field. */
export function resolveConfig(
  overrides: Partial<PipelineConfig> = {},
): PipelineConfig {
  const merged = { ...DEFAULT_CONFIG, ...overrides };
  if (merged.dockerfile.includes("..")) refuse("dockerfile");
  const config: PipelineConfig = {
    region: "fra1",
    builderVcpus: integer("builderVcpus", merged.builderVcpus, 1, 8),
    checkVcpus: integer("checkVcpus", merged.checkVcpus, 1, 8),
    builderTimeoutMs: integer(
      "builderTimeoutMs",
      merged.builderTimeoutMs,
      60_000,
      6 * 3600_000,
    ),
    checkTimeoutMs: integer(
      "checkTimeoutMs",
      merged.checkTimeoutMs,
      60_000,
      6 * 3600_000,
    ),
    dockerVersion: text("dockerVersion", merged.dockerVersion, VERSION),
    buildxVersion: text("buildxVersion", merged.buildxVersion, VERSION),
    sysboxVersion: text("sysboxVersion", merged.sysboxVersion, VERSION),
    sysboxSha256: text("sysboxSha256", merged.sysboxSha256, SHA256),
    sysboxProbeImage: text(
      "sysboxProbeImage",
      merged.sysboxProbeImage,
      DIGEST_IMAGE,
    ),
    dockerfile: text("dockerfile", merged.dockerfile, PATH),
    target: text("target", merged.target, TARGET),
    imageTag: text("imageTag", merged.imageTag, IMAGE_TAG),
    requiredEngines: list(
      "requiredEngines",
      merged.requiredEngines,
      ENGINE,
      1,
      4,
    ),
    probeMemory: text("probeMemory", merged.probeMemory, MEMORY),
    retention: merged.retention === false ? false : true,
    keep: integer("keep", merged.keep, 1, 10),
    pinnedSnapshotIds: list(
      "pinnedSnapshotIds",
      merged.pinnedSnapshotIds,
      SNAPSHOT_ID,
      0,
      10,
    ),
  };
  // The renderer is the judge of the memory limit: a limit the container spec does not allow is refused here,
  // not when the probe is built an hour into a run.
  try {
    probeRunArguments(config);
  } catch {
    refuse("probeMemory");
  }
  return config;
}
