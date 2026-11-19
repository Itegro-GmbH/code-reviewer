// SPDX-License-Identifier: LicenseRef-Proprietary

// The golden snapshot pair (#403): which snapshot the Dispatcher creates job VMs from, the id of the Worker image
// inside it, and the commit it was built from. Nothing in it is secret. It lives in three places that must agree,
// and this file is the one place that knows their names: the variables of the Dispatcher project (Infisical
// `/dispatcher`, synced by Secret Sync), the meta of a Dispatcher deployment (so that the live deployment says which
// pair it was started with) and the record of the build.

/** The Sysbox verdict of the snapshot's proof (the record's `sysbox`). Only `proven` lets the Implementer start. */
export type SysboxVerdict = "proven" | "unproven";

import { parseWorkerFeatures, workerFeaturesValue } from "./worker-features.ts";

export type SnapshotPair = {
  snapshotId: string;
  imageDigest: string;
  /** The commit the snapshot was built from: what the Worker image inputs are compared with. */
  commit: string;
  /**
   * The verdict of the snapshot's Sysbox proof (#745). It travels with the snapshot id, written and replaced with it,
   * so that a `proven` of an older snapshot cannot stay behind a newer one. Whatever is not exactly `proven` (a pair
   * from before this member existed, a value nobody can read) is `unproven`. Reviews never read it.
   */
  sysbox: SysboxVerdict;
  /**
   * #1098: the features the Worker image of the snapshot lists (`WORKER_FEATURES` of the runner), read from the image itself by
   * the build and kept with the snapshot id like the verdict, so that the list of an older snapshot cannot stay behind a newer
   * one. The Dispatcher names a claim feature that depends on the image (`multi-repo`) only when it is in this list. Sorted;
   * a pair from before this member existed, or a value nobody can read, has the empty list.
   */
  workerFeatures: readonly string[];
};

export const PAIR_VARIABLES = {
  snapshotId: "SANDBOX_SNAPSHOT_ID",
  imageDigest: "SANDBOX_IMAGE_DIGEST",
  commit: "SANDBOX_SNAPSHOT_COMMIT",
  sysbox: "SANDBOX_SYSBOX_PROOF",
  workerFeatures: "SANDBOX_WORKER_FEATURES",
} as const;

export const PAIR_META = {
  snapshotId: "sandboxSnapshotId",
  imageDigest: "sandboxImageDigest",
  commit: "sandboxSnapshotCommit",
  sysbox: "sandboxSysboxProof",
  workerFeatures: "sandboxWorkerFeatures",
} as const;

/**
 * Exactly what the Worker image build consumes, and nothing it does not (#403): a change in any of them since the
 * snapshot's commit means the snapshot is stale; a change anywhere else (the tests of `runner/`, its README, the
 * logic of the deployment steps) does not rebuild anything. Three groups:
 *  - the files `runner/Dockerfile` copies out of the build context (a test parses its `COPY` lines and fails when one is
 *    missing here, and when this list names something the build does not copy), and the files that decide what the
 *    build context holds (`runner/Dockerfile.dockerignore`, the Dockerfile itself);
 *  - the scripts the snapshot's VM runs at its start (`docker/sandbox/vm-prepare.sh` on every VM, `docker/sandbox/sysbox-prepare.sh`
 *    on the Implementer's);
 *  - the files of the build tool that decide what is installed and checked in the snapshot (the pinned Docker
 *    versions and the default build target live in `config.ts`; a test follows the imports of `pipeline.ts`).
 */
export const IMAGE_INPUT_PATHS = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_LICENSES.md",
  "runner/Dockerfile",
  "runner/Dockerfile.dockerignore",
  "runner/pyproject.toml",
  "runner/uv.lock",
  "runner/.python-version",
  "runner/src",
  "runner/docker/agent-init.sh",
  "runner/scripts/fetch_opencode.py",
  "runner/scripts/fetch_ripgrep.py",
  "runner/scripts/fetch_toolchain.py",
  "runner/opencode-pin.json",
  "runner/ripgrep-pin.json",
  "runner/git-pin.json",
  "runner/node-pin.json",
  "runner/pnpm-pin.json",
  "docker/sandbox/vm-prepare.sh",
  "docker/sandbox/sysbox-prepare.sh",
  "dispatcher/src/snapshot/config.ts",
  "dispatcher/src/snapshot/pipeline.ts",
  "dispatcher/src/snapshot/probe-flags.ts",
  "dispatcher/src/snapshot/scripts.ts",
  "dispatcher/src/snapshot/worker-features.ts",
] as const;

const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export const isSnapshotId = (value: unknown): value is string =>
  typeof value === "string" && SNAPSHOT_ID.test(value);
export const isImageDigest = (value: unknown): value is string =>
  typeof value === "string" && IMAGE_ID.test(value);
export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && COMMIT.test(value);

/** The verdict of a value: `proven` only when it is exactly that, else `unproven` (never an error, never a guess). */
export const sysboxVerdictOf = (value: unknown): SysboxVerdict =>
  value === "proven" ? "proven" : "unproven";

/**
 * The pair, or undefined unless the snapshot id, the image digest and the commit are there and of the right shape. The
 * verdict is read as `sysboxVerdictOf` does: a pair without one is a pair that is not proven.
 */
export function pairFromValues(
  snapshotId: unknown,
  imageDigest: unknown,
  commit: unknown,
  sysbox?: unknown,
  workerFeatures?: unknown,
): SnapshotPair | undefined {
  if (!isSnapshotId(snapshotId) || !isImageDigest(imageDigest))
    return undefined;
  if (!isCommit(commit)) return undefined;
  return {
    snapshotId,
    imageDigest,
    commit,
    sysbox: sysboxVerdictOf(sysbox),
    workerFeatures: parseWorkerFeatures(workerFeatures),
  };
}

export function pairFrom(
  variables: Readonly<Record<string, string | undefined>>,
): SnapshotPair | undefined {
  return pairFromValues(
    variables[PAIR_VARIABLES.snapshotId],
    variables[PAIR_VARIABLES.imageDigest],
    variables[PAIR_VARIABLES.commit],
    variables[PAIR_VARIABLES.sysbox],
    variables[PAIR_VARIABLES.workerFeatures],
  );
}

export function pairToEnv(pair: SnapshotPair): Record<string, string> {
  return {
    [PAIR_VARIABLES.snapshotId]: pair.snapshotId,
    [PAIR_VARIABLES.imageDigest]: pair.imageDigest,
    [PAIR_VARIABLES.commit]: pair.commit,
    [PAIR_VARIABLES.sysbox]: pair.sysbox,
    [PAIR_VARIABLES.workerFeatures]: workerFeaturesValue(pair.workerFeatures),
  };
}

export function pairToMeta(pair: SnapshotPair): Record<string, string> {
  return {
    [PAIR_META.snapshotId]: pair.snapshotId,
    [PAIR_META.imageDigest]: pair.imageDigest,
    [PAIR_META.commit]: pair.commit,
    [PAIR_META.sysbox]: pair.sysbox,
    [PAIR_META.workerFeatures]: workerFeaturesValue(pair.workerFeatures),
  };
}

export function pairsEqual(
  a: SnapshotPair | undefined,
  b: SnapshotPair | undefined,
): boolean {
  return (
    a !== undefined &&
    b !== undefined &&
    a.snapshotId === b.snapshotId &&
    a.imageDigest === b.imageDigest &&
    a.commit === b.commit &&
    a.sysbox === b.sysbox &&
    workerFeaturesValue(a.workerFeatures) ===
      workerFeaturesValue(b.workerFeatures)
  );
}

/** The `KEY=value` lines of a file `vercel pull` wrote (`.vercel/.env.production.local`). Lines it cannot read are skipped. */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    let value = match[2];
    const quote = value[0];
    if (
      (quote === '"' || quote === "'") &&
      value.endsWith(quote) &&
      value.length >= 2
    )
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
