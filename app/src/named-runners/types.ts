// SPDX-License-Identifier: LicenseRef-Proprietary

// The concrete runner a lane step names (#1105, ADR 0007, decisions 6, 14 and 16): a hosted runner (one type of the provided Vercel
// Sandbox, a fixed size and its own concurrency) or a self-hosted runner (a machine the customer registered). Both have an id the lane
// stores and a name the pages show; a rename changes the name only.
import type {
  RunnerLimits,
  RunnerManifest,
} from "../runner-identity/announcement.ts";
import type { HostedPlacement } from "../runner-identity/labels.ts";

export type HostedRunner = {
  kind: "hosted";
  id: string;
  /** "Vercel Sandbox 4 vCPU", or "Cloudflare Container 4 vCPU". */
  name: string;
  /** The fixed size of the type. */
  vcpus: number;
  /** #1158: where its VM runs. */
  placement: HostedPlacement;
  /**
   * #1158: whether a step may use it now. A Vercel runner always is; a Cloudflare runner only while its size is in `CLOUDFLARE_RUNNER_SIZES`: a
   * size the operator switched off later keeps its row (a lane may name it) and the validator says it is unavailable.
   */
  available: boolean;
  /** How many turns it may run at the same time. */
  concurrency: number;
};

export type SelfHostedRunner = {
  kind: "self_hosted";
  id: string;
  name: string;
  labels: string[];
  baseVersion: string;
  manifest: RunnerManifest;
  limits: RunnerLimits;
  lastSeenAt: string;
  /** Set when a member revoked the runner: a step that names it is `runner_unknown` at a save and `runner_not_found` for a run. */
  revokedAt: string | null;
};

export type NamedRunner = HostedRunner | SelfHostedRunner;

export function isRevoked(runner: NamedRunner): boolean {
  return runner.kind === "self_hosted" && runner.revokedAt !== null;
}

/** #1158: a hosted runner the operator switched off (a Cloudflare size no longer in `CLOUDFLARE_RUNNER_SIZES`): its row stays, nothing may start on it. */
export function isUnavailable(runner: NamedRunner): boolean {
  return runner.kind === "hosted" && !runner.available;
}
