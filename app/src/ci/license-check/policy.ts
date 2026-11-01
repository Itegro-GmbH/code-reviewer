// SPDX-License-Identifier: LicenseRef-Proprietary

// The license policy of the repository: license-policy.json at the repository root. One file holds
// the allow list and every documented exception, so the CI check, its tests and
// THIRD_PARTY_LICENSES.md (which a test compares with this file) read the same facts.
import { z } from "zod";

/**
 * `bun` names the npm packages that are bundled inside the Bun-compiled OpenCode executable. They
 * come from a reviewed snapshot (binaries.ts), not from an installed tree, but are judged by the
 * same rules and can carry exceptions like any other package.
 */
export const ECOSYSTEMS = ["npm", "python", "bun"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

const ecosystem = z.enum(ECOSYSTEMS);
const nonEmpty = z.string().min(1);

/**
 * A prebuilt binary that the Dynamic runner image ships. Its pin file (see binaries.ts) is what the
 * image build installs; this entry is the decision that the license check holds the pin to.
 */
const binary = z.strictObject({
  /** The name that THIRD_PARTY_LICENSES.md and NOTICE use, compared without regard to case. */
  name: nonEmpty,
  /** The pin file, relative to the repository root. */
  pin: nonEmpty,
  version: nonEmpty,
  /** The source commit of the release, when the pin has one; the documents must name it. */
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  /** The SPDX license that the policy expects; it must also be allowed. */
  license: nonEmpty,
  /**
   * The reviewed snapshot of the third-party packages inside the binary (a Bun executable hides
   * them from the npm collector), relative to the repository root.
   */
  bundledLicenses: nonEmpty.optional(),
  /**
   * `source` when the image builds the binary from the pinned source release instead of unpacking a
   * prebuilt one, so the pin holds the archive digest of the source and no executable digest.
   */
  build: z.literal("source").optional(),
  /**
   * The reviewed reason that a license outside the allow list is accepted for this binary (a copyleft
   * program that is a separate, unmodified part of the image and is never linked into our code). Without
   * it the license must be on the allow list. The pin must still carry the license named in `license`.
   */
  exception: nonEmpty.optional(),
  reason: nonEmpty,
});

export const policySchema = z.strictObject({
  /** SPDX ids that may appear in any dependency, compared without regard to case. */
  allowed: z.array(nonEmpty).min(1),
  /**
   * Packages that may carry a license outside the allow list. `package` is an exact name or a name
   * ending in `*`. `licenses` are the ids that these packages may add to the allow list, nothing else.
   */
  exceptions: z.array(
    z.strictObject({
      ecosystem,
      package: nonEmpty,
      licenses: z.array(nonEmpty).min(1),
      reason: nonEmpty,
    }),
  ),
  /**
   * Packages that the lockfile lists but that are not installed on every machine (a binary for
   * another operating system, a wasm fallback, a dependency for another platform), so their license
   * cannot be read from installed metadata. `license` is what the registry says, read when the entry
   * was added; it is judged like any other license.
   */
  notInstalled: z.array(
    z.strictObject({
      ecosystem,
      package: nonEmpty,
      license: nonEmpty,
      reason: nonEmpty,
    }),
  ),
  /** Prebuilt binaries of the runner image, audited from their pin files (binaries.ts). */
  binaries: z.array(binary),
});

export type BinaryEntry = z.infer<typeof binary>;

export type Policy = z.infer<typeof policySchema>;

export function parsePolicy(json: unknown): Policy {
  return policySchema.parse(json);
}

/** Python names are compared the way PEP 503 normalizes them; npm names are exact. */
export function normalizeName(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "python"
    ? name.toLowerCase().replace(/[-_.]+/g, "-")
    : name;
}

/**
 * Python versions are compared the way PEP 440 normalizes them: separators become dots and leading
 * zeros of numeric parts go (2024.02.26 is 2024.2.26). npm versions are exact.
 */
export function normalizeVersion(
  ecosystem: Ecosystem,
  version: string,
): string {
  if (ecosystem !== "python") return version;
  return version
    .toLowerCase()
    .replace(/[-_]/g, ".")
    .split(".")
    .map((part) => (/^\d+$/.test(part) ? String(Number(part)) : part))
    .join(".");
}

/** An exact package name, or a prefix ending in `*`. */
export function matchesPackage(
  ecosystem: Ecosystem,
  pattern: string,
  name: string,
): boolean {
  const wanted = normalizeName(ecosystem, pattern.replace(/\*$/, ""));
  const actual = normalizeName(ecosystem, name);
  return pattern.endsWith("*") ? actual.startsWith(wanted) : actual === wanted;
}
