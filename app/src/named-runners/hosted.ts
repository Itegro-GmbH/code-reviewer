// SPDX-License-Identifier: LicenseRef-Proprietary

// The hosted runners (ADR 0007, decisions 5 and 16): the provided Vercel Sandbox is one hosted runner for each size the platform offers
// an environment, in every workspace. A hosted runner states only how many turns it may run at the same time; its size is the property of
// its type and is never configured. The types are `ENVIRONMENT_VCPUS` (the app's copy of `environmentVcpus` in
// `contracts/environment-sizes.v1.json`, which `implementer/environments/limits.test.ts` holds to the file), not a second list.
import {
  ENVIRONMENT_VCPUS,
  type EnvironmentVcpus,
} from "../implementer/environments/limits.ts";

/** The types of hosted runner, by size in vCPUs, smallest first. */
export const HOSTED_RUNNER_VCPUS: readonly EnvironmentVcpus[] =
  ENVIRONMENT_VCPUS;

/** The name of the hosted runner of a type: "Vercel Sandbox 4 vCPU". */
export function hostedRunnerName(vcpus: number): string {
  return `Vercel Sandbox ${String(vcpus)} vCPU`;
}

/**
 * How many turns a hosted runner may run at the same time until somebody sets it: 2. A number for all types, set by the operator with
 * `HOSTED_RUNNER_DEFAULT_CONCURRENCY` (a whole number from 1 to `HOSTED_RUNNER_CONCURRENCY_MAX`); anything else is this default.
 */
export const HOSTED_RUNNER_DEFAULT_CONCURRENCY = 2;

/** The most a hosted runner's concurrency may be: the bound of a sane setting, not the operator's pool-wide cap (`DISPATCHER_MAX_RUNNING`). */
export const HOSTED_RUNNER_CONCURRENCY_MAX = 100;

export function isHostedConcurrency(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= HOSTED_RUNNER_CONCURRENCY_MAX
  );
}

/** The concurrency a new hosted runner starts with: the operator's setting when it is valid, else 2. */
export function hostedRunnerDefaultConcurrency(
  env: Record<string, string | undefined>,
): number {
  const text = env.HOSTED_RUNNER_DEFAULT_CONCURRENCY;
  if (text === undefined || !/^[0-9]{1,4}$/.test(text.trim()))
    return HOSTED_RUNNER_DEFAULT_CONCURRENCY;
  const value = Number(text.trim());
  return isHostedConcurrency(value) ? value : HOSTED_RUNNER_DEFAULT_CONCURRENCY;
}
