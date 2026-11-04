// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher of the hosted end-to-end journeys (#332), as a process: the real Node entry (the Webhook-Trigger, the
// core, the capability probe) over the real Sandbox-Launcher, whose platform is the local mode of the Sandbox double
// (`fakes/sandbox/local.ts`) and whose `docker` is `fakes/sandbox/bin/docker-worker.sh`, which runs the REAL Worker
// as a local process. It is the composition of `launchers/sandbox-env.ts` with that one platform and nothing else
// replaced. Test use only: nothing imports it, and no entry of the deployment does.
//
// Settings are the Dispatcher's own (`README.md`, "Configuration") plus:
//
//   E2E_PORT              the port to listen on, on loopback (required)
//   E2E_DOCKER_BIN        the `docker` stand-in (default: fakes/sandbox/bin/docker-worker.sh)
//   E2E_VM_ROOT           where the "VM" directories are made (default: the temporary directory); a lane whose Worker
//                         has a read-only root needs one that stays writable
//   E2E_IMAGE_ID          the image id the stand-in reports and the Launcher requires (required)
//   E2E_CONTROL_DIR       a directory a journey writes to steer this process: `fail-create` holds a number, and the
//                         next that many VM creations fail like a platform that is down (the file is counted down)
//   E2E_HANDOVER_SECONDS  how long the container runs before the Worker counts as having taken over (default 1)
//   E2E_*                 everything else with this prefix goes to the stand-in's environment (`docker-worker.sh`)
//
// One line of JSON per event on stdout, through the same masker as the deployment's.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSandboxService } from "../../../fakes/sandbox/local.ts";
import { integer, loadSettings, read } from "../config.ts";
import { createLogger } from "../core/logger.ts";
import { systemClock } from "../core/clock.ts";
import { startNodeServer } from "./node-host.ts";
import { createSandboxCanary } from "../launchers/sandbox-canary.ts";
import { createSandboxLauncher } from "../launchers/sandbox.ts";
import {
  SandboxServiceError,
  type SandboxFleet,
  type SandboxService,
} from "../launchers/sandbox-service.ts";
import { createCapabilityProbe } from "../probe/capability-probe.ts";
import { withProbeEndpoint } from "../probe/probe-endpoint.ts";

const SNAPSHOT_ID = "snap_e2e_local";
const DEFAULT_DOCKER = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "fakes",
  "sandbox",
  "bin",
  "docker-worker.sh",
);

function required(name: string): string {
  const value = read(process.env, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

/** Takes one failure off the count in `<dir>/fail-create`; true when this creation is to fail. */
function consumeCreateFailure(directory: string | undefined): boolean {
  if (directory === undefined) return false;
  const file = join(directory, "fail-create");
  let left: number;
  try {
    left = Number(readFileSync(file, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(left) || left < 1) return false;
  writeFileSync(file, String(left - 1));
  return true;
}

const env = process.env;
const settings = loadSettings(env);
const imageDigest = required("E2E_IMAGE_ID");
const controlDirectory = read(env, "E2E_CONTROL_DIR");
const handoverSeconds = integer(env, "E2E_HANDOVER_SECONDS", {
  min: 1,
  max: 120,
  fallback: 1,
});
const logger = createLogger(
  (line) => console.log(line),
  [
    ...settings.core.apps.map((configured) => configured.token),
    ...settings.signingKeys.map((key) => key.secret),
  ],
);

const local = new LocalSandboxService({
  dockerBin: read(env, "E2E_DOCKER_BIN") ?? DEFAULT_DOCKER,
  root: read(env, "E2E_VM_ROOT"),
  environment: Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith("E2E_") && entry[1] !== undefined,
    ),
  ),
});
const service: SandboxService & SandboxFleet = {
  async create(options, signal) {
    if (consumeCreateFailure(controlDirectory))
      throw new SandboxServiceError("unavailable");
    return local.create(options, signal);
  },
  stop: (name) => local.stop(name),
  delete: (name) => local.delete(name),
  list: (filter) => local.list(filter),
  // A local Docker host has no network policy of the platform's kind (#745, step 7).
  setNetworkPolicy: () => Promise.resolve(),
};

const dynamicEnvironment: Record<string, string> = {};
for (const name of [
  "RUNNER_DYNAMIC_CAPABILITIES",
  "RUNNER_DYNAMIC_MAX_COST_USD",
] as const) {
  const value = read(env, name);
  if (value !== undefined) dynamicEnvironment[name] = value;
}

// The same rule as the deployment (`launchers/sandbox-env.ts`, #765): the Launcher advertises `implementer` only for a
// deployment that serves the kind, and then the canary proves it in the Implementer's profile.
const servesImplementer = settings.core.engines.includes("implementer");
const sandbox = createSandboxLauncher({
  service,
  snapshotId: SNAPSHOT_ID,
  imageDigest,
  handoverSeconds,
  logger,
  dynamicEnvironment,
  servesImplementer,
});
// The same rule as the deployment (#479): a Dispatcher that serves Dynamic jobs runs no probe on a dispatch; the canary
// is reached through `POST /probe` only.
const launcher =
  settings.core.engines.includes("opencode") || servesImplementer
    ? withProbeEndpoint({
        launcher: sandbox,
        probe: createCapabilityProbe({
          run: createSandboxCanary({
            service,
            snapshotId: SNAPSHOT_ID,
            imageDigest,
            logger,
            config: settings.core.workerConfig.dynamic,
            environment: dynamicEnvironment,
            ...(servesImplementer
              ? {
                  implementer: {
                    config: settings.core.workerConfig.implementer ?? {},
                  },
                }
              : {}),
          }),
          clock: systemClock,
          now: () => Date.now(),
          logger,
        }),
      })
    : sandbox;

const server = await startNodeServer({
  env,
  launcher,
  port: integer(env, "E2E_PORT", { min: 1, max: 65535 }),
  hostname: "127.0.0.1",
  logger,
  // The App's stop call (#487) ends a finished job's VM through this fleet, as the deployment's does through the platform's.
  reaper: () => ({
    fleet: service,
    jobLifetimeSeconds: settings.core.jobTimeoutSeconds + 300,
    canaryLifetimeSeconds: 450,
  }),
});
console.log(
  JSON.stringify({ level: "info", event: "listening", port: server.port }),
);

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await server.shutdown();
      await local.stopAll();
      process.exit(0);
    })();
  });
