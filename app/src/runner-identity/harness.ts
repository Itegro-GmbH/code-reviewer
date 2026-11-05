// SPDX-License-Identifier: LicenseRef-Proprietary

// The harnesses (#854, decision 4 of the runner plan): the platform's catalog holds only OpenCode. Every other harness exists for the
// app only while a runner announces it as ready, and a profile that names one can run only on a runner environment. Profiles know
// only OpenCode today, so the rule is here and the field is prepared; nothing in this file adds a harness. Pure.
import type { RunnerManifest } from "./announcement.ts";

/** The one harness of the platform's catalog: the pinned OpenCode every runner's base provides. */
export const OPENCODE_HARNESS = "opencode";

/** The second harness of a profile (#856): Claude Code on the login of a customer's device. It exists only on a runner that announces it. */
export const CLAUDE_CODE_HARNESS = "claude-code";

/** The harnesses the catalog knows. */
export const CATALOG_HARNESSES = [OPENCODE_HARNESS] as const;

/**
 * The harnesses a profile can name (#856). `claude-code` is not in the catalog (decision 4 of the runner plan: it exists for the app only
 * while a runner announces it as ready), but a profile may ask for it, and then it runs only on a runner environment (`harnessNeedsRunner`).
 */
export const PROFILE_HARNESSES = [
  OPENCODE_HARNESS,
  CLAUDE_CODE_HARNESS,
] as const;

export type ProfileHarness = (typeof PROFILE_HARNESSES)[number];

/**
 * The provider a model of the harness `claude-code` is written under, `{"provider": "claude-code", "model": "<name>"}`: the name is the
 * one Claude Code reads (`sonnet`, `claude-sonnet-5-5`). No catalog, key or price is behind it: the login is the device's.
 */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** A model name as Claude Code reads it (the pattern of `ImplementerSubscription.model` in `contracts/runner-api.v1.json`). */
export const CLAUDE_CODE_MODEL_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

export function isProfileHarness(name: string): name is ProfileHarness {
  return (PROFILE_HARNESSES as readonly string[]).includes(name);
}

export function isCatalogHarness(name: string): boolean {
  return (CATALOG_HARNESSES as readonly string[]).includes(name);
}

/** The harness a profile version runs with. A version that names none (saved before harnesses were stored) runs OpenCode. */
export function harnessOfProfile(profile?: {
  harness?: string | null;
}): string {
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
