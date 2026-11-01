// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub integration on the running server: the credential store and the portal's service over the
// server's database, with the master key from the environment. Server code only. Nothing is cached: every
// call reads the database, so a replaced credential counts from the next request on every instance.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { getCapabilities } from "../capabilities/shared.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { suggestedAppName } from "../integrations/registry.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { createSignedStates } from "../signed-state/state.ts";
import { readEmailConflicts } from "./facts.ts";
import {
  createGithubCredentialStore,
  type GithubCredentialStore,
} from "./credentials.ts";
import {
  createGithubConfigService,
  type GithubConfigService,
} from "./service.ts";

function appSecret(): string {
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  return resolved.secret;
}

export function getGithubCredentialStore(): GithubCredentialStore {
  return createGithubCredentialStore({
    db: getDatabase(),
    appSecret: appSecret(),
  });
}

/** Whether the GitHub App's user authorization can sign people in: a client id and a secret that can be read. */
export async function isGithubSignInConfigured(): Promise<boolean> {
  return (
    (await getGithubCredentialStore().load()).userAuthorization.state ===
    "configured"
  );
}

export function getGithubConfigService(): GithubConfigService {
  const db = getDatabase();
  // Every address the service uses comes from the configuration, never from a request header.
  const config = loadAuthConfig(process.env);
  return createGithubConfigService({
    product: getProductIdentity(),
    capabilities: getCapabilities(),
    credentials: getGithubCredentialStore(),
    signedStates: createSignedStates({ db, appSecret: appSecret() }),
    rateLimits: createRateLimitsRepository(db),
    publicUrl: config.baseUrl,
    tenancy: async () =>
      (await createInstanceSettingsRepository(db).get("tenancy")) ?? "single",
    webBaseUrl: config.github.oauthBaseUrl,
    apiBaseUrl: config.github.apiBaseUrl,
  });
}

/** What the Integrations pages show besides the integration itself: what could not be updated, the name the one-click form starts with and the tenancy. */
export async function getIntegrationsPageData() {
  const db = getDatabase();
  const config = loadAuthConfig(process.env);
  const [view, conflicts, tenancy] = await Promise.all([
    getGithubConfigService().view(),
    readEmailConflicts(db),
    createInstanceSettingsRepository(db).get("tenancy"),
  ]);
  return {
    view,
    conflicts,
    tenancy: tenancy ?? "single",
    suggestedName: suggestedAppName(getProductIdentity(), config.baseUrl),
  };
}
