// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy for everything that can go wrong when a person activates a project or runs the sync.
// The routes answer with stable codes; this is where a code becomes a sentence (the UI translates
// codes, never the other way round). A code written out in a sentence is a bug, so an unknown code
// gets a generic one.
import type { ProductIdentity } from "../../product-identity/identity.ts";
import type { SyncErrorCode } from "../../integrations/sync/errors.ts";
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  REQUEST_NOT_UNDERSTOOD,
} from "../../copy/messages.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import type { ProjectErrorCode } from "../errors.ts";

/** The one owner of the three project state wordings (#169): the list badge and the settings page. */
export const PROJECT_STATE_LABEL: Record<
  "active" | "inactive" | "unavailable",
  string
> = {
  active: "Active",
  inactive: "Inactive",
  unavailable: "Unavailable",
};

/** The badge tone of a state; a state is never told by colour alone, the label always stands next to it. */
export const PROJECT_STATE_BADGE: Record<
  "active" | "inactive" | "unavailable",
  "success" | "neutral" | "warning"
> = {
  active: "success",
  inactive: "neutral",
  unavailable: "warning",
};

/**
 * What the settings page says about a project that is not running reviews (#174). The state itself is
 * the badge next to the title; what it means for this page is a row of the one "Needs attention" strip.
 * An active project has no row.
 */
export const PROJECT_STATE_NOTICE: Record<
  "inactive" | "unavailable",
  { severity: "warning" | "error"; title: string; detail: string }
> = {
  inactive: {
    severity: "warning",
    title: "Project is inactive",
    detail:
      "No reviews run until the project is activated. You can save settings now; they apply once it is switched on.",
  },
  unavailable: {
    severity: "error",
    title: "Repository is unavailable",
    detail:
      "The GitHub App cannot read this repository any more. Its settings are kept.",
  },
};

const FAILURE_COPY: Record<ProjectErrorCode | SyncErrorCode, string> = {
  PROJECT_REQUEST_INVALID: REQUEST_NOT_UNDERSTOOD,
  PROJECT_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  PROJECT_BODY_TOO_LARGE:
    "The request was too large. Reload the page and try again.",
  PROJECT_CONTENT_TYPE_UNSUPPORTED: REQUEST_NOT_UNDERSTOOD,
  PROJECT_REPOSITORY_NOT_FOUND:
    "This repository does not exist any more. Reload the page.",
  PROJECT_REPOSITORY_UNAVAILABLE:
    "This repository is no longer available to the GitHub App, so it cannot be activated.",
  PROJECT_INTEGRATION_UNAVAILABLE:
    "The GitHub App installation of this repository is suspended or removed, so the repository cannot be activated.",
  PROJECT_ALREADY_EXISTS:
    "This repository is a project already. Reload the page to see it.",
  PROJECT_BOARDS_UNAVAILABLE:
    "GitHub could not be asked for the boards of this repository right now. Try again in a moment.",
  SYNC_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
};

function hasCopy(code: string): code is keyof typeof FAILURE_COPY {
  return Object.hasOwn(FAILURE_COPY, code);
}

/** The sentence for the code a route answered with (or a transport code). */
export function describeFailure(
  product: ProductIdentity,
  code: string,
): string {
  if (hasCopy(code)) return FAILURE_COPY[code];
  return describeTransportFailure(product, code) ?? GENERIC_FAILURE;
}

const GENERIC_SYNC_PROBLEM = "GitHub could not be read.";

// The codes of the GitHub App provider's errors, which the sync reports (it reports the code of the
// error it met). Spelled out here because the UI may not import a provider (src/integrations/README.md,
// "The boundary"); `providers/github-app/sync-copy.test.ts` compares this list with the provider's
// own, so a new provider code without copy fails there. An unlisted code gets the generic sentence.
export const SYNC_PROBLEM_CODES = [
  "GITHUB_APP_CONFIG_INVALID",
  "GITHUB_APP_AUTH_FAILED",
  "GITHUB_APP_FORBIDDEN",
  "GITHUB_APP_NOT_FOUND",
  "GITHUB_APP_RATE_LIMITED",
  "GITHUB_APP_UNAVAILABLE",
  "GITHUB_APP_REQUEST_FAILED",
] as const;
type SyncProblemCode = (typeof SYNC_PROBLEM_CODES)[number];

const SYNC_PROBLEM_COPY: Record<SyncProblemCode, string> = {
  GITHUB_APP_CONFIG_INVALID:
    "The GitHub App settings are incomplete or not valid, so GitHub could not be asked.",
  GITHUB_APP_AUTH_FAILED:
    "GitHub refused the app's credentials. Check the app ID and the private key.",
  GITHUB_APP_FORBIDDEN:
    "GitHub refused the request: the app lacks a permission or the installation is suspended.",
  GITHUB_APP_NOT_FOUND: "GitHub does not know the installation any more.",
  GITHUB_APP_RATE_LIMITED:
    "GitHub's rate limit is reached. Try again in a few minutes.",
  GITHUB_APP_UNAVAILABLE:
    "GitHub could not be reached or had a problem. Try again later.",
  GITHUB_APP_REQUEST_FAILED: "GitHub answered with something unexpected.",
};

/** The sentence for the stable code of one problem the sync reported; nothing is lost, only translated. */
export function describeSyncProblem(code: string): string {
  const known = SYNC_PROBLEM_CODES.find((candidate) => candidate === code);
  return known === undefined ? GENERIC_SYNC_PROBLEM : SYNC_PROBLEM_COPY[known];
}
