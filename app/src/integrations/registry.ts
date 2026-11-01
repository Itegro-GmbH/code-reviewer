// SPDX-License-Identifier: LicenseRef-Proprietary

// Maps an integration type to its provider. The only module (besides the providers themselves) that
// is allowed to import a provider implementation; everything else asks the registry or uses the
// IntegrationProvider interface. See README.md in this folder.
import "server-only";
import { IntegrationError } from "./errors.ts";
import { GithubAppConfigError } from "./providers/github-app/errors.ts";
import type { IntegrationProvider } from "./provider.ts";
import type { GithubAppConfig } from "./providers/github-app/config.ts";
import { createGithubAppProvider } from "./providers/github-app/provider.ts";
import type { CapabilitySet } from "../capabilities/capability.ts";
import { getCapabilities } from "../capabilities/shared.ts";
import type { GithubAppClientOptions } from "./providers/github-app/client.ts";

import {
  INTEGRATION_TYPES,
  isIntegrationType,
  isReservedIntegrationType,
  type IntegrationType,
} from "./types.ts";

export type IntegrationRegistry = {
  /** The provider for a stored or user supplied type; throws an IntegrationError with a code. */
  resolve(type: unknown): IntegrationProvider;
  registeredTypes(): IntegrationType[];
};

export function createIntegrationRegistry(
  providers: Partial<Record<IntegrationType, IntegrationProvider>>,
): IntegrationRegistry {
  for (const [key, provider] of Object.entries(providers)) {
    if (provider !== undefined && provider.type !== key)
      throw new Error(
        `Provider registered as "${key}" declares the type "${provider.type}".`,
      );
  }

  return {
    resolve(type) {
      if (isReservedIntegrationType(type))
        throw new IntegrationError(
          "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
          `The integration type "${type}" is reserved but not implemented yet.`,
        );
      if (!isIntegrationType(type))
        throw new IntegrationError(
          "INTEGRATION_TYPE_UNKNOWN",
          `Unknown integration type "${String(type)}".`,
        );
      const provider = providers[type];
      if (provider === undefined)
        throw new IntegrationError(
          "INTEGRATION_PROVIDER_NOT_IMPLEMENTED",
          `No provider is registered for the integration type "${type}".`,
        );
      return provider;
    },

    registeredTypes() {
      return INTEGRATION_TYPES.filter((type) => providers[type] !== undefined);
    },
  };
}

// What the rest of the app may know about the GitHub App: the rest of the app reaches the provider folder
// through this file only.
export {
  githubAppInstallPageUrl,
  githubAppInstallUrlFor,
} from "./providers/github-app/setup-status.ts";
// The calls made with a person's own GitHub token (the binding of an installation to a workspace).
export {
  listUserInstallations,
  readOrganizationRole,
  readUser,
  type GithubUser,
  type OrganizationRole,
  type UserInstallation,
  type UserRequestFailure,
  type UserRequestOptions,
} from "./providers/github-app/user-requests.ts";
export { GithubAppConfigError };
export {
  loadGithubAppConfig,
  normalizePemKey,
  isUsableRsaKey,
  DEFAULT_GITHUB_API_BASE_URL,
  type GithubAppConfig,
} from "./providers/github-app/config.ts";
export {
  buildAppManifest,
  GITHUB_APP_PATHS,
  MANIFEST_PERMISSIONS,
  manifestPermissions,
  missingPermissions,
  suggestedAppName,
  type GithubAppManifest,
} from "./providers/github-app/manifest.ts";
export {
  checkClientCredentials,
  convertManifestCode,
  verifyGithubApp,
  type ConvertedApp,
  type ManifestConversionErrorCode,
  type VerifyAppErrorCode,
} from "./providers/github-app/app-requests.ts";

export type DefaultRegistryOptions = {
  /** Reads the GitHub App settings. Overrides the running server's database loader. */
  loadConfig?: () => Promise<GithubAppConfig> | GithubAppConfig;
  /** For tests: a different fetch, clock or request timeout for the GitHub client. */
  githubClient?: Omit<GithubAppClientOptions, "config">;
  /**
   * The capabilities of the deployment the GitHub provider checks before it makes the token of the Implementer (#753).
   * Default: those of the running server (`PRODUCT_ID`, `PRODUCT_CAPABILITIES`), read on every call.
   */
  capabilities?: () => CapabilitySet;
};

/**
 * The credentials of the GitHub App as the running server has them: the database.
 */
async function loadServerGithubAppConfig(): Promise<GithubAppConfig> {
  // Imported here, not at the top: the credential store builds on this file.
  const { getGithubCredentialStore } =
    await import("../github-config/shared.ts");
  const snapshot = await getGithubCredentialStore().load();
  if (snapshot.app.ok) return snapshot.app.config;
  throw new GithubAppConfigError(snapshot.app.fields, snapshot.app.kind);
}

/**
 * The registry of this app: the GitHub App provider. The settings are read every time GitHub is used, not
 * when the app loads and not once: a missing setting fails that call with GITHUB_APP_CONFIG_INVALID and
 * breaks nothing else, and a webhook secret or key that was replaced counts from the next call.
 */
export function createDefaultIntegrationRegistry(
  options: DefaultRegistryOptions = {},
): IntegrationRegistry {
  const config = options.loadConfig ?? loadServerGithubAppConfig;
  return createIntegrationRegistry({
    github_app: createGithubAppProvider({
      config,
      capabilities: options.capabilities ?? (() => getCapabilities()),
      ...(options.githubClient === undefined
        ? {}
        : { clientOptions: options.githubClient }),
    }),
  });
}

// The MVP has exactly one provider, the GitHub App. A new provider adds its entry above and nowhere
// else.
export const integrationRegistry = createDefaultIntegrationRegistry();
