// SPDX-License-Identifier: LicenseRef-Proprietary

// The port between the Sandbox-Launcher (#329) and the Sandbox platform: the few things a job's VM needs.
// The Launcher never imports the platform SDK; `vercel-sandbox.ts` adapts the SDK to this port and
// `fakes/sandbox/` holds the doubles of it (an in-process one and a local one that runs Docker on this host).
// This is the per-job port. The golden snapshot pipeline (#330) has its own, wider one for builder VMs.
//
// Commands are argument vectors, never shell text: nothing here is parsed by a shell, so a value cannot
// become a command. The per-job credential is not part of any request except the stdin of the Worker process.

import type { NetworkPolicy } from "../network/rule.ts";

/** Why the platform refused or failed a call, in the terms the Launcher classifies. */
export const SANDBOX_FAILURE_KINDS = [
  "rate_limited",
  "quota_exceeded",
  "network",
  "unavailable",
  "snapshot_missing",
  "region_mismatch",
  "not_ready",
  "rejected",
  "auth_failed",
] as const;
export type SandboxFailureKind = (typeof SANDBOX_FAILURE_KINDS)[number];

/** A failed platform call. The text of the platform's own error is dropped: it is not ours to log. */
export class SandboxServiceError extends Error {
  readonly kind: SandboxFailureKind;

  constructor(kind: SandboxFailureKind) {
    super(kind);
    this.name = "SandboxServiceError";
    this.kind = kind;
  }
}

export type SandboxCreateOptions = {
  /** Unique for this launch: a name is never reused, not even for a second attempt of the same job. */
  name: string;
  /** The golden snapshot the VM starts from. */
  snapshotId: string;
  /** Always `fra1`: snapshots are region-bound and there is no failover region. */
  region: string;
  vcpus: number;
  /** The backstop that ends the VM when nobody stops it: the job timeout plus a margin. */
  timeoutMs: number;
  tags: Readonly<Record<string, string>>;
  /** Always false: a persistent sandbox would write a snapshot of the job when it stops. */
  persistent: false;
};

export type ExecRequest = {
  /** A stable name of the step, for logs and for the doubles; never the command text. */
  label: string;
  cmd: string;
  args: readonly string[];
  sudo?: boolean;
  timeoutMs?: number;
};

export type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** A command that runs in the VM with a stdin pipe the caller writes to. */
export interface SandboxProcess {
  writeStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  /** Resolves with the exit code when the process ends, also when the VM is stopped under it. */
  wait(signal?: AbortSignal): Promise<{ exitCode: number }>;
}

export interface SandboxVm {
  readonly name: string;
  /** Runs a command to its end. */
  exec(request: ExecRequest, signal?: AbortSignal): Promise<ExecResult>;
  /** Starts a command and returns at once, with its stdin open. */
  start(
    request: Omit<ExecRequest, "timeoutMs">,
    signal?: AbortSignal,
  ): Promise<SandboxProcess>;
}

export interface SandboxService {
  /** Creates a VM from a snapshot. Throws `SandboxServiceError` for a failure of the platform. */
  create(
    options: SandboxCreateOptions,
    signal?: AbortSignal,
  ): Promise<SandboxVm>;
  /**
   * Stops a VM by its name, for any VM this service created, also one whose `create` was aborted. Stopping a
   * VM that does not exist or has ended already is not an error.
   */
  stop(name: string): Promise<void>;
}

/** A VM as the platform lists it: only what the reaper (#364) reads. */
export type ListedVm = {
  name: string;
  /** Creation time, in milliseconds since the epoch. */
  createdAtMs: number;
  /** The platform's own word (`running`, `pending`, `stopping`, `stopped`, ...). Never assumed to be one we know. */
  status: string;
  /** The VM's own timeout, when the platform reports it. */
  timeoutMs?: number;
  /** Whether the platform keeps a snapshot of the VM: the golden builder is persistent, no VM of a job or a canary is. */
  persistent?: boolean;
  tags: Readonly<Record<string, string>>;
};

/** What a listing narrows to: a name prefix and a single tag (the platform allows one tag per filter). */
export type ListFilter = {
  namePrefix: string;
  tags: Readonly<Record<string, string>>;
};

/**
 * What the reaper (#364) needs of the platform, next to the Launcher's `SandboxService`: list the VMs of the
 * project by a filter, and stop or delete one by name. The platform's filter is a narrowing, never the check: the reaper
 * decides itself which VMs are ours.
 */
export interface SandboxFleet {
  /** Every VM the filter matches, across all pages. Throws `SandboxServiceError` for a failure of the platform. */
  list(filter: ListFilter, signal?: AbortSignal): Promise<readonly ListedVm[]>;
  /** The same call as `SandboxService.stop`: by name, a VM that is gone is not an error. */
  stop(name: string): Promise<void>;
  /**
   * Deletes a VM by name, so the platform no longer lists it (#802): it keeps an ended VM until somebody does. The VM is
   * looked up again first and only deleted when it is still `DELETABLE_STATUSES` and not persistent; otherwise it is
   * `kept` (it came back after the listing). The snapshots the VM owns are kept too (the golden snapshot is the source of
   * every job VM). A VM the platform does not have (404) counts as deleted. Any other failure throws; a call that does not
   * answer in time throws `unavailable`.
   */
  delete(name: string): Promise<"deleted" | "kept">;
  /**
   * Sets the network policy of a running VM by name (#745, step 7: the second wall of the network door, called from `POST /network`).
   * The platform ends the connections that are open when the policy changes. Throws `SandboxServiceError` for a failure of the
   * platform, `not_ready` for a VM it does not have or that is no longer running.
   */
  setNetworkPolicy(name: string, policy: NetworkPolicy): Promise<void>;
}

/** The platform's words for a VM that has ended for good: the only ones the reaper deletes (#802). */
export const DELETABLE_STATUSES: readonly string[] = [
  "stopped",
  "failed",
  "aborted",
];
