// SPDX-License-Identifier: LicenseRef-Proprietary

// The repositories of a session of several repositories (#1092, epic #1090, ADR 0006): what the first turn resolved and the app stored,
// and what every later turn of the session (an answer, `session.continue`, a resume) works on without resolving anything again.
// Pure: no database, no I/O.

/** The most repositories a step may name (`maxItems` of `repos` in `contracts/workflow.v1.json`). */
export const SESSION_REPOS_MAX = 10;

/**
 * One repository of a session, as the first turn resolved it. `name` is the mount (`/work/<name>`), `base` the base branch (the default
 * branch of the repository when the step named none) and `branch` the working branch (the base again when the step named none: direct work).
 */
export type SessionRepo = {
  repositoryId: string;
  fullName: string;
  name: string;
  base: string;
  branch: string;
};

/** The names the work volume uses itself (and `.git`, which would make `/work` a repository): never a mount name as they are. */
const RESERVED_MOUNT_NAMES: ReadonlySet<string> = new Set([
  "result",
  "reserve",
  ".git",
]);

/**
 * The mount name of every repository of a job, from the `fullName`s alone (ADR 0006, `ImplementerMountName` in the runner contract): the
 * name part of `owner/name`, or `<owner>__<name>` for every repository whose name part another one has too (without regard to case, so the
 * result does not depend on the order of the list) and for a reserved name part. The runner re-derives every name the same way.
 */
export function deriveMountNames(fullNames: readonly string[]): string[] {
  const parts = fullNames.map(
    (fullName) => fullName.split("/") as [string, string],
  );
  const counts = new Map<string, number>();
  for (const [, name] of parts)
    counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  return parts.map(([owner, name]) =>
    (counts.get(name.toLowerCase()) ?? 0) > 1 ||
    RESERVED_MOUNT_NAMES.has(name.toLowerCase())
      ? `${owner}__${name}`
      : name,
  );
}

const REPOSITORY_FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * Whether the text is a repository a multi-repository job can mount (#1092, review finding 6): `owner/name` in the characters GitHub allows,
 * and a name whose mount name the runner contract accepts (`ImplementerMountName`: no leading `-`, which `git`, `docker` or `mkdir` would read as an
 * option, and never `.`, `..` or `.git`). A name this refuses is the app's `repo_invalid` (or the validator's `invalid_value`), never a runner's `invalid_job`.
 */
export function isRepositoryFullName(text: string): boolean {
  if (!REPOSITORY_FULL_NAME.test(text)) return false;
  const [owner, name] = text.split("/") as [string, string];
  return (
    !owner.startsWith("-") &&
    !name.startsWith("-") &&
    owner !== "." &&
    owner !== ".." &&
    ![".", "..", ".git"].includes(name.toLowerCase())
  );
}

/** The index of the second one of two entries equal without regard to case, or -1. */
export function firstRepeat(values: readonly string[]): number {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const key = value.toLowerCase();
    if (seen.has(key)) return index;
    seen.add(key);
  }
  return -1;
}

const NO_WHITESPACE = /^[^\s]+$/;

/** The list a session stored (JSON text), or null for a session of one repository and for text that is not a list of repositories. */
export function parseSessionRepos(text: string | null): SessionRepo[] | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > SESSION_REPOS_MAX
  )
    return null;
  const repos: SessionRepo[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const { repositoryId, fullName, name, base, branch } = entry as Record<
      string,
      unknown
    >;
    if (
      typeof repositoryId !== "string" ||
      typeof fullName !== "string" ||
      typeof name !== "string" ||
      typeof base !== "string" ||
      typeof branch !== "string" ||
      !NO_WHITESPACE.test(base) ||
      !NO_WHITESPACE.test(branch)
    )
      return null;
    repos.push({ repositoryId, fullName, name, base, branch });
  }
  return repos;
}

export function serializeSessionRepos(repos: readonly SessionRepo[]): string {
  return JSON.stringify(
    repos.map(({ repositoryId, fullName, name, base, branch }) => ({
      repositoryId,
      fullName,
      name,
      base,
      branch,
    })),
  );
}

/** Whether the entry works directly on its base branch (no working branch of its own). */
export function isDirect(repo: Pick<SessionRepo, "base" | "branch">): boolean {
  return repo.base === repo.branch;
}

/**
 * The preamble the app writes at the start of the instruction of a multi-repository turn (ADR 0006: the runner adds no list of repositories):
 * the repositories with their mount, base and branch, whether each branch is continued or made, and the rule that the work of a direct
 * repository goes to its base branch. Made from the stored resolution, so it is the same text on every turn of the session.
 */
export function preambleOf(
  repos: readonly Pick<SessionRepo, "fullName" | "name" | "base" | "branch">[],
  branchExists: readonly boolean[],
): string {
  const lines = [
    "This task works on several git repositories. Each one is a directory under /work (your working directory, which is not a repository itself); change into a repository to use git.",
    "",
  ];
  repos.forEach((repo, index) => {
    const where = `/work/${repo.name}`;
    lines.push(
      isDirect(repo)
        ? `- ${repo.fullName} at ${where}: work directly on its base branch "${repo.base}"; what you commit there is pushed to it when the task ends.`
        : branchExists[index] === true
          ? `- ${repo.fullName} at ${where}: base branch "${repo.base}"; the working branch "${repo.branch}" already exists and is checked out, continue on it.`
          : `- ${repo.fullName} at ${where}: base branch "${repo.base}"; the working branch "${repo.branch}" was made from it and is checked out.`,
    );
  });
  lines.push(
    "",
    "Commit your work in each repository you change. Everything you commit, on any branch of any of these repositories, is pushed when the task ends; you have no remote and no credential, so do not try to push.",
    "",
    "The task:",
    "",
  );
  return lines.join("\n");
}
