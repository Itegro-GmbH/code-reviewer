// SPDX-License-Identifier: LicenseRef-Proprietary

// The hosted lane (#332): the whole hosted flow with the real code of the App (serverless mode, Postgres), the
// Dispatcher (a process, started by the journeys) and the Worker (`worker-once` and `probe`, started by the Dispatcher's
// Sandbox-Launcher through the stand-in `docker` of fakes/sandbox/bin/docker-worker.sh), over the loopback fakes: the
// GitHub, the model and the Sandbox platform's local mode. No real Vercel and no network beyond loopback.
//
// A configuration of its own because the lane needs what the others do not: a Postgres server (E2E_DATABASE_URL, a
// service container in CI), the Dispatcher project's dependencies and the installed Worker. It does not run the journeys
// of `playwright.config.ts` and they do not run it; `make test-e2e-hosted` is its entry. The privileged half of the hosted
// proof (the Dynamic Worker under the container's capabilities and read-only root) is `e2e/dynamic/` in the privileged
// lane, which has its own configuration.
//
// Ports: the app listens on E2E_HOSTED_PORT (default 3617) and the Dispatcher on the next one; the fakes take random
// ones. Never 3000 or 3100.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { e2eEnv, llmEnv } from "./e2e/helpers/e2e-env";
import { hostedDatabaseUrls, hostedEnv } from "./e2e/helpers/hosted-env";

// A throwaway key for the GitHub App of the app under test, new for every run and never written anywhere (the same as
// playwright.config.ts).
process.env.E2E_GITHUB_APP_PRIVATE_KEY ||= generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const githubAppPublicKey = createPublicKey(
  process.env.E2E_GITHUB_APP_PRIVATE_KEY,
)
  .export({ type: "spki", format: "pem" })
  .toString();

const browser = {
  ...devices["Desktop Chrome"],
  channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  baseURL: hostedEnv.appUrl,
};
const database = hostedDatabaseUrls();

export default defineConfig({
  testDir: "e2e/hosted",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retry: the journeys change one app, one database and one Dispatcher, and a retry would hide what failed.
  retries: 0,
  // One app, one database, one pool: nothing of the lane runs next to anything else.
  workers: 1,
  timeout: 180_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: hostedEnv.appUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // The app starts with a migrated, empty database: the first-run setup and the GitHub App, once per run.
    {
      name: "prepare",
      use: browser,
      testMatch: /prepare-app\.e2e\.ts$/,
    },
    {
      name: "journeys",
      use: browser,
      testIgnore: [/prepare-app\.e2e\.ts$/, /no-secrets\.e2e\.ts$/],
      dependencies: ["prepare"],
    },
    // The last word: every log of every component, after all journeys have run.
    {
      name: "secrets",
      use: browser,
      testMatch: /no-secrets\.e2e\.ts$/,
      dependencies: ["journeys"],
    },
  ],
  webServer: [
    {
      command: "node ../fakes/github/main.ts",
      env: {
        GITHUB_FAKE_PORT: String(e2eEnv.githubPort),
        GITHUB_FAKE_CLIENT_ID: e2eEnv.githubClientId,
        GITHUB_FAKE_CLIENT_SECRET: e2eEnv.githubClientSecret,
        GITHUB_FAKE_MANIFEST_FLOW: "true",
        GITHUB_FAKE_APP_ID: e2eEnv.githubAppId,
        GITHUB_FAKE_APP_PUBLIC_KEY: githubAppPublicKey,
        GITHUB_FAKE_APP_SLUG: e2eEnv.githubAppSlug,
        // The links of the fake point to the fake, so that a pull request and the API address of a job are on one
        // host, which the Worker demands.
        GITHUB_FAKE_SELF_LINKS: "true",
      },
      url: `${e2eEnv.githubUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The deployment's order: build, the database and its migrations (`pnpm migrate`, a step of its own because a
      // serverless instance never migrates), then the server. A set up code is made by the prepare project with
      // `pnpm setup-code`. E2E_REUSE_BUILD=1 skips the build when there is one.
      command:
        `${process.env.E2E_REUSE_BUILD === "1" ? "true" : "pnpm build"} && ` +
        `rm -rf ${hostedEnv.directory} && mkdir -p ${hostedEnv.directory} && ` +
        "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/prepare-database.ts && pnpm migrate && " +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${String(hostedEnv.appPort)} > ${hostedEnv.logFiles.app} 2>&1`,
      env: {
        NEXT_TELEMETRY_DISABLED: "1",
        E2E_ADMIN_DATABASE_URL: database.admin,
        E2E_DATABASE_NAME: database.name,
        DATABASE_URL: database.app,
        DATABASE_URL_MIGRATE: database.app,
        APP_SECRET: hostedEnv.appSecret,
        // The lane's app is the clone (#731): the factory product with review and dynamic-review, billing off. The journeys
        // review without any balance, and e2e/hosted/capabilities.e2e.ts proves what is not there.
        PRODUCT_ID: "factory",
        PRODUCT_CAPABILITIES: "review,dynamic-review",
        // The sweep of the hosted lane would fetch the models.dev catalog (#548); no test reaches the internet.
        MODELS_DEV_FETCH: "off",
        BETTER_AUTH_URL: hostedEnv.appUrl,
        GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
        GITHUB_API_BASE_URL: e2eEnv.githubUrl,
        // Without this flag the server refuses the two overrides above.
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
        // The Dispatcher of a journey is started by the journey: a wider window for the inline retries than a slow
        // runner needs to start it (src/dispatch/test-timing.ts).
        ALLOW_TEST_DISPATCH_TIMING: "true",
        TEST_DISPATCH_INLINE_RETRY_DELAYS_MS: "2000,6000,10000",
        // The dispatcher credential of the claim; the Workers never see it.
        RUNNER_TOKEN: hostedEnv.dispatcherToken,
        // The hosted deployment: a queued job wakes the Dispatcher with a signed call, and the sweep is the clock.
        RUNNER_DISPATCH: "webhook",
        // A dispatcher of the E2E announces an address on this machine (the fakes); never set outside tests.
        RUNNER_DELIVERY_ALLOW_LOOPBACK: "1",
        RUNNER_WEBHOOK_URL: `${hostedEnv.dispatcherUrl}/dispatch`,
        RUNNER_WEBHOOK_KEY_ID: hostedEnv.webhookKeyId,
        RUNNER_WEBHOOK_SECRET: hostedEnv.webhookSecret,
        // The pool of the lane is one Worker, here and in the Dispatcher (DISPATCHER_MAX_RUNNING): the sweep sends
        // no more calls than there are free slots.
        RUNNER_DISPATCH_MAX_RUNNING: "1",
        CRON_SECRET: hostedEnv.cronSecret,
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
        // Saving a Dynamic model asks the provider's model metadata: the fake LLM of the journey answers (#269).
        LLM_API_BASE_URL: e2eEnv.modelLlmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
        // A push is reviewed after a second instead of after 90.
      },
      url: `${hostedEnv.appUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
    },
  ],
});
