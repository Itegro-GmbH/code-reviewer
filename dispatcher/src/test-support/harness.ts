// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Dispatcher tests share: the fake App from fakes/dispatcher-app, a recording logger, dummy
// settings and signed webhook requests. Dummy values only; nothing leaves loopback.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startDispatcherAppFake,
  type DispatcherAppFake,
  type DispatcherAppFakeOptions,
} from "../../../fakes/dispatcher-app/server.ts";
import { signDispatch } from "../../../fakes/dispatcher-app/signing.ts";
import type { CoreSettings, Logger, ReviewKind } from "../core/types.ts";

export const DISPATCHER_TOKEN = "dummy-dispatcher-token-for-tests";
export const SIGNING_SECRET = "dummy-signing-secret-current-0000000000";
export const PREVIOUS_SIGNING_SECRET =
  "dummy-signing-secret-previous-000000000";
export const KEY_ID = "k2";
export const PREVIOUS_KEY_ID = "k1";

const CONTRACTS = join(import.meta.dirname, "..", "..", "..", "contracts");

export function readContract<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(join(CONTRACTS, path), "utf8")) as T;
}

export type RecordedLogger = Logger & {
  /** Every line written, as one text, for a test that looks for a secret in it. */
  text(): string;
  lines: string[];
};

export function recordingLogger(): RecordedLogger {
  const lines: string[] = [];
  const write = (level: string, event: string, fields?: unknown) => {
    lines.push(
      `${level} ${event} ${fields === undefined ? "" : JSON.stringify(fields)}`,
    );
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    text: () => lines.join("\n"),
    lines,
  };
}

export async function startApp(
  options: DispatcherAppFakeOptions = {},
): Promise<DispatcherAppFake> {
  return startDispatcherAppFake({
    dispatcherToken: DISPATCHER_TOKEN,
    ...options,
  });
}

/** The one app `reviewer` as the legacy variables define it, and the rest of the core's settings. */
export type SettingsOverrides = Partial<Omit<CoreSettings, "apps">> & {
  /** Fields of the app `reviewer`. */
  appUrl?: string;
  token?: string;
  poolId?: string;
  maxRunning?: number;
  kinds?: readonly ReviewKind[];
  /** Further apps next to `reviewer` (#730). */
  more?: CoreSettings["apps"];
};

export function settingsFor(
  appUrl: string,
  overrides: SettingsOverrides = {},
): CoreSettings {
  const {
    token,
    poolId,
    maxRunning,
    kinds,
    more,
    appUrl: url,
    ...core
  } = overrides;
  return {
    engines: ["pr-agent", "opencode"],
    jobTimeoutSeconds: 1200,
    launchDeadlineSeconds: 300,
    workerConfig: { diff: {}, dynamic: {} },
    ...core,
    apps: [
      {
        id: "reviewer",
        url: url ?? appUrl,
        token: token ?? DISPATCHER_TOKEN,
        poolId: poolId ?? "test-pool",
        maxRunning: maxRunning ?? 4,
        kinds: kinds ?? ["diff", "dynamic"],
      },
      ...(more ?? []),
    ],
  };
}

export type WebhookBody = {
  version: 1;
  type: "job.ready";
  jobId: string;
  reviewKind: "diff" | "dynamic" | "implementer";
  attempt: number;
  dispatchId: string;
  sentAt: string;
};

export function webhookBody(overrides: Partial<WebhookBody> = {}): WebhookBody {
  return {
    version: 1,
    type: "job.ready",
    jobId: "00000000-0000-4000-8000-000000000001",
    reviewKind: "diff",
    attempt: 1,
    dispatchId: "5d3a8c0e-91b4-4f6a-a2c7-3e8b1d7f4a92",
    sentAt: "2026-10-10T12:00:00.000Z",
    ...overrides,
  };
}

/** A signed request like the App sends it; `mutate` changes the parts after signing. */
export function signedRequest(input: {
  body?: WebhookBody;
  rawBody?: string;
  secret?: string;
  keyId?: string;
  nowSeconds: number;
  timestamp?: string;
  headers?: Record<string, string | null>;
}): Request {
  const body = input.body ?? webhookBody();
  const rawBody = input.rawBody ?? JSON.stringify(body);
  const timestamp = input.timestamp ?? String(input.nowSeconds);
  const headers: Record<string, string | null> = {
    "content-type": "application/json",
    "x-dispatch-timestamp": timestamp,
    "x-dispatch-id": body.dispatchId,
    "x-dispatch-key-id": input.keyId ?? KEY_ID,
    "x-dispatch-signature": signDispatch({
      secret: input.secret ?? SIGNING_SECRET,
      timestamp,
      dispatchId: body.dispatchId,
      rawBody,
    }),
    ...input.headers,
  };
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== null) clean[name] = value;
  return new Request("http://dispatcher.test/dispatch", {
    method: "POST",
    headers: clean,
    body: rawBody,
  });
}

/** Polls until the condition holds; the loopback I/O of the fake App needs real turns of the event loop. */
export async function waitFor(
  condition: () => boolean,
  what = "the condition",
  timeoutMs = 5000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export type StopBody = {
  version: 1;
  type: "job.stop";
  jobId: string;
  stopId: string;
  sentAt: string;
};

export function stopBody(overrides: Partial<StopBody> = {}): StopBody {
  return {
    version: 1,
    type: "job.stop",
    jobId: "00000000-0000-4000-8000-000000000001",
    stopId: "7c1e2d44-6b0a-4f5b-9a3e-5d8f2b6c1e07",
    sentAt: "2026-10-10T12:20:00.000Z",
    ...overrides,
  };
}

/** A signed stop call like the App sends it: the same signing as the wake-up call, `x-dispatch-id` is the stop id. */
export function signedStopRequest(input: {
  body?: StopBody;
  rawBody?: string;
  secret?: string;
  keyId?: string;
  nowSeconds: number;
  timestamp?: string;
  headers?: Record<string, string | null>;
}): Request {
  const body = input.body ?? stopBody();
  const rawBody = input.rawBody ?? JSON.stringify(body);
  const timestamp = input.timestamp ?? String(input.nowSeconds);
  const headers: Record<string, string | null> = {
    "content-type": "application/json",
    "x-dispatch-timestamp": timestamp,
    "x-dispatch-id": body.stopId,
    "x-dispatch-key-id": input.keyId ?? KEY_ID,
    "x-dispatch-signature": signDispatch({
      secret: input.secret ?? SIGNING_SECRET,
      timestamp,
      dispatchId: body.stopId,
      rawBody,
    }),
    ...input.headers,
  };
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (value !== null) clean[name] = value;
  return new Request("http://dispatcher.test/stop", {
    method: "POST",
    headers: clean,
    body: rawBody,
  });
}
