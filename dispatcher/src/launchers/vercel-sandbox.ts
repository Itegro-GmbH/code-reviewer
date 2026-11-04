// SPDX-License-Identifier: LicenseRef-Proprietary

// The Sandbox port (sandbox-service.ts) over the Vercel Sandbox SDK (`@vercel/sandbox`, #329): the one file of the
// Sandbox-Launcher that knows the platform. The SDK is handed in as a loader, so a test drives the adapter with a
// stand-in, the SDK is not loaded before the first job, and `index.ts` is the one place that names the module.
//
// Authentication: without credentials the SDK uses the OIDC token of the Vercel project (automatic inside a
// Function). With them it uses the access token, the team and the project. Neither is ever logged or sent anywhere
// but to the SDK.
//
// What this adapter never does: pass an environment to a command, write a file, set a failover region or a
// persistent sandbox. The per-job credential reaches the VM through `SandboxProcess.writeStdin` and nothing else.
import { Writable } from "node:stream";
import type { NetworkPolicy } from "../network/rule.ts";
import {
  DELETABLE_STATUSES,
  SandboxServiceError,
  type ExecRequest,
  type ExecResult,
  type ListFilter,
  type ListedVm,
  type SandboxFleet,
  type SandboxCreateOptions,
  type SandboxFailureKind,
  type SandboxProcess,
  type SandboxService,
  type SandboxVm,
} from "./sandbox-service.ts";

/** An access token with the team and project it belongs to. Without them the SDK reads the OIDC token. */
export type VercelCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

/** The part of the SDK's `Command` (a detached process) the adapter uses. */
export interface SdkCommand {
  writeStdin(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  wait(params?: { signal?: AbortSignal }): Promise<{ exitCode: number }>;
}

/** The part of the SDK's `Sandbox` the adapter uses. */
export interface SdkSandbox {
  readonly name: string;
  runCommand(params: {
    cmd: string;
    args: string[];
    sudo?: boolean;
    detached: true;
    stdin: true;
    signal?: AbortSignal;
  }): Promise<SdkCommand>;
  runCommand(params: {
    cmd: string;
    args: string[];
    sudo?: boolean;
    timeoutMs?: number;
    stdout: Writable;
    stderr: Writable;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number }>;
  /** The status of the VM's session, as of the lookup. */
  readonly status: string;
  readonly persistent: boolean;
  stop(opts?: { signal?: AbortSignal }): Promise<unknown>;
  /** The platform's call for the network policy of a running VM (#745, step 7). */
  updateNetworkPolicy(
    policy: NetworkPolicy,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>;
  delete(opts?: {
    deleteOrphanSnapshots?: boolean;
    signal?: AbortSignal;
  }): Promise<unknown>;
}

/** What the adapter reads of one VM of `Sandbox.list` (the SDK yields more). */
export interface SdkListedSandbox {
  readonly name: string;
  readonly createdAt: number;
  readonly status: string;
  readonly timeout?: number | undefined;
  readonly persistent?: boolean | undefined;
  readonly tags?: Record<string, string> | undefined;
}

/** The credentials of an access token, as the SDK takes them (all three or none). */
type SdkAuth = { token?: string; teamId?: string; projectId?: string };

/** The static side of the SDK's `Sandbox` class that the adapter uses. */
export interface SandboxSdk {
  Sandbox: {
    create(
      params: SdkAuth & {
        name: string;
        source: { type: "snapshot"; snapshotId: string };
        region: string;
        resources: { vcpus: number };
        timeout: number;
        tags: Record<string, string>;
        persistent: boolean;
        signal?: AbortSignal;
      },
    ): Promise<SdkSandbox>;
    get(
      params: SdkAuth & { name: string; signal?: AbortSignal },
    ): Promise<SdkSandbox>;
    /** The result is async-iterable over every page. The parameters are loose: the SDK's own are unions. */
    list(
      params: Record<string, unknown>,
    ): Promise<AsyncIterable<SdkListedSandbox>>;
  };
}

class Collector extends Writable {
  text = "";
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ) {
    this.text += chunk.toString();
    done();
  }
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("response" in error))
    return undefined;
  const response: unknown = error.response;
  if (typeof response !== "object" || response === null) return undefined;
  const status: unknown = "status" in response ? response.status : undefined;
  return typeof status === "number" ? status : undefined;
}

/** The machine-readable code of an API error's body, lower case, or "" when it has none. */
function codeOf(error: unknown): string {
  if (typeof error !== "object" || error === null || !("json" in error))
    return "";
  const json: unknown = error.json;
  if (typeof json !== "object" || json === null) return "";
  const body = json as Record<string, unknown>;
  const nested = body.error;
  const code =
    typeof body.code === "string"
      ? body.code
      : typeof nested === "string"
        ? nested
        : typeof nested === "object" &&
            nested !== null &&
            typeof (nested as Record<string, unknown>).code === "string"
          ? (nested as { code: string }).code
          : "";
  return code.toLowerCase();
}

/** The words of an API error that classify it: its message and its code, lower case. */
function wordsOf(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return `${message} ${codeOf(error)}`.toLowerCase();
}

const NETWORK_CODE = /^(E[A-Z0-9]+|UND_ERR[A-Z_]*)$/;

function isConnectionFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const codes: unknown[] = [
    "code" in error ? error.code : undefined,
    "cause" in error && typeof error.cause === "object" && error.cause !== null
      ? (error.cause as { code?: unknown }).code
      : undefined,
  ];
  if (codes.some((code) => typeof code === "string" && NETWORK_CODE.test(code)))
    return true;
  const name = "name" in error ? String(error.name) : "";
  return (
    name === "TimeoutError" ||
    (error instanceof TypeError &&
      /fetch failed|terminated/i.test(error.message))
  );
}

/**
 * The failure kind of a platform error. The bodies of the platform's errors are not documented, so this goes by the
 * HTTP status first, then the error code of the body, then words of the message; a call that got no answer is a network failure. Anything
 * it does not recognise is a refusal, which no retry is known to fix.
 */
export function classifySandboxError(error: unknown): SandboxFailureKind {
  const status = statusOf(error);
  if (status === undefined)
    return isConnectionFailure(error) ? "network" : "rejected";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  // A quota is the status 402 or an explicit code of the body. The words of a message are not enough: a refusal of a
  // bad request ("timeout exceeds the limit") is a configuration error, not a quota that clears.
  if (status === 402 || /quota|limit_exceeded|too_many/.test(codeOf(error)))
    return "quota_exceeded";
  if (status === 401 || status === 403) return "auth_failed";
  const words = wordsOf(error);
  if (/region/.test(words)) return "region_mismatch";
  if (
    /snapshot/.test(words) &&
    /not.?found|missing|expired|deleted|gone/.test(words)
  )
    return "snapshot_missing";
  if (status === 425 || /not.?ready|pending|processing/.test(words))
    return "not_ready";
  if (status === 404 && /snapshot/.test(words)) return "snapshot_missing";
  return "rejected";
}

/** How long one platform call of the delete path may take: a lookup or a delete (#802). */
export const DELETE_CALL_LIMIT_MS = 15_000;

/**
 * Runs one platform call with a time limit: the signal is aborted at the limit, and the wait itself ends there too, for a
 * platform that ignores the signal. The failure is `unavailable`, like any other answer of a platform that is not there.
 */
async function limited<T>(
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SandboxServiceError("unavailable"));
    }, DELETE_CALL_LIMIT_MS);
  });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function mapped(error: unknown): unknown {
  return isAbort(error)
    ? error
    : new SandboxServiceError(classifySandboxError(error));
}

function vmOf(sandbox: SdkSandbox): SandboxVm {
  return {
    name: sandbox.name,
    async exec(request: ExecRequest, signal): Promise<ExecResult> {
      const stdout = new Collector();
      const stderr = new Collector();
      try {
        const finished = await sandbox.runCommand({
          cmd: request.cmd,
          args: [...request.args],
          ...(request.sudo === undefined ? {} : { sudo: request.sudo }),
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
          stdout,
          stderr,
          ...(signal === undefined ? {} : { signal }),
        });
        return {
          exitCode: finished.exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
        };
      } catch (error) {
        throw mapped(error);
      }
    },
    async start(request, signal): Promise<SandboxProcess> {
      let command: SdkCommand;
      try {
        command = await sandbox.runCommand({
          cmd: request.cmd,
          args: [...request.args],
          ...(request.sudo === undefined ? {} : { sudo: request.sudo }),
          detached: true,
          stdin: true,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        throw mapped(error);
      }
      return {
        writeStdin: (data) => command.writeStdin(data),
        closeStdin: () => command.closeStdin(),
        async wait(waitSignal) {
          const finished = await command.wait(
            waitSignal === undefined ? undefined : { signal: waitSignal },
          );
          return { exitCode: finished.exitCode };
        },
      };
    },
  };
}

/** A VM that is gone: stopping it again is done. */
function isGone(error: unknown): boolean {
  const status = statusOf(error);
  return status === 404 || status === 410;
}

export function createVercelSandboxService(
  load: () => Promise<SandboxSdk>,
  credentials?: VercelCredentials,
): SandboxService & SandboxFleet {
  const auth = credentials === undefined ? {} : { ...credentials };
  let sdk: Promise<SandboxSdk> | undefined;
  const loaded = () => (sdk ??= load());

  return {
    async create(options: SandboxCreateOptions, signal) {
      const { Sandbox } = await loaded();
      try {
        return vmOf(
          await Sandbox.create({
            ...auth,
            name: options.name,
            source: { type: "snapshot", snapshotId: options.snapshotId },
            region: options.region,
            resources: { vcpus: options.vcpus },
            timeout: options.timeoutMs,
            tags: options.tags,
            persistent: options.persistent,
            ...(signal === undefined ? {} : { signal }),
          }),
        );
      } catch (error) {
        throw mapped(error);
      }
    },

    async stop(name) {
      const { Sandbox } = await loaded();
      try {
        const sandbox = await Sandbox.get({ ...auth, name });
        await sandbox.stop();
      } catch (error) {
        if (isGone(error)) return;
        throw mapped(error);
      }
    },

    async setNetworkPolicy(name, policy) {
      const { Sandbox } = await loaded();
      try {
        // No `resume`: the VM must be running, and a stopped one is not started to be narrowed.
        const sandbox = await limited((signal) =>
          Sandbox.get({ ...auth, name, signal }),
        );
        await limited((signal) =>
          sandbox.updateNetworkPolicy(policy, { signal }),
        );
      } catch (error) {
        if (error instanceof SandboxServiceError) throw error;
        if (statusOf(error) === 404 || statusOf(error) === 410)
          throw new SandboxServiceError("not_ready");
        throw mapped(error);
      }
    },

    async delete(name) {
      const { Sandbox } = await loaded();
      try {
        // No `resume`: an ended VM is deleted as it is, not started first.
        const sandbox = await limited((signal) =>
          Sandbox.get({ ...auth, name, signal }),
        );
        // The listing may be old: a VM that is up again, ending, being snapshotted or persistent is not ours to delete.
        if (sandbox.persistent || !DELETABLE_STATUSES.includes(sandbox.status))
          return "kept";
        await limited((signal) =>
          // Said in so many words: the snapshots a VM owns are not ours to delete here, the golden snapshot included.
          sandbox.delete({ deleteOrphanSnapshots: false, signal }),
        );
        return "deleted";
      } catch (error) {
        // Only 404 means it is gone. A 410 is the SDK's "sandbox stopped": the VM is still listed, so it is a failed
        // delete and the reaper counts it, rather than reporting a deletion that left the listing as long as before.
        if (statusOf(error) === 404) return "deleted";
        if (error instanceof SandboxServiceError) throw error;
        throw mapped(error);
      }
    },

    async list(filter: ListFilter, signal): Promise<ListedVm[]> {
      const { Sandbox } = await loaded();
      const vms: ListedVm[] = [];
      try {
        for await (const listed of await Sandbox.list({
          ...auth,
          namePrefix: filter.namePrefix,
          // The platform refuses a name prefix with any other sort (HTTP 400): without it every run would fail.
          sortBy: "name",
          tags: { ...filter.tags },
          // The platform keeps stopped VMs, so the listing grows (283 took 5.1 s); its default page is small. 50 is the
          // largest page it allows (above it HTTP 400): fewer round trips, inside the claim's 4 s limit.
          limit: 50,
          ...(signal === undefined ? {} : { signal }),
        }))
          vms.push({
            name: listed.name,
            createdAtMs: listed.createdAt,
            status: listed.status,
            ...(typeof listed.timeout === "number"
              ? { timeoutMs: listed.timeout }
              : {}),
            ...(typeof listed.persistent === "boolean"
              ? { persistent: listed.persistent }
              : {}),
            tags: { ...listed.tags },
          });
      } catch (error) {
        throw mapped(error);
      }
      return vms;
    },
  };
}
