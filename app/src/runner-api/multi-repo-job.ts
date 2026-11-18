// SPDX-License-Identifier: LicenseRef-Proprietary

// The rules of a multi-repository job that JSON Schema cannot state (#1092, epic #1090, ADR 0006; the shared negative corpus is
// `contracts/examples/implementer-multi-repo/invalid/`, the runner's parser holds the same list). The claim builds a job and holds its
// own work to them before anything leaves (`checkMultiRepoJob`), so a rule of the contract broken by the app is the app's refusal and
// never a runner's `invalid_job`. Pure.
import { deriveMountNames } from "../db/session-repos.ts";

/** A JSON document edited by key (the corpus, the job as it is built). */
export type JobDocument = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a JSON document read by key; the rules read what the schema does not state

/** The rules of the job, by the name the corpus gives them. */
export const MULTI_REPO_JOB_RULES = [
  "token_id_repeated",
  "token_unresolved",
  "token_unused",
  "git_token_mismatch",
  "full_name_repeated",
  "mount_name_repeated",
  "mount_name_not_derived",
  "clone_url_host",
  "clone_url_path",
  "resume_names",
] as const;
export type MultiRepoJobRule = (typeof MULTI_REPO_JOB_RULES)[number];

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

/** The host a clone address must have for a git API address: `github.com` for `api.github.com`, else the host itself. */
function webHost(baseUrl: string): string {
  const host = new URL(baseUrl).host;
  return host === "api.github.com" ? "github.com" : host;
}

/**
 * The rule of the job a document breaks, or null. The order is fixed, so every implementation names the same rule for a document that
 * breaks several. A job without `implementer.repos` breaks none (it is the job of today).
 */
export function breakOfJobRule(job: JobDocument): MultiRepoJobRule | null {
  const implementer: JobDocument = job.implementer ?? {};
  const repos: JobDocument[] | undefined = implementer.repos;
  if (repos === undefined) return null;
  const tokens: JobDocument[] = job.git?.tokens ?? [];

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

  const resume: JobDocument[] | undefined = implementer.resume?.repos;
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
