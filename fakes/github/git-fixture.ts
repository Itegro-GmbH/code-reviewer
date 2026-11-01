// SPDX-License-Identifier: LicenseRef-Proprietary

// A small real Git repository for the tests that need Git objects: made with the Git command line, with
// a fixed identity and fixed dates, so the same files and messages always give the same commit names. The
// fake GitHub serves it over smart HTTP (`git-http.ts`), the runner's Git transport reads it unchanged.
// Local fixed Git commands only; never a remote. Dummy data.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export type GitRepository = {
  /** The directory a Git server serves (the repository's `.git` directory). */
  path: string;
  /** Writes these files (null removes one), commits everything on the current branch, returns the commit. */
  commit(files: Record<string, string | null>, message: string): string;
  /** Creates a branch at the current commit and switches to it. */
  branch(name: string): void;
  /** Switches to an existing branch. */
  checkout(name: string): void;
  /** Points a ref (a branch, `refs/pull/<n>/head`) at a commit. */
  setRef(ref: string, sha: string): void;
};

export function createGitRepository(
  directory: string,
  options: { defaultBranch?: string } = {},
): GitRepository {
  const defaultBranch = options.defaultBranch ?? "main";
  mkdirSync(directory, { recursive: true });
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    ...IDENTITY,
  };
  const git = (...args: string[]): string =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      // Next's types make NODE_ENV a required variable; Git does not read it.
      env: environment as NodeJS.ProcessEnv,
    }).trim();
  git("init", "--quiet", `--initial-branch=${defaultBranch}`);
  // The fake GitHub reads the default branch of the repository from here (`git-branches.ts`): the checked out
  // branch moves with `branch` and `checkout`, this does not.
  git("config", "init.defaultBranch", defaultBranch);
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", "/dev/null");
  // What the runner's checkout asks the server for: a depth-one fetch of a commit with a blob size filter.
  git("config", "uploadpack.allowFilter", "true");
  git("config", "uploadpack.allowAnySHA1InWant", "true");
  return {
    path: join(directory, ".git"),
    commit(files, message) {
      for (const [name, content] of Object.entries(files)) {
        const target = join(directory, name);
        if (content === null) {
          rmSync(target, { force: true });
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
      git("add", "--all");
      git("commit", "--quiet", "--allow-empty", "--message", message);
      return git("rev-parse", "HEAD");
    },
    branch(name) {
      git("checkout", "--quiet", "-b", name);
    },
    checkout(name) {
      git("checkout", "--quiet", name);
    },
    setRef(ref, sha) {
      git("update-ref", ref, sha);
    },
  };
}
