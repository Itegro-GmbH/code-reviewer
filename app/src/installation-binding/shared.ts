// SPDX-License-Identifier: LicenseRef-Proprietary

// The binding of installations on the running server: the real database, the registry, the process-wide
// synchronization (whose lock the binding shares), the credentials of the GitHub App as the admin saved them
// (read per call) and the master key from the environment. Server code only.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { getCapabilities } from "../capabilities/shared.ts";
import { resolveAppSecret } from "../crypto/app-secret.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getGithubCredentialStore } from "../github-config/shared.ts";
import { sessionOfRequest } from "../github-signin/shared.ts";
import { lookupSessionId } from "../auth/session.ts";
import { integrationRegistry } from "../integrations/registry.ts";
import { getIntegrationSync } from "../integrations/sync/shared.ts";
import { purposeOfState } from "../signed-state/state.ts";
import {
  assembleInstallationBinding,
  bindingTenancy,
  type AssembledBinding,
} from "./assemble.ts";
import { hitBindingLimit } from "./rate-limits.ts";
import {
  createBindingRouteHandlers,
  type BindingRouteHandlers,
} from "./http.ts";

function appSecret(): string {
  const resolved = resolveAppSecret(process.env);
  // The server does not start without it (src/auth/startup.ts); this is the second line.
  if (!resolved.ok) throw new Error(resolved.problem);
  return resolved.secret;
}

export function getInstallationBinding(): AssembledBinding {
  const db = getDatabase();
  const config = loadAuthConfig(process.env);
  return assembleInstallationBinding({
    db,
    registry: integrationRegistry,
    sync: getIntegrationSync(),
    appSecret: appSecret(),
    publicUrl: config.baseUrl,
    oauthBaseUrl: config.github.oauthBaseUrl,
    apiBaseUrl: config.github.apiBaseUrl,
    github: async () => {
      const snapshot = await getGithubCredentialStore().load();
      const { userAuthorization } = snapshot;
      return {
        slug: snapshot.slug,
        userAuthorization:
          userAuthorization.state === "configured"
            ? {
                clientId: userAuthorization.clientId,
                clientSecret: userAuthorization.clientSecret.reveal(),
              }
            : null,
      };
    },
    tenancy: () => bindingTenancy(db),
  });
}

export function getBindingRouteHandlers(): BindingRouteHandlers {
  const db = getDatabase();
  const secret = appSecret();
  const { service, connections } = getInstallationBinding();
  return createBindingRouteHandlers({
    service,
    connections,
    sync: getIntegrationSync(),
    sessionId: lookupSessionId,
    session: sessionOfRequest,
    workspaceSlug: async (workspaceId) =>
      (await createWorkspacesRepository(db).get(workspaceId))?.slug ?? null,
    syncLimit: (userId) =>
      hitBindingLimit(
        createRateLimitsRepository(db),
        "sync",
        userId,
        new Date(),
      ),
    isAuthorizationState: (state) =>
      purposeOfState(secret, state) === "github-authorize",
    capabilities: () => getCapabilities(),
  });
}
