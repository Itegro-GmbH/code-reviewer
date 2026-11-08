// SPDX-License-Identifier: LicenseRef-Proprietary

// Addresses and dummy credentials shared by the Playwright configuration (which starts the app and
// the fake GitHub) and the journeys. Nothing here is a secret: the values only have to match
// between the two processes under test.
import { EPHEMERAL_FLOOR, pickFreePort } from "./free-port";

const appPort = Number(process.env.E2E_PORT) || 3417;
// The second app of the run, for the journey that runs the real runner (see playwright.config.ts):
// the next port unless E2E_PIPELINE_PORT says otherwise.
const pipelineAppPort = Number(process.env.E2E_PIPELINE_PORT) || appPort + 1;
// The third app of the run, for the journey of the first-run setup (it needs an instance that nobody
// has set up): the port after the second one unless E2E_SETUP_PORT says otherwise.
const setupAppPort = Number(process.env.E2E_SETUP_PORT) || appPort + 2;
// The fourth app of the run, for the journey of the sign-up and the email verification (it has a mail
// outbox, which makes every other journey's admin ask for a verified address): the port after the third
// one unless E2E_SIGNUP_PORT says otherwise.
const signupAppPort = Number(process.env.E2E_SIGNUP_PORT) || appPort + 3;
// The fifth app of the run, for the journeys of the workspaces in a multi-tenant instance (people create
// workspaces and switch between them): the port after the fourth one unless E2E_MULTI_PORT says otherwise.
const multiAppPort = Number(process.env.E2E_MULTI_PORT) || appPort + 4;
// The app of the journey of the operator limits (e2e/operator/, #285): multi-tenant, with the operator API on and a
// real Worker driver (e2e/helpers/runner-process.ts) claiming for it. The port six after the first app unless E2E_OPERATOR_PORT says otherwise.
const operatorAppPort = Number(process.env.E2E_OPERATOR_PORT) || appPort + 6;
// The app of the catalog journey (e2e/operator/catalog-journey.e2e.ts, #435): a fresh multi-tenant instance with the operator API on,
// so the catalog starts empty and the admin builds it in the portal. The port after the operator app unless
// E2E_CATALOG_PORT says otherwise.
const catalogAppPort = Number(process.env.E2E_CATALOG_PORT) || appPort + 7;
// The app of the catalog admin journey (e2e/admin/catalog.e2e.ts, #554): a single-tenant instance that fetches the
// models.dev catalog from the fake (`MODELS_DEV_URL`), so the journey can move a price and fetch again. The port after
// the catalog app unless E2E_CATALOG_ADMIN_PORT says otherwise.
const catalogAdminAppPort =
  Number(process.env.E2E_CATALOG_ADMIN_PORT) || appPort + 8;
// The fake Stripe of the billing journey of a workspace (#505): the catalog admin app sends its Stripe API calls to it, so the port has to be
// known when the app starts. The port after the catalog admin app unless E2E_STRIPE_PORT says otherwise.
const stripeFakePort = Number(process.env.E2E_STRIPE_PORT) || appPort + 9;
// The factory app of the browser journey of the factory pages (e2e/factory, #951): the product `factory` with the capability
// `implementer`, single-tenant. The port after the fake Stripe's unless E2E_FACTORY_PORT says otherwise.
const factoryAppPort = Number(process.env.E2E_FACTORY_PORT) || appPort + 10;
// The fakes get ports of their own, picked once per run by the main Playwright process: random, so that two checkouts never
// collide however their E2E_PORT values are chosen, below the ephemeral range of the kernel (the ports it gives to
// outgoing connections: a fake inside it can find its port taken by a connection of the same run, `listen EADDRINUSE`,
// #585), and probed, so a port that something listens on is never handed out (e2e/helpers/free-port.ts). The choice is
// stored in the environment: Playwright loads this file again in every worker process, which inherits the main process's
// environment, and the apps and fakes the configuration starts get the same values.
const FAKE_PORT_RANGE = { low: 20000, high: EPHEMERAL_FLOOR - 1 } as const;
// The environment variable of each fake and how many ports in a row it takes.
const FAKE_PORTS = {
  E2E_GITHUB_PORT: 1,
  E2E_SMTP_PORT: 3,
  E2E_LLM_PORT: 1,
  E2E_MODEL_LLM_PORT: 1,
  E2E_OPERATOR_LLM_PORT: 1,
  E2E_CATALOG_LLM_PORT: 1,
  E2E_MODELS_DEV_PORT: 1,
} as const;
type FakePortVariable = keyof typeof FAKE_PORTS;

function givenPort(variable: FakePortVariable): number | undefined {
  const given = Number(process.env[variable]);
  return Number.isInteger(given) && given > 0 ? given : undefined;
}

// What the environment already names (a worker process: all of it; a developer: the ports they chose) is out of the pick.
const claimedPorts = new Set<number>();
for (const variable of Object.keys(FAKE_PORTS) as FakePortVariable[]) {
  const given = givenPort(variable);
  if (given === undefined) continue;
  for (let offset = 0; offset < FAKE_PORTS[variable]; offset += 1)
    claimedPorts.add(given + offset);
}

/** The port (or first of the ports in a row) the environment variable names, or a free one picked and stored in it. */
function claimFakePort(variable: FakePortVariable): number {
  const given = givenPort(variable);
  if (given !== undefined) return given;
  const base = pickFreePort({
    ...FAKE_PORT_RANGE,
    count: FAKE_PORTS[variable],
    avoid: claimedPorts,
  });
  process.env[variable] = String(base);
  for (let offset = 0; offset < FAKE_PORTS[variable]; offset += 1)
    claimedPorts.add(base + offset);
  return base;
}

// The fake GitHub.
const githubPort = claimFakePort("E2E_GITHUB_PORT");
// The fake SMTP server takes three ports in a row (the plain one that offers STARTTLS, the one with TLS and the control API
// the journeys read the inbox from).
const smtpPort = claimFakePort("E2E_SMTP_PORT");
// The fake LLM of the journey of the LLM key. The fifth app (multi-tenant) checks keys at this address (the "test key"
// button), so the port has to be known when the app starts.
const llmFakePort = claimFakePort("E2E_LLM_PORT");
// The fake LLM of the journeys that save a Dynamic model (#269): the app checks the model's tool support at this address.
const modelLlmFakePort = claimFakePort("E2E_MODEL_LLM_PORT");
// The fake LLM of the operator limits journey (#285): it answers the reviews of the real runner and, at the same port, the
// model metadata the operator app reads when it releases a catalog entry and claims with one.
const operatorLlmFakePort = claimFakePort("E2E_OPERATOR_LLM_PORT");
// The fake LLM of the catalog journey (#435): the same duties as the operator journey's, at a port of its own, so that the
// two journeys can run side by side.
const catalogLlmFakePort = claimFakePort("E2E_CATALOG_LLM_PORT");
// The fake models.dev of the catalog admin journey (#554): the app fetches the catalog from it.
const modelsDevFakePort = claimFakePort("E2E_MODELS_DEV_PORT");

/**
 * The Postgres server the apps under test make their databases on: `E2E_DATABASE_URL`, a URL whose user may create and
 * drop databases (CI: the service container of the job; on a machine: any server you own). The default is the one of
 * the usual throwaway container. Every app has a database of its own, fresh for every run
 * (`cr_e2e_<app>_<port>`, dropped and made again by e2e/prepare-database.ts when the app starts).
 */
export function adminDatabaseUrl(): URL {
  const url = new URL(
    process.env.E2E_DATABASE_URL?.trim() ||
      "postgres://postgres:postgres@127.0.0.1:5432/postgres",
  );
  // A Unix socket (the privileged lane reaches the server through one, e2e/pg-bridge.ts) names its directory as the host.
  const local =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname.toLowerCase().startsWith("%2f");
  if (!local)
    throw new Error(
      "E2E_DATABASE_URL must point at this machine (127.0.0.1): a test never uses a database somewhere else.",
    );
  return url;
}

/** The name and the URL of the database of one app of the run. */
export function appDatabase(app: string): { name: string; url: string } {
  const name = `cr_e2e_${app}_${String(appPort)}`;
  const url = adminDatabaseUrl();
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

export const e2eEnv = {
  appPort,
  /** The database of the app under test (fresh for every run). */
  databaseUrl: appDatabase("main").url,
  githubPort,
  appUrl: `http://127.0.0.1:${appPort}`,
  pipelineAppPort,
  /** The database of the second app, which runs the real review (fresh for every run). */
  pipelineDatabaseUrl: appDatabase("pipeline").url,
  pipelineAppUrl: `http://127.0.0.1:${pipelineAppPort}`,
  setupAppPort,
  /** The database of the third app, which the setup journey sets up (fresh for every run). */
  setupDatabaseUrl: appDatabase("setup").url,
  setupAppUrl: `http://127.0.0.1:${setupAppPort}`,
  signupAppPort,
  /** The database of the fourth app, which the sign-up journey uses (fresh for every run). */
  signupDatabaseUrl: appDatabase("signup").url,
  signupAppUrl: `http://127.0.0.1:${signupAppPort}`,
  multiAppPort,
  /** The database of the fifth app, which is multi-tenant (fresh for every run). */
  multiDatabaseUrl: appDatabase("multi").url,
  multiAppUrl: `http://127.0.0.1:${multiAppPort}`,
  operatorAppPort,
  /** The database of the operator app (#285) (fresh for every run). */
  operatorDatabaseUrl: appDatabase("operator").url,
  operatorAppUrl: `http://127.0.0.1:${operatorAppPort}`,
  catalogAppPort,
  /** The database of the catalog app (#435) (fresh for every run). */
  catalogDatabaseUrl: appDatabase("catalog").url,
  catalogAppUrl: `http://127.0.0.1:${catalogAppPort}`,
  catalogAdminAppPort,
  /** The database of the catalog admin app (#554) (fresh for every run). */
  catalogAdminDatabaseUrl: appDatabase("catalog_admin").url,
  catalogAdminAppUrl: `http://127.0.0.1:${catalogAdminAppPort}`,
  factoryAppPort,
  /** The database of the factory app (#951) (fresh for every run). */
  factoryDatabaseUrl: appDatabase("factory").url,
  factoryAppUrl: `http://127.0.0.1:${factoryAppPort}`,
  stripeFakePort,
  /** The fake Stripe (`fakes/stripe`): the address of the catalog admin app's Stripe API calls (`STRIPE_API_BASE_URL`, test stack only). */
  stripeFakeUrl: `http://127.0.0.1:${stripeFakePort}`,
  /** The API key the fake Stripe accepts; a dummy, and the one the journey saves in the admin portal. */
  stripeFakeApiKey: "sk_test_E2eFakeStripeKey0123456789abcdef",
  modelsDevFakePort,
  /** The fake models.dev of the catalog admin app (`MODELS_DEV_URL`). */
  modelsDevFakeUrl: `http://127.0.0.1:${modelsDevFakePort}/api.json`,
  catalogLlmFakePort,
  /** The fake LLM of the catalog app: reviews and model metadata (`LLM_API_BASE_URL`). */
  catalogLlmFakeApiUrl: `http://127.0.0.1:${catalogLlmFakePort}/api/v1`,
  operatorLlmFakePort,
  /** The fake LLM of the operator app: reviews and model metadata (`LLM_API_BASE_URL`). */
  operatorLlmFakeApiUrl: `http://127.0.0.1:${operatorLlmFakePort}/api/v1`,
  /**
   * The fake SMTP server (fakes/smtp): the journey of the mail page configures the fourth app to send to it
   * (host, STARTTLS port, TLS port, a login), and every journey that reads a mail reads the "inbox" from its
   * control API.
   */
  smtp: {
    host: "127.0.0.1",
    port: smtpPort,
    tlsPort: smtpPort + 1,
    controlPort: smtpPort + 2,
    controlUrl: `http://127.0.0.1:${smtpPort + 2}`,
    user: "e2e-mailer",
    password: "e2e-smtp-password-0123456789",
  },
  /** Where each app's output goes (relative to the app folder). The files are fresh for every run. */
  logFiles: {
    app: "test-results/e2e-app.log",
    pipeline: "test-results/e2e-pipeline.log",
    setup: "test-results/e2e-setup.log",
    signup: "test-results/e2e-signup.log",
    multi: "test-results/e2e-multi.log",
    operator: "test-results/e2e-operator.log",
    catalog: "test-results/e2e-catalog.log",
    catalogAdmin: "test-results/e2e-catalog-admin.log",
    factory: "test-results/e2e-factory.log",
  },
  /** The instance admin the journeys create when they set an app up. A dummy, as everything here. */
  adminEmail: "admin@e2e.test",
  adminPassword: "e2e-admin-passphrase-orbit-lantern-77",
  githubUrl: `http://127.0.0.1:${githubPort}`,
  /** The fake LLM of the LLM key journey; the fifth app is pointed at its `/api/v1` (LLM_API_BASE_URL). */
  llmFakePort,
  llmFakeApiUrl: `http://127.0.0.1:${llmFakePort}/api/v1`,
  /** The fake LLM that answers the model metadata for the journeys that save a Dynamic model (#269). */
  modelLlmFakePort,
  modelLlmFakeApiUrl: `http://127.0.0.1:${modelLlmFakePort}/api/v1`,
  githubClientId: "e2e-client-id",
  githubClientSecret: "e2e-client-secret-value",
  appSecret: "e2e-app-secret-0123456789-0123456789-abcdef",
  // The production server refuses to start without the runner token. A dummy: only the journey of
  // e2e/jobs starts a runner that talks to an app (the second one); the others act on the queue
  // through its code (e2e/helpers/job-queue.ts).
  runnerToken: "e2e-runner-token-0123456789-0123456789-abcdef",
  // The GitHub App of the apps under test, which the run enters in the admin portal of each (e2e/setup/
  // prepare-apps.e2e.ts). The webhook secret matters to the journeys (they sign deliveries with it); the
  // private key is generated for each run in playwright.config.ts and handed on through the environment.
  githubAppId: "424242",
  githubAppSlug: "code-reviewer-e2e",
  /** The login the app's comments are written as at the fake GitHub. */
  githubBotLogin: "code-reviewer-e2e[bot]",
  githubAppWebhookSecret: "e2e-webhook-secret-value",
  /** The token of the operator API of the operator app (#285): a dummy, the script of the journey sends it. */
  operatorApiToken: "e2e-operator-api-token-0123456789-0123456789-abcdef",
};

/**
 * The LLM access of the second app. The key is a dummy that must never show up anywhere: the fake
 * LLM quotes it in its errors, and the journey searches every output for it. The model is one
 * PR-Agent does not know, so the context window is given too.
 */
export const llmEnv = {
  provider: "openrouter",
  apiKey: "e2e-llm-key-0123456789-0123456789-abcdef",
  model: "test/fake-model",
  maxTokens: "32000",
};

/**
 * The private key of the GitHub App registered at the fake GitHub (a throwaway made for each run in
 * playwright.config.ts and passed on in the environment, never written anywhere), for the journeys that
 * enter the App in the admin portal.
 */
export function githubAppPrivateKey(): string {
  const key = process.env.E2E_GITHUB_APP_PRIVATE_KEY;
  if (key === undefined || key === "")
    throw new Error("playwright.config.ts did not make the GitHub App key.");
  return key;
}
