// SPDX-License-Identifier: LicenseRef-Proprietary

// Turns the dispatch settings into the hook `createJobQueue` takes (`onEnqueued`): in poll mode (the default)
// there is none, so nothing runs and nothing is written; in webhook mode the hook hands the send to
// `schedule`, which in the app is Next's `after()` (src/dispatch/shared.ts), so the send starts only once
// the answer to the caller is on its way. A bad setting turns the dispatch off for that call and says why
// (by variable name, never by value): the start check (src/deploy/startup.ts) is what refuses it loudly.
import "server-only";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { EnqueueResult } from "../jobs/job-types.ts";
import {
  DispatchConfigError,
  loadDispatchConfig,
  type WebhookDispatchConfig,
} from "./config.ts";
import type { RingService } from "./rings.ts";
import { createDispatchService, type DispatchService } from "./service.ts";
import { testInlineRetryDelays } from "./test-timing.ts";

type Env = Readonly<Record<string, string | undefined>>;

export type DispatchHookOptions = {
  env: Env;
  db: Kysely<Database>;
  /** Runs the work after the response (`after()`); the work never rejects. */
  schedule: (work: () => Promise<void>) => void;
  /** Where a bad setting is reported. */
  reportInvalid?: (line: string) => void;
  /** A monotonic clock in milliseconds (default `performance.now`); tests move it by hand. */
  monotonicMs?: () => number;
  /** The service to use instead of the real one (tests). */
  service?: (config: WebhookDispatchConfig) => DispatchService;
  /**
   * #972: the doorbell to the webhook dispatchers of customers. It rings beside the platform's wake-up call, not behind its retries; none
   * is made when it is left out.
   */
  rings?: RingService;
};

export function createDispatchHook(
  options: DispatchHookOptions,
): ((result: EnqueueResult) => void) | undefined {
  let config;
  try {
    config = loadDispatchConfig(options.env);
  } catch (error) {
    if (error instanceof DispatchConfigError)
      options.reportInvalid?.(`[dispatch] ${error.code}: ${error.message}`);
    else throw error;
    return undefined;
  }
  if (config.mode === "poll") return undefined;

  const delays = testInlineRetryDelays(options.env);
  const service =
    options.service?.(config) ??
    createDispatchService({
      db: options.db,
      config,
      ...(delays === undefined ? {} : { inlineRetryDelaysMs: delays }),
    });
  const monotonicMs = options.monotonicMs ?? (() => performance.now());
  return (result) => {
    // The function lives from the start of the request, and `after()` runs the work later: the time is noted now so that
    // the budget of the inline retries counts what the request already used (#479).
    const receivedAt = monotonicMs();
    options.schedule(async () => {
      // Side by side: the platform's call may spend its inline retries, and the customers' dispatchers must not wait for them.
      await Promise.all([
        service.onEnqueued(result, { receivedAt }),
        options.rings?.onEnqueued(result),
      ]);
    });
  };
}
