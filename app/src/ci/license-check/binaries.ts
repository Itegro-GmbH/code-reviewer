// SPDX-License-Identifier: LicenseRef-Proprietary

// The provenance and license audit of the prebuilt binaries that the Dynamic runner image ships
// (OpenCode, ripgrep). A binary has no package manager metadata, so the audit reads what the
// repository records about it, offline:
//
//   - the pin file (runner/<name>-pin.json): version, source, license and the SHA-256 digests;
//   - the policy entry in license-policy.json, which must agree with the pin and name a license
//     that the allow list permits;
//   - THIRD_PARTY_LICENSES.md and NOTICE, which must name the binary, its version and its source
//     commit;
//   - for a Bun-compiled executable, the reviewed snapshot of the npm packages inside it
//     (runner/opencode-bundled-licenses.json, written by runner/scripts/audit_opencode_bundle.py).
//     Its packages are returned as `bun` packages and judged by check.ts like any other package.
//
// The inputs are plain text read through `readText`, so the rules are tested without the files.
import { z } from "zod";
import type { InstalledPackage, LockedPackage } from "./check.ts";
import type { BinaryEntry, Policy } from "./policy.ts";
import { parseExpression, satisfies } from "./spdx.ts";

export const BINARY_VIOLATION_CODES = [
  "BINARY_PIN_UNREADABLE",
  "BINARY_PROVENANCE_MISSING",
  "BINARY_LICENSE_NOT_ALLOWED",
  "BINARY_POLICY_MISMATCH",
  "BINARY_DIGEST_MISSING",
  "BINARY_NOT_DOCUMENTED",
  "BUNDLED_SNAPSHOT_UNREADABLE",
  "BUNDLED_SNAPSHOT_COMMIT_MISMATCH",
] as const;
export type BinaryViolationCode = (typeof BINARY_VIOLATION_CODES)[number];

export type BinaryViolation = {
  code: BinaryViolationCode;
  binary: string;
  /** The message after the code; it names the binary where that helps. */
  detail: string;
};

export type BinaryAudit = {
  violations: BinaryViolation[];
  /** How many binary pins were audited. */
  binaries: number;
  /** The packages bundled in the binaries, as the license check judges them. */
  installed: InstalledPackage[];
  locked: LockedPackage[];
};

export function describeBinaryViolation(violation: BinaryViolation): string {
  return `${violation.code}: ${violation.detail}`;
}

const SHA256 = /^[0-9a-f]{64}$/;
const DOCUMENTS = ["THIRD_PARTY_LICENSES.md", "NOTICE"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const snapshotSchema = z.object({
  sourceCommit: z.string().min(1),
  packages: z.array(
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      license: z.string().min(1),
    }),
  ),
});

type Violate = (code: BinaryViolationCode, detail: string) => void;

function checkPin(
  entry: BinaryEntry,
  pin: Record<string, unknown>,
  allowed: Set<string>,
  violate: Violate,
): void {
  for (const field of ["repository", "licenseUrl"]) {
    if (text(pin[field]) === undefined) {
      violate(
        "BINARY_PROVENANCE_MISSING",
        `${entry.name}: ${entry.pin} has no ${field}`,
      );
    }
  }

  const mismatches: [string, string | undefined, string | undefined][] = [
    ["version", entry.version, text(pin.version)],
    ["commit", entry.commit, entry.commit ? text(pin.commit) : undefined],
    ["license", entry.license, text(pin.license)],
  ];
  for (const [field, expected, actual] of mismatches) {
    if (expected === undefined) continue;
    if (actual !== expected) {
      violate(
        "BINARY_POLICY_MISMATCH",
        `${entry.name}: ${field} is ${JSON.stringify(expected)} in license-policy.json but ${JSON.stringify(actual ?? null)} in ${entry.pin}`,
      );
    }
  }

  const license = text(pin.license);
  if (license !== undefined) {
    // An entry with a documented exception is accepted with the license it names; the pin must say the
    // same license (checked above), so the exception cannot cover another one.
    let permitted = entry.exception !== undefined && license === entry.license;
    try {
      permitted ||= satisfies(parseExpression(license), (id) =>
        allowed.has(id.toLowerCase()),
      );
    } catch {
      // not an SPDX expression: only an exception can permit it
    }
    if (!permitted) {
      violate(
        "BINARY_LICENSE_NOT_ALLOWED",
        `${entry.name} ${text(pin.version) ?? entry.version} is ${license}, which the policy does not allow`,
      );
    }
  }

  const platforms = isRecord(pin.platforms) ? pin.platforms : {};
  const names = Object.keys(platforms);
  if (names.length === 0) {
    violate(
      "BINARY_DIGEST_MISSING",
      `${entry.name}: ${entry.pin} pins no platform`,
    );
  }
  for (const platform of names) {
    const artifact = platforms[platform];
    // A release built from source has the digest of its archive only: the executable is a build result.
    const digests =
      entry.build === "source"
        ? ["archiveSha256"]
        : ["archiveSha256", "executableSha256"];
    for (const field of digests) {
      const digest = isRecord(artifact) ? artifact[field] : undefined;
      if (typeof digest !== "string" || !SHA256.test(digest)) {
        violate(
          "BINARY_DIGEST_MISSING",
          `${entry.name} platform ${platform} has no valid SHA-256 (64 hex digits) in ${field}`,
        );
      }
    }
  }
}

/** True when one paragraph of the document names the binary, its version and (if any) its commit. */
function documents(entry: BinaryEntry, readText: ReadText, violate: Violate) {
  const tokens = [
    entry.name,
    entry.version,
    ...(entry.commit ? [entry.commit] : []),
  ];
  for (const path of DOCUMENTS) {
    const content = readText(path);
    if (content === undefined) {
      violate("BINARY_NOT_DOCUMENTED", `${path} cannot be read`);
      continue;
    }
    const lowered = content.toLowerCase();
    const paragraphs = lowered.split(/\n\s*\n/);
    const named = paragraphs.some((paragraph) =>
      tokens.every((token) => paragraph.includes(token.toLowerCase())),
    );
    if (!named) {
      violate(
        "BINARY_NOT_DOCUMENTED",
        `${path} has no entry that names ${tokens.join(", ").replace(/, ([^,]*)$/, " and $1")} together`,
      );
    }
    if (
      path === "THIRD_PARTY_LICENSES.md" &&
      entry.bundledLicenses !== undefined &&
      !lowered.includes(entry.bundledLicenses.toLowerCase())
    ) {
      violate(
        "BINARY_NOT_DOCUMENTED",
        `${path} does not mention ${entry.bundledLicenses}, the bundled dependencies of ${entry.name}`,
      );
    }
  }
}

type ReadText = (path: string) => string | undefined;

function checkSnapshot(
  entry: BinaryEntry,
  path: string,
  pinCommit: string | undefined,
  readText: ReadText,
  violate: Violate,
): { installed: InstalledPackage[]; locked: LockedPackage[] } {
  const none = { installed: [], locked: [] };
  const content = readText(path);
  if (content === undefined) {
    violate(
      "BUNDLED_SNAPSHOT_UNREADABLE",
      `${entry.name}: ${path} cannot be read`,
    );
    return none;
  }
  let snapshot;
  try {
    snapshot = snapshotSchema.parse(JSON.parse(content));
  } catch {
    violate(
      "BUNDLED_SNAPSHOT_UNREADABLE",
      `${entry.name}: ${path} is not a snapshot of the bundled packages (sourceCommit and packages)`,
    );
    return none;
  }
  const expected = pinCommit ?? entry.commit;
  if (expected !== undefined && snapshot.sourceCommit !== expected) {
    violate(
      "BUNDLED_SNAPSHOT_COMMIT_MISMATCH",
      `${entry.name}: ${path} was generated for ${snapshot.sourceCommit}, the pin is ${expected}; run runner/scripts/audit_opencode_bundle.py --fetch again`,
    );
    return none;
  }
  return {
    installed: snapshot.packages.map(({ name, version, license }) => ({
      ecosystem: "bun" as const,
      name,
      version,
      license,
    })),
    locked: snapshot.packages.map(({ name, version }) => ({
      ecosystem: "bun" as const,
      name,
      version,
    })),
  };
}

export function auditBinaries(input: {
  policy: Policy;
  readText: ReadText;
}): BinaryAudit {
  const { policy, readText } = input;
  const allowed = new Set(policy.allowed.map((id) => id.toLowerCase()));
  const audit: BinaryAudit = {
    violations: [],
    binaries: policy.binaries.length,
    installed: [],
    locked: [],
  };

  for (const entry of policy.binaries) {
    const violate: Violate = (code, detail) =>
      audit.violations.push({ code, binary: entry.name, detail });

    const raw = readText(entry.pin);
    if (raw === undefined) {
      violate(
        "BINARY_PIN_UNREADABLE",
        `${entry.name}: ${entry.pin} cannot be read`,
      );
      continue;
    }
    let pin: unknown;
    try {
      pin = JSON.parse(raw);
    } catch {
      violate(
        "BINARY_PIN_UNREADABLE",
        `${entry.name}: ${entry.pin} is not JSON`,
      );
      continue;
    }
    if (!isRecord(pin)) {
      violate(
        "BINARY_PIN_UNREADABLE",
        `${entry.name}: ${entry.pin} is not a JSON object`,
      );
      continue;
    }

    checkPin(entry, pin, allowed, violate);
    documents(entry, readText, violate);
    if (entry.bundledLicenses !== undefined) {
      const bundled = checkSnapshot(
        entry,
        entry.bundledLicenses,
        text(pin.commit),
        readText,
        violate,
      );
      audit.installed.push(...bundled.installed);
      audit.locked.push(...bundled.locked);
    }
  }
  return audit;
}
