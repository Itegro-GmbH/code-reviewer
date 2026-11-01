// SPDX-License-Identifier: LicenseRef-Proprietary

// The branches of a registered Git repository (`git-fixture.ts`), as the branch endpoints of the fake GitHub
// report them: read from the repository on every call, so a branch a test creates afterwards is there at once.
// Local read-only Git commands on the directory the test registered; never a remote.
import { execFileSync } from "node:child_process";

export type FixtureBranch = { name: string; sha: string };

export type FixtureBranches = {
  /** The default branch the fixture was made with, or null when it names none that exists. */
  defaultBranch: string | null;
  /** Every branch (`refs/heads/*`), by name. */
  branches: FixtureBranch[];
};

function git(gitDirectory: string, ...args: string[]): string {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  return execFileSync("git", ["--git-dir", gitDirectory, ...args], {
    encoding: "utf8",
    // Next's types make NODE_ENV a required variable; Git does not read it.
    env: environment as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function readFixtureBranches(gitDirectory: string): FixtureBranches {
  const branches: FixtureBranch[] = git(
    gitDirectory,
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%09%(objectname)",
    "refs/heads",
  )
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [ref = "", sha = ""] = line.split("\t");
      return { name: ref.slice("refs/heads/".length), sha };
    });
  let configured = "";
  try {
    configured = git(gitDirectory, "config", "--get", "init.defaultBranch");
  } catch {
    // No such key: a fixture that was not made by `createGitRepository`.
  }
  const defaultBranch = branches.some((branch) => branch.name === configured)
    ? configured
    : null;
  return { defaultBranch, branches };
}
