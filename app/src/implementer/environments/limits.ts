// SPDX-License-Identifier: LicenseRef-Proprietary

// The sizes and bounds of an Implementer environment (#818). `contracts/environment-sizes.v1.json` is the single record; the
// Dispatcher keeps the same figures (`SANDBOX_VCPUS`, `agentMemoryMb`) and `limits.test.ts` holds this copy to the file. The sizes are
// the platform's (Pro plan): 1 or an even number up to 8 vCPUs, 2 GB per vCPU. An environment may name 2, 4, 6 or 8: 1 vCPU is a size
// of the platform and leaves the agent's container no memory (the VM's other containers take it all), so it is not offered, and a task
// whose environment still has it is refused (`environment_size_unsupported`).

/** The VM sizes an environment may name. */
export const ENVIRONMENT_VCPUS = [2, 4, 6, 8] as const;
export type EnvironmentVcpus = (typeof ENVIRONMENT_VCPUS)[number];

export const MEMORY_PER_VCPU_MB = 2048;
/** What the agent's container gets at each size of the platform, in MB (the VM's memory less the OS, Control, the model door, the network door, the readers and the memory guard's floor above 512 MiB). */
export const AGENT_MEMORY_MB: Readonly<Record<number, number>> = {
  1: 0,
  2: 1952,
  4: 5904,
  6: 9672,
  8: 13441,
};
/** The least the agent's container is worth starting with. */
export const MIN_AGENT_MEMORY_MB = 1024;
/** What a task gets without an environment (and what the Dispatcher launches for the kind): 2 vCPU, no script. */
export const DEFAULT_VCPUS: EnvironmentVcpus = 2;

/** The script is literal text, at most 64 KB of UTF-8. */
export const SETUP_SCRIPT_MAX_BYTES = 64 * 1024;
/** The script's own time limit; it counts into the turn's time limit. */
export const SETUP_SCRIPT_TIMEOUT_SECONDS = 15 * 60;

export const ENVIRONMENT_NAME_MAX_LENGTH = 80;
/** More than this many environments in a workspace is a mistake, not a use; it bounds what the list and the picker load. */
export const ENVIRONMENTS_PER_WORKSPACE_MAX = 50;

export function isEnvironmentVcpus(value: unknown): value is EnvironmentVcpus {
  return (ENVIRONMENT_VCPUS as readonly unknown[]).includes(value);
}

/** The memory the agent's container gets at a size, in GB (one decimal), as the page shows it (0 for a size that leaves it none). */
export function memoryGbOf(vcpus: number): number {
  return gbOf(AGENT_MEMORY_MB[vcpus] ?? 0);
}

/** MB as GB with one decimal, rounded down (5,904 MB are 5.7 GB, never 5.8): the page does not promise more than the agent gets. */
export function gbOf(megabytes: number): number {
  return Math.floor(megabytes / 102.4) / 10;
}
