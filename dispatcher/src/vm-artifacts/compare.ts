// SPDX-License-Identifier: LicenseRef-Proprietary

// The version check of #976-T02: does the local root file system carry what the hosted golden snapshot was built from? The hosted side is
// what the pipeline pins (`PipelineConfig`, which its install steps enforce) and what its record says about the images; the local side is
// what the root file system reports. Pure: the CLI (compare-main.ts) reads the files.
import type { PipelineConfig } from "../snapshot/config.ts";
import type { GoldenRecord } from "../snapshot/record.ts";

/** What the local build reports: installed package versions (dpkg), the Sysbox package's checksum and the ids on the data disk. */
export type LocalRecipe = {
  dockerd: string;
  buildx: string;
  sysbox: string;
  sysboxSha256: string;
  images: {
    worker: { tag: string; id: string };
    agent: { tag: string; id: string };
  };
};

export type Difference = { field: string; hosted: string; local: string };

export type Comparison = {
  ok: boolean;
  /** What must agree: the versions, the Sysbox package and, when images are required, the image ids. */
  differences: Difference[];
  /** Image ids that differ, whether or not they count (they do when `requireImages` is set). */
  imageDifferences: Difference[];
};

/**
 * The pipeline's own rule for a version: the installed package version starts with the pinned one, and what follows is the package
 * revision (`29.1.3-0ubuntu1`). `29.1.3` followed by a digit is another version.
 */
function sameVersion(installed: string, pinned: string): boolean {
  if (!installed.startsWith(pinned)) return false;
  const next = installed.charAt(pinned.length);
  return next === "" || !/[0-9]/.test(next);
}

/**
 * The image ids are separate because of how the two outputs are made: the hosted pipeline builds the images inside its builder VM and
 * the local build in CI, so the ids agree only once both load one build (docs/runner.md, "VM artifacts"). Until then they are reported
 * and do not fail the check; `requireImages` makes them count.
 */
export function compareWithHosted(
  hosted: {
    config: Pick<
      PipelineConfig,
      | "dockerVersion"
      | "buildxVersion"
      | "sysboxVersion"
      | "sysboxSha256"
      | "imageTag"
      | "agentImageTag"
    >;
    record: Pick<GoldenRecord, "imageDigest" | "agentImageDigest">;
  },
  local: LocalRecipe,
  options: { requireImages?: boolean } = {},
): Comparison {
  const differences: Difference[] = [];
  const imageDifferences: Difference[] = [];
  const check = (
    field: string,
    hostedValue: string,
    localValue: string,
    agree: boolean,
  ): void => {
    if (!agree)
      differences.push({ field, hosted: hostedValue, local: localValue });
  };
  const { config, record } = hosted;
  check(
    "dockerd",
    config.dockerVersion,
    local.dockerd,
    sameVersion(local.dockerd, config.dockerVersion),
  );
  check(
    "buildx",
    config.buildxVersion,
    local.buildx,
    sameVersion(local.buildx, config.buildxVersion),
  );
  check(
    "sysbox",
    config.sysboxVersion,
    local.sysbox,
    sameVersion(local.sysbox, config.sysboxVersion),
  );
  check(
    "sysboxSha256",
    config.sysboxSha256,
    local.sysboxSha256,
    local.sysboxSha256 === config.sysboxSha256,
  );
  check(
    "workerTag",
    config.imageTag,
    local.images.worker.tag,
    local.images.worker.tag === config.imageTag,
  );
  check(
    "agentTag",
    config.agentImageTag,
    local.images.agent.tag,
    local.images.agent.tag === config.agentImageTag,
  );
  const images: [string, string | undefined, string][] = [
    ["worker", record.imageDigest, local.images.worker.id],
    ["agent", record.agentImageDigest, local.images.agent.id],
  ];
  for (const [field, hostedId, localId] of images) {
    if (hostedId === undefined || hostedId === localId) continue;
    const difference = { field, hosted: hostedId, local: localId };
    imageDifferences.push(difference);
    if (options.requireImages) differences.push(difference);
  }
  return { ok: differences.length === 0, differences, imageDifferences };
}
