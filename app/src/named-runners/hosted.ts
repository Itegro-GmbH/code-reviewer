// SPDX-License-Identifier: LicenseRef-Proprietary

// The hosted runners (ADR 0007, decisions 5 and 16): the provided Vercel Sandbox is one hosted runner for each size the platform offers
// an environment, in every workspace. A hosted runner states only how many turns it may run at the same time; its size is the property of
// its type and is never configured. Since #1158 a type has a placement too: the Vercel Sandbox, or a Cloudflare Container for the sizes the
// operator enabled.
import type { HostedPlacement } from "../runner-identity/labels.ts";

/**
 * The types of hosted runner, by size in vCPUs, smallest first: the sizes an environment may name. A typed copy of `environmentVcpus` of
 * `contracts/environment-sizes.v1.json` (this module imports no other, so the runners and the environments stay apart), which `hosted.test.ts`
 * holds to the file and to `ENVIRONMENT_VCPUS` of the environments.
 */
export const HOSTED_RUNNER_VCPUS = [2, 4, 6, 8] as const;

export type { HostedPlacement };

/** The name of the hosted runner of a type: "Vercel Sandbox 4 vCPU", or (#1158) "Cloudflare Container 4 vCPU". */
export function hostedRunnerName(
  vcpus: number,
  placement: HostedPlacement = "vercel",
): string {
  return `${placement === "cloudflare" ? "Cloudflare Container" : "Vercel Sandbox"} ${String(vcpus)} vCPU`;
}

/**
 * #1158 (epic #1157): the sizes of the Cloudflare placement the operator enabled, `CLOUDFLARE_RUNNER_SIZES` (a comma list of vCPU counts, for
 * example `4`), smallest first, each once. Unset or empty is none: the placement is off and no Cloudflare runner exists. A value that is no size an
 * environment may name (`HOSTED_RUNNER_VCPUS`) is ignored, so a typo enables nothing. The Dispatcher's own configuration (`CF_SANDBOX_INSTANCE_TYPES`)
 * says which of them it can launch; this says which of them the app offers.
 */
export function cloudflareRunnerVcpus(
  env: Record<string, string | undefined>,
): number[] {
  const sizes = new Set<number>();
  for (const part of (env.CLOUDFLARE_RUNNER_SIZES ?? "").split(",")) {
    const text = part.trim();
    if (!/^[0-9]{1,2}$/.test(text)) continue;
    const vcpus = Number(text);
    if ((HOSTED_RUNNER_VCPUS as readonly number[]).includes(vcpus))
      sizes.add(vcpus);
  }
  return [...sizes].sort((a, b) => a - b);
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
