// SPDX-License-Identifier: LicenseRef-Proprietary

// The stop call of the dispatch webhook (#487): when the claim of a job ends, the App tells the Dispatcher that sent the
// job's wake-up to stop the job's Sandbox VM. The Dispatcher holds no supervision after the hand-over and the VM never
// gets access to it, so this signed `POST /stop` is the whole of the way a VM is ended on purpose; the reaper cron of the
// Dispatcher and the VM's own timeout are the safety nets.
//
// - Best effort. The job's transition committed before this runs (`after()`, src/dispatch/shared.ts), and nothing here
//   throws or is awaited by it.
// - Only for a job whose wake-up a Dispatcher acknowledged (`job_dispatches.acked_at`). A self-hosted runner or a
//   Compose stack polls (`RUNNER_DISPATCH=poll`): no service exists and nothing is sent. The job's row is the proof
//   that a Dispatcher started it, so an instance that also has polling runners never signs a call for their jobs.
// - A bounded retry for a transient answer (`STOP_RETRY_DELAYS_MS`, 5 seconds a call); the same `stopId` in every
//   repeat, so a stop that arrived twice is a replay the receiver ignores. A failure is logged once per job with a
//   stable code (`STOP_RESULT_CODES`) and never with the URL, a key, a header or the text of an error.
// - A Dispatcher of the previous release has no `/stop` and answers 404: logged once as `DISPATCH_STOP_UNSUPPORTED`,
//   never repeated. The reaper then ends the VM as it did before.
import "server-only";
import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { createJobDispatchesRepository } from "../db/repositories/job-dispatches-repository.ts";
import {
  createJobVmRunsRepository,
  type JobVmRunsRepository,
} from "../db/repositories/job-vm-runs-repository.ts";
import type { Database } from "../db/schema.ts";
import { correctLateMinutes } from "../billing/late-minutes.ts";
import { VM_NAME_PATTERN } from "../runner-api/contract.ts";
import type { DispatchKey, WebhookDispatchConfig } from "./config.ts";
import { buildStopRequest } from "./request.ts";
import { parseRetryAfter, type DispatchFetch } from "./send.ts";

/** One call of the stop: shorter than the wake-up's 8 seconds, because the Dispatcher answers before it stops anything. */
export const STOP_TIMEOUT_MS = 5_000;
/** The pauses before the repeats of a transient failure: at most two more calls. */
export const STOP_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000];
/** A longer `Retry-After` of the Dispatcher is cut to this: a stop is not worth a longer wait inside a request. */
const STOP_RETRY_AFTER_CAP_MS = 5_000;
/** How many jobs are stopped at once when a sweep ends many. */
const STOP_CONCURRENCY = 5;
/** #493: how much of an answer is read for the names of the VMs it is stopping; the contract's answer is far smaller. */
const ANSWER_MAX_BYTES = 4096;
/** #493: how many VM names an answer may carry (`DispatchStopAccepted.vms`). */
const ANSWER_MAX_VMS = 16;

export const STOP_RESULT_CODES = [
  "DISPATCH_STOP_FAILED",
  "DISPATCH_STOP_UNSUPPORTED",
  "DISPATCH_STOP_REJECTED",
  "DISPATCH_STOP_URL_INVALID",
  /** #493: the stop worked, but the end of its VMs could not be stored; the backstop covers them. */
  "DISPATCH_VM_END_FAILED",
] as const;
export type StopResultCode = (typeof STOP_RESULT_CODES)[number];

/**
 * The Dispatcher's `POST /stop` for the address of its `POST /dispatch` (they are one project): the last path segment
 * `dispatch` becomes `stop`. Null for an address that does not end in `/dispatch`; the stop is then not sent, and says so.
 */
export function stopUrlOf(dispatchUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(dispatchUrl);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/");
  if (segments[segments.length - 1] !== "dispatch") return null;
  segments[segments.length - 1] = "stop";
  url.pathname = segments.join("/");
  url.search = "";
  url.hash = "";
  return url.toString();
}

type StopAnswer =
  /** `vms`: the VMs the Dispatcher named as stopping (#493); empty when it named none or the answer is not the contract's. */
  | { kind: "done"; vms: string[] }
  | { kind: "transient"; retryAfterMs: number | null }
  | { kind: "unsupported" }
  | { kind: "rejected"; status: number }
  | { kind: "unreachable" };

export type StopLog = {
  /** A stop that failed, with its stable code. One line per job. */
  warn(line: string): void;
};

/**
 * #493: the names of the VMs in the Dispatcher's answer (`DispatchStopAccepted.vms`). Bounded reading; anything that is not
 * a short list of well-formed names is no names at all. The body is data of another system: it is never logged.
 */
async function namedVms(response: Response): Promise<string[]> {
  try {
    const reader = response.body?.getReader();
    if (reader === undefined) return [];
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > ANSWER_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        return [];
      }
      chunks.push(part.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    const vms = (parsed as { vms?: unknown }).vms;
    if (!Array.isArray(vms) || vms.length > ANSWER_MAX_VMS) return [];
    return vms.every(
      (name) => typeof name === "string" && VM_NAME_PATTERN.test(name),
    )
      ? (vms as string[])
      : [];
  } catch {
    return [];
  }
}

/** Where one stop call goes and what signs it. */
export type StopTarget = {
  /** The address of the stop call (`stopUrlOf` of the dispatcher's address), or null for one that has none. */
  url: string | null;
  key: DispatchKey;
  bypassToken?: string;
};

export type StopService = {
  /** Stops the VMs of these jobs, best effort. Never rejects. */
  stopJobs(jobIds: readonly string[]): Promise<void>;
};

export function createStopService(options: {
  db: Kysely<Database>;
  config: WebhookDispatchConfig;
  fetch?: DispatchFetch;
  now?: () => Date;
  newId?: () => string;
  timeoutMs?: number;
  /** The pauses before the repeats; `[]` makes none. */
  retryDelaysMs?: readonly number[];
  /** Waits (default: a timer); tests pass a fake. */
  sleep?: (ms: number) => Promise<void>;
  log?: StopLog;
  /** #493: where the end of a VM is stored; the VM runs of a job's workspace. */
  vmRuns?: (workspaceId: string) => JobVmRunsRepository;
  /**
   * #972: the delivery of the customer's webhook dispatcher that holds the job (the runner of the claim), with its own key; undefined when
   * none does. Such a dispatcher is told to stop its VM like the platform's, and a serverless one learns from it that a slot is free.
   */
  customerTarget?: (jobId: string) => Promise<
    | {
        /** The address of its doorbell. */
        url: string;
        key: DispatchKey;
      }
    | undefined
  >;
}): StopService {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? STOP_TIMEOUT_MS;
  const retryDelays = options.retryDelaysMs ?? STOP_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log: StopLog = options.log ?? { warn: (line) => console.warn(line) };
  const { config } = options;
  const dispatches = createJobDispatchesRepository(options.db, now);
  const vmRuns =
    options.vmRuns ??
    ((workspaceId: string) =>
      createJobVmRunsRepository(options.db, workspaceId, now));
  const platform: StopTarget = {
    url: stopUrlOf(config.url),
    key: config.currentKey,
    ...(config.bypassToken === undefined
      ? {}
      : { bypassToken: config.bypassToken }),
  };

  /** One call, whose answer is reduced to what decides the next step. The body of the answer is never read. */
  async function call(
    target: StopTarget,
    jobId: string,
    stopId: string,
  ): Promise<StopAnswer> {
    const sentAt = now();
    const request = buildStopRequest({
      key: target.key,
      ...(target.bypassToken === undefined
        ? {}
        : { bypassToken: target.bypassToken }),
      jobId,
      stopId,
      now: sentAt,
    });
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await send(target.url as string, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        redirect: "manual",
        cache: "no-store",
        signal,
      });
      const { status } = response;
      if (status === 200 || status === 202)
        return {
          kind: "done",
          vms: status === 202 ? await namedVms(response) : [],
        };
      void response.body?.cancel().catch(() => undefined);
      if (status === 404) return { kind: "unsupported" };
      if (status === 429 || status === 503) {
        const seconds = parseRetryAfter(
          response.headers.get("retry-after"),
          now(),
        );
        return {
          kind: "transient",
          retryAfterMs: seconds === null ? null : seconds * 1000,
        };
      }
      if (status >= 500) return { kind: "transient", retryAfterMs: null };
      return { kind: "rejected", status };
    } catch {
      return { kind: "unreachable" };
    }
  }

  function fail(jobId: string, code: StopResultCode, status?: number): void {
    log.warn(
      `[dispatch] ${code} job=${jobId}${status === undefined ? "" : ` status=${String(status)}`}`,
    );
  }

  /**
   * #493: the answer named the VMs it is stopping, so the App's clock now is the end of their billable minutes. Nothing
   * that goes wrong here reaches the job; a VM whose end is not stored ends at the bounded backstop.
   */
  async function recordEnd(
    jobId: string,
    names: readonly string[],
  ): Promise<void> {
    if (names.length === 0) return;
    const at = now();
    try {
      const workspaceId = await dispatches.workspaceOf(jobId);
      if (workspaceId === undefined) return;
      const changed = await vmRuns(workspaceId).confirmStopped(
        jobId,
        names,
        at,
      );
      // #498: the job settled with the backstop; a real end that moves its minutes is a correction of the charge.
      if (changed > 0)
        await correctLateMinutes(options.db, workspaceId, jobId, now);
    } catch {
      fail(jobId, "DISPATCH_VM_END_FAILED");
    }
  }

  /** The call and its repeats for a transient failure, with the same `stopId`: a stop that arrived twice is a replay the receiver ignores. */
  async function callWithRetries(
    target: StopTarget,
    jobId: string,
  ): Promise<StopAnswer> {
    const stopId = newId();
    let answer = await call(target, jobId, stopId);
    for (const delay of retryDelays) {
      if (answer.kind !== "transient" && answer.kind !== "unreachable") break;
      const asked = answer.kind === "transient" ? answer.retryAfterMs : null;
      await sleep(
        Math.max(delay, Math.min(asked ?? 0, STOP_RETRY_AFTER_CAP_MS)),
      );
      answer = await call(target, jobId, stopId);
    }
    return answer;
  }

  async function stopOne(jobId: string): Promise<void> {
    const row = await dispatches.get(jobId);
    // No wake-up of the platform's Dispatcher was acknowledged: a customer's dispatcher may hold the job (#972), else it is a job that was
    // never dispatched.
    if (row === undefined || row.ackedAt === null)
      return stopCustomersOne(jobId);
    if (platform.url === null) return fail(jobId, "DISPATCH_STOP_URL_INVALID");
    const answer = await callWithRetries(platform, jobId);
    switch (answer.kind) {
      case "done":
        return recordEnd(jobId, answer.vms);
      case "unsupported":
        return fail(jobId, "DISPATCH_STOP_UNSUPPORTED", 404);
      case "rejected":
        return fail(jobId, "DISPATCH_STOP_REJECTED", answer.status);
      case "transient":
      case "unreachable":
        return fail(jobId, "DISPATCH_STOP_FAILED");
    }
  }

  /**
   * #972: the job is held by a customer's runner that announced a webhook: its dispatcher gets the stop call, signed with its own secret.
   * The VMs it names are its own and not billed here (a runner's jobs are not), so nothing of the answer is stored.
   */
  async function stopCustomersOne(jobId: string): Promise<void> {
    const holder = await options.customerTarget?.(jobId);
    if (holder === undefined) return;
    const url = stopUrlOf(holder.url);
    if (url === null) return fail(jobId, "DISPATCH_STOP_URL_INVALID");
    const answer = await callWithRetries({ url, key: holder.key }, jobId);
    switch (answer.kind) {
      case "done":
        return;
      case "unsupported":
        return fail(jobId, "DISPATCH_STOP_UNSUPPORTED", 404);
      case "rejected":
        return fail(jobId, "DISPATCH_STOP_REJECTED", answer.status);
      case "transient":
      case "unreachable":
        return fail(jobId, "DISPATCH_STOP_FAILED");
    }
  }

  return {
    async stopJobs(jobIds) {
      const queue = [...new Set(jobIds)];
      await Promise.all(
        Array.from(
          { length: Math.min(STOP_CONCURRENCY, queue.length) },
          async () => {
            for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
              try {
                await stopOne(id);
              } catch {
                // The database failed (the lookup of the row): the reaper ends the VM. Only the code, never the error.
                fail(id, "DISPATCH_STOP_FAILED");
              }
            }
          },
        ),
      );
    },
  };
}
