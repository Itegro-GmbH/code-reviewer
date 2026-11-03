// SPDX-License-Identifier: LicenseRef-Proprietary

// The Sandbox-Launcher from the environment, for the Vercel entry (#329). Names only; a refusal names the
// variable and never the value.
//
// | Variable                                           | Meaning                                                            | Default |
// |----------------------------------------------------|--------------------------------------------------------------------|---------|
// | SANDBOX_SNAPSHOT_ID                                | The golden snapshot (#330 record `snapshotId`)                     | none: no launcher, nothing is claimed |
// | SANDBOX_IMAGE_DIGEST                               | The Worker image id in it (#330 record `imageDigest`), `sha256:...` | required with the snapshot |
// | SANDBOX_SYSBOX_PROOF                              | The snapshot's Sysbox verdict (#330 record `sysbox`): `proven` or `unproven`, a member of the snapshot pair. Only `proven` lets the Implementer start, anything else ends its turn `sandbox_unproven` (free); reviews never read it, whatever it holds | none: `unproven` |
// | SANDBOX_HANDOVER_SECONDS                           | How long the container runs before the Worker counts as having taken over (1 to 120) | 20 |
// | SANDBOX_VM_TIMEOUT_MARGIN_SECONDS                 | Seconds added to the job's timeout for the VM's own (the backstop that ends a VM nobody stops); at least 180 and 150 more than the hand-over time, at most 3600 | 300 |
// | DISPATCHER_PROBE_TIMEOUT_SECONDS                  | How long a probe (`POST /probe`, the deploy canary) may take, canary VM included (30 to 600); the reaper (#364) takes a canary's lifetime from it | 150 |
// | DISPATCHER_PROBE_REUSE_SECONDS                    | A forced probe (`POST /probe`) is served from an answer younger than this instead of a new canary VM (0 to 600; 0: never) | 60 |
// | DISPATCHER_PROBE_TTL_SECONDS                      | **Deprecated (#479), ignored.** Dispatch no longer runs a probe, so no answer has a time to live. Any value is accepted with a warning, for one release, so that an existing deployment still starts | none |
// | RUNNER_DYNAMIC_CAPABILITIES, RUNNER_DYNAMIC_MAX_COST_USD | The operator's Dynamic configuration, given to the container of a Dynamic job and to the canary (a JSON object; a plain positive decimal) | none |
// | DISPATCHER_PUBLIC_URL                              | #745 step 7: the https address this Dispatcher is reached at, the base of the network switch call a VM makes (`POST /network`) | `https://$VERCEL_PROJECT_PRODUCTION_URL`; neither: no switch, the VM's policy is not narrowed |
// | VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID    | Platform access by token. Without a token the OIDC token is used   | OIDC |
//
// VM size and container memory per Worker kind are part of DISPATCHER_WORKER_CONFIG (`launcher.vcpus`,
// `container.memory`), validated here at start.
import {
  ConfigError,
  integer,
  read,
  type Environment,
  type Settings,
} from "../config.ts";
import {
  longestJobTimeoutSeconds,
  type Launcher,
  type Logger,
} from "../core/types.ts";
import { systemClock } from "../core/clock.ts";
import { publicUrlOf, NETWORK_ROUTE_PATH } from "../network/public-url.ts";
import { switchToken } from "../network/switch-token.ts";
import { createCapabilityProbe } from "../probe/capability-probe.ts";
import { withProbeEndpoint } from "../probe/probe-endpoint.ts";
import type { SandboxFleet, SandboxService } from "./sandbox-service.ts";
import { noLauncher } from "./none.ts";
import {
  IMPLEMENTER_PROBE_EXTRA_SECONDS,
  createSandboxCanary,
} from "./sandbox-canary.ts";
import {
  LAUNCH_STEPS_SECONDS,
  createSandboxLauncher,
  minimumVmTimeoutMargin,
  validateKindConfig,
  VM_TIMEOUT_MARGIN_SECONDS,
  type SysboxProof,
} from "./sandbox.ts";
import {
  createVercelSandboxService,
  type SandboxSdk,
  type VercelCredentials,
} from "./vercel-sandbox.ts";

const SNAPSHOT_ID = /^[A-Za-z0-9_-]{3,128}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const PLAIN = /^[^\s\p{Cc}]+$/u;
const NO_CONTROL = /^[^\p{Cc}]+$/u;
const PLAIN_DECIMAL = /^(?:0|[1-9]\d{0,5})(?:\.\d{1,6})?$/;
const MAX_DESCRIPTOR_LENGTH = 4096;

export type LauncherContext = {
  settings: Settings;
  logger: Logger;
  /** `waitUntil` on the platform, the tracker of the Node entry. */
  background: (work: Promise<unknown>) => void;
};

/** What the reaper (#364) needs of the platform side, and how long each kind of VM may live before it is overdue. */
export type ReaperSetup = {
  fleet: SandboxFleet;
  /** A job VM's lifetime when the platform reports none: the job timeout plus the VM margin. */
  jobLifetimeSeconds: number;
  /** A canary VM's (#331): the probe timeout plus the VM margin. */
  canaryLifetimeSeconds: number;
};

export type SandboxFromEnvironment = {
  /** The launcher for a composed Dispatcher: the Sandbox-Launcher, or `noLauncher` when no snapshot is configured. */
  launcher: (context: LauncherContext) => Launcher;
  /** Secrets of this part of the configuration, for the logger's masker. */
  secrets: string[];
  /** The reaper's platform side; undefined when no snapshot is configured, so there is nothing to reap and no route. */
  reaper?: (settings: Settings) => ReaperSetup;
};

function credentials(env: Environment): VercelCredentials | undefined {
  const token = read(env, "VERCEL_TOKEN");
  if (token === undefined) return undefined;
  if (!PLAIN.test(token)) throw new ConfigError("VERCEL_TOKEN", "invalid");
  const teamId = read(env, "VERCEL_TEAM_ID");
  if (teamId === undefined) throw new ConfigError("VERCEL_TEAM_ID", "required");
  const projectId = read(env, "VERCEL_PROJECT_ID");
  if (projectId === undefined)
    throw new ConfigError("VERCEL_PROJECT_ID", "required");
  for (const [name, value] of [
    ["VERCEL_TEAM_ID", teamId],
    ["VERCEL_PROJECT_ID", projectId],
  ] as const)
    if (!PLAIN.test(value)) throw new ConfigError(name, "invalid");
  return { token, teamId, projectId };
}

/**
 * The operator's Dynamic configuration for the container (names of the spec's allow-list): refused at start when
 * the value could not be given to a container or the runner would refuse it, so a typo does not wait for the
 * first Dynamic job. The runner reads the values again and decides what they mean; here only their form is held.
 */
function dynamicEnvironment(env: Environment): Record<string, string> {
  const result: Record<string, string> = {};
  const capabilities = read(env, "RUNNER_DYNAMIC_CAPABILITIES");
  if (capabilities !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(capabilities);
    } catch {
      throw new ConfigError("RUNNER_DYNAMIC_CAPABILITIES", "invalid");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      capabilities.length > MAX_DESCRIPTOR_LENGTH ||
      !NO_CONTROL.test(capabilities)
    )
      throw new ConfigError("RUNNER_DYNAMIC_CAPABILITIES", "invalid");
    result.RUNNER_DYNAMIC_CAPABILITIES = capabilities;
  }
  const cost = read(env, "RUNNER_DYNAMIC_MAX_COST_USD");
  if (cost !== undefined) {
    if (!PLAIN_DECIMAL.test(cost) || Number(cost) <= 0)
      throw new ConfigError("RUNNER_DYNAMIC_MAX_COST_USD", "invalid");
    result.RUNNER_DYNAMIC_MAX_COST_USD = cost;
  }
  return result;
}

export function sandboxFromEnvironment(
  env: Environment,
  loadSdk: () => Promise<SandboxSdk>,
  /** The platform service; the Vercel one unless a test brings its own. */
  service?: SandboxService & SandboxFleet,
): SandboxFromEnvironment {
  const snapshotId = read(env, "SANDBOX_SNAPSHOT_ID");
  const imageDigest = read(env, "SANDBOX_IMAGE_DIGEST");
  if (snapshotId === undefined && imageDigest === undefined)
    return { launcher: () => noLauncher, secrets: [] };

  // One without the other is a mistake, not "off": a Dispatcher that claims nothing would look healthy.
  if (snapshotId === undefined)
    throw new ConfigError("SANDBOX_SNAPSHOT_ID", "required");
  if (!SNAPSHOT_ID.test(snapshotId))
    throw new ConfigError("SANDBOX_SNAPSHOT_ID", "invalid");
  if (imageDigest === undefined)
    throw new ConfigError("SANDBOX_IMAGE_DIGEST", "required");
  if (!IMAGE_DIGEST.test(imageDigest))
    throw new ConfigError("SANDBOX_IMAGE_DIGEST", "invalid");
  // Only the Implementer's gate reads the verdict, and only `proven` opens it: a value that is missing or not exactly that is
  // `unproven`. It is never an error here, because a Dispatcher that serves reviews must start whatever this variable holds.
  const sysboxProof: SysboxProof =
    read(env, "SANDBOX_SYSBOX_PROOF") === "proven" ? "proven" : "unproven";
  const handoverSeconds = integer(env, "SANDBOX_HANDOVER_SECONDS", {
    min: 1,
    max: 120,
    fallback: 20,
  });
  const vmTimeoutMarginSeconds = integer(
    env,
    "SANDBOX_VM_TIMEOUT_MARGIN_SECONDS",
    { min: 1, max: 3600, fallback: VM_TIMEOUT_MARGIN_SECONDS },
  );
  if (vmTimeoutMarginSeconds < minimumVmTimeoutMargin(handoverSeconds))
    throw new ConfigError("SANDBOX_VM_TIMEOUT_MARGIN_SECONDS", "invalid");
  // Obsolete since #479: dispatch runs no probe. Accepted, whatever it holds, so an existing deployment still starts.
  const probeTtlSet = read(env, "DISPATCHER_PROBE_TTL_SECONDS") !== undefined;
  const probeTimeoutSeconds = integer(env, "DISPATCHER_PROBE_TIMEOUT_SECONDS", {
    min: 30,
    max: 600,
    fallback: 150,
  });
  const probeReuseSeconds = integer(env, "DISPATCHER_PROBE_REUSE_SECONDS", {
    min: 0,
    max: 600,
    fallback: 60,
  });
  /** The time of the probe: the configured one, and for a deployment that serves the Implementer the work volume and its probe. */
  const probeSecondsFor = (servesImplementer: boolean) =>
    probeTimeoutSeconds +
    (servesImplementer ? IMPLEMENTER_PROBE_EXTRA_SECONDS : 0);
  const publicUrl = publicUrlOf(env);
  const access = credentials(env);
  const secrets = [access?.token, read(env, "VERCEL_OIDC_TOKEN")].filter(
    (secret): secret is string => secret !== undefined,
  );
  // One service for the launcher and the reaper: the platform's access is configured once.
  const platform = service ?? createVercelSandboxService(loadSdk, access);

  return {
    secrets,
    reaper: (settings) => ({
      fleet: platform,
      jobLifetimeSeconds:
        longestJobTimeoutSeconds(settings.core) + vmTimeoutMarginSeconds,
      // A deployment that serves the Implementer has the canary run a second probe, so its VM lives that much longer.
      canaryLifetimeSeconds:
        probeSecondsFor(settings.core.engines.includes("implementer")) +
        vmTimeoutMarginSeconds,
    }),
    launcher({ settings, logger }) {
      if (probeTtlSet)
        logger.warn("deprecated_setting", {
          variable: "DISPATCHER_PROBE_TTL_SECONDS",
          note: "ignored since #479: dispatch runs no capability probe; the deploy canary is the proof",
        });
      // The launch has the core's deadline from the claim: the hand-over comes after create, the host preparation
      // and the image check, whose own timeouts add up to LAUNCH_STEPS_SECONDS.
      if (
        handoverSeconds + LAUNCH_STEPS_SECONDS >
        settings.core.launchDeadlineSeconds
      )
        throw new ConfigError("SANDBOX_HANDOVER_SECONDS", "invalid");
      for (const kind of ["diff", "dynamic"] as const) {
        try {
          validateKindConfig(kind, settings.core.workerConfig[kind]);
        } catch {
          throw new ConfigError("DISPATCHER_WORKER_CONFIG", "invalid");
        }
      }
      // The Implementer's configuration is read only by a deployment that serves the kind (#760), and a wrong value in it
      // is logged, never thrown: a Dispatcher that does not start fails the canary of every release it deploys. Each launch
      // of the kind is refused with `sandbox_config_invalid` by the same check (`planOf`) until the value is corrected;
      // Diff and Dynamic are untouched by it. **It does block the release of a deployment that serves the kind** (#765):
      // the canary cannot size the Implementer's VM and its half is `implementer_probe_failed`, so `POST /probe` is 503 until
      // the value is corrected or the kind is taken out of `kinds` and the Dispatcher is deployed again.
      if (settings.core.engines.includes("implementer")) {
        try {
          validateKindConfig(
            "implementer",
            settings.core.workerConfig.implementer ?? {},
          );
        } catch {
          logger.error("worker_config_invalid", {
            kind: "implementer",
            variable: "DISPATCHER_WORKER_CONFIG",
            note: "launches of this kind are refused until it is corrected",
          });
        }
      }
      // Only a deployment that serves Dynamic jobs reads (and refuses) the Dynamic configuration: a typo in a variable
      // it does not use must not take its Diff jobs down.
      const serversDynamic = settings.core.engines.includes("opencode");
      // The Launcher advertises `implementer` only for a deployment that serves it (#765), and then the canary has to
      // prove it (`POST /probe` requires every engine the Launcher advertises that the deployment serves).
      const servesImplementer = settings.core.engines.includes("implementer");
      const dynamic = serversDynamic ? dynamicEnvironment(env) : {};
      const launcher = createSandboxLauncher({
        service: platform,
        snapshotId,
        imageDigest,
        sysboxProof,
        handoverSeconds,
        vmTimeoutMarginSeconds,
        logger,
        dynamicEnvironment: dynamic,
        servesImplementer,
        // #745, step 7: what the Control container of an Implementer VM needs to ask for its network policy to be narrowed. The key
        // is the app's current signing secret, the token is derived from it for this purpose only (`network/switch-token.ts`).
        ...(publicUrl === undefined
          ? {}
          : {
              networkSwitch: ({ appId, vm, rule }) => {
                const key = settings.signingKeys.find(
                  (candidate) => candidate.appId === appId,
                );
                if (key === undefined) return undefined;
                return JSON.stringify({
                  url: `${publicUrl}${NETWORK_ROUTE_PATH}`,
                  vm,
                  appId,
                  network: rule,
                  token: switchToken(key.secret, appId, vm, rule),
                });
              },
            }),
      });
      // A deployment that serves neither a Dynamic job nor the Implementer has nothing to prove: no canary VM is ever
      // made for it.
      if (!serversDynamic && !servesImplementer) return launcher;
      // `opencode` is advertised by the Launcher like any engine (#479): a Dynamic job is accepted whenever
      // `DISPATCHER_ENGINES` has it and the snapshot pair is set, and no canary VM is started by a dispatch. The proof is the
      // deploy canary, which must pass before a deployment goes live; the snapshot pair and the settings cannot change
      // during its lifetime. The canary reaches the probe through `POST /probe` only.
      const probe = createCapabilityProbe({
        run: createSandboxCanary({
          service: platform,
          snapshotId,
          imageDigest,
          sysboxProof,
          logger,
          config: settings.core.workerConfig.dynamic,
          environment: dynamic,
          ...(servesImplementer
            ? {
                implementer: {
                  config: settings.core.workerConfig.implementer ?? {},
                },
              }
            : {}),
          timeoutSeconds: probeSecondsFor(servesImplementer),
          vmTimeoutMarginSeconds,
        }),
        clock: systemClock,
        now: () => Date.now(),
        logger,
        timeoutMs: probeSecondsFor(servesImplementer) * 1000,
        forceReuseMs: probeReuseSeconds * 1000,
      });
      return withProbeEndpoint({ launcher, probe });
    },
  };
}
