// SPDX-License-Identifier: LicenseRef-Proprietary

// The privileged Dynamic e2e lane (#253): one fake GitHub and one app under test (a production build, made once by
// runner/scripts/run_dynamic_e2e.sh before this runs, over a Postgres database of its own), and the journey of
// e2e/dynamic: a signed webhook wakes the real Dispatcher, whose Sandbox-Launcher starts the real Worker in the
// container's root, capabilities and read-only root (runner/scripts/dynamic_e2e_worker_container.sh), with the pinned
// OpenCode as its engine user. It is a configuration of its own because the lane needs root, nft, an engine user and a
// network namespace that nothing of `playwright.config.ts` has: the other journeys never run it, and the lane never
// runs theirs. Run it with `make test-e2e-dynamic` (it uses sudo), not directly.
//
// Ports: the app listens on E2E_HOSTED_PORT (default 3617) with the Dispatcher on the next one, and nothing else of
// the lane listens on a fixed port (the fake GitHub takes a random one, the fake LLM another); never 3000 or 3100.
// The lane's namespace has loopback only, so the Postgres server is reached through a Unix socket
// (e2e/pg-bridge.ts, E2E_DATABASE_URL).
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import { e2eEnv, llmEnv } from "./e2e/helpers/e2e-env";
import {
  factoryDatabaseUrls,
  factoryEnv,
  hostedDatabaseUrls,
  hostedEnv,
} from "./e2e/helpers/hosted-env";

for (const port of [
  hostedEnv.appPort,
  hostedEnv.dispatcherPort,
  factoryEnv.appPort,
])
  if (port === 3000 || port === 3100)
    throw new Error(
      `The lane must not use port ${String(port)}: other work runs there. Set E2E_PORT to a private one.`,
    );

// A throwaway key for the GitHub App of the app under test, new for every run and never written anywhere
// (the same as playwright.config.ts).
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
const factoryDatabase = factoryDatabaseUrls();

export default defineConfig({
  testDir: "e2e/dynamic",
  testMatch: /.*\.e2e\.ts$/,
  // Before anything else: the lane says what is missing and stops (e2e/helpers/dynamic-preflight.ts).
  globalSetup: "./e2e/dynamic/preflight.global-setup.ts",
  // Playwright reads the commit of the checkout for its report and, on CI, runs `git fetch origin <sha>` for it: a name lookup of
  // github.com by root, inside the lane's network namespace, found with strace (#714, #736). The lane's report does not need it.
  captureGitInfo: { commit: false, diff: false },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retry: the journey and its fixtures are written once per run, and a retry would hide what failed.
  retries: 0,
  // One app, one Worker slot, one database: nothing of the lane runs next to anything else.
  workers: 1,
  timeout: 240_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: hostedEnv.appUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // The app starts on a migrated, empty database: the first-run setup and the GitHub App, once per run.
    {
      name: "prepare",
      use: browser,
      testMatch: /prepare-app\.e2e\.ts$/,
    },
    // The guard proves its own counters move; the journey reads them at its end. They do not wait for
    // each other, so one failing does not hide the other.
    {
      name: "guard",
      use: browser,
      testMatch: /network-guard\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The hosted deployment's Dynamic journey (#332): the real Dispatcher and a Worker that is started by its
    // Sandbox-Launcher.
    {
      name: "hosted",
      use: browser,
      testMatch: /hosted-dynamic\.e2e\.ts$/,
      dependencies: ["prepare", "guard"],
    },
    // The second app, the factory's, is set up before its journey (#767).
    {
      name: "prepare-factory",
      use: browser,
      testMatch: /prepare-factory\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The Implementer's journeys (#767): the factory app, the same Dispatcher process type serving both apps, the Worker
    // with the Implementer's profile, git and the pinned OpenCode as the engine user. After the hosted journey, so that
    // the two never run a Dispatcher next to each other (one port, one engine user), and after the guard's positive
    // controls, whose counters it reads at its end.
    {
      name: "implementer",
      use: { ...browser, baseURL: factoryEnv.appUrl },
      testMatch: /hosted-implementer\.e2e\.ts$/,
      dependencies: ["prepare-factory", "guard", "hosted"],
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
        // The links of the fake point to the fake, so that a pull request and the API address of a job
        // are on one host, which the runner demands.
        GITHUB_FAKE_SELF_LINKS: "true",
        // The comments carry github.com links, like a real GitHub's (the Runs page links only to those).
        GITHUB_FAKE_COMMENT_LINKS: "https://github.com",
      },
      url: `${e2eEnv.githubUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The app (the production build made once, before the lane starts) over a database of its own, migrated like a
      // deployment does, in the hosted deployment's dispatch mode (a queued job wakes the Dispatcher with a signed
      // call). There is no sweep in this lane, which the journey does not need: the probe has passed before the call
      // comes.
      command:
        `rm -rf ${hostedEnv.directory} && mkdir -p ${hostedEnv.directory} && ` +
        "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/prepare-database.ts && " +
        "node --conditions=react-server --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/db/migrate-cli.ts && " +
        `./node_modules/.bin/next start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${String(hostedEnv.appPort)} > ${hostedEnv.logFiles.app} 2>&1`,
      env: {
        APP_SECRET: e2eEnv.appSecret,
        // A production server fetches the models.dev catalog on its own (#548); no test reaches the internet.
        MODELS_DEV_FETCH: "off",
        GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
        GITHUB_API_BASE_URL: e2eEnv.githubUrl,
        RUNNER_TOKEN: hostedEnv.dispatcherToken,
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
        E2E_ADMIN_DATABASE_URL: database.admin,
        E2E_DATABASE_NAME: database.name,
        DATABASE_URL: database.app,
        DATABASE_URL_MIGRATE: database.app,
        BETTER_AUTH_URL: hostedEnv.appUrl,
        RUNNER_DISPATCH: "webhook",
        RUNNER_WEBHOOK_URL: `${hostedEnv.dispatcherUrl}/dispatch`,
        RUNNER_WEBHOOK_KEY_ID: hostedEnv.webhookKeyId,
        RUNNER_WEBHOOK_SECRET: hostedEnv.webhookSecret,
        LLM_API_BASE_URL: e2eEnv.modelLlmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      url: hostedEnv.appUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The second app: the factory product with the Implementer, over a database of its own, from the same build (the
      // product is read when the server starts, `src/capabilities/shared.ts`). A queued job wakes the Dispatcher with a
      // signed call, as in the first app; the credentials differ from the first app's.
      command:
        `rm -rf ${factoryEnv.directory} && mkdir -p ${factoryEnv.directory} && ` +
        "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/prepare-database.ts && " +
        "node --conditions=react-server --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/db/migrate-cli.ts && " +
        `./node_modules/.bin/next start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${String(factoryEnv.appPort)} > ${factoryEnv.logFiles.app} 2>&1`,
      env: {
        APP_SECRET: e2eEnv.appSecret,
        PRODUCT_ID: "factory",
        PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
        MODELS_DEV_FETCH: "off",
        GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
        GITHUB_API_BASE_URL: e2eEnv.githubUrl,
        RUNNER_TOKEN: factoryEnv.dispatcherToken,
        ALLOW_TEST_GITHUB_ENDPOINTS: "true",
        E2E_ADMIN_DATABASE_URL: factoryDatabase.admin,
        E2E_DATABASE_NAME: factoryDatabase.name,
        DATABASE_URL: factoryDatabase.app,
        DATABASE_URL_MIGRATE: factoryDatabase.app,
        BETTER_AUTH_URL: factoryEnv.appUrl,
        RUNNER_DISPATCH: "webhook",
        RUNNER_WEBHOOK_URL: `${hostedEnv.dispatcherUrl}/dispatch`,
        RUNNER_WEBHOOK_KEY_ID: factoryEnv.webhookKeyId,
        RUNNER_WEBHOOK_SECRET: factoryEnv.webhookSecret,
        // The pool of the factory is one Worker, here and in the Dispatcher's entry (`maxRunning`): both must be equal.
        RUNNER_DISPATCH_MAX_RUNNING: "1",
        CRON_SECRET: factoryEnv.cronSecret,
        LLM_API_BASE_URL: e2eEnv.modelLlmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      url: factoryEnv.appUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
