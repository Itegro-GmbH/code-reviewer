// SPDX-License-Identifier: LicenseRef-Proprietary

// The capabilities of a deployment (#731). One codebase is deployed more than once (code-review.com and a clone
// with another product); what a deployment offers is its capability set. A feature outside the set has no route,
// no navigation entry, no API endpoint and no background work: it is not switched off at run time, it is absent.
// This module is pure (no environment, no imports), so the proxy, the pages, the jobs and the tests share it.

/**
 * Every capability a deployment can have. `implementer` belongs to the Software Factory (#747): only the product
 * `factory` allows it, any other product refuses it by name. Routes, navigation and the job kind that it gates come
 * with later changes of the Implementer (#745).
 */
export const CAPABILITIES = [
  "review",
  "dynamic-review",
  "billing",
  "implementer",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value);
}

/** The capability that a capability cannot exist without. */
const REQUIRES: Partial<Record<Capability, Capability>> = {
  "dynamic-review": "review",
  // The Implementer runs on the Dynamic engine, so a set without it cannot have the Implementer (and so not without review).
  implementer: "dynamic-review",
};

export function requiredCapability(
  capability: Capability,
): Capability | undefined {
  return REQUIRES[capability];
}

/**
 * The job kinds and the capability each needs (the job kind lives in src/job-kind/job-kind.ts). `implementer` is
 * mapped here before the kind exists in that type (#752), so the set already answers for it.
 */
export const CAPABILITY_OF_REVIEW_KIND = {
  diff: "review",
  dynamic: "dynamic-review",
  implementer: "implementer",
} as const satisfies Record<string, Capability>;

export type CapabilitySet = {
  has(capability: Capability): boolean;
  /** Sorted alphabetically: the stable contract of the health check, which the deploy pipeline compares. */
  list(): Capability[];
  /** Whether a job of this review kind may exist in this deployment. */
  allowsReviewKind(kind: keyof typeof CAPABILITY_OF_REVIEW_KIND): boolean;
};

export function createCapabilitySet(
  capabilities: Iterable<Capability>,
): CapabilitySet {
  const members = new Set(capabilities);
  return {
    has: (capability) => members.has(capability),
    list: () => [...members].sort(),
    allowsReviewKind: (kind) => members.has(CAPABILITY_OF_REVIEW_KIND[kind]),
  };
}
