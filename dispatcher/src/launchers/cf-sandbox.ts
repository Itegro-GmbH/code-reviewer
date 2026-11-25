// SPDX-License-Identifier: LicenseRef-Proprietary

// The Sandbox port (sandbox-service.ts) over the cf-sandbox HTTP API (`contracts/cf-sandbox.v1.json`, #1158, epic #1157): the Cloudflare placement.
// A Worker `cr-sandbox` (#1159) runs one Durable Object and one Cloudflare Container (a microVM) for each VM; this file is the Dispatcher's client
// of it and the only one that knows its wire format. It is `SandboxService` and `SandboxFleet` like `vercel-sandbox.ts`, so the Launcher, the stop
// route, the network switch and the reaper work on it unchanged.
//
// What this client never does: log a body or the token, follow a redirect, send a credential anywhere but in the `data` of the stdin call of the
// Worker process (that is where `SandboxProcess.writeStdin` puts it, exactly as on Vercel), or send the token to a host other than the one it is
// configured with. A failure is a `SandboxServiceError` with a kind of `SANDBOX_FAILURE_KINDS` and no text.
import { z } from "zod";
import type { NetworkPolicy } from "../network/rule.ts";
import {
  DELETABLE_STATUSES,
  SANDBOX_FAILURE_KINDS,
  SandboxServiceError,
  type ExecRequest,
  type ExecResult,
  type ListFilter,
  type ListedVm,
  type SandboxCreateOptions,
  type SandboxFailureKind,
  type SandboxFleet,
  type SandboxProcess,
  type SandboxService,
  type SandboxVm,
} from "./sandbox-service.ts";

/** What the Dispatcher is configured with for the Cloudflare placement (`CF_SANDBOX_URL`, `CF_SANDBOX_TOKEN`, `CF_SANDBOX_INSTANCE_TYPES`). */
export type CfSandboxConfig = {
  /** The base address of the Worker, `https://...` and no path. */
  baseUrl: string;
  /** The bearer token (a secret, at least 32 characters). */
  token: string;
  /** vCPU count of a job's size to the Cloudflare instance type that runs it, for example `4` to `standard-4`. */
  instanceTypes: ReadonlyMap<number, string>;
  fetch?: typeof fetch;
  /** The call timeouts, for a test that cannot wait; `CF_TIMEOUTS` otherwise. */
  timeouts?: Partial<Record<keyof typeof CF_TIMEOUTS, number>>;
};

/** The call timeouts of the client, in milliseconds. */
export const CF_TIMEOUTS = {
  /** `POST /v1/vms` answers after the Container runs, the CA is installed and the images are loaded: up to 300 s (the contract). */
  create: 330_000,
  /** Every other call that is not a long poll. */
  call: 20_000,
  /** The margin over the `timeoutMs` of an `exec` that the HTTP call may take. */
  execMargin: 15_000,
  /** The wait of one poll of a process, at most 25 s (the contract); the HTTP call may take a little longer. */
  pollWait: 25_000,
  pollMargin: 10_000,
  /** `GET /health`. */
  health: 5_000,
} as const;

const EXEC_DEFAULT_MS = 120_000;
const EXEC_MIN_MS = 1_000;
const EXEC_MAX_MS = 600_000;
const CREATE_TIMEOUT_MIN_MS = 60_000;
const CREATE_TIMEOUT_MAX_MS = 21_600_000;

/** The statuses of the contract, as failure kinds. A body's own `error` wins when it is one of the kinds. */
const STATUS_KINDS: Readonly<Record<number, SandboxFailureKind>> = {
  400: "rejected",
  401: "auth_failed",
  404: "not_ready",
  429: "rate_limited",
  503: "unavailable",
};

const failureBody = z.object({ error: z.enum(SANDBOX_FAILURE_KINDS) });

const createAnswer = z.object({ name: z.string(), instanceType: z.string() });
const execAnswer = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
});
const processAnswer = z.object({ processId: z.string() });
const stateAnswer = z.union([
  z.object({ running: z.literal(false), exitCode: z.number().int() }),
  z.object({ running: z.literal(true) }),
]);
const listAnswer = z.object({
  vms: z.array(
    z.object({
      name: z.string(),
      createdAtMs: z.number().int().nonnegative(),
      status: z.string(),
      timeoutMs: z.number().int().nonnegative().optional(),
      tags: z.record(z.string(), z.string()),
    }),
  ),
});
const healthAnswer = z.object({
  ok: z.literal(true),
  imageVersion: z.string(),
  workerFeatures: z.array(z.string()),
  instanceTypes: z.array(z.string()),
  workerImageId: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
});

/** What `GET /health` says of the Worker's image: read by the Dispatcher to gate claim features and to check the image in a VM. */
export type CfHealth = z.infer<typeof healthAnswer>;

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

/** A client of the cf-sandbox API: the Dispatcher's port `SandboxService` and `SandboxFleet`, and the health check of the Worker. */
export type CfSandboxClient = SandboxService &
  SandboxFleet & {
    /** `GET /health`, no credential. Throws `SandboxServiceError` when the Worker does not answer or answers something else. */
    health(signal?: AbortSignal): Promise<CfHealth>;
  };

export function createCfSandboxService(
  config: CfSandboxConfig,
): CfSandboxClient {
  const base = config.baseUrl.replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const timeouts = { ...CF_TIMEOUTS, ...config.timeouts };

  type Call = {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string>;
    body?: unknown;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    /** `GET /health` is the one call without the token. */
    anonymous?: boolean;
  };

  /** The answer of one call, or a `SandboxServiceError`. An abort of the caller's signal is rethrown as the AbortError it is. */
  async function send(call: Call): Promise<Response> {
    const timeout = AbortSignal.timeout(call.timeoutMs);
    const signal =
      call.signal === undefined
        ? timeout
        : AbortSignal.any([call.signal, timeout]);
    const query =
      call.query === undefined || Object.keys(call.query).length === 0
        ? ""
        : `?${new URLSearchParams(call.query).toString()}`;
    let response: Response;
    try {
      response = await doFetch(`${base}${call.path}${query}`, {
        method: call.method,
        headers: {
          accept: "application/json",
          ...(call.anonymous === true
            ? {}
            : { authorization: `Bearer ${config.token}` }),
          ...(call.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        redirect: "error",
        signal,
      });
    } catch (error) {
      // The caller's own abort is theirs to handle; a call that ran out of time or got no answer is a failure of the platform.
      if (call.signal?.aborted === true || (isAbort(error) && !timeout.aborted))
        throw error;
      throw new SandboxServiceError(
        timeout.aborted ? "unavailable" : "network",
      );
    }
    if (response.ok) return response;
    throw new SandboxServiceError(await kindOf(response));
  }

  async function kindOf(response: Response): Promise<SandboxFailureKind> {
    const parsed = failureBody.safeParse(
      await response.json().catch(() => null),
    );
    if (parsed.success) return parsed.data.error;
    return STATUS_KINDS[response.status] ?? "unavailable";
  }

  async function answer<T>(
    response: Response,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const parsed = schema.safeParse(await response.json().catch(() => null));
    // An answer of another shape is not the Worker's: nothing more is read of it, and nothing of it is logged.
    if (!parsed.success) throw new SandboxServiceError("unavailable");
    return parsed.data;
  }

  const vmPath = (name: string) => `/v1/vms/${encodeURIComponent(name)}`;

  function processOf(name: string, id: string): SandboxProcess {
    const path = `${vmPath(name)}/processes/${encodeURIComponent(id)}`;
    return {
      async writeStdin(data) {
        await send({
          method: "POST",
          path: `${path}/stdin`,
          body: { data },
          timeoutMs: timeouts.call,
        });
      },
      async closeStdin() {
        await send({
          method: "POST",
          path: `${path}/stdin/close`,
          timeoutMs: timeouts.call,
        });
      },
      async wait(signal) {
        for (;;) {
          const state = await answer(
            await send({
              method: "GET",
              path,
              query: { waitMs: String(timeouts.pollWait) },
              timeoutMs: timeouts.pollWait + timeouts.pollMargin,
              signal,
            }),
            stateAnswer,
          );
          if (!state.running) return { exitCode: state.exitCode };
        }
      },
    };
  }

  function vmOf(name: string): SandboxVm {
    return {
      name,
      async exec(request: ExecRequest, signal): Promise<ExecResult> {
        const timeoutMs = Math.min(
          EXEC_MAX_MS,
          Math.max(EXEC_MIN_MS, request.timeoutMs ?? EXEC_DEFAULT_MS),
        );
        const done = await answer(
          await send({
            method: "POST",
            path: `${vmPath(name)}/exec`,
            body: {
              label: request.label,
              cmd: request.cmd,
              args: request.args,
              ...(request.sudo === undefined ? {} : { sudo: request.sudo }),
              timeoutMs,
            },
            timeoutMs: timeoutMs + timeouts.execMargin,
            signal,
          }),
          execAnswer,
        );
        return done;
      },
      async start(request, signal) {
        const started = await answer(
          await send({
            method: "POST",
            path: `${vmPath(name)}/processes`,
            body: {
              label: request.label,
              cmd: request.cmd,
              args: request.args,
              ...(request.sudo === undefined ? {} : { sudo: request.sudo }),
            },
            timeoutMs: timeouts.call,
            signal,
          }),
          processAnswer,
        );
        return processOf(name, started.processId);
      },
    };
  }

  return {
    async create(options: SandboxCreateOptions, signal) {
      const instanceType = config.instanceTypes.get(options.vcpus);
      // A size nobody configured is a refusal, as it is when the Worker refuses the type: no retry fixes it.
      if (instanceType === undefined) throw new SandboxServiceError("rejected");
      const created = await answer(
        await send({
          method: "POST",
          path: "/v1/vms",
          body: {
            name: options.name,
            instanceType,
            timeoutMs: Math.min(
              CREATE_TIMEOUT_MAX_MS,
              Math.max(CREATE_TIMEOUT_MIN_MS, options.timeoutMs),
            ),
            tags: options.tags,
          },
          timeoutMs: timeouts.create,
          signal,
        }),
        createAnswer,
      );
      return vmOf(created.name);
    },

    async stop(name) {
      try {
        await send({
          method: "DELETE",
          path: vmPath(name),
          timeoutMs: timeouts.call,
        });
      } catch (error) {
        // A VM that is gone or never existed is not an error (the contract answers 204; an older Worker may say 404).
        if (error instanceof SandboxServiceError && error.kind === "not_ready")
          return;
        throw error;
      }
    },

    async list(filter: ListFilter, signal) {
      // The API filters by one tag; the reaper decides itself which VMs are ours.
      const [tag] = Object.entries(filter.tags);
      const listed = await answer(
        await send({
          method: "GET",
          path: "/v1/vms",
          query: {
            namePrefix: filter.namePrefix,
            ...(tag === undefined ? {} : { tag: `${tag[0]}:${tag[1]}` }),
          },
          timeoutMs: timeouts.call,
          signal,
        }),
        listAnswer,
      );
      return listed.vms.map((vm): ListedVm => ({
        name: vm.name,
        createdAtMs: vm.createdAtMs,
        status: vm.status,
        ...(vm.timeoutMs === undefined ? {} : { timeoutMs: vm.timeoutMs }),
        tags: vm.tags,
      }));
    },

    async delete(name) {
      // Looked up again first, as on Vercel: only a VM the Worker reports as ended is deleted. The Worker does not list an ended VM at all,
      // so a VM that is not listed counts as deleted, and a listed one that is still `running` or `pending` is kept.
      const listed = await answer(
        await send({
          method: "GET",
          path: "/v1/vms",
          query: { namePrefix: name },
          timeoutMs: timeouts.call,
        }),
        listAnswer,
      );
      const found = listed.vms.find((vm) => vm.name === name);
      if (found === undefined) return "deleted";
      if (!DELETABLE_STATUSES.includes(found.status)) return "kept";
      await send({
        method: "DELETE",
        path: vmPath(name),
        timeoutMs: timeouts.call,
      });
      return "deleted";
    },

    async setNetworkPolicy(name: string, policy: NetworkPolicy) {
      await send({
        method: "PUT",
        path: `${vmPath(name)}/network`,
        body: { policy },
        timeoutMs: timeouts.call,
      });
    },

    async health(signal) {
      return answer(
        await send({
          method: "GET",
          path: "/health",
          timeoutMs: timeouts.health,
          anonymous: true,
          signal,
        }),
        healthAnswer,
      );
    },
  };
}
