// SPDX-License-Identifier: LicenseRef-Proprietary

// The local mode of the Sandbox double (#329): the port of dispatcher/src/launchers/sandbox-service.ts over the
// Docker daemon of this machine. A "VM" is a temporary directory; the commands the Sandbox-Launcher runs in it run
// here, so the rendered `docker run` meets a real Docker (or, in the host suites, a stand-in `docker` executable)
// with the same flags and the same stdin pipe the real VM would get. Test use only; it imports nothing from the
// Dispatcher (fakes/ is shared by every project).
//
// What local mode is not: a VM. There is no snapshot (the image is whatever the local daemon has), no cgroup fix
// and no daemon start (`vm-prepare.sh`, the Implementer's `sysbox-prepare.sh` and its `ipv6-off` step succeed without doing anything), no `sudo`, no mounts (the work volume's
// `mkdir` and `mount` succeed without doing anything, and a read of the mountinfo shows what they asked for) and no kernel of its own. What
// it proves is the container spec end to end and that nothing of one job is left for the next: the directory of a
// stopped "VM" is removed and every container it started is force-removed.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountinfoAfter } from "./mountinfo.ts";

export type LocalExecRequest = {
  label: string;
  cmd: string;
  args: readonly string[];
  sudo?: boolean;
  timeoutMs?: number;
};

export type LocalCreateOptions = {
  name: string;
  snapshotId: string;
  region: string;
  vcpus: number;
  timeoutMs: number;
  tags: Readonly<Record<string, string>>;
  persistent: boolean;
};

export type LocalSandboxOptions = {
  /** The `docker` executable: the real one by default, or a script that stands in for it. */
  dockerBin?: string;
  /** Where the "VM" directories are made; the system's temporary directory by default. */
  root?: string;
  /** Extra environment of the commands (for example `DOCKER_HOST`). The VM's home is always its own directory. */
  environment?: Readonly<Record<string, string>>;
};

/** What `list` yields; it matches `ListedVm` of the Launcher's port, which this file does not import. */
export type LocalListedVm = {
  name: string;
  createdAtMs: number;
  status: string;
  timeoutMs: number;
  persistent: boolean;
  tags: Record<string, string>;
};

type LocalVmState = {
  name: string;
  createdAtMs: number;
  timeoutMs: number;
  persistent: boolean;
  tags: Record<string, string>;
  dir: string;
  children: Set<ChildProcess>;
  containers: Set<string>;
  /** The host steps (`mkdir`, `mount`) the VM was asked for: what its mountinfo shows. */
  hostSteps: Array<{ cmd: string; args: readonly string[] }>;
  stopped: boolean;
};

const PREPARE = "/usr/local/sbin/vm-prepare.sh";
// Like the cgroup fix: local mode has no kernel of its own to prepare for Sysbox.
const SYSBOX_PREPARE = "/usr/local/sbin/sysbox-prepare.sh";
// The steps of the Implementer's launch that change the VM itself (#760, #745): a directory, a mount, the reserve disk's image
// and its file system. Local mode has no VM of its own (like the cgroup fix and the daemon start, they succeed without doing
// anything); the `docker volume create` that follows them is a docker command and goes to the daemon, or the stand-in, like
// any other.
const HOST_STEPS: ReadonlySet<string> = new Set([
  "mkdir",
  "mount",
  "fallocate",
  "mkfs.ext4",
]);
const MOUNTINFO = "/proc/self/mountinfo";

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class LocalSandboxService {
  /** The names `create` was called with, in order. */
  readonly created: string[] = [];
  /** The directory of each VM, kept after its stop so a test can prove it is gone. */
  readonly directories = new Map<string, string>();
  private readonly vms = new Map<string, LocalVmState>();
  private readonly dockerBin: string;
  private readonly root: string | undefined;
  private readonly environment: Record<string, string>;

  constructor(options: LocalSandboxOptions = {}) {
    this.dockerBin = options.dockerBin ?? "docker";
    this.root = options.root;
    this.environment = { ...options.environment };
  }

  async create(options: LocalCreateOptions, signal?: AbortSignal) {
    if (signal?.aborted) throw abortError();
    if (this.vms.has(options.name))
      throw new Error(`The sandbox name ${options.name} is taken.`);
    this.created.push(options.name);
    const base = this.root ?? tmpdir();
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, "cr-sandbox-"));
    const state: LocalVmState = {
      name: options.name,
      createdAtMs: Date.now(),
      timeoutMs: options.timeoutMs,
      persistent: options.persistent,
      tags: { ...options.tags },
      dir,
      children: new Set(),
      containers: new Set(),
      hostSteps: [],
      stopped: false,
    };
    this.vms.set(options.name, state);
    this.directories.set(options.name, dir);
    return this.vm(state);
  }

  async stop(name: string): Promise<void> {
    const state = this.vms.get(name);
    if (state === undefined || state.stopped) return;
    state.stopped = true;
    // A killed `docker run` client leaves its container running on the daemon: remove the containers first.
    for (const container of state.containers)
      await this.dockerQuietly(state, ["rm", "--force", container]);
    for (const child of state.children) child.kill("SIGKILL");
    await rm(state.dir, { recursive: true, force: true });
  }

  /** Stops the VM and forgets it, as the platform's delete does: it is no longer listed (#802). */
  async delete(name: string): Promise<"deleted"> {
    await this.stop(name);
    this.vms.delete(name);
    return "deleted";
  }

  /**
   * The VMs whose name starts with the prefix and that carry every tag of the filter, like the platform's listing; a
   * VM that was stopped is still listed, as `stopped`.
   */
  list(filter: {
    namePrefix: string;
    tags: Readonly<Record<string, string>>;
  }): Promise<LocalListedVm[]> {
    return Promise.resolve(
      [...this.vms.values()]
        .filter(
          (state) =>
            state.name.startsWith(filter.namePrefix) &&
            Object.entries(filter.tags).every(
              ([key, value]) => state.tags[key] === value,
            ),
        )
        .map((state) => ({
          name: state.name,
          createdAtMs: state.createdAtMs,
          status: state.stopped ? "stopped" : "running",
          timeoutMs: state.timeoutMs,
          persistent: state.persistent,
          tags: { ...state.tags },
        })),
    );
  }

  /** Stops every VM that is still up: a suite's `afterEach`, so a failed test leaves nothing behind. */
  async stopAll(): Promise<void> {
    for (const name of [...this.vms.keys()]) await this.stop(name);
  }

  /** The VMs that were created and not stopped. */
  running(): string[] {
    return [...this.vms.values()]
      .filter((state) => !state.stopped)
      .map((state) => state.name);
  }

  // ---- internals -------------------------------------------------------------------------------

  private env(state: LocalVmState): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "",
      ...(process.env.DOCKER_HOST === undefined
        ? {}
        : { DOCKER_HOST: process.env.DOCKER_HOST }),
      ...this.environment,
      HOME: state.dir,
    };
  }

  private command(request: LocalExecRequest): string | undefined {
    if (request.cmd === "docker") return this.dockerBin;
    return undefined;
  }

  private spawnIn(
    state: LocalVmState,
    command: string,
    args: readonly string[],
  ): ChildProcess {
    const child = spawn(command, [...args], {
      cwd: state.dir,
      env: this.env(state),
      stdio: ["pipe", "pipe", "pipe"],
    });
    state.children.add(child);
    child.once("close", () => state.children.delete(child));
    return child;
  }

  private rememberContainer(state: LocalVmState, args: readonly string[]) {
    if (args[0] !== "run") return;
    const at = args.indexOf("--name");
    const name = at < 0 ? undefined : args[at + 1];
    if (name !== undefined) state.containers.add(name);
  }

  private dockerQuietly(
    state: LocalVmState,
    args: readonly string[],
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const child = spawn(this.dockerBin, [...args], {
        cwd: state.dir,
        env: this.env(state),
        stdio: "ignore",
      });
      child.once("error", () => resolve());
      child.once("close", () => resolve());
    });
  }

  private vm(state: LocalVmState) {
    return {
      name: state.name,
      exec: (request: LocalExecRequest, signal?: AbortSignal) =>
        new Promise<{ exitCode: number; stdout: string; stderr: string }>(
          (resolve, reject) => {
            if (state.stopped) return reject(new Error("The VM is stopped."));
            if (signal?.aborted) return reject(abortError());
            // The Implementer's VM starts the daemon through `env TMPDIR=... vm-prepare.sh` (#745).
            // `ipv6-off` writes the kernel's files: a stand-in on the host's own kernel never does.
            if (
              request.label === "ipv6-off" ||
              request.cmd === PREPARE ||
              request.cmd === SYSBOX_PREPARE ||
              (request.cmd === "env" && request.args.includes(PREPARE))
            )
              return resolve({ exitCode: 0, stdout: "", stderr: "" });
            if (HOST_STEPS.has(request.cmd)) {
              state.hostSteps.push({ cmd: request.cmd, args: request.args });
              return resolve({ exitCode: 0, stdout: "", stderr: "" });
            }
            if (request.cmd === "cat" && request.args[0] === MOUNTINFO)
              return resolve({
                exitCode: 0,
                stdout: mountinfoAfter(state.hostSteps),
                stderr: "",
              });
            const command = this.command(request);
            if (command === undefined)
              return resolve({
                exitCode: 127,
                stdout: "",
                stderr: "not available in local mode",
              });
            const child = this.spawnIn(state, command, request.args);
            let stdout = "";
            let stderr = "";
            child.stdout?.on(
              "data",
              (chunk: Buffer) => (stdout += String(chunk)),
            );
            child.stderr?.on(
              "data",
              (chunk: Buffer) => (stderr += String(chunk)),
            );
            child.stdin?.end();
            child.once("error", reject);
            child.once("close", (code) =>
              resolve({ exitCode: code ?? 137, stdout, stderr }),
            );
          },
        ),
      start: (request: LocalExecRequest) => {
        if (state.stopped)
          return Promise.reject(new Error("The VM is stopped."));
        const command = this.command(request);
        if (command === undefined)
          return Promise.reject(new Error("not available in local mode"));
        this.rememberContainer(state, request.args);
        const child = this.spawnIn(state, command, request.args);
        child.stdout?.resume();
        child.stderr?.resume();
        const ended = new Promise<{ exitCode: number }>((resolve) => {
          child.once("error", () => resolve({ exitCode: 127 }));
          child.once("close", (code) => resolve({ exitCode: code ?? 137 }));
        });
        return Promise.resolve({
          writeStdin: (data: string) =>
            new Promise<void>((resolve, reject) =>
              child.stdin?.write(data, (error) =>
                error ? reject(error) : resolve(),
              ),
            ),
          closeStdin: () =>
            new Promise<void>((resolve) => child.stdin?.end(() => resolve())),
          wait: (signal?: AbortSignal) =>
            signal === undefined
              ? ended
              : Promise.race([
                  ended,
                  new Promise<never>((_resolve, reject) => {
                    if (signal.aborted) reject(abortError());
                    signal.addEventListener(
                      "abort",
                      () => reject(abortError()),
                      {
                        once: true,
                      },
                    );
                  }),
                ]),
        });
      },
    };
  }
}
