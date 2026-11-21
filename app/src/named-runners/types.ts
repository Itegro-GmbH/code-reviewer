// SPDX-License-Identifier: LicenseRef-Proprietary

// The concrete runner a lane step names (#1105, ADR 0007, decisions 6, 14 and 16): a hosted runner (one type of the provided Vercel
// Sandbox, a fixed size and its own concurrency) or a self-hosted runner (a machine the customer registered). Both have an id the lane
// stores and a name the pages show; a rename changes the name only.
import type {
  RunnerLimits,
  RunnerManifest,
} from "../runner-identity/announcement.ts";

export type HostedRunner = {
  kind: "hosted";
  id: string;
  /** "Vercel Sandbox 4 vCPU". */
  name: string;
  /** The fixed size of the type. */
  vcpus: number;
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
