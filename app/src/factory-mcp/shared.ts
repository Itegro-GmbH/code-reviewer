// SPDX-License-Identifier: LicenseRef-Proprietary

// The factory MCP on the running server (#1144): the real database, the address of the app, the capabilities of the deployment and the
// tools. Routes and pages ask for the pieces here; tests build their own (`oauth/test-harness.ts`). Everything is made when it is asked
// for, never when the module is loaded, because the database is only opened once the server runs.
import "server-only";
import { loadAuthConfig } from "../auth/config.ts";
import { currentLookup } from "../auth/session.ts";
import { getCapabilities } from "../capabilities/shared.ts";
import { createFactoryOAuthDirectoryRepository } from "../db/repositories/factory-oauth-directory-repository.ts";
import { createFactoryOAuthRepository } from "../db/repositories/factory-oauth-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createWorkspacesRepository } from "../db/repositories/workspaces-repository.ts";
import { getDatabase } from "../db/startup.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { createConnectedAppsHandlers } from "./apps/http.ts";
import { createConnectedAppsService } from "./apps/service.ts";
import { createMcpEndpoint } from "./endpoint/handler.ts";
import { createOAuthHandlers } from "./oauth/http.ts";
import { resourceOf } from "./oauth/metadata.ts";
import { createRegistrationLimiter } from "./oauth/registration-limit.ts";
import { createOAuthService, type OAuthService } from "./oauth/service.ts";
import type { OAuthStore } from "./oauth/store.ts";
import { ALL_TOOLS } from "./tools/all.ts";
import { createToolRegistry } from "./tools/registry.ts";

const registry = createToolRegistry(ALL_TOOLS);

function baseUrl(): string {
  return loadAuthConfig(process.env).baseUrl;
}

function store(): OAuthStore {
  const db = getDatabase();
  return {
    directory: createFactoryOAuthDirectoryRepository(db),
    scoped: (workspaceId) => createFactoryOAuthRepository(db, workspaceId),
  };
}

export function getOAuthService(): OAuthService {
  const address = baseUrl();
  return createOAuthService({
    store: store(),
    memberships: createWorkspacesRepository(getDatabase()),
    config: { issuer: address, resource: resourceOf(address) },
  });
}

export function getOAuthHandlers() {
  const address = baseUrl();
  return createOAuthHandlers({
    service: getOAuthService(),
    baseUrl: address,
    allowRegistration: createRegistrationLimiter(
      createRateLimitsRepository(getDatabase()),
    ),
    currentUser: async () => {
      const lookup = await currentLookup();
      return lookup.kind === "user" ? lookup.user : null;
    },
  });
}

export function getMcpEndpoint() {
  return createMcpEndpoint({
    service: getOAuthService(),
    registry,
    baseUrl: baseUrl(),
    database: getDatabase,
    environment: {
      productName: getProductIdentity().name,
      capabilities: getCapabilities().list(),
    },
  });
}

export function getConnectedAppsService() {
  const db = getDatabase();
  return createConnectedAppsService({
    grantsOf: (workspaceId) => createFactoryOAuthRepository(db, workspaceId),
  });
}

export function getConnectedAppsHandlers() {
  return createConnectedAppsHandlers(getConnectedAppsService());
}
