// SPDX-License-Identifier: LicenseRef-Proprietary

// The size labels of the platform (#971, Runner v2): a job requires `cr:size-<vCPUs>` and the claim answer names it. The core is
// platform-free, so the sizes are the platform's own list, held to `contracts/environment-sizes.v1.json` by `contracts.test.ts`; which of
// them a Launcher can start is its own decision (`SANDBOX_VCPUS` of the Vercel Sandbox Launcher, which a test holds to the same file).

/** The VM sizes of the platform in vCPUs (`vcpus` of `contracts/environment-sizes.v1.json`). */
export const PLATFORM_VCPUS = [1, 2, 4, 6, 8] as const;

const SIZE_LABEL = /^cr:size-(?:[1-9][0-9]?)$/;

/** Whether a text is spelled like a size label (`cr:size-<n>`), whatever the size. */
export function isSizeLabel(value: string): boolean {
  return SIZE_LABEL.test(value);
}

/** The size a label names, or undefined for any other text and for a size the platform does not offer. */
export function vcpusOfSizeLabel(label: string): number | undefined {
  return PLATFORM_VCPUS.find((vcpus) => `cr:size-${String(vcpus)}` === label);
}
