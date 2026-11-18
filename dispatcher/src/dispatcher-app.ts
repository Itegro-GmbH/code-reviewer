// SPDX-License-Identifier: LicenseRef-Proprietary

// Puts the Dispatcher together: the core (over a Launcher), one Trigger and GET /health on a Hono app.
// Nothing here knows the platform: the entry points (index.ts for Vercel, node.ts for a Node process)
// choose the Launcher and say how background work is kept alive.
import { Hono } from "hono";
import { createLogger } from "./core/logger.ts";
import { imageClaimFeatures } from "./core/claim-features.ts";
import { createDispatcherCore } from "./core/dispatcher.ts";
import { LEGACY_APP_ID } from "./core/types.ts";
import type {
  Clock,
  CoreSettings,
  DispatcherCore,
  Launcher,
  LiveVmCounter,
  Logger,
} from "./core/types.ts";
import { mountAppsCheckRoute } from "./probe/apps-check.ts";
import { mountProbeRoute } from "./probe/route.ts";
import type { Trigger } from "./triggers/types.ts";

export type AppOptions = {
  settings: CoreSettings;
  trigger: Trigger;
  launcher: Launcher;
  /** Keeps the launch going after the answer is sent: `waitUntil` on the platform. */
  background: (work: Promise<unknown>) => void;
  logger?: Logger;
  fetch?: typeof fetch;
  clock?: Clock;
  /**
   * `DISPATCHER_OPERATOR_TOKEN` (#730): the credential of `POST /probe` and `POST /apps/check`. Unset, `/probe` is still
   * opened by the token of the app `reviewer` while that is the only app (the rollout fallback); with several apps, and
   * for `/apps/check` always, nobody (a warning is logged).
   */
  operatorToken?: string;
  /** The platform's live job VMs per app: the Dispatcher's own check of every app's cap (`core/dispatcher.ts`). */
  liveVms?: LiveVmCounter;
  /**
   * #1098: the features the Worker image of the golden snapshot lists (`SANDBOX_WORKER_FEATURES`). Only the claim features that
   * depend on the image (`core/claim-features.ts`) are named from it; absent, none is.
   */
  workerFeatures?: readonly string[];
  /** The Worker image id of the golden snapshot (`SANDBOX_IMAGE_DIGEST`): named in the answer of `POST /probe`. */
  imageDigest?: string;
  /** The golden snapshot (`SANDBOX_SNAPSHOT_ID`): named in the answer of `POST /probe` too. */
  snapshotId?: string;
};

export type Dispatcher = { app: Hono; core: DispatcherCore };

export function createDispatcher(options: AppOptions): Dispatcher {
  const logger =
    options.logger ??
    createLogger(
      (line) => console.log(line),
      options.settings.apps.map((configured) => configured.token),
    );
  const core = createDispatcherCore({
    settings: options.settings,
    launcher: options.launcher,
    logger,
    fetch: options.fetch,
    clock: options.clock,
    ...(options.liveVms === undefined ? {} : { liveVms: options.liveVms }),
    imageFeatures: imageClaimFeatures(options.workerFeatures),
  });
  const app = new Hono();
  app.get("/health", (c) => c.json({ status: "ok" }));
  options.trigger.mount(app, { core, background: options.background, logger });
  // The probe starts canary VMs, which cost money: an app's own credential must not open it. With one app and no operator
  // token (the Dispatcher as it was before #730) the token of `reviewer` still does; with several apps only the operator
  // token does, so no app's credential, the reviewer's included, can start a canary VM.
  const severalApps = options.settings.apps.length > 1;
  const fallback = severalApps
    ? undefined
    : options.settings.apps.find(
        (configured) => configured.id === LEGACY_APP_ID,
      )?.token;
  const probeToken = options.operatorToken ?? fallback;
  if (options.operatorToken === undefined && severalApps)
    logger.warn("operator_token_missing", {
      note: "POST /probe and POST /apps/check refuse everyone until DISPATCHER_OPERATOR_TOKEN is set",
    });
  mountAppsCheckRoute(app, {
    token: options.operatorToken,
    apps: options.settings.apps,
    logger,
    fetch: options.fetch,
  });
  mountProbeRoute(app, {
    token: probeToken,
    engines: options.settings.engines,
    launcher: options.launcher,
    logger,
    ...(options.imageDigest === undefined
      ? {}
      : { imageDigest: options.imageDigest }),
    ...(options.snapshotId === undefined
      ? {}
      : { snapshotId: options.snapshotId }),
  });
  app.onError((_error, c) => {
    // The error is not logged with its text: it may carry what a caller sent.
    logger.error("unhandled_error");
    return c.json(
      {
        error: {
          code: "RUNNER_INTERNAL_ERROR",
          message: "The request could not be handled.",
        },
      },
      500,
    );
  });
  return { app, core };
}

/** `createApp({ trigger, launcher })` of the design: the Hono app of a Dispatcher. */
export function createApp(options: AppOptions): Hono {
  return createDispatcher(options).app;
}
