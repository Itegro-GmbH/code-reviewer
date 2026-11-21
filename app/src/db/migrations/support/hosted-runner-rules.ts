// SPDX-License-Identifier: LicenseRef-Proprietary

// What the hosted runners migration (`../20261121100000_add_hosted_runners.ts`) knew about the application on 2026-11-21 (#1105, ADR 0007),
// as constants and two small functions of its own. A migration is frozen: it must give the same result when it runs in a year, whatever
// the sizes of the platform have become by then (a size added later is a new migration), so it does not import them. Only the files of
// `db/migrations/` import this module (`import-cycles/graph.ts` checks it), and nobody edits it. `add-hosted-runners.integration.test.ts`
// holds it to what the application has today.

/** The sizes in vCPUs an environment could name that day (`environmentVcpus` of `contracts/environment-sizes.v1.json`). */
export const HOSTED_RUNNER_MIGRATION_VCPUS = [2, 4, 6, 8] as const;

/** The name of the hosted runner of a size. */
export function hostedRunnerMigrationName(vcpus: number): string {
  return `Vercel Sandbox ${String(vcpus)} vCPU`;
}

/** The concurrency a hosted runner starts with: `HOSTED_RUNNER_DEFAULT_CONCURRENCY` when it is a whole number from 1 to 100, else 2. */
export function hostedRunnerMigrationConcurrency(
  env: Record<string, string | undefined>,
): number {
  const text = env.HOSTED_RUNNER_DEFAULT_CONCURRENCY?.trim();
  if (text === undefined || !/^[0-9]{1,4}$/.test(text)) return 2;
  const value = Number(text);
  return value >= 1 && value <= 100 ? value : 2;
}
