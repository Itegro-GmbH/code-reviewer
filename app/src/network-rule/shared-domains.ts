// SPDX-License-Identifier: LicenseRef-Proprietary

/**
 * #1176: kept only for the release skew: the claim refuses `open` and a wildcard on one of these domains for a caller whose Worker has no door for the token
 * (`implementer_subscription_door`); the validator no longer refuses them. Can go once every Worker image has the feature.
 *
 * #1126 (ADR 0007, decision 11 as amended): a `*.suffix` entry in the network rule of a step on the harness `claude-code` is refused
 * when the suffix is a domain whose subdomains anybody can get (user content, hosting, a public suffix): the login lives in the
 * container, so such an entry would let a `GET` carry it to any tenant's host. An exact host on these domains
 * (`raw.githubusercontent.com`) stays the owner's choice, like any host the list names.
 *
 * Small on purpose: the common cases, not the Public Suffix List. The runner keeps the same list
 * (`runner/src/code_reviewer_runner/implementer/claude_code/gates.py`, `SHARED_SUFFIXES`); a test on each side pins it, and the
 * runner is the wall that decides (it fails closed, free, before a container exists).
 */
export const SHARED_SUFFIXES: readonly string[] = [
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "bitbucket.io",
  "pages.dev",
  "workers.dev",
  "r2.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "onrender.com",
  "fly.dev",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "blogspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "amazonaws.com",
  "glitch.me",
  "repl.co",
  "ngrok.io",
  "surge.sh",
];

/** `co.uk`, `com.au`: a second-level public suffix of a country, which a `*.` entry would cover whole. */
const COUNTRY_SECOND_LEVEL = /^(co|com|org|net|ac|gov|edu)\.[a-z]{2}$/;

/** Whether a normalised host entry (`normalizeHostEntry`) is a `*.` entry on a shared domain. */
export function isSharedWildcard(entry: string): boolean {
  if (!entry.startsWith("*.")) return false;
  const base = entry.slice(2);
  return SHARED_SUFFIXES.includes(base) || COUNTRY_SECOND_LEVEL.test(base);
}
