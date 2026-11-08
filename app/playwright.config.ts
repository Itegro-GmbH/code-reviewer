// SPDX-License-Identifier: LicenseRef-Proprietary

import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";
import {
  adminDatabaseUrl,
  appDatabase,
  e2eEnv,
  llmEnv,
} from "./e2e/helpers/e2e-env";

// Own ports per checkout (E2E_PORT, default 3417; the fake GitHub gets a random one, see
// e2e/helpers/e2e-env.ts); never 3000 or 3100 so parallel work in other worktrees is safe.
const baseURL = e2eEnv.appUrl;

// A throwaway key for the GitHub App of the apps under test, new for every run and never written
// anywhere. The run enters the App in the admin portal of each app (e2e/setup/prepare-apps.e2e.ts),
// so the journeys that need a token (the real review) and the portal's own check (`GET /app` with
// the App's JWT) work against the fake GitHub. It is made once in this process and handed on through
// the environment, which every worker inherits.
process.env.E2E_GITHUB_APP_PRIVATE_KEY ||= generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
const githubAppPrivateKey = process.env.E2E_GITHUB_APP_PRIVATE_KEY;

// The fake GitHub checks the App JWTs of the app under test with the public half of that key.
const githubAppPublicKey = createPublicKey(githubAppPrivateKey)
  .export({ type: "spki", format: "pem" })
  .toString();

// Locally an installed Chrome can be used instead of a downloaded Chromium:
// PLAYWRIGHT_CHANNEL=chrome pnpm test:e2e
const browser = {
  ...devices["Desktop Chrome"],
  channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
};

// What all apps under test share: the address of GitHub (the fake), the master key and the runner token,
// all dummies. The GitHub App itself is not in the environment: the run enters it in each app's admin portal.
const appEnv = {
  APP_SECRET: e2eEnv.appSecret,
  GITHUB_OAUTH_BASE_URL: e2eEnv.githubUrl,
  GITHUB_API_BASE_URL: e2eEnv.githubUrl,
  RUNNER_TOKEN: e2eEnv.runnerToken,
  // Without this flag the server refuses the two overrides above.
  ALLOW_TEST_GITHUB_ENDPOINTS: "true",
  // A production server fetches the models.dev catalog on its own (#548); no test reaches the internet.
  MODELS_DEV_FETCH: "off",
};

// The database of an app under test: made fresh and migrated before the app starts, like a deployment does
// (`pnpm migrate` is a step of its own; the app never migrates). The set-up code of a new instance comes from
// `pnpm setup-code` (e2e/helpers/setup.ts), not from the log.
const PREPARE_DATABASE =
  "mkdir -p test-results && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON e2e/prepare-database.ts && pnpm migrate";
function databaseEnv(app: string): Record<string, string> {
  const { name, url } = appDatabase(app);
  return {
    E2E_ADMIN_DATABASE_URL: adminDatabaseUrl().toString(),
    E2E_DATABASE_NAME: name,
    DATABASE_URL: url,
    DATABASE_URL_MIGRATE: url,
  };
}

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: Number(process.env.E2E_WORKERS) || 2,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The journeys share one app and one database file. The ones that put runs into the queue or claim
  // them (the Runs pages and the manual start) must not overlap: the Runs journey expects an empty
  // queue when it starts and `claimNextRun` takes the oldest job of the whole queue. So they are
  // projects of their own, and the manual start waits for the Runs journeys to finish.
  projects: [
    // The apps under test start without a database, so each is a new instance that answers nothing
    // but its health check until it is set up. This sets up the two that the other projects use
    // (e2e/setup/prepare-apps.e2e.ts); every other project waits for it.
    {
      name: "prepare",
      use: browser,
      testMatch: /e2e\/setup\/prepare-apps\.e2e\.ts$/,
    },
    {
      name: "chromium",
      use: browser,
      dependencies: ["prepare"],
      testIgnore: [
        /e2e\/runs\//,
        /e2e\/reviews\//,
        /e2e\/jobs\//,
        /e2e\/dynamic\//,
        /e2e\/factory\//,
        /e2e\/hosted\//,
        /e2e\/setup\//,
        /e2e\/auth\/(sign-up|password-reset)\.e2e\.ts$/,
        /e2e\/admin\/mail\.e2e\.ts$/,
        /e2e\/admin\/github-integration\.e2e\.ts$/,
        /e2e\/admin\/catalog\.e2e\.ts$/,
        /e2e\/admin\/billing\.e2e\.ts$/,
        /e2e\/admin\/billing-reviews\.e2e\.ts$/,
        /e2e\/admin\/operator-cost-limit\.e2e\.ts$/,
        /e2e\/billing\//,
        /e2e\/billing-journeys\//,
        /e2e\/workspaces\//,
        /e2e\/settings\/llm-key\.e2e\.ts$/,
        /e2e\/settings\/workspace-defaults\.e2e\.ts$/,
        /e2e\/settings\/native-provider\.e2e\.ts$/,
        /e2e\/operator\//,
      ],
    },
    {
      name: "runs",
      use: browser,
      testMatch: /e2e\/runs\/.*\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    {
      name: "reviews",
      use: browser,
      testMatch: /e2e\/reviews\/.*\.e2e\.ts$/,
      dependencies: ["runs"],
    },
    // The journeys with a mail server have an app of their own (the fourth), because a mail server makes the
    // instance ask every email account for a verified address, which would change what the admin of the
    // other journeys sees. The mail page's journey comes first: it takes the app from "no mail server" to
    // "mail through the fake SMTP server", configured in the admin portal like an operator does it. The
    // sign-up and the password reset use that mail server.
    {
      name: "mail",
      use: { ...browser, baseURL: e2eEnv.signupAppUrl },
      testMatch: /e2e\/admin\/mail\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    {
      name: "signup",
      use: { ...browser, baseURL: e2eEnv.signupAppUrl },
      testMatch: /e2e\/auth\/(sign-up|password-reset)\.e2e\.ts$/,
      dependencies: ["prepare", "mail"],
    },
    // The journey of a catalog provider (#555) opens a pull request and has a script claim its Dynamic job, so it puts a run
    // into the queue of the first app: it runs after the Runs journeys, which expect an empty queue when they start.
    {
      name: "native-provider",
      use: browser,
      testMatch: /e2e\/settings\/native-provider\.e2e\.ts$/,
      dependencies: ["chromium", "runs", "reviews"],
    },
    // The journey of the operator's maximum cost per review (#689) changes that maximum of the first app for a while,
    // while the project settings journey expects the default: it runs after every journey of that app.
    {
      name: "operator-cost-limit",
      use: browser,
      testMatch: /e2e\/admin\/operator-cost-limit\.e2e\.ts$/,
      dependencies: ["chromium", "runs", "reviews", "native-provider"],
    },
    // The journey of the invitations changes who belongs to the workspace of the first app and needs its
    // sign-up rule to be "everyone", which the admin portal journey changes for a while: it runs after
    // every journey of that app.
    {
      name: "invitations",
      use: browser,
      testMatch: /e2e\/workspaces\/invite-and-accept\.e2e\.ts$/,
      dependencies: [
        "chromium",
        "runs",
        "reviews",
        "native-provider",
        "operator-cost-limit",
      ],
    },
    // The journeys of the workspaces in a multi-tenant instance have an app of their own (the fifth): people
    // create workspaces there, and a single-tenant instance does not let them.
    {
      name: "multi",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/workspaces\/multi-tenant\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The journey of the invitations by mail uses the multi-tenant app again, after the journeys that need it
    // without a mail server: it configures the fake SMTP server there, which makes every account of that
    // app confirm its address.
    {
      name: "multi-mail",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/workspaces\/invite-by-mail\.e2e\.ts$/,
      dependencies: ["multi", "multi-llm", "multi-defaults"],
    },
    // The journey of the LLM key of a workspace uses the multi-tenant app as well (a workspace of its own, so it
    // changes nothing for the others), before the mail server is configured there.
    {
      name: "multi-llm",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/settings\/llm-key\.e2e\.ts$/,
      dependencies: ["multi"],
    },
    // The journey of the workspace Review defaults (#676) uses the multi-tenant app too, in a workspace of its own, after the LLM key
    // journey (both start the fake LLM of that app) and before the mail server is configured there.
    {
      name: "multi-defaults",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/settings\/workspace-defaults\.e2e\.ts$/,
      dependencies: ["multi", "multi-llm"],
    },
    // The journey that connects GitHub installations to workspaces uses the multi-tenant app again, after the
    // journeys that configure the fake SMTP server there (which makes every account of that app confirm its
    // address) have removed it.
    {
      name: "connect",
      use: { ...browser, baseURL: e2eEnv.multiAppUrl },
      testMatch: /e2e\/workspaces\/connect-github\.e2e\.ts$/,
      dependencies: ["multi-mail"],
    },
    // The journey of the first-run setup has an app of its own that nobody has set up (the third
    // one), so it needs nothing to run first and disturbs nobody.
    {
      name: "setup",
      use: { ...browser, baseURL: e2eEnv.setupAppUrl },
      testMatch: /e2e\/setup\/first-run\.e2e\.ts$/,
    },
    // The journey of the GitHub integration uses the third app after the first-run journey has set it up: it
    // creates the GitHub App through the manifest flow, signs people in with GitHub, merges the admin with an
    // imported operator, makes GitHub the only way to sign in and enters the App by hand, so nobody else may
    // use that app.
    {
      name: "github",
      use: { ...browser, baseURL: e2eEnv.setupAppUrl },
      testMatch: /e2e\/admin\/github-integration\.e2e\.ts$/,
      dependencies: ["setup"],
    },
    // The journey of the models.dev catalog in the admin portal (#554): an app of its own (the ninth) that fetches the
    // catalog from the fake models.dev the journey starts, so it can move a price and fetch again without disturbing the
    // other journeys.
    {
      name: "catalog-admin",
      // No retry: a second attempt would find the catalog filled and the decisions made.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAdminAppUrl },
      testMatch: /e2e\/admin\/catalog\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The journey of the billing page in the admin portal (#504): it uses the app of the catalog admin journey (a single-tenant
    // instance of its own), after that journey, because it switches billing on and off again and credits a workspace there.
    {
      name: "billing-admin",
      // No retry: a second attempt would find the credentials saved and the journal written.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAdminAppUrl },
      testMatch: /e2e\/admin\/billing\.e2e\.ts$/,
      dependencies: ["catalog-admin"],
    },
    // The journey of the payment reviews in the admin portal (#603): the same app, after the billing journey, because it leaves
    // review rows there and credits the default workspace by hand.
    {
      name: "billing-reviews-admin",
      // No retry: a second attempt would find the rows closed and the credit written.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAdminAppUrl },
      testMatch: /e2e\/admin\/billing-reviews\.e2e\.ts$/,
      dependencies: ["billing-admin"],
    },
    // The journey of the billing page of a workspace (#505): the same app, after the payment reviews, against the fake Stripe the
    // run starts. The journey configures billing with the Stripe adapter through the admin routes, so it needs the rates, the
    // webhook endpoint and the credentials to be its own; it adds credit, so it comes after the journeys that count the balance.
    {
      name: "billing-workspace",
      // No retry: a second attempt would find the payments made and the profile saved.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAdminAppUrl },
      testMatch: /e2e\/billing\/workspace-billing\.e2e\.ts$/,
      dependencies: ["billing-reviews-admin"],
    },
    // The journeys of the balance banner (#506) and of the key mode (#496): the same app, one after the other and after the billing page
    // of a workspace, not next to it. Each puts billing on against the fake Stripe (the app keeps the signing secret of the last webhook
    // endpoint made) and ends with billing off or a balance of its own, so run side by side on two workers they broke each other (the
    // payment's webhook was answered 400, #623).
    {
      name: "billing-banner",
      // No retry: a second attempt would find the balance set by the first.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAdminAppUrl },
      testMatch: /e2e\/billing\/balance-banner\.e2e\.ts$/,
      dependencies: ["billing-workspace"],
    },
    {
      name: "billing-key-mode",
      // No retry: a second attempt would find the key saved and the choice made.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAdminAppUrl },
      testMatch: /e2e\/billing\/key-mode\.e2e\.ts$/,
      dependencies: ["billing-banner"],
    },
    // The billing journeys that need a review to run (#508): the same app, after the billing page of a workspace and the key mode. A runner script
    // hands out the jobs the pushes make and reports them, so the journeys count the balance, the prices and the notices; they leave
    // the workspace with a bound installation, a project that is active and a journal of its own, so nothing comes after them.
    {
      name: "billing-journeys",
      // No retry: a second attempt would find the credit granted, the payments made and the reviews run.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAdminAppUrl },
      testMatch: /e2e\/billing-journeys\/.*\.e2e\.ts$/,
      dependencies: ["billing-key-mode"],
    },
    // The browser journey of the factory pages (#951): an app of its own (the tenth), the product `factory` with the capability
    // `implementer` on the fake GitHub, so the Issues tab, the ToDos, the lane builder, the run page, Profiles, Runners, Settings and
    // the Setup tab open in a real browser. The code-review.com apps above have none of them. Nothing else uses that app and the
    // journey leaves no queue behind that another app could claim.
    {
      name: "factory",
      // No retry: a second attempt would find the lane started, the question answered and the run discarded.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.factoryAppUrl },
      testMatch: /e2e\/factory\/.*\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The journey with the real runner and the real PR-Agent. It has an app of its own (its own
    // database, the LLM configured, a real runner polling it), so it cannot disturb the queue of the
    // other journeys and they cannot disturb it, and it runs next to them.
    {
      name: "jobs",
      use: { ...browser, baseURL: e2eEnv.pipelineAppUrl },
      testMatch: /e2e\/jobs\/.*\.e2e\.ts$/,
      dependencies: ["prepare"],
    },
    // The journeys of the operator limits (#285). The plain one runs on the pipeline app (an instance that never
    // switched any of it on) after the journey of the real runner, which uses the same app: two runners must not poll
    // one app. The limited one has an app of its own (the seventh: multi-tenant, with the operator API on) and
    // connects GitHub installations to two workspaces, which sets the setup address of the one app registered at the
    // fake GitHub, so it waits for the journey that does the same on the fifth app.
    {
      name: "operator-plain",
      // No retry: the set-up of the group changes the app (a switch that would be clicked off again), so an attempt
      // that fails is reported as it failed.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.pipelineAppUrl },
      testMatch: /e2e\/operator\/plain-instance\.e2e\.ts$/,
      dependencies: ["jobs"],
    },
    {
      name: "operator",
      // No retry: a second attempt would sign the same people up again and connect installations that are connected.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.operatorAppUrl },
      testMatch: /e2e\/operator\/limited-workspace\.e2e\.ts$/,
      // After the catalog journey, which sets the same setup address at the fake GitHub for its own app.
      dependencies: ["prepare", "connect", "catalog"],
    },
    // The journey of the providers and the catalog (#435): the admin builds the catalog in the portal, a managed
    // workspace runs on its entries and a workspace on its own key on its model, and no member reads a model id. It has
    // an app of its own (the eighth: a new multi-tenant instance with the operator API on, so the catalog starts
    // empty) and a fake LLM of its own. It connects GitHub installations, which sets the setup address of the one app
    // registered at the fake GitHub: so it runs after the journey of the connections, which sets the same address for
    // the multi-tenant app, and before the operator journey, which does it for the operator app. (A journey that is
    // not a dependency of the smoke selection stays out of a smoke run, which is why the order is this way round: the
    // smoke run takes the catalog journey and the connections one, not the operator journey.)
    {
      name: "catalog",
      // No retry, as the operator journey: a second attempt would sign the same people up again.
      retries: 0,
      use: { ...browser, baseURL: e2eEnv.catalogAppUrl },
      testMatch: /e2e\/operator\/catalog-journey\.e2e\.ts$/,
      dependencies: ["prepare", "connect"],
    },
  ],
  // Nine apps under test (the port `E2E_PORT` + 5 is the one the update journey starts itself) and the two
  // fake servers they share, GitHub and SMTP; the journeys start their own fake LLMs. The apps take consecutive ports
  // from `E2E_PORT` up to `E2E_PORT` + 7. The fake GitHub stands in for github.com (sign in) and api.github.com; the app
  // under test is pointed at it by environment variables. The journeys always run against a
  // production build, never the dev server, with a fresh Postgres database each (E2E_DATABASE_URL names the server;
  // `pnpm migrate` migrates it before the app starts). All values are fixed dummies.
  //
  // Each app's output goes to a log file in test-results: a new instance prints its setup code only
  // there, and the journeys read it from the file (e2e/helpers/setup.ts).
  //
  // The second app serves the same build (the servers start one after the other, so the build of
  // the first is done) with a database of its own and the settings the journey with the real
  // runner needs: the LLM access (the other app has none, a journey checks its warning), and a
  // push that is reviewed after a second instead of after 90 seconds. The third is the same build
  // again, left unconfigured and not set up, for the journey that walks through the first-run
  // wizard. The fourth is the same build with a database of its own, for the journeys that need a mail server:
  // the journey of the mail page configures it in the admin portal to send to the fake SMTP server (the
  // sixth server), and the sign-up and the password reset read their mail from that server's inbox.
  webServer: [
    {
      command: "node ../fakes/github/main.ts",
      env: {
        GITHUB_FAKE_PORT: String(e2eEnv.githubPort),
        GITHUB_FAKE_CLIENT_ID: e2eEnv.githubClientId,
        GITHUB_FAKE_CLIENT_SECRET: e2eEnv.githubClientSecret,
        // Apps can also be created through the manifest flow (e2e/admin/github-integration.e2e.ts).
        GITHUB_FAKE_MANIFEST_FLOW: "true",
        GITHUB_FAKE_APP_ID: e2eEnv.githubAppId,
        GITHUB_FAKE_APP_PUBLIC_KEY: githubAppPublicKey,
        GITHUB_FAKE_APP_SLUG: e2eEnv.githubAppSlug,
        // The links of the fake point to the fake, so that a pull request and the API address of a
        // job are on one host, which the runner demands.
        GITHUB_FAKE_SELF_LINKS: "true",
      },
      url: `${e2eEnv.githubUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The fake Stripe of the billing journey of a workspace (#505): the catalog admin app is pointed at it
      // (STRIPE_API_BASE_URL with ALLOW_TEST_STRIPE_ENDPOINTS=true), and the journey pays, refunds and delivers events over its
      // control API under /__fake/.
      command: "node ../fakes/stripe/main.ts",
      env: {
        STRIPE_FAKE_PORT: String(e2eEnv.stripeFakePort),
        STRIPE_FAKE_API_KEY: e2eEnv.stripeFakeApiKey,
      },
      url: `${e2eEnv.stripeFakeUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "node ../fakes/smtp/main.ts",
      env: {
        SMTP_FAKE_PORT: String(e2eEnv.smtp.port),
        SMTP_FAKE_TLS_PORT: String(e2eEnv.smtp.tlsPort),
        SMTP_FAKE_CONTROL_PORT: String(e2eEnv.smtp.controlPort),
        SMTP_FAKE_USER: e2eEnv.smtp.user,
        SMTP_FAKE_PASSWORD: e2eEnv.smtp.password,
      },
      url: `${e2eEnv.smtp.controlUrl}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      // The fake models.dev the catalog admin app fetches from (#554); the journey scripts it over HTTP.
      command: "node ../fakes/models-dev/main.ts",
      env: { MODELS_DEV_FAKE_PORT: String(e2eEnv.modelsDevFakePort) },
      url: `http://127.0.0.1:${e2eEnv.modelsDevFakePort}/__fake/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        `pnpm build && ${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.appPort} > ${e2eEnv.logFiles.app} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("main"),
        BETTER_AUTH_URL: e2eEnv.appUrl,
        // Saving a Dynamic model asks the provider's model metadata: the fake LLM answers (#269).
        LLM_API_BASE_URL: e2eEnv.modelLlmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
      },
      url: e2eEnv.appUrl,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.pipelineAppPort} > ${e2eEnv.logFiles.pipeline} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("pipeline"),
        BETTER_AUTH_URL: e2eEnv.pipelineAppUrl,
        // The key is not an environment setting any more: the journey saves it for the workspace, as an Owner
        // does. The model and the context window of a model PR-Agent does not know still are.
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
      },
      url: e2eEnv.pipelineAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.setupAppPort} > ${e2eEnv.logFiles.setup} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("setup"),
        BETTER_AUTH_URL: e2eEnv.setupAppUrl,
      },
      url: e2eEnv.setupAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.signupAppPort} > ${e2eEnv.logFiles.signup} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("signup"),
        BETTER_AUTH_URL: e2eEnv.signupAppUrl,
      },
      url: e2eEnv.signupAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.multiAppPort} > ${e2eEnv.logFiles.multi} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("multi"),
        BETTER_AUTH_URL: e2eEnv.multiAppUrl,
        // The "test key" button of the LLM key journey asks the fake LLM, not the provider.
        LLM_API_BASE_URL: e2eEnv.llmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
      },
      url: e2eEnv.multiAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.operatorAppPort} > ${e2eEnv.logFiles.operator} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("operator"),
        BETTER_AUTH_URL: e2eEnv.operatorAppUrl,
        // The operator API: the journey's script is the external service (e2e/operator/).
        OPERATOR_API_TOKEN: e2eEnv.operatorApiToken,
        // The model metadata a managed tier is saved and claimed with comes from the journey's fake LLM, which also
        // answers the reviews of the real runner. The model and the context window are those of a workspace on its
        // own key (a model PR-Agent does not know); a managed workspace gets the model of its tier.
        LLM_API_BASE_URL: e2eEnv.operatorLlmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
      },
      url: e2eEnv.operatorAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.catalogAppPort} > ${e2eEnv.logFiles.catalog} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("catalog"),
        BETTER_AUTH_URL: e2eEnv.catalogAppUrl,
        OPERATOR_API_TOKEN: e2eEnv.operatorApiToken,
        // The model metadata the catalog is released and claimed with, the key tests and the reviews of the real
        // runner come from the journey's fake LLM, which listens at the port of the operator journey's.
        LLM_API_BASE_URL: e2eEnv.catalogLlmFakeApiUrl,
        ALLOW_TEST_LLM_ENDPOINTS: "true",
        LLM_MODEL: llmEnv.model,
        LLM_MAX_TOKENS: llmEnv.maxTokens,
      },
      url: e2eEnv.catalogAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.catalogAdminAppPort} > ${e2eEnv.logFiles.catalogAdmin} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("catalog_admin"),
        BETTER_AUTH_URL: e2eEnv.catalogAdminAppUrl,
        // This app fetches the catalog, from the fake models.dev of the journey (#554).
        MODELS_DEV_FETCH: "on",
        MODELS_DEV_URL: e2eEnv.modelsDevFakeUrl,
        // The billing journeys of this app (#504, #505) talk to the fake Stripe: the app ignores the address without the flag, and
        // accepts only a loopback one with it (src/stripe-endpoints.ts).
        STRIPE_API_BASE_URL: e2eEnv.stripeFakeUrl,
        ALLOW_TEST_STRIPE_ENDPOINTS: "true",
      },
      url: e2eEnv.catalogAdminAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The factory app (#951): the same build, the product `factory` with the capability `implementer` (read when the server starts,
      // `src/capabilities/shared.ts`), over a database of its own. No Dispatcher and no model: the journey seeds what a lane would have
      // written (e2e/factory) and the fake GitHub answers the few calls the pages make.
      command:
        `${PREPARE_DATABASE} && ` +
        `pnpm start --hostname 127.0.0.1 --keepAliveTimeout 120000 --port ${e2eEnv.factoryAppPort} > ${e2eEnv.logFiles.factory} 2>&1`,
      env: {
        ...appEnv,
        ...databaseEnv("factory"),
        BETTER_AUTH_URL: e2eEnv.factoryAppUrl,
        PRODUCT_ID: "factory",
        PRODUCT_CAPABILITIES: "review,dynamic-review,implementer",
      },
      url: e2eEnv.factoryAppUrl,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
