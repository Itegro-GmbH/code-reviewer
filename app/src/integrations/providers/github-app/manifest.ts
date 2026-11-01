// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App manifest (docs/decisions/0001-editions-setup-and-accounts.md, section 2.4): what the
// admin portal posts to GitHub so that creating the App is one click, and the list of what the App
// needs, which `docs/github-app.md` repeats for the manual way (a test keeps the two together).
//
// Every address in it is made from the configured public URL of the instance, never from a request
// header: the manifest decides where GitHub delivers webhooks and sends the person back, so a forged
// `Host` header must not be able to change it.
import type { CapabilitySet } from "../../../capabilities/capability.ts";
import type { ProductIdentity } from "../../../product-identity/identity.ts";
import { JOB_TOKEN_PERMISSIONS } from "./job-access.ts";

/** The paths of the app that GitHub is told about. */
export const GITHUB_APP_PATHS = {
  webhook: "/api/webhooks/github-app",
  /** Where GitHub sends the person back with the one-time code (the admin portal's data route). */
  manifestRedirect: "/api/admin/github/manifest/callback",
  /** The callback of the user authorization, which is the sign in with GitHub. */
  signInCallback: "/api/auth/callback/github",
  /** Where GitHub sends the person after an installation (the binding of installations to workspaces). */
  installationSetup: "/github/connected",
} as const;

/**
 * The repository permission the App itself needs for the check run of a review (#405): it creates and updates the
 * check run in the checks area of the pull request. Only the App's own token has it, never the token of a review
 * job (`JOB_TOKEN_PERMISSIONS`): the Worker does not write check runs. An installation or an App made by hand that
 * lacks it keeps reviewing; `missingPermissions` names it and no job fails because of it.
 */
export const CHECK_RUN_PERMISSIONS = { checks: "write" } as const;

/** The repository permissions of the App: what a review job gets, and the check runs the App writes itself. */
export const REPOSITORY_PERMISSIONS: Readonly<
  Record<string, "read" | "write">
> = { ...JOB_TOKEN_PERMISSIONS, ...CHECK_RUN_PERMISSIONS };

/**
 * What the Implementer changes in the repository permissions (#749): it pushes branches, so Contents is write instead of
 * read. Only a deployment with the capability `implementer` (the factory) asks for it; the manifest of code-review.com is
 * the one above, unchanged, and the App of the reviewer never holds write access to code.
 */
export const IMPLEMENTER_REPOSITORY_PERMISSIONS = {
  contents: "write",
} as const;

/**
 * The account permission "Email addresses": it lets a sign in with GitHub read the verified primary email
 * (`GET /user/emails`), which applies the sign-up rule and replaces the placeholder address of an imported
 * user.
 */
export const ACCOUNT_PERMISSIONS = { emails: "read" } as const;

/**
 * The organization permission "Members": it lets the binding of an installation read a person's role in
 * the organization with the user token of the App.
 */
export const ORGANIZATION_PERMISSIONS = { members: "read" } as const;

/** The events a person ticks. `installation` and `installation_repositories` are always sent. */
export const SUBSCRIBED_EVENTS = ["pull_request", "issue_comment"] as const;

/** Every permission the manifest asks for, in the flat form of `default_permissions`. */
export const MANIFEST_PERMISSIONS: Readonly<Record<string, "read" | "write">> =
  {
    ...REPOSITORY_PERMISSIONS,
    ...ACCOUNT_PERMISSIONS,
    ...ORGANIZATION_PERMISSIONS,
  };

/**
 * Every permission the manifest of a deployment asks for. `MANIFEST_PERMISSIONS` is the set without the Implementer;
 * the Implementer raises Contents to write and nothing else (the keys keep their order, so the only difference in the
 * text of the manifest is that level).
 */
export function manifestPermissions(
  capabilities: CapabilitySet,
): Readonly<Record<string, "read" | "write">> {
  return capabilities.has("implementer")
    ? { ...MANIFEST_PERMISSIONS, ...IMPLEMENTER_REPOSITORY_PERMISSIONS }
    : MANIFEST_PERMISSIONS;
}

export type GithubAppManifest = {
  name: string;
  url: string;
  hook_attributes: { url: string; active: true };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  setup_on_update: true;
  description: string;
  public: boolean;
  request_oauth_on_install: false;
  default_events: string[];
  default_permissions: Record<string, "read" | "write">;
};

/** GitHub's limit for the name of an App. */
export const APP_NAME_MAX_LENGTH = 34;

export type ManifestInput = {
  /** Who the App is for: what it says about itself on GitHub (`githubAppDescription`). */
  product: ProductIdentity;
  /** What the deployment offers: the permissions the App asks for follow it (#749). */
  capabilities: CapabilitySet;
  /** The configured public address of the instance (`BETTER_AUTH_URL`), an origin without a path. */
  publicUrl: string;
  /** Multi-tenant instances create a public App (anybody may install it), single-tenant a private one. */
  tenancy: "single" | "multi";
  name: string;
};

export function buildAppManifest({
  product,
  capabilities,
  publicUrl,
  tenancy,
  name,
}: ManifestInput): GithubAppManifest {
  const origin = publicUrl.replace(/\/+$/, "");
  return {
    name,
    url: origin,
    hook_attributes: {
      url: `${origin}${GITHUB_APP_PATHS.webhook}`,
      active: true,
    },
    redirect_url: `${origin}${GITHUB_APP_PATHS.manifestRedirect}`,
    callback_urls: [`${origin}${GITHUB_APP_PATHS.signInCallback}`],
    setup_url: `${origin}${GITHUB_APP_PATHS.installationSetup}`,
    setup_on_update: true,
    description: product.githubAppDescription,
    public: tenancy === "multi",
    request_oauth_on_install: false,
    default_events: [...SUBSCRIBED_EVENTS],
    default_permissions: { ...manifestPermissions(capabilities) },
  };
}

/**
 * The name the form starts with: the App name of the product (`githubAppName`) and the host of the deployment, cut to what
 * GitHub accepts. The admin can change it before creating the App.
 */
export function suggestedAppName(
  product: ProductIdentity,
  publicUrl: string,
): string {
  let host = "";
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    // No usable address: the plain name.
  }
  const base = product.githubAppName;
  const name = host === "" ? base : `${base} ${host}`;
  return name.slice(0, APP_NAME_MAX_LENGTH).trim();
}

const LEVELS = ["read", "write", "admin"];

/**
 * What an App lacks of what the manifest of this deployment asks for, by API permission name, given the `permissions`
 * object of `GET /app`. An App that was imported or made by hand may lack the repository permission "Checks", the account
 * permission "Email addresses" or the organization permission "Members", and in a deployment with the Implementer it
 * may hold Contents as read only (#749); the portal lists what to add in the App's settings. A level below the wanted
 * one counts as missing.
 */
export function missingPermissions(
  granted: Readonly<Record<string, unknown>>,
  capabilities: CapabilitySet,
): string[] {
  return Object.entries(manifestPermissions(capabilities))
    .filter(
      ([name, wanted]) =>
        LEVELS.indexOf(String(granted[name])) < LEVELS.indexOf(wanted),
    )
    .map(([name]) => name);
}
