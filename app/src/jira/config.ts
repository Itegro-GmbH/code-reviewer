// SPDX-License-Identifier: LicenseRef-Proprietary

// The settings of the Jira Cloud connection (#1037, epic #1034): the client id and secret of the factory's own Atlassian app
// (OAuth 2.0 3LO), read from the environment (Infisical in a deployment), the scopes it asks for and the addresses of Atlassian.
// Without both values the feature is off: the settings page offers no "Connect Jira" and every route answers `jira_not_configured`.
// Names and stable problems only, never a value: the secret is a secret, and a wrong value may be one pasted into the wrong place.
// Pure (the environment is passed in), so the server, the start-up check and the tests read it the same way.
import { resolveGithubEndpoint } from "../github-endpoints.ts";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The scopes the app asks for (classic scopes of Atlassian's OAuth 2.0 3LO; the same list is in `docs/jira-cloud-setup.md` and must be
 * enabled on the app in the developer console):
 * - `read:jira-work`, `write:jira-work`: read and change issues, comments, transitions and the projects around them;
 * - `manage:jira-webhook`: register and refresh the webhooks of a site (#1039; the factory registers them itself);
 * - `read:me`: the name of the account that granted the app, for the settings page;
 * - `offline_access`: the refresh token, so the connection outlives the one hour of an access token.
 */
export const JIRA_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "manage:jira-webhook",
  "read:me",
  "offline_access",
] as const;

/** Where Atlassian sends the browser back: `<BETTER_AUTH_URL>` plus this path is the "Callback URL" of the Atlassian app. */
export const JIRA_CALLBACK_PATH = "/api/jira/callback";

/** The real Atlassian: the consent and the token endpoint, and the API gateway. */
export const ATLASSIAN_AUTH_URL = "https://auth.atlassian.com";
export const ATLASSIAN_API_URL = "https://api.atlassian.com";

export const ATLASSIAN_CLIENT_ID_VARIABLE = "ATLASSIAN_CLIENT_ID";
export const ATLASSIAN_CLIENT_SECRET_VARIABLE = "ATLASSIAN_CLIENT_SECRET";
export const ATLASSIAN_AUTH_BASE_URL_VARIABLE = "ATLASSIAN_AUTH_BASE_URL";
export const ATLASSIAN_API_BASE_URL_VARIABLE = "ATLASSIAN_API_BASE_URL";
export const ALLOW_TEST_ATLASSIAN_ENDPOINTS_VARIABLE =
  "ALLOW_TEST_ATLASSIAN_ENDPOINTS";

export type AtlassianConfig =
  | {
      configured: true;
      clientId: string;
      clientSecret: string;
      authBaseUrl: string;
      apiBaseUrl: string;
    }
  | {
      configured: false;
      /** `missing`: not set (or one of the two). `invalid`: set but not usable (an address that is not allowed). */
      kind: "missing" | "invalid";
      /** Names of variables, never values. */
      variables: readonly string[];
    };

function valueOf(env: Env, name: string): string | undefined {
  const text = env[name]?.trim();
  return text === undefined || text === "" ? undefined : text;
}

/**
 * The address problems of the environment, as variable names. An address other than the real Atlassian is only accepted together
 * with `ALLOW_TEST_ATLASSIAN_ENDPOINTS=true` (the client secret and the tokens are sent to it), like the GitHub addresses.
 */
function endpointProblems(env: Env): string[] {
  const allowed =
    valueOf(env, ALLOW_TEST_ATLASSIAN_ENDPOINTS_VARIABLE) === "true";
  const problems: string[] = [];
  for (const [name, fallback] of [
    [ATLASSIAN_AUTH_BASE_URL_VARIABLE, ATLASSIAN_AUTH_URL],
    [ATLASSIAN_API_BASE_URL_VARIABLE, ATLASSIAN_API_URL],
  ] as const)
    if (!resolveGithubEndpoint(env[name], fallback, allowed).ok)
      problems.push(name);
  return problems;
}

export function readAtlassianConfig(env: Env): AtlassianConfig {
  const clientId = valueOf(env, ATLASSIAN_CLIENT_ID_VARIABLE);
  const clientSecret = valueOf(env, ATLASSIAN_CLIENT_SECRET_VARIABLE);
  if (clientId === undefined || clientSecret === undefined)
    return {
      configured: false,
      kind: "missing",
      variables: [
        ...(clientId === undefined ? [ATLASSIAN_CLIENT_ID_VARIABLE] : []),
        ...(clientSecret === undefined
          ? [ATLASSIAN_CLIENT_SECRET_VARIABLE]
          : []),
      ],
    };
  const problems = endpointProblems(env);
  if (problems.length > 0)
    return { configured: false, kind: "invalid", variables: problems };
  const allowed =
    valueOf(env, ALLOW_TEST_ATLASSIAN_ENDPOINTS_VARIABLE) === "true";
  const resolve = (name: string, fallback: string): string => {
    const resolved = resolveGithubEndpoint(env[name], fallback, allowed);
    return resolved.ok ? resolved.url : fallback;
  };
  return {
    configured: true,
    clientId,
    clientSecret,
    authBaseUrl: resolve(ATLASSIAN_AUTH_BASE_URL_VARIABLE, ATLASSIAN_AUTH_URL),
    apiBaseUrl: resolve(ATLASSIAN_API_BASE_URL_VARIABLE, ATLASSIAN_API_URL),
  };
}

/** The callback address of the Atlassian app: made from the configured public address of the app, never from a header. */
export function jiraCallbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${JIRA_CALLBACK_PATH}`;
}

/**
 * The start-up problems of the settings, naming variables only. The feature is optional: no variable at all is fine (it is off),
 * but one of the two without the other, or an address that is not allowed, stops the start, because the person who set it meant
 * it to work.
 */
export function atlassianConfigProblems(env: Env): string[] {
  const clientId = valueOf(env, ATLASSIAN_CLIENT_ID_VARIABLE);
  const clientSecret = valueOf(env, ATLASSIAN_CLIENT_SECRET_VARIABLE);
  const problems: string[] = [];
  if ((clientId === undefined) !== (clientSecret === undefined))
    problems.push(
      `${clientId === undefined ? ATLASSIAN_CLIENT_ID_VARIABLE : ATLASSIAN_CLIENT_SECRET_VARIABLE} is not set, but ${clientId === undefined ? ATLASSIAN_CLIENT_SECRET_VARIABLE : ATLASSIAN_CLIENT_ID_VARIABLE} is: Jira needs both`,
    );
  for (const name of endpointProblems(env))
    problems.push(
      `${name} is not the real Atlassian address and ${ALLOW_TEST_ATLASSIAN_ENDPOINTS_VARIABLE} is not true`,
    );
  return problems;
}

/** The one start line about Jira: whether it is on. Names variables, never a value. */
export function jiraStateLine(env: Env): string {
  const config = readAtlassianConfig(env);
  return config.configured
    ? "[jira] on."
    : `[jira] off: ${config.variables.join(", ")} ${config.kind === "missing" ? "not set" : "not usable"}.`;
}
