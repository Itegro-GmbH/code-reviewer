// SPDX-License-Identifier: LicenseRef-Proprietary

// Addresses, files and dummy credentials of the hosted end-to-end lane (#332, playwright.hosted.config.ts and the
// journeys of e2e/hosted/): the app in its serverless mode over Postgres, the Dispatcher as a process, and the loopback
// fakes. Shared by the configuration (which starts the app and the fake GitHub) and the journeys (which start the
// Dispatcher and the fake LLM). Nothing here is a secret: the values only have to match between the processes under
// test, and they differ from each other (the app refuses a signing secret that is another credential).
import { adminDatabaseUrl, e2eEnv } from "./e2e-env";

const appPort = Number(process.env.E2E_HOSTED_PORT) || 3617;
// The Dispatcher listens on the next port; the app is told its address at start (RUNNER_WEBHOOK_URL), and the
// journeys start and stop the process, so "the Dispatcher is down" is simply that nothing listens there.
const dispatcherPort = appPort + 1;

for (const port of [appPort, dispatcherPort])
  if (port === 3000 || port === 3100)
    throw new Error(
      `The hosted lane must not use port ${String(port)}: other work runs there. Set E2E_HOSTED_PORT to a private one.`,
    );

/** The server URL with the database of this run's app (`cr_e2e_hosted_<port>`, dropped and made again at start). */
export function hostedDatabaseUrls(): {
  admin: string;
  app: string;
  name: string;
} {
  const admin = adminDatabaseUrl();
  const name = `cr_e2e_hosted_${String(appPort)}`;
  const app = new URL(admin);
  app.pathname = `/${name}`;
  return { admin: admin.toString(), app: app.toString(), name };
}

const directory = "test-results/e2e-hosted";

// The second app of the privileged lane, the factory's (#767): the product `factory` with the capability `implementer`, in
// the same mode as the first (serverless, a signed call wakes the Dispatcher), over a database of its own. The Dispatcher
// of its journey serves both apps (the first as the legacy `reviewer`, this one as an entry of `DISPATCHER_APPS`), so every
// credential of it differs from every credential of the first, as the Dispatcher demands.
const factoryPort = appPort + 2;
for (const port of [factoryPort])
  if (port === 3000 || port === 3100)
    throw new Error(
      `The factory app of the lane must not use port ${String(port)}: other work runs there. Set E2E_HOSTED_PORT to a private one.`,
    );

/** The server URL with the database of the factory app (`cr_e2e_factory_<port>`, dropped and made again at start). */
export function factoryDatabaseUrls(): {
  admin: string;
  app: string;
  name: string;
} {
  const admin = adminDatabaseUrl();
  const name = `cr_e2e_factory_${String(factoryPort)}`;
  const app = new URL(admin);
  app.pathname = `/${name}`;
  return { admin: admin.toString(), app: app.toString(), name };
}

const factoryDirectory = "test-results/e2e-factory";

export const factoryEnv = {
  appPort: factoryPort,
  appUrl: `http://127.0.0.1:${String(factoryPort)}`,
  directory: factoryDirectory,
  logFiles: {
    app: `${factoryDirectory}/app.log`,
    dispatcher: `${factoryDirectory}/dispatcher.log`,
  },
  /** The records of the journey's Dispatcher and its `docker` stand-in, kept apart from the first journey's. */
  dockerDirectory: `${factoryDirectory}/docker`,
  controlDirectory: `${factoryDirectory}/control`,
  secretsDirectory: `${factoryDirectory}/secrets`,
  /** The id of the app in the Dispatcher's registry (`DISPATCHER_APPS`). */
  registryId: "factory",
  webhookKeyId: "e2f1",
  webhookSecret: "e2f-dispatch-webhook-secret-0123456789-abcdef",
  /** What the factory app and the Dispatcher's entry for it share: the claim's credential. */
  dispatcherToken: "e2f-dispatcher-token-0123456789-0123456789-abcdef",
  /** The Dispatcher's operator credential (`/probe`, required with `DISPATCHER_APPS`). */
  operatorToken: "e2f-operator-token-0123456789-0123456789-abcdef",
  cronSecret: "e2f-cron-secret-0123456789-0123456789-abcdef",
};

export const hostedEnv = {
  appPort,
  appUrl: `http://127.0.0.1:${String(appPort)}`,
  dispatcherPort,
  dispatcherUrl: `http://127.0.0.1:${String(dispatcherPort)}`,
  /** Where the lane keeps its files, relative to the app folder; fresh for every run. */
  directory,
  logFiles: {
    app: `${directory}/app.log`,
    dispatcher: `${directory}/dispatcher.log`,
  },
  /** One JSON line per connection of the Worker host and the job process (the runner's connect guard); loopback only. */
  connectionLog: `${directory}/connections.jsonl`,
  /**
   * What the lane knows that no log may hold: the start documents the Worker was given (with the per-job credential),
   * the session cookies and the setup code. Never scanned itself; every log is scanned for what is in it.
   */
  secretsDirectory: `${directory}/secrets`,
  /** The records of the `docker` stand-in (`fakes/sandbox/bin/docker-worker.sh`): one set of files per container. */
  dockerDirectory: `${directory}/docker`,
  /** What a journey writes to steer the Dispatcher process (`dispatcher/src/test-support/hosted-e2e-main.ts`). */
  controlDirectory: `${directory}/control`,
  /** The key the app signs the wake-up call with (the Dispatcher's `DISPATCHER_SIGNING_*`), 32 characters at least. */
  webhookKeyId: "e2e1",
  webhookSecret: "e2e-dispatch-webhook-secret-0123456789-abcdef",
  /** `Authorization: Bearer` of the cron routes. */
  cronSecret: "e2e-cron-secret-0123456789-0123456789-abcdef",
  /** The id of the Dispatcher's pool, which the app counts running jobs by. */
  poolId: "e2e-pool",
  /** The image id the Launcher requires and the `docker` stand-in reports. A dummy: no image exists. */
  imageId: `sha256:${"e2e0".repeat(16)}`,
  // The same dummies as every other app of the e2e runs: the master key, the dispatcher credential and the
  // runner token are the shared ones; the signing secret and the cron secret above are the lane's own.
  appSecret: e2eEnv.appSecret,
  dispatcherToken: e2eEnv.runnerToken,
};

/** Every credential of the lane, to search outputs for. */
export function hostedSecrets(): string[] {
  return [
    hostedEnv.webhookSecret,
    hostedEnv.cronSecret,
    hostedEnv.appSecret,
    hostedEnv.dispatcherToken,
  ];
}

/** Every credential of the factory app and the Dispatcher's entry for it, to search outputs for. */
export function factorySecrets(): string[] {
  return [
    factoryEnv.webhookSecret,
    factoryEnv.dispatcherToken,
    factoryEnv.operatorToken,
    factoryEnv.cronSecret,
  ];
}
