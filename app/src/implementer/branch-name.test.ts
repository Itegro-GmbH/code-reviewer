// SPDX-License-Identifier: LicenseRef-Proprietary

// The rules of a new branch name (#755): `git check-ref-format --branch`, plus the ones of this product (not the base branch,
// at most 200 characters). Pure.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BRANCH_NAME } from "../jobs/job-input.ts";
import {
  BRANCH_COMPONENT_MAX_BYTES,
  BRANCH_NAME_MAX_LENGTH,
  branchConflict,
  checkBranchName,
  type BranchNameIssue,
} from "./branch-name.ts";

const VALID: string[] = [
  "implementer/abc123",
  "feature/x",
  "fix-1",
  "a",
  "release/2026.10",
  "user@example",
  "a/b/c/d",
  "ünïcode/ß",
  "with+plus",
  "with%percent",
  "with#hash",
  "dot.in.middle",
  "x".repeat(BRANCH_NAME_MAX_LENGTH),
  "ä".repeat(BRANCH_COMPONENT_MAX_BYTES / 2),
  "d/" + "€".repeat(BRANCH_COMPONENT_MAX_BYTES / 3) + "/e",
  "{braces}",
  "tilde-at-end-ok-1",
];

const INVALID: [string, BranchNameIssue][] = [
  ["", "empty"],
  ["   ", "empty"],
  ["has space", "forbidden_character"],
  ["tab\there", "forbidden_character"],
  ["new\nline", "forbidden_character"],
  ["nul\u0000byte", "forbidden_character"],
  ["del\u007fchar", "forbidden_character"],
  ["tilde~1", "forbidden_character"],
  ["caret^", "forbidden_character"],
  ["colon:x", "forbidden_character"],
  ["quest?", "forbidden_character"],
  ["star*", "forbidden_character"],
  ["open[bracket", "forbidden_character"],
  ["back\\slash", "forbidden_character"],
  ["a..b", "double_dot"],
  ["..", "double_dot"],
  ["a@{b", "reflog_syntax"],
  ["@{", "reflog_syntax"],
  ["-leading", "leading_dash"],
  ["--force", "leading_dash"],
  ["branch.lock", "lock_suffix"],
  ["dir.lock/branch", "component_lock_suffix"],
  ["/leading-slash", "slash_placement"],
  ["trailing-slash/", "slash_placement"],
  ["double//slash", "slash_placement"],
  [".hidden", "component_leading_dot"],
  ["dir/.hidden", "component_leading_dot"],
  ["ends.", "trailing_dot"],
  ["@", "reserved_name"],
  ["HEAD", "reserved_name"],
  ["x".repeat(BRANCH_NAME_MAX_LENGTH + 1), "too_long"],
  // #791: a path component holds 255 bytes on the file systems git runs on, and git also makes `<name>.lock`.
  ["ä".repeat(121), "component_too_long"],
  ["feature/" + "ä".repeat(121), "component_too_long"],
  ["a/" + "ß".repeat(121) + "/b", "component_too_long"],
  ["€".repeat(81), "component_too_long"],
  // #791: the queue refuses `\s` (NBSP, line separators, the byte order mark, ...); the form says why.
  ["no\u00a0break", "forbidden_character"],
  ["line\u2028separator", "forbidden_character"],
  ["para\u2029separator", "forbidden_character"],
  ["bom\ufeffhere", "forbidden_character"],
  ["ideographic\u3000space", "forbidden_character"],
  ["thin\u2009space", "forbidden_character"],
];

describe("the rules of a new branch name", () => {
  // #755-T05
  it.each(VALID)("accepts %j", (name) => {
    expect(checkBranchName(name, "main")).toEqual({ ok: true, value: name });
  });

  // #755-T05
  it.each(INVALID)("refuses %j with %s", (name, issue) => {
    expect(checkBranchName(name, "main")).toEqual({ ok: false, issue });
  });

  // #755-T04
  it("refuses the base branch, also with another spelling of case that git treats as another branch it accepts", () => {
    expect(checkBranchName("main", "main")).toEqual({
      ok: false,
      issue: "same_as_base",
    });
    expect(checkBranchName("Main", "main")).toEqual({
      ok: true,
      value: "Main",
    });
  });

  // #755-T05
  it("does not change the name it is given: no trimming that would make another branch of it", () => {
    expect(checkBranchName(" padded ", "main")).toEqual({
      ok: false,
      issue: "forbidden_character",
    });
  });

  // #755-T05
  it("has at least 30 cases", () => {
    expect(VALID.length + INVALID.length).toBeGreaterThanOrEqual(30);
  });

  // #755-T05
  it("agrees with the real `git check-ref-format --branch` for every name above that git can be asked about", () => {
    const gitAccepts = (name: string): boolean => {
      // A name with a NUL cannot be passed as an argument at all.
      if (name.includes("\u0000")) return false;
      try {
        execFileSync("git", ["check-ref-format", "--branch", name], {
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    };
    const disagreements = [
      ...VALID.map((name) => ({ name, expected: true })),
      ...INVALID.filter(
        ([name, issue]) =>
          name.length <= 255 &&
          // Rules of this product that `git check-ref-format` does not have: the bytes of a part (a file name limit, not syntax)
          // and the white space beyond ASCII (git takes NBSP; the queue and the form do not).
          issue !== "component_too_long" &&
          !(issue === "forbidden_character" && /[\u0080-\uffff]/.test(name)),
      ).map(([name]) => ({
        name,
        expected: false,
      })),
    ]
      // `HEAD` and `@` (git's `--branch` reads `@` as HEAD and accepts it), a leading dash (an option) and a 201-character name
      // are rules of this product that `git check-ref-format` does not have; the others must agree.
      .filter(
        ({ name }) =>
          name !== "HEAD" &&
          name !== "@" &&
          !name.startsWith("-") &&
          name.length <= BRANCH_NAME_MAX_LENGTH,
      )
      .filter(({ name, expected }) => gitAccepts(name) !== expected);
    expect(disagreements).toEqual([]);
  });
});

describe("the rules and the queue's", () => {
  // #791: a name that passes here must pass the queue's `BRANCH_NAME`, otherwise GitHub is asked and the submit then fails with a
  // bare IMPLEMENTER_REQUEST_INVALID and no issue.
  it("accepts no character the queue refuses, over the whole basic plane", () => {
    const disagreements: string[] = [];
    for (let code = 0; code <= 0xffff; code += 1) {
      const name = `a${String.fromCharCode(code)}b`;
      if (checkBranchName(name, "main").ok && !BRANCH_NAME.test(name))
        disagreements.push(`U+${code.toString(16).padStart(4, "0")}`);
    }
    expect(disagreements).toEqual([]);
  });

  it("accepts no name the queue refuses, whatever its length", () => {
    for (const name of [
      "x".repeat(BRANCH_NAME_MAX_LENGTH),
      "ä".repeat(BRANCH_COMPONENT_MAX_BYTES / 2),
    ])
      expect(BRANCH_NAME.test(name)).toBe(true);
  });
});

describe("a branch name and the branches that are there", () => {
  // #791
  it.each([
    ["foo/bar", ["foo"], "foo"],
    ["a/b/c", ["x", "a/b"], "a/b"],
    ["a/b/c", ["a"], "a"],
    ["foo", ["foo/bar"], "foo/bar"],
    ["a/b", ["other", "a/b/c/d"], "a/b/c/d"],
  ])("sees that %s conflicts with %j: %s", (name, existing, conflict) => {
    expect(branchConflict(name, existing)).toBe(conflict);
  });

  // #791
  it.each([
    ["foo/bar", ["foo/baz", "foobar", "foo2", "bar"]],
    ["foo", ["foobar", "fo", "foo.x", "bar/foo"]],
    ["a/b", ["a/c", "a/bb", "b"]],
    // The same name is no conflict of folders: the branch exists, which is another refusal.
    ["foo", ["foo"]],
    ["foo", []],
  ])("sees no conflict of %s with %j", (name, existing) => {
    expect(branchConflict(name, existing)).toBeNull();
  });
});

describe("the rules against the real git", () => {
  let repository: string;
  beforeAll(() => {
    repository = mkdtempSync(join(tmpdir(), "cr-755-git-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repository, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "base",
    );
  });
  afterAll(() => {
    rmSync(repository, { recursive: true, force: true });
  });

  /** What the runner does: a new branch at the base. */
  const gitCreates = (name: string): boolean => {
    try {
      execFileSync("git", ["checkout", "-q", "-b", name], {
        cwd: repository,
        stdio: "ignore",
      });
      execFileSync("git", ["checkout", "-q", "main"], {
        cwd: repository,
        stdio: "ignore",
      });
      execFileSync("git", ["branch", "-q", "-D", name], {
        cwd: repository,
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };

  // #791
  it("creates every name of the rules that is accepted, the longest components included (with their `.lock` file)", () => {
    const failed = VALID.filter(
      (name) => checkBranchName(name, "main").ok && !gitCreates(name),
    );
    expect(failed).toEqual([]);
  });

  // #791
  it("shows why the limit is in bytes: git cannot create a branch that is under 200 characters and over 255 bytes", () => {
    for (const name of ["ä".repeat(150), "feature/" + "ä".repeat(130)]) {
      expect(name.length).toBeLessThanOrEqual(BRANCH_NAME_MAX_LENGTH);
      expect(gitCreates(name), name.length.toString()).toBe(false);
      expect(checkBranchName(name, "main")).toEqual({
        ok: false,
        issue: "component_too_long",
      });
    }
  });

  // #791
  it("agrees on folder and file: where the rules see a conflict git cannot create the branch, where they see none it can", () => {
    const pairs: Array<[string, string[]]> = [
      ["foo/bar", ["foo"]],
      ["foo", ["foo/bar"]],
      ["a/b/c", ["a/b"]],
      ["foo/baz", ["foo/bar"]],
      ["foobar", ["foo"]],
    ];
    for (const [name, existing] of pairs) {
      const created: string[] = [];
      for (const other of existing) {
        execFileSync("git", ["branch", other], {
          cwd: repository,
          stdio: "ignore",
        });
        created.push(other);
      }
      const conflict = branchConflict(name, existing);
      expect(gitCreates(name), `${name} beside ${existing.join(",")}`).toBe(
        conflict === null,
      );
      for (const other of created)
        execFileSync("git", ["branch", "-D", "-q", other], {
          cwd: repository,
          stdio: "ignore",
        });
    }
  });
});
