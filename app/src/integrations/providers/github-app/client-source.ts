// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub App's settings and HTTP client as the providers of this folder share them (#1035): the git provider (`provider.ts`) and the
// ticket provider (`ticket-provider.ts`) are two faces of one installation, so they read the settings and keep the client in one place.
import { createHash } from "node:crypto";
import type { CapabilitySet } from "../../../capabilities/capability.ts";
import {
  createGithubAppClient,
  type GithubAppClient,
  type GithubAppClientOptions,
} from "./client.ts";
import type { GithubAppConfig } from "./config.ts";

export type GithubAppProviderOptions = {
  /**
   * The settings, or a function that reads them. The provider is created when the app loads, so a
   * missing setting must not break anything else: it fails the call that needs GitHub, with
   * GITHUB_APP_CONFIG_INVALID, and works again once the settings are fixed. A function is asked on
   * every call and its answer is not remembered: a webhook secret or a key that the admin replaced
   * counts from the next request on, on every app instance (docs/decisions/0001-editions-setup-and-
   * accounts.md, section 2.10). Only the HTTP client is kept, for as long as the settings it was made
   * for are the settings in force.
   */
  config: GithubAppConfig | (() => GithubAppConfig | Promise<GithubAppConfig>);
  /** Replaces the HTTP client; for unit tests. */
  client?: GithubAppClient;
  /** Passed to the default client (a different fetch, clock or timeout). */
  clientOptions?: Omit<GithubAppClientOptions, "config">;
  /**
   * The capabilities of the deployment (#753), asked on every call. The token of the Implementer is made only where
   * `allowsReviewKind("implementer")` holds; left out, none is: the default is closed, so a provider wired without it, or a
   * deployment of another product (code-review.com) whose App was set to write by hand, can never mint a write token.
   */
  capabilities?: () => CapabilitySet;
};

/** What every call of a provider of this folder reads the App's settings and client from. */
export type GithubClientSource = {
  getConfig(): Promise<GithubAppConfig>;
  getClient(): Promise<GithubAppClient>;
};

export function createGithubClientSource(
  options: Pick<
    GithubAppProviderOptions,
    "config" | "client" | "clientOptions"
  >,
): GithubClientSource {
  let resolvedClient:
    { fingerprint: string; client: GithubAppClient } | undefined;

  async function getConfig(): Promise<GithubAppConfig> {
    return typeof options.config === "function"
      ? await options.config()
      : options.config;
  }

  // What the client was made from. The key is hashed, so nothing secret is kept as a string.
  function fingerprintOf(config: GithubAppConfig): string {
    return [
      config.appId,
      config.slug,
      config.apiBaseUrl,
      createHash("sha256").update(config.privateKey).digest("hex"),
    ].join("\n");
  }

  async function getClient(): Promise<GithubAppClient> {
    // Reading the settings first makes an injected client fail like the real one when they are bad.
    const config = await getConfig();
    if (options.client) return options.client;
    const fingerprint = fingerprintOf(config);
    if (resolvedClient?.fingerprint !== fingerprint)
      resolvedClient = {
        fingerprint,
        client: createGithubAppClient({ ...options.clientOptions, config }),
      };
    return resolvedClient.client;
  }

  return { getConfig, getClient };
}
