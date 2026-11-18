// SPDX-License-Identifier: LicenseRef-Proprietary

// #1091 (epic #1090, ADR 0006): the rules of a multi-repository job that JSON Schema cannot state, as a small reference
// implementation for the shared negative corpus (contracts/examples/implementer-multi-repo/invalid/). The real checks are the
// app's lane validation and claim (#1092) and the runner's parser (#1093); they must reject every case of the corpus with the same
// rule. The Python twin is runner/tests/contract/multi_repo_rules.py: change both together.

/** A JSON document edited by key. */
export type Document = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document edited by key in a test

/** The names the work volume uses itself (and `.git`, which would make `/work` a repository): never a mount name as they are. */
const RESERVED_MOUNT_NAMES = new Set(["result", "reserve", ".git"]);

/**
 * The mount name of every repository of a job, from the `fullName`s alone: the name part, or `<owner>__<name>` for every
 * repository whose name part another one has too (without regard to case) and for a reserved name part.
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

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function webHost(baseUrl: string): string {
  const host = new URL(baseUrl).host;
  return host === "api.github.com" ? "github.com" : host;
}

/** The rule of the job a document breaks, or null. The order is fixed, so every implementation names the same rule. */
export function breakOfJobRule(job: Document): string | null {
  const implementer: Document = job.implementer ?? {};
  const repos: Document[] | undefined = implementer.repos;
  if (repos === undefined) return null;
  const tokens: Document[] = job.git?.tokens ?? [];

  if (duplicates(tokens.map((token) => String(token.id))))
    return "token_id_repeated";
  const ids = new Set(tokens.map((token) => String(token.id)));
  if (repos.some((repo) => !ids.has(String(repo.tokenId))))
    return "token_unresolved";
  const used = new Set(repos.map((repo) => String(repo.tokenId)));
  if (tokens.some((token) => !used.has(String(token.id))))
    return "token_unused";
  const first = tokens.find((token) => token.id === repos[0]?.tokenId);
  if (first === undefined || first.token !== job.git?.token)
    return "git_token_mismatch";

  if (duplicates(repos.map((repo) => String(repo.fullName).toLowerCase())))
    return "full_name_repeated";
  if (duplicates(repos.map((repo) => String(repo.name).toLowerCase())))
    return "mount_name_repeated";
  const derived = deriveMountNames(repos.map((repo) => String(repo.fullName)));
  if (repos.some((repo, index) => repo.name !== derived[index]))
    return "mount_name_not_derived";

  const host = webHost(String(job.git?.baseUrl));
  for (const repo of repos) {
    let url: URL;
    try {
      url = new URL(String(repo.cloneUrl));
    } catch {
      return "clone_url_host";
    }
    if (url.host !== host) return "clone_url_host";
    if (![`/${repo.fullName}`, `/${repo.fullName}.git`].includes(url.pathname))
      return "clone_url_path";
  }

  const resume: Document[] | undefined = implementer.resume?.repos;
  if (resume !== undefined) {
    const names = resume.map((entry) => entry.name);
    if (
      names.length !== repos.length ||
      names.some((name, index) => name !== repos[index]?.name)
    )
      return "resume_names";
  }
  return null;
}

/** The code a lane step with `repos` breaks that the schema cannot state, from its literal repositories, or null. */
export function breakOfLaneRule(step: Document): string | null {
  const repos: Document[] = step.repos ?? [];
  const literals = repos
    .map((entry) => String(entry.repo))
    .filter((repo) => !repo.includes("{{"));
  if (duplicates(literals.map((repo) => repo.toLowerCase())))
    return "repo_duplicate";
  if (literals.length === repos.length)
    if (
      duplicates(deriveMountNames(literals).map((name) => name.toLowerCase()))
    )
      return "repo_name_clash";
  return null;
}

function pointer(path: string): string[] {
  return path
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** A minimal RFC 6902 patch (add, replace, remove; `-` appends) of a copy of `document`. */
export function applyPatch(
  document: Document,
  patch: ReadonlyArray<{ op: string; path: string; value?: unknown }>,
): Document {
  const result = structuredClone(document);
  for (const { op, path, value } of patch) {
    const keys = pointer(path);
    const last = keys.pop() as string;
    let parent: any = result; // eslint-disable-line @typescript-eslint/no-explicit-any -- walks a JSON document by pointer
    for (const key of keys) parent = parent[key];
    if (Array.isArray(parent)) {
      const index = last === "-" ? parent.length : Number(last);
      if (op === "add") parent.splice(index, 0, value);
      else if (op === "replace") parent[index] = value;
      else if (op === "remove") parent.splice(index, 1);
      else throw new Error(`unknown patch operation ${op}`);
    } else if (op === "remove") delete parent[last];
    else if (op === "add" || op === "replace") parent[last] = value;
    else throw new Error(`unknown patch operation ${op}`);
  }
  return result;
}
