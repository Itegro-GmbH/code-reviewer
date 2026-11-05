// SPDX-License-Identifier: LicenseRef-Proprietary

// The one place a workflow page makes a link from a value an action returned (#873). A step's output is data from outside the page (the
// connector of an action fills it from what GitHub answered), so a link is made only when the value is an address on github.com that
// belongs to the repository of the run: `https://github.com/<owner>/<name>` or below it. The address is parsed with `new URL` and the
// link is the parsed, normalised form; anything else (another host, another repository, `javascript:`, `data:`, a user name or port in
// the address, text that is no address) gives `undefined`, and the page shows the value as text.

const GITHUB_HOST = "github.com";

/** Whether the text is a plain `owner/name` of a repository. */
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * The address to link to, or undefined. `repository` is the `owner/name` of the run; its case is ignored, as GitHub ignores it.
 */
export function githubLinkInRepository(
  value: unknown,
  repository: string | undefined,
): string | undefined {
  if (typeof value !== "string" || repository === undefined) return undefined;
  if (!REPOSITORY.test(repository)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== GITHUB_HOST)
    return undefined;
  if (url.username !== "" || url.password !== "" || url.port !== "")
    return undefined;
  const base = `/${repository}`.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (path !== base && !path.startsWith(`${base}/`)) return undefined;
  return url.href;
}

/** The address of a branch of the repository, or undefined when the repository or the branch name is not usable. */
export function githubBranchLink(
  repository: string | undefined,
  branch: unknown,
): string | undefined {
  if (typeof branch !== "string" || branch === "") return undefined;
  if (repository === undefined || !REPOSITORY.test(repository))
    return undefined;
  const segments = branch.split("/");
  // A git branch has no empty or dot segment; one that does would be read by the URL parser as a way out of `tree/`.
  if (segments.some((s) => s === "" || s === "." || s === ".."))
    return undefined;
  const path = segments.map(encodeURIComponent).join("/");
  return githubLinkInRepository(
    `https://${GITHUB_HOST}/${repository}/tree/${path}`,
    repository,
  );
}
