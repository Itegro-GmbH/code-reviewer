// SPDX-License-Identifier: LicenseRef-Proprietary

// Where `docker run` executes for the Sandbox-Launcher (#329): inside one fresh Sandbox VM. It is a
// `ContainerHost` (container.ts), so the flags come from the one hardened container spec; what it adds is the
// life of the VM around that command:
//
//   prepare()  vm-prepare.sh as root (the cgroup fix, then dockerd, spike #317 F1), then the image check
//   createWorkVolume()  the Implementer's profile only (#760): the steps that make the job's work volume in this VM
//   run()      `docker run --interactive ...` as a process with a stdin pipe; the start document is written to
//              the pipe and the pipe closed. Nothing else carries it: not an argument, not the environment,
//              not a file on the VM.
//   handover   settles once the Worker has taken over (see `handover` below)
//
// A pending launch that is aborted kills the container by name; stopping the VM is the launcher's job. Nothing
// watches the container after the hand-over (#487): the wait that tells the hand-over from an early end is ended
// then, and the VM is stopped by the App's signal (`POST /stop`), with the reaper and the VM timeout behind it.
import { LaunchError, type Clock, type Logger } from "../core/types.ts";
import type {
  ContainerHost,
  ContainerInvocation,
  ContainerRunResult,
  HostCommand,
} from "./container.ts";
import type { SandboxVm } from "./sandbox-service.ts";
import { VM_PREPARE_FAILED_EVENT, stderrTail } from "./vm-prepare-log.ts";

/** Installed into the golden snapshot by the pipeline (#330) from docker/sandbox/vm-prepare.sh. */
export const VM_PREPARE_PATH = "/usr/local/sbin/vm-prepare.sh";
const VM_PREPARE_TIMEOUT_MS = 60_000;
const IMAGE_CHECK_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_MS = 15_000;
/** Each step of the work volume is a `mkdir`, a `mount` or one `docker volume create`: a second or so, never half a minute. */
export const WORK_VOLUME_STEP_TIMEOUT_MS = 10_000;

export type SandboxDockerHostOptions = {
  vm: SandboxVm;
  clock: Clock;
  logger: Logger;
  /** Fields of the log lines of this VM besides its name: the job id, or `canary: true`. */
  logFields?: Readonly<Record<string, string | boolean>>;
  /** The tag the golden snapshot's image has (#330), looked up to read its id. */
  imageReference: string;
  /** The id the Dispatcher is configured with; the image in the VM must be this one. */
  imageDigest: string;
  /** How long the container must have run for the Worker to count as having taken over. */
  handoverSeconds: number;
};

/** How often a failed `wait()` is asked again, and how long to wait between the tries. */
export const WAIT_ATTEMPTS = 3;
const WAIT_RETRY_DELAYS_MS = [2_000, 5_000] as const;

/** `wait()` kept failing before the hand-over: whether the container started is unknown, so the launch fails. */
export class WorkerWaitError extends Error {
  readonly code = "worker_wait_failed";
  readonly attempts: number;

  constructor(attempts: number) {
    super("worker_wait_failed");
    this.name = "WorkerWaitError";
    this.attempts = attempts;
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

/** The `--name` of a rendered `docker run`, so a pending container can be killed. */
function containerNameOf(args: readonly string[]): string | undefined {
  const at = args.indexOf("--name");
  return at < 0 ? undefined : args[at + 1];
}

export class SandboxDockerHost implements ContainerHost {
  /**
   * Settles once the Worker has taken over: the container is running and has been given its start document, and
   * it has run for `handoverSeconds` (or it ended with 0 sooner). The Worker owns the lease from its first
   * heartbeat, which follows its startup and the fetch of its job by a few seconds; the core keeps the lease alive
   * until this settles. Rejects with a `LaunchError` when the container ends with an error first, or the launch
   * is aborted. A time is the stand-in for the Worker's own signal, which does not exist yet (follow-up).
   */
  readonly handover: Promise<void>;
  readonly #options: SandboxDockerHostOptions;
  #settle!: { resolve: () => void; reject: (error: unknown) => void };
  #settled = false;

  constructor(options: SandboxDockerHostOptions) {
    this.#options = options;
    this.handover = new Promise<void>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    this.handover.catch(() => undefined);
  }

  /** Starts the daemon and proves the image in the VM is the one the Dispatcher is configured with. */
  async prepare(signal: AbortSignal): Promise<void> {
    const { vm } = this.#options;
    const prepared = await vm.exec(
      {
        label: "vm-prepare",
        cmd: VM_PREPARE_PATH,
        args: [],
        sudo: true,
        timeoutMs: VM_PREPARE_TIMEOUT_MS,
      },
      signal,
    );
    if (prepared.exitCode !== 0) {
      // The one place the stderr of the script is read: its exit status and the end of it make the failure
      // diagnosable. The error code stays the stable `docker_not_ready` for everyone who branches on it.
      this.#options.logger.warn(VM_PREPARE_FAILED_EVENT, {
        ...this.#options.logFields,
        sandbox: vm.name,
        code: "docker_not_ready",
        exitCode: prepared.exitCode,
        stderrTail: stderrTail(prepared.stderr),
      });
      throw new LaunchError("docker_not_ready", { retryable: true });
    }

    const image = await vm.exec(
      {
        label: "image-id",
        cmd: "docker",
        args: [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          this.#options.imageReference,
        ],
        sudo: true,
        timeoutMs: IMAGE_CHECK_TIMEOUT_MS,
      },
      signal,
    );
    if (image.exitCode !== 0) throw new LaunchError("image_missing");
    // The text of the answer is not logged or echoed: only whether it is the configured id.
    if (image.stdout.trim() !== this.#options.imageDigest)
      throw new LaunchError("image_mismatch");
  }

  /**
   * Makes the work volume of the Implementer's profile in this VM, step by step (`workVolumeCommands`), and stops at the
   * first step that fails: a non-zero exit status, a step that takes longer than `WORK_VOLUME_STEP_TIMEOUT_MS` (the
   * Launcher's own clock, so that a platform that ignores the signal cannot hang the launch), or a step whose output
   * does not pass its check (the mount options read back from the kernel). The volume and its mount are the VM's:
   * stopping the VM, which the Launcher does after any failure, removes them; nothing is removed here. The log names
   * the step and why, never the text of the step.
   */
  async createWorkVolume(
    commands: readonly HostCommand[],
    signal: AbortSignal,
  ): Promise<void> {
    const { vm, clock } = this.#options;
    const failed = (command: HostCommand, why: string, exitCode?: number) => {
      this.#options.logger.warn("work_volume_failed", {
        ...this.#options.logFields,
        sandbox: vm.name,
        step: command.label,
        why,
        ...(exitCode === undefined ? {} : { exitCode }),
      });
      return new LaunchError("work_volume_failed", { retryable: true });
    };
    for (const command of commands) {
      const step = new AbortController();
      const forward = () => step.abort();
      signal.addEventListener("abort", forward, { once: true });
      const deadline = new AbortController();
      const expired = new Promise<"timeout">((resolve) => {
        void clock
          .sleep(WORK_VOLUME_STEP_TIMEOUT_MS, deadline.signal)
          .then(() => {
            if (!deadline.signal.aborted) resolve("timeout");
          });
      });
      const running = vm.exec(
        {
          label: command.label,
          cmd: command.cmd,
          args: command.args,
          sudo: command.sudo,
          timeoutMs: WORK_VOLUME_STEP_TIMEOUT_MS,
        },
        step.signal,
      );
      running.catch(() => undefined);
      let done: Awaited<typeof running> | "timeout";
      try {
        done = await Promise.race([running, expired]);
      } finally {
        deadline.abort();
        signal.removeEventListener("abort", forward);
        // A step that is still running (it timed out) is told to stop; the VM is stopped by the Launcher next.
        step.abort();
      }
      if (done === "timeout") throw failed(command, "timeout");
      if (done.exitCode !== 0) throw failed(command, "exit", done.exitCode);
      if (command.check !== undefined && !command.check(done.stdout))
        throw failed(command, "check");
    }
  }

  /** Fails the handover when the container could not even be started (a refused spec, say). */
  fail(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#settle.reject(error);
  }

  async run(invocation: ContainerInvocation): Promise<ContainerRunResult> {
    const { vm, clock } = this.#options;
    // Watches the caller's signal only until the hand-over: the core never aborts a launch that succeeded, and a
    // Worker that has taken over is not tied to it.
    const pending = new AbortController();
    // Ends the wait for the container: on an abort of the launch, and at the hand-over, when nobody watches it any more.
    const watch = new AbortController();
    const forward = () => {
      pending.abort();
      watch.abort();
    };
    invocation.signal?.addEventListener("abort", forward, { once: true });
    if (invocation.signal?.aborted) forward();
    const name = containerNameOf(invocation.args);

    try {
      const worker = await vm.start(
        {
          label: "docker-run",
          cmd: "docker",
          args: invocation.args,
          sudo: true,
        },
        pending.signal,
      );
      await worker.writeStdin(invocation.stdin);
      await worker.closeStdin();

      const exited = this.#wait(worker, watch.signal);
      exited.catch(() => undefined);
      const first = await Promise.race([
        exited.then((result) => ({ ended: result })),
        clock
          .sleep(this.#options.handoverSeconds * 1000, pending.signal)
          .then(() => ({ ended: undefined })),
      ]);
      if (pending.signal.aborted) {
        await this.#kill(name);
        throw new LaunchError("launch_aborted");
      }
      if (first.ended !== undefined && first.ended.exitCode !== 0)
        // Exit 1 is the Worker saying the job failed, after it delivered its own result: a second VM would get the
        // same answer, so it is not retryable. Any other code (a setup error 2, docker's own 125 to 127, a kill 137)
        // is about this VM or its start, which a fresh VM can get right.
        throw new LaunchError("worker_exited_early", {
          retryable: first.ended.exitCode !== 1,
        });
      this.#handedOver();
      invocation.signal?.removeEventListener("abort", forward);
      // The Worker owns the job from here. Nobody waits for its container: no `wait()` stays open.
      watch.abort();
      return { exitCode: first.ended?.exitCode ?? null };
    } catch (error) {
      invocation.signal?.removeEventListener("abort", forward);
      watch.abort();
      const failure = this.#asLaunchError(error, pending.signal);
      this.fail(failure);
      throw failure;
    }
  }

  /** `wait()` asked again a bounded number of times: a broken log stream is not the end of the container. */
  async #wait(
    worker: { wait(signal?: AbortSignal): Promise<{ exitCode: number }> },
    watch: AbortSignal,
  ): Promise<{ exitCode: number }> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await worker.wait(watch);
      } catch (error) {
        // An abort is the end of the watch (the launch's own end, or the hand-over), not a failed wait.
        if (watch.aborted || isAbort(error)) throw error;
        if (attempt >= WAIT_ATTEMPTS) throw new WorkerWaitError(attempt);
        await this.#options.clock.sleep(
          WAIT_RETRY_DELAYS_MS[attempt - 1] ?? 5_000,
          watch,
        );
        if (watch.aborted) throw error;
      }
    }
  }

  #handedOver(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#settle.resolve();
  }

  #asLaunchError(error: unknown, signal: AbortSignal): unknown {
    if (error instanceof LaunchError) return error;
    // After the hand-over the failure is the container's, not the launch's; the caller reads it as it is.
    if (this.#settled) return error;
    if (signal.aborted || isAbort(error))
      return new LaunchError("launch_aborted");
    return new LaunchError("worker_start_failed", { retryable: true });
  }

  async #kill(name: string | undefined): Promise<void> {
    if (name === undefined) return;
    try {
      await this.#options.vm.exec({
        label: "docker-kill",
        cmd: "docker",
        args: ["kill", name],
        sudo: true,
        timeoutMs: KILL_TIMEOUT_MS,
      });
    } catch {
      // Stopping the VM, which the launcher does next, ends the container anyway.
    }
  }
}
