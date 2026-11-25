// SPDX-License-Identifier: LicenseRef-Proprietary

import { DurableObject } from "cloudflare:workers";
import type { Result } from "./errors.ts";
import type { NetworkPolicy } from "./policy.ts";
import type { ContainerPort, ProcessHandle } from "./ports.ts";
import { REGISTRY_NAME, type Env } from "./env.ts";
import {
  VmController,
  type ExecAnswer,
  type ExecCommand,
  type ProcessAnswer,
  type StartRequest,
} from "./vm-controller.ts";

/** What of the platform's `ExecProcess` the controller uses. */
function asHandle(process: ExecProcess): ProcessHandle {
  return {
    stdout: process.stdout as ReadableStream<Uint8Array> | null,
    stderr: process.stderr as ReadableStream<Uint8Array> | null,
    exitCode: process.exitCode,
    kill: (signal) => process.kill(signal),
  };
}

/**
 * One VM: this Durable Object (named by the VM's name) owns one Container (the `durable_object` scheduling policy,
 * `enableInternet: false`). The logic is in vm-controller.ts; this class adapts the platform to it and registers the outbound
 * handlers (the outer wall, door.ts) with the VM's name as their props.
 */
export class CrSandboxVm extends DurableObject<Env> {
  readonly #controller: VmController;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const c = ctx.container;
    const registerIntercepts = async () => {
      if (!c) return;
      // `ctx.exports` carries the Worker's own entrypoints; `props` tells the handler which VM's policy to read.
      const exports = ctx.exports as unknown as {
        Door(options: { props: { vm: string } }): Fetcher;
      };
      const door = exports.Door({ props: { vm: ctx.id.name ?? "" } });
      // The order matters (docs, "Handler precedence"): `*` for HTTPS and all HTTP. No hostname intercepts in layout P1.
      await c.interceptOutboundHttps("*", door);
      await c.interceptAllOutboundHttp(door);
    };
    const container: ContainerPort | undefined = c && {
      get running() {
        return c.running;
      },
      registerIntercepts,
      start: ({ instance, entrypoint }) =>
        c.start({
          image: c.images.base ?? "",
          instance: instance as ContainerStartupOptions["instance"],
          entrypoint,
          enableInternet: false,
        }),
      exec: async (cmd, options) =>
        asHandle(
          await c.exec(cmd, {
            stdin: options.stdin,
            stdout: "pipe",
            stderr: "pipe",
          }),
        ),
      setInactivityTimeout: (ms) => c.setInactivityTimeout(ms),
      destroy: (reason) => c.destroy(reason),
    };
    this.#controller = new VmController({
      container,
      storage: {
        get: <T>(key: string) => ctx.storage.get<T>(key),
        put: (key, value) => ctx.storage.put(key, value),
        deleteAll: () => ctx.storage.deleteAll(),
        setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
        deleteAlarm: () => ctx.storage.deleteAlarm(),
      },
      registry: {
        remove: (name) => env.REGISTRY.getByName(REGISTRY_NAME).remove(name),
      },
      logger: {
        warn: (event, fields) =>
          console.warn(JSON.stringify({ event, ...fields })),
      },
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
    });
    void ctx.blockConcurrencyWhile(() => this.#controller.wake());
  }

  getPolicy(): Promise<NetworkPolicy> {
    return this.#controller.getPolicy();
  }
  setPolicy(policy: NetworkPolicy): Promise<Result<null>> {
    return this.#controller.setPolicy(policy);
  }
  start(request: StartRequest): Promise<Result<null>> {
    return this.#controller.start(request);
  }
  exec(command: ExecCommand): Promise<Result<ExecAnswer>> {
    return this.#controller.exec(command);
  }
  startProcess(command: {
    label: string;
    cmd: string;
    args: string[];
  }): Promise<Result<{ processId: string }>> {
    return this.#controller.startProcess(command);
  }
  writeStdin(processId: string, data: string): Promise<Result<null>> {
    return this.#controller.writeStdin(processId, data);
  }
  closeStdin(processId: string): Promise<Result<null>> {
    return this.#controller.closeStdin(processId);
  }
  waitProcess(
    processId: string,
    waitMs: number,
  ): Promise<Result<ProcessAnswer>> {
    return this.#controller.waitProcess(processId, waitMs);
  }
  destroy(): Promise<void> {
    return this.#controller.destroy();
  }
  override alarm(): Promise<void> {
    return this.#controller.alarm();
  }
}
