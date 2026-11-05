// SPDX-License-Identifier: LicenseRef-Proprietary

// Everything a test of the synchronization needs: a real Postgres database, the registry with the real
// GitHub App provider and client, the fake GitHub API behind it, and `deliver`, which does what the
// webhook route does with a delivery (verify, identify, find the row, translate, hand over).
import {
  webhookDelivery,
  webhookFixture,
} from "../../../fakes/github/webhooks.ts";
import { createIntegrationDirectory } from "../db/repositories/integration-directory-repository.ts";
import { createIntegrationsRepository } from "../db/repositories/integrations-repository.ts";
import { createRepositoriesRepository } from "../db/repositories/repositories-repository.ts";
import { createGithubCredentialStore } from "../github-config/credentials.ts";
import type { GithubAppConfig } from "../integrations/registry.ts";
import { createDefaultIntegrationRegistry } from "../integrations/registry.ts";
import { loadGithubAppConfig } from "../integrations/registry.ts";
import {
  createIntegrationSync,
  type InstallationChangeResult,
} from "../integrations/sync/service.ts";
import { TEST_WEBHOOK_SECRET } from "./github-app.ts";
import { defaultWorkspaceId } from "./workspaces.ts";
import { startGithubAppHarness } from "./github-app-harness.ts";
import { createTestDatabase } from "./test-database.ts";
import { insertUser } from "./users.ts";

export async function startSyncHarness(
  options: {
    requestTimeoutMs?: number;
    /** Replaces or (with undefined) removes GitHub App variables. */
    env?: Record<string, string | undefined>;
    /**
     * Keeps the GitHub App only in the database, as the admin portal saves it (the encrypted secret store and
     * the settings), and removes every GitHub App variable: the provider then reads what the running server
     * reads, per request, from the credential store.
     */
    credentialsFromDatabase?: boolean;
    /** The most connections the pool of the database opens; default: the test database's. */
    poolMax?: number;
  } = {},
) {
  const github = await startGithubAppHarness();
  Object.assign(github.env, options.env);
  const { db } = await createTestDatabase(
    options.poolMax === undefined ? {} : { poolMax: options.poolMax },
  );
  let loadConfig: (() => Promise<GithubAppConfig>) | undefined;
  if (options.credentialsFromDatabase === true) {
    const appEnv = { ...github.env };
    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_SLUG",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GITHUB_APP_WEBHOOK_SECRET",
    ])
      delete github.env[name];
    await insertUser(db, { id: "portal-admin", isInstanceAdmin: true });
    const store = createGithubCredentialStore({
      db,
      appSecret: appEnv.APP_SECRET ?? "",
      env: github.env,
    });
    await store.persistApp({
      actorId: "portal-admin",
      stored: {
        appId: appEnv.GITHUB_APP_ID ?? "",
        slug: appEnv.GITHUB_APP_SLUG ?? "",
        clientId: null,
        privateApp: true,
        origin: "manual",
      },
      privateKey: appEnv.GITHUB_APP_PRIVATE_KEY ?? "",
      webhookSecret: appEnv.GITHUB_APP_WEBHOOK_SECRET ?? "",
      clientSecret: { kind: "keep" },
    });
    loadConfig = async () => {
      const loaded = await store.load();
      if (!loaded.app.ok) throw new Error("The GitHub App is not configured.");
      return loaded.app.config;
    };
  }
  const registry = createDefaultIntegrationRegistry({
    loadConfig: loadConfig ?? (() => loadGithubAppConfig(github.env)),
    githubClient: {
      now: github.clock.now,
      requestTimeoutMs: options.requestTimeoutMs ?? 5000,
    },
  });
  const logged: string[] = [];
  const workspaceId = await defaultWorkspaceId(db);
  const sync = createIntegrationSync({
    db,
    registry,
    log: (line) => logged.push(line),
    // These tests are about the synchronization itself: a connection that is new to the instance goes to the
    // default workspace. Where a new installation may go for real (src/installation-binding/placement.ts) is
    // proven by the binding's own tests.
    placeNewConnection: async () => workspaceId,
  });
  const integrations = createIntegrationsRepository(db, workspaceId);
  const repositories = createRepositoriesRepository(db, workspaceId);
  const directory = createIntegrationDirectory(db);

  /** The webhook route's job for an installation delivery, step by step as the README describes. */
  async function deliver(
    fixture: string,
  ): Promise<
    InstallationChangeResult | "refused" | "unidentified" | "ignored"
  > {
    const provider = registry.resolve("github_app");
    const request = webhookDelivery({
      event: fixture.split(".")[0] as string,
      payload: webhookFixture(fixture),
      secret: TEST_WEBHOOK_SECRET,
    });
    if (!(await provider.verifyWebhook(null, request))) return "refused";
    const identity = await provider.identifyWebhook(request);
    if (identity === null) return "unidentified";
    const known = await directory.findByExternalId(
      "github_app",
      identity.externalId,
    );
    // An installation without a row can only be a "created" delivery (or a leftover); the route
    // then parses with a stand-in, because the row is created from GitHub's confirmation.
    const event = await provider.parseEvent(
      known ?? {
        id: "unknown",
        workspaceId,
        type: "github_app",
        displayName: "",
        externalId: identity.externalId,
        config: {},
        credentials: null,
        webhookSecret: null,
        status: "active",
        createdAt: "",
        updatedAt: "",
      },
      request,
    );
    if (event.kind !== "installation_changed") return "ignored";
    return sync.handleInstallationChange({
      type: "github_app",
      externalId: event.externalId,
      action: event.action,
    });
  }

  return {
    ...github,
    db,
    registry,
    sync,
    workspaceId,
    integrations,
    directory,
    repositories,
    logged,
    deliver,
  };
}
