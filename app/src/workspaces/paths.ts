// SPDX-License-Identifier: LicenseRef-Proprietary

// The addresses of a workspace (docs/decisions/0001-editions-setup-and-accounts.md, section 2.6): every
// workspace page lives below `/w/<slug>` and every data route of it below `/api/w/<slug>`. The workspace is
// in the address, not in a cookie or a header, because an address is what a link, a bookmark and a second
// browser tab carry with them: a deep link opens the workspace it names for any member, two tabs can work in
// two workspaces, and nothing the browser remembers can point a request at a workspace by accident. What
// the address names is never trusted: the slug is looked up among the memberships of the signed in person
// on every request (src/workspaces/access.ts), and a workspace they do not belong to answers exactly like
// one that does not exist.
//
// Pure functions, usable on the server and in the browser.
import type { CapabilitySet } from "../capabilities/capability.ts";
import { WORKSPACE_SLUG_MAX_LENGTH, WORKSPACE_SLUG_PATTERN } from "./names.ts";

/** Whether the text can be the slug of a workspace (the shape only; it says nothing about membership). */
export function isWorkspaceSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= WORKSPACE_SLUG_MAX_LENGTH &&
    WORKSPACE_SLUG_PATTERN.test(value)
  );
}

const PAGE_PREFIX = "/w/";
const API_PREFIX = "/api/w/";

/**
 * What the address of a request says about a workspace: the slug (`null` when the address below `/w/` or
 * `/api/w/` is not shaped like one), or `undefined` when the address is not a workspace address at all.
 * `/w/acme`, `/w/acme/runs`, `/api/w/acme/runs` all name `acme`; `/windows` and `/api/workspaces` name
 * nothing.
 */
export function workspaceSlugOfPath(
  pathname: string,
): string | null | undefined {
  for (const prefix of [PAGE_PREFIX, API_PREFIX]) {
    if (!pathname.startsWith(prefix)) continue;
    const rest = pathname.slice(prefix.length);
    const slash = rest.indexOf("/");
    const candidate = slash === -1 ? rest : rest.slice(0, slash);
    return isWorkspaceSlug(candidate) ? candidate : null;
  }
  return undefined;
}

/** `/w/<slug>` followed by `rest` (which starts with a slash, or is empty). */
export function workspacePath(slug: string, rest = ""): string {
  return `${PAGE_PREFIX}${slug}${rest}`;
}

/** `/api/w/<slug>` followed by `rest`. */
export function workspaceApiPath(slug: string, rest = ""): string {
  return `${API_PREFIX}${slug}${rest}`;
}

/**
 * Where an address from before the workspace was in the address leads, for the workspace `slug`: `/` is the
 * start page of the workspace, `/projects`, `/projects/<id>`, `/runs`, `/runs/<id>` and `/settings` are the
 * same page below `/w/<slug>`. `null` for any other address (also for a longer name that merely starts with
 * one of them). The rest of the address is carried as it came, so an encoded id stays encoded.
 */
export function legacyWorkspaceTarget(
  pathname: string,
  slug: string,
): string | null {
  if (pathname === "/") return workspaceHome(slug);
  for (const section of ["projects", "runs", "settings"]) {
    const root = `/${section}`;
    if (pathname === root || pathname.startsWith(`${root}/`))
      return workspacePath(slug, pathname);
  }
  return null;
}

/**
 * Where a workspace opens when no page is named: its projects, or, in a deployment without the `review` capability (which has no
 * projects, src/capabilities/), its connections. Without a set the deployment is code-review.com.
 */
export function workspaceHome(
  slug: string,
  capabilities?: CapabilitySet,
): string {
  const hasProjects = capabilities === undefined || capabilities.has("review");
  return workspacePath(slug, hasProjects ? "/projects" : "/connections");
}

/**
 * The page of a workspace that shows its connections, the GitHub App: the Integrations tab of the settings in the factory (#925),
 * `/connections` in every other deployment. Without a set the deployment is code-review.com.
 */
export function connectionsPlace(
  capabilities?: CapabilitySet,
): "/connections" | "/settings/integrations" {
  return capabilities?.has("implementer") === true
    ? "/settings/integrations"
    : "/connections";
}
