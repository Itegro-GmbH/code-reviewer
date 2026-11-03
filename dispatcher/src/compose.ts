// SPDX-License-Identifier: LicenseRef-Proprietary

// What both entry points share: the settings from the environment, the Webhook-Trigger over the
// configured keys (one set per app, #730), the stop route and the reaper where there is a platform fleet (with several apps
// also the fleet cap), and a logger that masks every secret of this deployment, every app's included.
import { createDispatcher, type Dispatcher } from "./dispatcher-app.ts";
import { loadSettings, type Settings } from "./config.ts";
import { createLogger } from "./core/logger.ts";
import type { Launcher, Logger } from "./core/types.ts";
import type { LauncherContext, ReaperSetup } from "./launchers/sandbox-env.ts";
import { createAppClient } from "./core/app-client.ts";
import { liveJobVmsByApp } from "./reaper/live-vms.ts";
import { createReaper } from "./reaper/reaper.ts";
import { mountReaperRoute } from "./reaper/route.ts";
import { publicUrlOf } from "./network/public-url.ts";
import { mountNetworkRoute } from "./triggers/network.ts";
import { mountStopRoute } from "./triggers/stop.ts";
import { webhookTrigger } from "./triggers/webhook.ts";

export type ComposeOptions = {
  env: Readonly<Record<string, string | undefined>>;
  /** A Launcher, or how to make one once the settings, the logger and the background tracker exist. */
  launcher: Launcher | ((context: LauncherContext) => Launcher);
  /** Secrets of the launcher's own configuration (a platform token), masked in every log line next to the core's. */
  secrets?: readonly string[];
  /** `waitUntil` on the platform, the tracker of the Node entry. */
  background: (work: Promise<unknown>) => void;
  /** The reaper's platform side (#364): its cron route is mounted when there is one. */
  reaper?: (settings: Settings) => ReaperSetup;
  logger?: Logger;
  fetch?: typeof fetch;
};

export function composeDispatcher(
  options: ComposeOptions,
): Dispatcher & { settings: Settings; logger: Logger } {
  const settings = loadSettings(options.env);
  const logger =
    options.logger ??
    createLogger(
      (line) => console.log(line),
      [
        ...settings.core.apps.map((configured) => configured.token),
        ...settings.signingKeys.map((key) => key.secret),
        ...(settings.operatorToken === undefined
          ? []
          : [settings.operatorToken]),
        ...(settings.cronSecret === undefined ? [] : [settings.cronSecret]),
        ...(options.secrets ?? []),
      ],
    );
  const launcher =
    typeof options.launcher === "function"
      ? options.launcher({
          settings,
          logger,
          background: options.background,
        })
      : options.launcher;
  // A malformed CRON_SECRET matters only where the route exists: there it refuses the start (fail closed), elsewhere
  // a Dispatcher that never reaps is not taken down by a variable it does not use.
  if (settings.cronSecretProblem !== undefined) {
    if (options.reaper !== undefined) throw settings.cronSecretProblem;
    logger.warn("cron_secret_ignored", {
      variable: settings.cronSecretProblem.variable,
      reason: settings.cronSecretProblem.reason,
    });
  }
  const setup = options.reaper?.(settings);
  // The platform's side of the fleet (#364) is also what counts the live VMs of every app for its cap (#730), but only where
  // there is another app to protect: with one app the listing would cost a platform call and two new ways to refuse, for
  // nothing the App's own cap does not already do.
  const liveVms =
    setup !== undefined && settings.core.apps.length > 1
      ? liveJobVmsByApp(setup.fleet, { logger })
      : undefined;
  const dispatcher = createDispatcher({
    settings: settings.core,
    launcher,
    background: options.background,
    trigger: webhookTrigger({ keys: settings.signingKeys }),
    logger,
    fetch: options.fetch,
    ...(liveVms === undefined ? {} : { liveVms }),
    ...(settings.operatorToken === undefined
      ? {}
      : { operatorToken: settings.operatorToken }),
    ...(options.env.SANDBOX_IMAGE_DIGEST === undefined
      ? {}
      : { imageDigest: options.env.SANDBOX_IMAGE_DIGEST }),
    ...(options.env.SANDBOX_SNAPSHOT_ID === undefined
      ? {}
      : { snapshotId: options.env.SANDBOX_SNAPSHOT_ID }),
  });
  if (setup !== undefined) {
    // One client per app: a VM's job is asked about at the app its tenant tag names and at no other (#730).
    const clients = new Map(
      settings.core.apps.map((configured) => [
        configured.id,
        createAppClient({
          appUrl: configured.url,
          token: configured.token,
          poolId: configured.poolId,
          fetch: options.fetch ?? fetch,
        }),
      ]),
    );
    mountReaperRoute(dispatcher.app, {
      cronSecret: settings.cronSecret,
      reaper: createReaper({
        fleet: setup.fleet,
        jobs: {
          async jobState(jobId, appId) {
            const client = clients.get(appId);
            // A tenant this Dispatcher does not serve: nothing to ask, so only the VM's lifetime ends it.
            if (client === undefined) return { kind: "unreadable" };
            return client.jobState(jobId);
          },
        },
        logger,
        jobLifetimeSeconds: setup.jobLifetimeSeconds,
        canaryLifetimeSeconds: setup.canaryLifetimeSeconds,
      }),
      logger,
    });
    // The App's stop call (#487) ends a job's VM with the same fleet and the keys of the wake-up call.
    mountStopRoute(dispatcher.app, {
      keys: settings.signingKeys,
      fleet: setup.fleet,
      logger,
      background: options.background,
    });
    // #745, step 7: the call by which an Implementer VM's Control container has its network policy narrowed after the setup (the
    // second wall of the network door). Only where there is a platform fleet and an address to be called at.
    const publicUrl = publicUrlOf(options.env);
    if (publicUrl !== undefined)
      mountNetworkRoute(dispatcher.app, {
        apps: settings.core.apps,
        keys: settings.signingKeys,
        fleet: setup.fleet,
        publicUrl,
        logger,
      });
    // Without it the route refuses everyone and leftover VMs are billed until their own timeout.
    if (settings.cronSecret === undefined)
      logger.warn("reaper_cron_secret_missing");
  }
  return { ...dispatcher, settings, logger };
}
