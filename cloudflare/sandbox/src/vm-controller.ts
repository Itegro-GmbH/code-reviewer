// SPDX-License-Identifier: LicenseRef-Proprietary

// The life of one VM: the logic of the Durable Object `CrSandboxVm`, free of `cloudflare:workers` so that it can be tested with fakes.
// One VM is one Container (a microVM) with `enableInternet: false`: all its HTTP and HTTPS goes through the outbound handler
// (door.ts), which reads `getPolicy()` per request, so a policy set here is in effect for the next request.
import { drain, OUTPUT_CAP_BYTES, TailBuffer } from "./bounded-tail.ts";
import { fail, ok, type Result } from "./errors.ts";
import {
  BOOT_TIMEOUT_MS,
  INACTIVITY_TIMEOUT_MS,
  planAlarm,
} from "./lifecycle.ts";
import type { NetworkPolicy } from "./policy.ts";
import type {
  ContainerPort,
  InstanceOption,
  Logger,
  ProcessHandle,
  RegistryRemover,
  StoredPolicy,
  StoredProcess,
  VmMeta,
  VmStoragePort,
} from "./ports.ts";

/** The boot of the Container's content, from the image (cloudflare/sandbox/image/rootfs/cr-sandbox-boot.sh): the intercept CA, the Worker and agent images. */
export const BOOT_COMMAND = ["/usr/local/sbin/cr-sandbox-boot.sh"];
/** The Container's init: reaps what the VM's steps leave behind, then sleeps; everything else is started by `exec`. */
export const ENTRYPOINT = ["/usr/bin/tini", "--", "sleep", "infinity"];
/** A killed command's exit status, as `timeout(1)` gives it. */
export const EXIT_TIMEOUT = 124;
/** What a process the Durable Object lost (it restarted) is reported as. */
export const EXIT_LOST = 255;
const EXIT_KILLED = 137;
/** After a command ended its pipes get this long to deliver the rest: a daemon that keeps them open must not hold the answer. */
const DRAIN_GRACE_MS = 2_000;

export type StartRequest = {
  name: string;
  instanceType: string;
  instance: InstanceOption;
  timeoutMs: number;
  createdAtMs: number;
};
export type ExecCommand = {
  label: string;
  cmd: string;
  args: string[];
  timeoutMs: number;
};
export type ExecAnswer = {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};
export type ProcessAnswer =
  { running: false; exitCode: number } | { running: true };

type LiveProcess = {
  writer: WritableStreamDefaultWriter<Uint8Array> | null;
  handle: ProcessHandle;
  exitCode: number | null;
  exited: Promise<number>;
};

export type VmControllerDeps = {
  container: ContainerPort | undefined;
  storage: VmStoragePort;
  registry: RegistryRemover;
  logger: Logger;
  now: () => number;
  newId: () => string;
};

const encoder = new TextEncoder();
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export class VmController {
  readonly #d: VmControllerDeps;
  readonly #processes = new Map<string, LiveProcess>();
  #policy: StoredPolicy | null = null;

  constructor(deps: VmControllerDeps) {
    this.#d = deps;
  }

  /** Runs when the Durable Object is created again with a Container that still runs: the inactivity timeout does not survive a restart (spike finding), and the handlers are registered again (replacing, never adding). */
  async wake(): Promise<void> {
    const container = this.#d.container;
    if (!container?.running) return;
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    await container
      .registerIntercepts()
      .catch(() => this.#d.logger.warn("intercepts_reregister_failed"));
  }

  async getPolicy(): Promise<NetworkPolicy> {
    if (this.#policy !== null) return this.#policy;
    const stored = await this.#d.storage.get<StoredPolicy>("policy");
    this.#policy = stored ?? "deny-all"; // no VM and no policy: nothing is allowed (fail closed)
    return this.#policy;
  }

  async setPolicy(policy: NetworkPolicy): Promise<Result<null>> {
    if (!(await this.#d.storage.get<VmMeta>("meta"))) return fail("not_ready");
    await this.#d.storage.put("policy", policy);
    this.#policy = policy;
    return ok(null);
  }

  /** Starts the Container and its content; answers when it accepts `exec`, the intercept CA is installed and the images are loaded. */
  async start(request: StartRequest): Promise<Result<null>> {
    const { container, storage } = this.#d;
    if (!container) return fail("unavailable");
    if (container.running || (await storage.get<VmMeta>("meta")))
      return fail("rejected");
    await storage.put("meta", {
      name: request.name,
      instanceType: request.instanceType,
      createdAtMs: request.createdAtMs,
      timeoutMs: request.timeoutMs,
    } satisfies VmMeta);
    await storage.put("policy", "allow-all" satisfies StoredPolicy);
    this.#policy = "allow-all";
    try {
      // The deadline alarm first: whatever happens next, the VM ends at its own deadline.
      await storage.setAlarm(
        Math.min(
          this.#d.now() + BOOT_TIMEOUT_MS,
          request.createdAtMs + request.timeoutMs,
        ),
      );
      await container.registerIntercepts();
      container.start({ instance: request.instance, entrypoint: ENTRYPOINT });
      const booted = await this.#execToEnd(BOOT_COMMAND, BOOT_TIMEOUT_MS);
      if (booted.exitCode !== 0) {
        this.#d.logger.warn("boot_failed", { exitCode: booted.exitCode });
        await this.destroy();
        return fail("unavailable");
      }
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
      const plan = planAlarm(
        this.#d.now(),
        request.createdAtMs + request.timeoutMs,
      );
      await storage.setAlarm(
        plan.action === "keep" ? plan.atMs : this.#d.now(),
      );
      return ok(null);
    } catch {
      this.#d.logger.warn("start_failed");
      await this.destroy().catch(() => undefined);
      return fail("unavailable");
    }
  }

  async exec(command: ExecCommand): Promise<Result<ExecAnswer>> {
    if (!this.#d.container?.running) return fail("not_ready");
    try {
      return ok(
        await this.#execToEnd(
          [command.cmd, ...command.args],
          command.timeoutMs,
        ),
      );
    } catch {
      this.#d.logger.warn("exec_failed", { label: command.label });
      return fail("unavailable");
    }
  }

  async #execToEnd(cmd: string[], timeoutMs: number): Promise<ExecAnswer> {
    const container = this.#d.container;
    if (!container) throw new Error("no container");
    const handle = await container.exec(cmd, {});
    const out = new TailBuffer(OUTPUT_CAP_BYTES);
    const err = new TailBuffer(OUTPUT_CAP_BYTES);
    const drained = Promise.all([
      drain(handle.stdout, out),
      drain(handle.stderr, err),
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        handle.kill(9);
        resolve(EXIT_TIMEOUT);
      }, timeoutMs);
    });
    const exited = handle.exitCode.catch(() => EXIT_KILLED);
    const exitCode = await Promise.race([exited, timeout]);
    clearTimeout(timer);
    await Promise.race([drained, sleep(DRAIN_GRACE_MS)]);
    return {
      exitCode,
      stdout: out.text(),
      stderr: err.text(),
      truncated: out.truncated || err.truncated,
    };
  }

  /** A command with its stdin open that outlives the request. */
  async startProcess(command: {
    label: string;
    cmd: string;
    args: string[];
  }): Promise<Result<{ processId: string }>> {
    const container = this.#d.container;
    if (!container?.running) return fail("not_ready");
    try {
      const stdin = new TransformStream<Uint8Array, Uint8Array>();
      const handle = await container.exec([command.cmd, ...command.args], {
        stdin: stdin.readable,
      });
      const processId = `p-${this.#d.newId()}`;
      const live: LiveProcess = {
        writer: stdin.writable.getWriter(),
        handle,
        exitCode: null,
        exited: handle.exitCode.catch(() => EXIT_KILLED),
      };
      void live.exited.then((code) => {
        live.exitCode = code;
        live.writer = null;
      });
      // Nobody reads the output of these processes: it is drained so that the pipe never fills, and kept to nothing.
      const sink = new TailBuffer(1024);
      void drain(handle.stdout, sink);
      void drain(handle.stderr, sink);
      this.#processes.set(processId, live);
      await this.#d.storage.put(`proc:${processId}`, {
        label: command.label,
        startedAtMs: this.#d.now(),
      } satisfies StoredProcess);
      return ok({ processId });
    } catch {
      this.#d.logger.warn("process_start_failed", { label: command.label });
      return fail("unavailable");
    }
  }

  async writeStdin(processId: string, data: string): Promise<Result<null>> {
    const live = this.#processes.get(processId);
    if (!live) return fail("not_ready");
    if (live.writer === null) return ok(null); // ended: the write goes nowhere, like a write to a closed pipe the caller ignores
    try {
      await live.writer.write(encoder.encode(data));
      return ok(null);
    } catch {
      return ok(null);
    }
  }

  async closeStdin(processId: string): Promise<Result<null>> {
    const live = this.#processes.get(processId);
    if (!live) return fail("not_ready");
    const writer = live.writer;
    live.writer = null;
    try {
      await writer?.close();
    } catch {
      // already closed or the process is gone
    }
    return ok(null);
  }

  async waitProcess(
    processId: string,
    waitMs: number,
  ): Promise<Result<ProcessAnswer>> {
    const live = this.#processes.get(processId);
    if (!live) {
      // The Durable Object restarted and lost the handle: the process may still run, but nothing can drive it any more.
      const known = await this.#d.storage.get<StoredProcess>(
        `proc:${processId}`,
      );
      return known
        ? ok({ running: false, exitCode: EXIT_LOST })
        : fail("not_ready");
    }
    if (live.exitCode === null && waitMs > 0)
      await Promise.race([live.exited, sleep(waitMs)]);
    return ok(
      live.exitCode === null
        ? { running: true }
        : { running: false, exitCode: live.exitCode },
    );
  }

  /** Ends the VM: the Container, the alarm and everything stored. Safe to call again and for a VM that never existed. */
  async destroy(): Promise<void> {
    const { container, storage } = this.#d;
    for (const live of this.#processes.values()) {
      try {
        live.handle.kill(9);
      } catch {
        // already gone
      }
    }
    this.#processes.clear();
    await storage.deleteAlarm().catch(() => undefined);
    if (container?.running)
      await container
        .destroy("destroyed")
        .catch(() => this.#d.logger.warn("destroy_failed"));
    await storage.deleteAll();
    this.#policy = null;
  }

  /** The alarm: the activity that keeps the Container up, and the end of the VM at its deadline (or when the platform stopped the Container). */
  async alarm(): Promise<void> {
    const { container, storage } = this.#d;
    const meta = await storage.get<VmMeta>("meta");
    if (!meta) return;
    const plan = planAlarm(this.#d.now(), meta.createdAtMs + meta.timeoutMs);
    if (plan.action === "destroy" || !container?.running) {
      await this.destroy();
      await this.#d.registry
        .remove(meta.name)
        .catch(() => this.#d.logger.warn("registry_remove_failed"));
      return;
    }
    await storage.setAlarm(plan.atMs);
  }
}
