// SPDX-License-Identifier: LicenseRef-Proprietary

// The harnesses (#854, decision 4 of the runner plan): the platform's catalog holds only OpenCode. Every other harness exists for the
// app only while a runner announces it as ready, and a profile that names one can run only on a runner environment. Profiles know
// only OpenCode today, so the rule is here and the field is prepared; nothing in this file adds a harness. Pure.
import type { RunnerManifest } from "./announcement.ts";

/** The one harness of the platform's catalog: the pinned OpenCode every runner's base provides. */
export const OPENCODE_HARNESS = "opencode";

/** The harnesses the catalog knows. A profile may name one of these; any other name is refused. */
export const CATALOG_HARNESSES = [OPENCODE_HARNESS] as const;

export function isCatalogHarness(name: string): boolean {
  return (CATALOG_HARNESSES as readonly string[]).includes(name);
}

/** The harness a profile version runs with. A version names none today and runs OpenCode. */
export function harnessOfProfile(profile?: { harness?: string }): string {
  return profile?.harness ?? OPENCODE_HARNESS;
}

/**
 * Whether a harness needs a runner environment: every harness but OpenCode. OpenCode is the base of every runner and of every platform VM;
 * a harness only a runner announces cannot run on a VM of the platform.
 */
export function harnessNeedsRunner(harness: string): boolean {
  return harness !== OPENCODE_HARNESS;
}

/** The names of the harnesses a runner announces as ready: only these take a job. */
export function readyHarnesses(manifest: RunnerManifest): string[] {
  return Object.entries(manifest.harnesses)
    .filter(([, harness]) => harness.ready)
    .map(([name]) => name)
    .sort();
}
