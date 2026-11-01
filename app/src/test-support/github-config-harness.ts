// SPDX-License-Identifier: LicenseRef-Proprietary

// The GitHub integration of the admin portal assembled for integration tests: a real Postgres database, the
// encrypted secret store and the credential store on it, the service with a clock, and the fake GitHub on a
// loopback port (with the manifest flow switched on) as `github.com` and `api.github.com`. Every address the
// service builds is made from `GITHUB_CONFIG_TEST_PUBLIC_URL`.
import {
  createCapabilitySet,
  type CapabilitySet,
} from "../capabilities/capability.ts";
import { PRODUCTS } from "../capabilities/products.ts";
import { getProductIdentity } from "../product-identity/current.ts";
import { GITHUB_APP_SECRET_NAMES } from "../secret-names/names.ts";
import type { FakeGithub } from "../../../fakes/github/server.ts";
import {
  createGithubCredentialStore,
  type GithubCredentialStore,
} from "../github-config/credentials.ts";
import {
  createGithubConfigService,
  type GithubActor,
  type GithubConfigService,
} from "../github-config/service.ts";
import { createInstanceSettingsRepository } from "../db/repositories/instance-settings-repository.ts";
import { createRateLimitsRepository } from "../db/repositories/rate-limits-repository.ts";
import { createSecretStore } from "../secrets/store.ts";
import { createSignedStates } from "../signed-state/state.ts";
import { TEST_APP_ID, TEST_APP_SLUG, testAppKeys } from "./github-app.ts";
import {
  startTestGithub,
  TEST_CLIENT_ID,
  TEST_CLIENT_SECRET,
} from "./github-fake.ts";
import { createTestDatabase } from "./test-database.ts";
import { insertUser } from "./users.ts";

export const GITHUB_CONFIG_TEST_PUBLIC_URL = "https://reviews.example.test";
export const GITHUB_CONFIG_TEST_SECRET =
  "test-app-secret-0123456789-0123456789-abc";

export type GithubConfigHarnessOptions = {
  github?: FakeGithub;
  tenancy?: "single" | "multi";
  /** What the deployment offers; default: the capabilities of code-review.com. */
  capabilities?: CapabilitySet;
  /** The process environment the credential store falls back to. */
  env?: Record<string, string | undefined>;
  requestTimeoutMs?: number;
};

export async function createGithubConfigHarness(
  options: GithubConfigHarnessOptions = {},
) {
  const { db } = await createTestDatabase();
  const github =
    options.github ?? (await startTestGithub({ appSlug: TEST_APP_SLUG }));
  const clock = { at: new Date("2026-10-12T10:00:00.000Z") };
  const now = () => clock.at;
  const tenancy = { value: options.tenancy ?? "single" };
  const env = {
    GITHUB_API_BASE_URL: github.baseUrl,
    ALLOW_TEST_GITHUB_ENDPOINTS: "true",
    ...options.env,
  };

  const credentials = createGithubCredentialStore({
    db,
    appSecret: GITHUB_CONFIG_TEST_SECRET,
    env,
    now,
  });
  const signedStates = createSignedStates({
    db,
    appSecret: GITHUB_CONFIG_TEST_SECRET,
    now,
  });
  const logs: string[] = [];
  const service = createGithubConfigService({
    product: getProductIdentity(),
    capabilities:
      options.capabilities ??
      createCapabilitySet(PRODUCTS["code-review-com"].default),
    credentials,
    signedStates,
    rateLimits: createRateLimitsRepository(db, now),
    publicUrl: GITHUB_CONFIG_TEST_PUBLIC_URL,
    tenancy: async () => tenancy.value,
    webBaseUrl: github.baseUrl,
    apiBaseUrl: github.baseUrl,
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { timeoutMs: options.requestTimeoutMs }),
    now,
    log: (line) => logs.push(line),
  });

  await insertUser(db, { id: "admin-1", isInstanceAdmin: true });
  await insertUser(db, { id: "admin-2", isInstanceAdmin: true });
  const admin: GithubActor = { id: "admin-1", sessionId: "session-1" };

  /** Another credential store over the same database: what a second app instance would use. */
  const secondInstance = (): GithubCredentialStore =>
    createGithubCredentialStore({
      db,
      appSecret: GITHUB_CONFIG_TEST_SECRET,
      env,
      now,
    });

  /**
   * The whole manifest flow as a person does it: start, post the manifest to GitHub and confirm there, and
   * come back with the code. Resolves to the result of the callback and what GitHub sent.
   */
  async function createAppThroughManifest(
    actor: GithubActor = admin,
    body: Record<string, unknown> = {},
  ) {
    const started = await service.startManifest(actor, body);
    if (!started.ok)
      throw new Error(`The manifest flow did not start: ${started.error}`);
    const back = await github.confirmManifest(
      started.postUrl,
      started.manifest,
    );
    const result = await service.completeManifest(actor, {
      code: back.searchParams.get("code"),
      state: back.searchParams.get("state"),
    });
    return { started, back, result };
  }

  /** The values of the manual form for the app registered at the fake, with a key as the form gets it. */
  function validManualInput(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      appId: TEST_APP_ID,
      slug: TEST_APP_SLUG,
      privateKey: testAppKeys().privateKey,
      webhookSecret: "a-webhook-secret-of-the-test",
      clientId: TEST_CLIENT_ID,
      clientSecret: TEST_CLIENT_SECRET,
      privateApp: true,
      ...overrides,
    };
  }

  return {
    db,
    github,
    clock,
    tenancy,
    credentials,
    service,
    signedStates,
    secrets: createSecretStore({
      db,
      names: GITHUB_APP_SECRET_NAMES,
      appSecret: GITHUB_CONFIG_TEST_SECRET,
      now,
    }),
    settings: createInstanceSettingsRepository(db, now),
    logs,
    admin,
    secondInstance,
    createAppThroughManifest,
    validManualInput,
  };
}

export type GithubConfigHarness = Awaited<
  ReturnType<typeof createGithubConfigHarness>
>;

export type { GithubConfigService };
