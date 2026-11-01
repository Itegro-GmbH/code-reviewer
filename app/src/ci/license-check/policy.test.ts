// SPDX-License-Identifier: LicenseRef-Proprietary

// #118: license-policy.json against the real lockfiles. Which packages are installed differs per
// machine, so this reads only the lockfiles (the CI job and `make check-licenses` read the
// installed metadata).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkLicenses,
  describeViolation,
  findStalePolicyEntries,
  type LockedPackage,
} from "./check.ts";
import { auditBinaries, describeBinaryViolation } from "./binaries.ts";
import { parsePnpmLock, parseUvLock } from "./collect.ts";
import { matchesPackage, parsePolicy } from "./policy.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function read(path: string): string {
  return readFileSync(`${repoRoot}${path}`, "utf8");
}

function readIfThere(path: string): string | undefined {
  try {
    return read(path);
  } catch {
    return undefined;
  }
}

const policy = parsePolicy(JSON.parse(read("license-policy.json")));
// The packages that the prebuilt binaries bundle (runner/opencode-bundled-licenses.json), read the
// way `make check-licenses` reads them.
const binaries = auditBinaries({ policy, readText: readIfThere });
const locked: LockedPackage[] = [
  ...parsePnpmLock(read("pnpm-lock.yaml")),
  ...parseUvLock(read("runner/uv.lock")),
  ...binaries.locked,
];

describe("license-policy.json", () => {
  it("is valid and has no duplicate allowed license", () => {
    const ids = policy.allowed.map((id) => id.toLowerCase());

    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads the lockfiles of both parts", () => {
    expect(
      locked.filter((entry) => entry.ecosystem === "npm").length,
    ).toBeGreaterThan(300);
    expect(
      locked.filter((entry) => entry.ecosystem === "python").length,
    ).toBeGreaterThan(100);
  });

  it("has no entry that matches no package of the lockfiles", () => {
    expect(
      findStalePolicyEntries(policy, locked).map(describeViolation),
    ).toEqual([]);
  });

  it("allows the license that it declares for every package that is not installed everywhere", () => {
    const declared: LockedPackage[] = policy.notInstalled.map((entry) => ({
      ecosystem: entry.ecosystem,
      name: entry.package.replace(/\*$/, "x"),
      version: "1.0.0",
    }));

    const result = checkLicenses({ policy, installed: [], locked: declared });

    expect(result.violations.map(describeViolation)).toEqual([]);
  });

  it("declares every package that the lockfiles list for another platform only by name pattern", () => {
    for (const entry of policy.notInstalled) {
      expect(
        locked.some(
          (candidate) =>
            candidate.ecosystem === entry.ecosystem &&
            matchesPackage(entry.ecosystem, entry.package, candidate.name),
        ),
        entry.package,
      ).toBe(true);
    }
  });

  // #202-T06
  describe("binaries", () => {
    it("names the pin of every prebuilt binary and tool of the Worker image, each with its version, license and reason", () => {
      expect(
        policy.binaries.map((entry) => [entry.name, entry.pin, entry.license]),
      ).toEqual([
        ["opencode", "runner/opencode-pin.json", "MIT"],
        ["ripgrep", "runner/ripgrep-pin.json", "MIT"],
        // #761-T07
        ["git", "runner/git-pin.json", "GPL-2.0-only"],
        ["node", "runner/node-pin.json", "MIT"],
        ["pnpm", "runner/pnpm-pin.json", "MIT"],
      ]);
      for (const entry of policy.binaries) {
        expect(entry.version, entry.name).toMatch(/^\d+\.\d+\.\d+$/);
        expect(entry.reason, entry.name).not.toBe("");
        expect(entry.commit, entry.name).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    // #202-T06, #761-T07: the pins of all five parts pass the audit.
    it("passes the audit of the real pins, documents and snapshot", () => {
      expect(binaries.violations.map(describeBinaryViolation)).toEqual([]);
      expect(binaries.binaries).toBe(5);
      expect(binaries.installed.length).toBeGreaterThan(100);
    });

    // #761-T07: git is GPL-2.0, which is not on the allow list; it is a separate program of the image,
    // built from the unmodified release, and the policy says so in the entry itself.
    it("accepts git's GPL license only through a documented exception, and marks it as built from source", () => {
      const git = policy.binaries.find((entry) => entry.name === "git");

      expect(git?.build).toBe("source");
      expect(git?.exception).toMatch(/separate program/i);
      for (const entry of policy.binaries.filter((e) => e.name !== "git")) {
        expect(entry.exception, entry.name).toBeUndefined();
        expect(entry.build, entry.name).toBeUndefined();
      }
    });

    it("allows the license of every package bundled in OpenCode, by the allow list or by name", () => {
      const result = checkLicenses({
        policy,
        installed: binaries.installed,
        locked: binaries.locked,
      });

      expect(result.violations.map(describeViolation)).toEqual([]);
    });

    it("rejects a policy file without binaries or with a field it does not know", () => {
      const withoutBinaries = Object.fromEntries(
        Object.entries(policy).filter(([key]) => key !== "binaries"),
      );
      const [first] = policy.binaries;

      expect(() => parsePolicy(withoutBinaries)).toThrow();
      expect(() =>
        parsePolicy({ ...policy, binaries: [{ ...first, extra: 1 }] }),
      ).toThrow();
      expect(() =>
        parsePolicy({
          ...policy,
          binaries: [{ ...first, commit: "not-a-commit" }],
        }),
      ).toThrow();
      // #761-T07: `build` knows one value, and an exception needs a reason.
      expect(() =>
        parsePolicy({ ...policy, binaries: [{ ...first, build: "binary" }] }),
      ).toThrow();
      expect(() =>
        parsePolicy({ ...policy, binaries: [{ ...first, exception: "" }] }),
      ).toThrow();
    });
  });
});
