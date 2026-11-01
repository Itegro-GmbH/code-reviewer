// SPDX-License-Identifier: LicenseRef-Proprietary

// #202-T06: the provenance and license audit of the prebuilt binaries that the Dynamic runner image
// ships (OpenCode, ripgrep), with made-up pins, documents and snapshots. The real files are covered
// by policy.test.ts and by `make check-licenses`.
import { describe, expect, it } from "vitest";
import {
  auditBinaries,
  describeBinaryViolation,
  type BinaryViolation,
} from "./binaries.ts";
import type { BinaryEntry, Policy } from "./policy.ts";

const COMMIT = "733b2c627e5aec39cb33cc22373bdce33053ef2c";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

const policy: Policy = {
  allowed: ["MIT", "Apache-2.0", "ISC"],
  exceptions: [],
  notInstalled: [],
  binaries: [
    {
      name: "opencode",
      pin: "runner/opencode-pin.json",
      version: "1.19.0",
      commit: COMMIT,
      license: "MIT",
      bundledLicenses: "runner/opencode-bundled-licenses.json",
      reason: "The engine of Dynamic Review, unmodified.",
    },
    {
      name: "ripgrep",
      pin: "runner/ripgrep-pin.json",
      version: "14.1.1",
      license: "MIT",
      reason: "The search helper of the engine.",
    },
  ],
};

type Json = Record<string, unknown>;

function pinOf(overrides: Json = {}): Json {
  return {
    name: "opencode",
    repository: "https://github.com/anomalyco/opencode",
    version: "1.19.0",
    commit: COMMIT,
    license: "MIT",
    licenseUrl: "https://github.com/anomalyco/opencode/blob/v1.19.0/LICENSE",
    platforms: {
      "linux-x64": { archiveSha256: HEX_A, executableSha256: HEX_B },
    },
    ...overrides,
  };
}

function rgPinOf(overrides: Json = {}): Json {
  return {
    name: "ripgrep",
    repository: "https://github.com/BurntSushi/ripgrep",
    version: "14.1.1",
    license: "MIT",
    licenseUrl: "https://github.com/BurntSushi/ripgrep/blob/14.1.1/LICENSE-MIT",
    platforms: {
      "linux-x64": { archiveSha256: HEX_A, executableSha256: HEX_B },
    },
    ...overrides,
  };
}

function snapshotOf(overrides: Json = {}): Json {
  return {
    sourceCommit: COMMIT,
    packages: [
      { name: "left-pad", version: "1.3.0", license: "MIT" },
      {
        name: "@scope/dual",
        version: "2.0.0",
        license: "(MIT OR GPL-3.0-only)",
      },
    ],
    ...overrides,
  };
}

const THIRD_PARTY = `# Third party licenses

## OpenCode

- Package: OpenCode 1.19.0, source commit ${COMMIT}
- Bundled dependencies: runner/opencode-bundled-licenses.json

## ripgrep

- Package: ripgrep 14.1.1
`;

const NOTICE = `code-review.com

  OpenCode (https://github.com/anomalyco/opencode) 1.19.0, source commit ${COMMIT}
  Licensed under the MIT License.

  ripgrep 14.1.1 (https://github.com/BurntSushi/ripgrep)
  Licensed under the MIT License.
`;

type Files = Record<string, string | undefined>;

function filesOf(overrides: Files = {}): Files {
  return {
    "runner/opencode-pin.json": JSON.stringify(pinOf()),
    "runner/ripgrep-pin.json": JSON.stringify(rgPinOf()),
    "runner/opencode-bundled-licenses.json": JSON.stringify(snapshotOf()),
    "THIRD_PARTY_LICENSES.md": THIRD_PARTY,
    NOTICE,
    ...overrides,
  };
}

function audit(overrides: Files = {}, withPolicy: Policy = policy) {
  const files = filesOf(overrides);
  return auditBinaries({ policy: withPolicy, readText: (path) => files[path] });
}

const codes = (violations: BinaryViolation[]) =>
  violations.map((violation) => violation.code);

describe("auditBinaries", () => {
  // #202-T06
  it("passes when pins, policy, documents and snapshot agree", () => {
    const result = audit();

    expect(result.violations.map(describeBinaryViolation)).toEqual([]);
    expect(result.binaries).toBe(2);
  });

  // #202-T06
  it("hands the bundled packages of the snapshot to the license check as bun packages", () => {
    const result = audit();

    expect(result.installed).toEqual([
      { ecosystem: "bun", name: "left-pad", version: "1.3.0", license: "MIT" },
      {
        ecosystem: "bun",
        name: "@scope/dual",
        version: "2.0.0",
        license: "(MIT OR GPL-3.0-only)",
      },
    ]);
    expect(result.locked).toEqual([
      { ecosystem: "bun", name: "left-pad", version: "1.3.0" },
      { ecosystem: "bun", name: "@scope/dual", version: "2.0.0" },
    ]);
  });

  // #202-T06
  it("fails with a clear message when a pin file is missing", () => {
    const result = audit({ "runner/ripgrep-pin.json": undefined });

    expect(result.violations.map(describeBinaryViolation)).toEqual([
      "BINARY_PIN_UNREADABLE: ripgrep: runner/ripgrep-pin.json cannot be read",
    ]);
  });

  // #202-T06
  it("fails when a pin file is not JSON or not an object", () => {
    const notJson = audit({ "runner/ripgrep-pin.json": "{ nope" });
    const array = audit({ "runner/ripgrep-pin.json": "[]" });

    expect(codes(notJson.violations)).toEqual(["BINARY_PIN_UNREADABLE"]);
    expect(codes(array.violations)).toEqual(["BINARY_PIN_UNREADABLE"]);
  });

  // #202-T06
  it("fails when the license of the pin is not allowed by the policy", () => {
    const result = audit({
      "runner/opencode-pin.json": JSON.stringify(
        pinOf({ license: "AGPL-3.0-only" }),
      ),
    });

    expect(result.violations.map(describeBinaryViolation)).toContain(
      "BINARY_LICENSE_NOT_ALLOWED: opencode 1.19.0 is AGPL-3.0-only, which the policy does not allow",
    );
  });

  // #202-T06
  it("accepts a dual license when one side is allowed", () => {
    const dual = {
      ...policy,
      binaries: policy.binaries.map((entry) => ({
        ...entry,
        license: "Unlicense OR MIT",
      })),
    };

    const result = audit(
      {
        "runner/opencode-pin.json": JSON.stringify(
          pinOf({ license: "Unlicense OR MIT" }),
        ),
        "runner/ripgrep-pin.json": JSON.stringify(
          rgPinOf({ license: "Unlicense OR MIT" }),
        ),
      },
      dual,
    );

    expect(result.violations.map(describeBinaryViolation)).toEqual([]);
  });

  // #761-T07: git is GPL-2.0-only and built from source; the policy entry carries the documented exception.
  describe("a release built from source with a license outside the allow list", () => {
    const GIT_COMMIT = "67ad42147a7acc2af6074753ebd03d904476118f";
    const gitPolicy: Policy = {
      ...policy,
      binaries: [
        {
          name: "git",
          pin: "runner/git-pin.json",
          version: "2.53.0",
          commit: GIT_COMMIT,
          license: "GPL-2.0-only",
          build: "source",
          exception: "A separate program of the image, used unmodified.",
          reason: "The version control of the Implementer's agent.",
        },
      ],
    };
    const without = (
      entry: BinaryEntry,
      key: "exception" | "build",
    ): BinaryEntry =>
      Object.fromEntries(
        Object.entries(entry).filter(([name]) => name !== key),
      ) as BinaryEntry;
    const gitPin = (overrides: Json = {}): Json => ({
      name: "git",
      repository: "https://github.com/git/git",
      version: "2.53.0",
      commit: GIT_COMMIT,
      license: "GPL-2.0-only",
      licenseUrl: "https://github.com/git/git/blob/v2.53.0/COPYING",
      platforms: { "linux-x64": { archiveSha256: HEX_A } },
      ...overrides,
    });
    const gitFiles = (overrides: Files = {}): Files => ({
      "runner/git-pin.json": JSON.stringify(gitPin()),
      "THIRD_PARTY_LICENSES.md": `git 2.53.0, source commit ${GIT_COMMIT}\n`,
      NOTICE: `git 2.53.0 (${GIT_COMMIT})\n`,
      ...overrides,
    });
    const auditGit = (overrides: Files = {}, p: Policy = gitPolicy) => {
      const files = gitFiles(overrides);
      return auditBinaries({ policy: p, readText: (path) => files[path] });
    };

    it("passes with only the archive digest, because there is no executable to pin", () => {
      expect(auditGit().violations.map(describeBinaryViolation)).toEqual([]);
    });

    it("still needs a valid archive digest", () => {
      const result = auditGit({
        "runner/git-pin.json": JSON.stringify(
          gitPin({ platforms: { "linux-x64": { archiveSha256: "abc" } } }),
        ),
      });

      expect(codes(result.violations)).toEqual(["BINARY_DIGEST_MISSING"]);
    });

    it("fails on the license without the exception", () => {
      const withoutException: Policy = {
        ...gitPolicy,
        binaries: gitPolicy.binaries.map((entry) =>
          without(entry, "exception"),
        ),
      };

      expect(codes(auditGit({}, withoutException).violations)).toEqual([
        "BINARY_LICENSE_NOT_ALLOWED",
      ]);
    });

    it("does not let the exception hide a pin whose license is another one", () => {
      const result = auditGit({
        "runner/git-pin.json": JSON.stringify(
          gitPin({ license: "AGPL-3.0-only" }),
        ),
      });

      expect(codes(result.violations)).toContain("BINARY_POLICY_MISMATCH");
    });

    it("still needs the executable digest of a release that is not built from source", () => {
      const prebuilt: Policy = {
        ...gitPolicy,
        binaries: gitPolicy.binaries.map((entry) => without(entry, "build")),
      };

      expect(codes(auditGit({}, prebuilt).violations)).toEqual([
        "BINARY_DIGEST_MISSING",
      ]);
    });
  });

  // #202-T06
  it("fails when the policy entry disagrees with the pin on version, commit or license", () => {
    const result = audit({
      "runner/opencode-pin.json": JSON.stringify(
        pinOf({
          version: "1.20.0",
          commit: "f".repeat(40),
          license: "Apache-2.0",
        }),
      ),
    });

    expect(result.violations.map(describeBinaryViolation)).toEqual(
      expect.arrayContaining([
        'BINARY_POLICY_MISMATCH: opencode: version is "1.19.0" in license-policy.json but "1.20.0" in runner/opencode-pin.json',
        `BINARY_POLICY_MISMATCH: opencode: commit is "${COMMIT}" in license-policy.json but "${"f".repeat(40)}" in runner/opencode-pin.json`,
        'BINARY_POLICY_MISMATCH: opencode: license is "MIT" in license-policy.json but "Apache-2.0" in runner/opencode-pin.json',
      ]),
    );
  });

  // #202-T06
  it.each([
    ["archiveSha256", "a pinned archive"],
    ["executableSha256", "a pinned executable"],
  ])("fails when a platform has no SHA-256 for %s", (field) => {
    const platforms = {
      "linux-x64": {
        archiveSha256: HEX_A,
        executableSha256: HEX_B,
        [field]: undefined,
      },
    };

    const result = audit({
      "runner/opencode-pin.json": JSON.stringify(pinOf({ platforms })),
    });

    expect(result.violations.map(describeBinaryViolation)).toEqual([
      `BINARY_DIGEST_MISSING: opencode platform linux-x64 has no valid SHA-256 (64 hex digits) in ${field}`,
    ]);
  });

  // #202-T06
  it("fails when a digest is not 64 lowercase hex digits", () => {
    const platforms = {
      "linux-x64": {
        archiveSha256: "abc123",
        executableSha256: HEX_B.toUpperCase(),
      },
    };

    const result = audit({
      "runner/opencode-pin.json": JSON.stringify(pinOf({ platforms })),
    });

    expect(codes(result.violations)).toEqual([
      "BINARY_DIGEST_MISSING",
      "BINARY_DIGEST_MISSING",
    ]);
  });

  // #202-T06
  it("fails when the pin pins no platform at all", () => {
    const result = audit({
      "runner/opencode-pin.json": JSON.stringify(pinOf({ platforms: {} })),
    });

    expect(codes(result.violations)).toEqual(["BINARY_DIGEST_MISSING"]);
  });

  // #202-T06
  it.each(["licenseUrl", "repository"])(
    "fails when the pin has no %s",
    (field) => {
      const result = audit({
        "runner/opencode-pin.json": JSON.stringify(
          pinOf({ [field]: undefined }),
        ),
      });

      expect(result.violations.map(describeBinaryViolation)).toEqual([
        `BINARY_PROVENANCE_MISSING: opencode: runner/opencode-pin.json has no ${field}`,
      ]);
    },
  );

  // #202-T06
  it("fails when THIRD_PARTY_LICENSES.md does not mention the binary by name, version and commit", () => {
    const noVersion = audit({
      "THIRD_PARTY_LICENSES.md": THIRD_PARTY.replace(
        "OpenCode 1.19.0",
        "OpenCode",
      ),
    });
    const noCommit = audit({
      "THIRD_PARTY_LICENSES.md": THIRD_PARTY.replace(
        `, source commit ${COMMIT}`,
        "",
      ),
    });
    const noName = audit({
      "THIRD_PARTY_LICENSES.md": THIRD_PARTY.replaceAll("ripgrep", "grep"),
    });

    expect(noVersion.violations.map(describeBinaryViolation)).toEqual([
      "BINARY_NOT_DOCUMENTED: THIRD_PARTY_LICENSES.md has no entry that names opencode, 1.19.0 and 733b2c627e5aec39cb33cc22373bdce33053ef2c together",
    ]);
    expect(codes(noCommit.violations)).toEqual(["BINARY_NOT_DOCUMENTED"]);
    expect(codes(noName.violations)).toEqual(["BINARY_NOT_DOCUMENTED"]);
  });

  // #202-T06
  it("fails when NOTICE does not mention the binary, or is missing", () => {
    const noOpencode = audit({
      NOTICE: NOTICE.replace(/opencode/gi, "Something"),
    });
    const missing = audit({ NOTICE: undefined });

    expect(codes(noOpencode.violations)).toEqual(["BINARY_NOT_DOCUMENTED"]);
    expect(codes(missing.violations)).toEqual([
      "BINARY_NOT_DOCUMENTED",
      "BINARY_NOT_DOCUMENTED",
    ]);
  });

  // #202-T06
  it("fails when THIRD_PARTY_LICENSES.md does not point to the bundled-dependency snapshot", () => {
    const result = audit({
      "THIRD_PARTY_LICENSES.md": THIRD_PARTY.replace(
        "runner/opencode-bundled-licenses.json",
        "somewhere else",
      ),
    });

    expect(result.violations.map(describeBinaryViolation)).toEqual([
      "BINARY_NOT_DOCUMENTED: THIRD_PARTY_LICENSES.md does not mention runner/opencode-bundled-licenses.json, the bundled dependencies of opencode",
    ]);
  });

  // #202-T06
  it("fails when the snapshot is missing, unreadable or of another commit", () => {
    const missing = audit({
      "runner/opencode-bundled-licenses.json": undefined,
    });
    const garbage = audit({ "runner/opencode-bundled-licenses.json": "{}" });
    const other = audit({
      "runner/opencode-bundled-licenses.json": JSON.stringify(
        snapshotOf({ sourceCommit: "e".repeat(40) }),
      ),
    });

    expect(codes(missing.violations)).toEqual(["BUNDLED_SNAPSHOT_UNREADABLE"]);
    expect(codes(garbage.violations)).toEqual(["BUNDLED_SNAPSHOT_UNREADABLE"]);
    expect(other.violations.map(describeBinaryViolation)).toEqual([
      `BUNDLED_SNAPSHOT_COMMIT_MISMATCH: opencode: runner/opencode-bundled-licenses.json was generated for ${"e".repeat(40)}, the pin is ${COMMIT}; run runner/scripts/audit_opencode_bundle.py --fetch again`,
    ]);
  });

  // #202-T06
  it("does not hand packages of an unreadable snapshot to the license check", () => {
    const result = audit({
      "runner/opencode-bundled-licenses.json": undefined,
    });

    expect(result.installed).toEqual([]);
    expect(result.locked).toEqual([]);
  });
});
