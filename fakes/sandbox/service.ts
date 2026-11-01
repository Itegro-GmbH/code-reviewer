// SPDX-License-Identifier: LicenseRef-Proprietary

// An in-process double of the Sandbox platform for the Sandbox-Launcher (#329). It speaks the port of
// dispatcher/src/launchers/sandbox-service.ts, which it matches structurally: this file imports nothing from the
// Dispatcher, as fakes/ is shared by every project. A VM here is a record, not a machine: no command runs.
//
// A test scripts the answer of a command with `onExec` (matched by the step label or by a regular expression over
// the command line); anything unscripted ends with exit code 0 and no output. A started process (the Worker's
// `docker run`) stays running until the test ends it with `exitProcess`, or until its VM is stopped, which ends it
// with 137 like a killed process. Everything a caller sends except the stdin of a process is kept as text in
// `requestText()`, so a test can prove that a secret never left the process any other way than on that pipe.
// The golden snapshot pipeline's double is `fakes/vercel-sandbox/`; the two do not share state. See README.md.

import { mountinfoAfter } from "./mountinfo.ts";

export type FakeCreateOptions = {
  name: string;
  snapshotId: string;
  region: string;
  vcpus: number;
  timeoutMs: number;
  tags: Readonly<Record<string, string>>;
  persistent: boolean;
};

export type FakeExecRequest = {
  label: string;
  cmd: string;
  args: readonly string[];
  sudo?: boolean;
  timeoutMs?: number;
};

export type FakeExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type FakeExecCall = FakeExecRequest & { vm: string };

export type ExecHandler =
  Partial<FakeExecResult> | ((call: FakeExecCall) => Partial<FakeExecResult>);

type Rule = {
  match: string | RegExp;
  handler: ExecHandler;
  remaining: number;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export type FakeVmRecord = {
  name: string;
  options: FakeCreateOptions;
  state: "running" | "stopped";
  /** When the platform created it, in milliseconds since the epoch (the fake's `now` at `create`, or what a test seeds). */
  createdAtMs: number;
  /** The platform's word for the state when a test needs one other than the two of `state`. */
  statusWord?: string;
};

/** What `list` yields; it matches `ListedVm` of the Launcher's port, which this file does not import. */
export type FakeListedVm = {
  name: string;
  createdAtMs: number;
  status: string;
  timeoutMs?: number;
  persistent?: boolean;
  tags: Record<string, string>;
};

export type FakeListFilter = {
  namePrefix: string;
  tags: Readonly<Record<string, string>>;
};

type FakeProcessRecord = {
  vm: string;
  label: string;
  stdin: string;
  stdinClosed: boolean;
  exit: Deferred<{ exitCode: number }>;
  ended: boolean;
  /** The `wait()` calls that have not ended yet; `dropWaits` rejects them like a broken log stream. */
  pendingWaits: Set<(error: Error) => void>;
};

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class FakeSandboxService {
  /** Every observable action in order: `create:<vm>`, `exec:<label>`, `start:<label>`, `stdin:<vm>`, `stop:<vm>`. */
  readonly events: string[] = [];
  readonly creates: FakeCreateOptions[] = [];
  readonly execs: FakeExecCall[] = [];
  readonly starts: FakeExecCall[] = [];
  /** Every name `stop` was called with, in order. */
  readonly stops: string[] = [];
  /** Every name `delete` was called with, in order. */
  readonly deletes: string[] = [];
  readonly vms = new Map<string, FakeVmRecord>();
  private readonly processes: FakeProcessRecord[] = [];
  private readonly rules: Rule[] = [];
  private readonly holds: Array<string | RegExp> = [];
  private createError: Error | undefined;
  private createGate: Deferred<void> | undefined;
  private stopError: Error | undefined;
  private readonly stopErrors = new Map<string, Error>();
  private deleteError: Error | undefined;
  private readonly deleteErrors = new Map<string, Error>();
  private ignoreFilter = false;
  private waitFailures: { remaining: number; error: Error } | undefined;
  private rename: ((name: string) => string) | undefined;
  private listError: Error | undefined;
  /** Every filter `list` was called with, in order. */
  readonly lists: FakeListFilter[] = [];

  /** `now` stamps the creation time of a VM and is what a test moves to age one; the real clock by default. */
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  // ---- scripting -------------------------------------------------------------------------------

  /** Answers the commands with this label (or whose command line matches) until `times` answers were given. */
  onExec(
    match: string | RegExp,
    handler: ExecHandler,
    options: { times?: number } = {},
  ): void {
    this.rules.unshift({
      match,
      handler,
      remaining: options.times ?? Infinity,
    });
  }

  /** The commands with this label (or whose command line matches) never answer by themselves: they end only when their signal aborts, like a platform call that hangs. */
  hangOn(match: string | RegExp): void {
    this.holds.push(match);
  }

  /** The next `create` throws this error (a `SandboxServiceError` of the Dispatcher, brought by the test). */
  failNextCreate(error: Error): void {
    this.createError = error;
  }

  /** Every following `stop` throws this error; with a name, only the `stop` of that VM does. */
  failStops(error: Error, name?: string): void {
    if (name === undefined) this.stopError = error;
    else this.stopErrors.set(name, error);
  }

  /** Every following `delete` throws this error; with a name, only the `delete` of that VM does. */
  failDeletes(error: Error, name?: string): void {
    if (name === undefined) this.deleteError = error;
    else this.deleteErrors.set(name, error);
  }

  /** The `delete` calls work again. */
  healDeletes(): void {
    this.deleteError = undefined;
    this.deleteErrors.clear();
  }

  /** The `stop` calls work again (a failed stop is retried by the next run of the reaper). */
  healStops(): void {
    this.stopError = undefined;
    this.stopErrors.clear();
  }

  /** `list` returns every VM whatever the filter says: a platform that does not honour it, to prove the caller checks. */
  listIgnoresFilter(): void {
    this.ignoreFilter = true;
  }

  /** The next `list` throws this error (a `SandboxServiceError` of the Dispatcher, brought by the test). */
  failNextList(error: Error): void {
    this.listError = error;
  }

  /**
   * A VM that is on the platform without a launch of this fake: one an earlier Dispatcher made, a golden builder or
   * somebody else's. `timeoutMs` and `status` are reported by `list` the way the platform does.
   */
  seedVm(vm: {
    name: string;
    tags?: Record<string, string>;
    createdAtMs?: number;
    timeoutMs?: number;
    /** The platform's word: `running` (the default), `stopping`, `stopped`, ... */
    status?: string;
    /** A persistent VM, like the golden builder; `list` reports it. */
    persistent?: boolean;
  }): void {
    const status = vm.status ?? "running";
    this.vms.set(vm.name, {
      name: vm.name,
      options: {
        name: vm.name,
        snapshotId: "seeded",
        region: "fra1",
        vcpus: 1,
        timeoutMs: vm.timeoutMs ?? 0,
        tags: { ...vm.tags },
        persistent: vm.persistent ?? false,
      },
      state:
        status === "running" || status === "pending" ? "running" : "stopped",
      createdAtMs: vm.createdAtMs ?? this.now(),
      statusWord: status,
    });
  }

  /** The VMs the platform creates get a different name than the requested one (a normalised name). */
  renameCreatedVms(rename: (name: string) => string): void {
    this.rename = rename;
  }

  /** Rejects the `wait()` calls of the VM's processes that are pending now, like a log stream that broke. */
  dropWaits(vm: string, error: Error): void {
    for (const process of this.processes)
      if (process.vm === vm && !process.ended)
        for (const reject of [...process.pendingWaits]) reject(error);
  }

  /** The next `times` calls of `wait()` reject at once with this error. */
  failWaits(times: number, error: Error): void {
    this.waitFailures = { remaining: times, error };
  }

  /** The next `create` waits until `release()` is called or its signal aborts. */
  holdNextCreate(): { release: () => void } {
    const gate = deferred<void>();
    this.createGate = gate;
    return { release: () => gate.resolve() };
  }

  /** Ends the running process of a VM (the first one with this label, or the first running one). */
  exitProcess(vm: string, exitCode: number, label?: string): void {
    const process = this.processes.find(
      (candidate) =>
        candidate.vm === vm &&
        !candidate.ended &&
        (label === undefined || candidate.label === label),
    );
    if (process === undefined)
      throw new Error(`No running process in ${vm} to end.`);
    this.end(process, exitCode);
  }

  // ---- what the tests look at ------------------------------------------------------------------

  /** What was written to the stdin of the processes of a VM, in one text. */
  stdinOf(vm: string): string {
    return this.processes
      .filter((process) => process.vm === vm)
      .map((process) => process.stdin)
      .join("");
  }

  /** Whether the stdin of the VM's process was closed (the Worker reads to the end of it). */
  stdinClosed(vm: string): boolean {
    return this.processes.some(
      (process) => process.vm === vm && process.stdinClosed,
    );
  }

  /** Every request except process stdin, as one text: create options, command lines and stop calls. */
  requestText(): string {
    return JSON.stringify({
      creates: this.creates,
      execs: this.execs,
      starts: this.starts,
      stops: this.stops,
    });
  }

  /** How many `wait()` calls are still pending on any process: a caller that watches a container holds one. */
  pendingWaits(): number {
    return this.processes.reduce(
      (count, process) => count + process.pendingWaits.size,
      0,
    );
  }

  /** The VMs that were created and not stopped. */
  running(): string[] {
    return [...this.vms.values()]
      .filter((vm) => vm.state === "running")
      .map((vm) => vm.name);
  }

  // ---- the port --------------------------------------------------------------------------------

  async create(options: FakeCreateOptions, signal?: AbortSignal) {
    this.events.push(`create:${options.name}`);
    this.creates.push(structuredClone(options));
    if (this.createError !== undefined) {
      const error = this.createError;
      this.createError = undefined;
      throw error;
    }
    if (this.createGate !== undefined) {
      const gate = this.createGate;
      this.createGate = undefined;
      await new Promise<void>((resolve, reject) => {
        void gate.promise.then(resolve);
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });
    }
    const name = this.rename?.(options.name) ?? options.name;
    if (this.vms.has(name))
      throw new Error(`The sandbox name ${name} is taken.`);
    const record: FakeVmRecord = {
      name,
      options: structuredClone(options),
      state: "running",
      createdAtMs: this.now(),
    };
    this.vms.set(name, record);
    return this.vm(record);
  }

  /**
   * The VMs whose name starts with the prefix and that carry every tag of the filter, like the platform's listing
   * (which narrows by one tag; the fake accepts more). A VM that was stopped is still listed, as `stopped`.
   */
  async list(filter: FakeListFilter): Promise<FakeListedVm[]> {
    this.events.push("list");
    this.lists.push(structuredClone(filter));
    if (this.listError !== undefined) {
      const error = this.listError;
      this.listError = undefined;
      throw error;
    }
    return [...this.vms.values()]
      .filter(
        (vm) =>
          this.ignoreFilter ||
          (vm.name.startsWith(filter.namePrefix) &&
            Object.entries(filter.tags).every(
              ([key, value]) => vm.options.tags[key] === value,
            )),
      )
      .map((vm) => ({
        name: vm.name,
        createdAtMs: vm.createdAtMs,
        status:
          vm.state === "running"
            ? (vm.statusWord ?? "running")
            : (vm.statusWord ?? "stopped"),
        ...(vm.options.timeoutMs > 0
          ? { timeoutMs: vm.options.timeoutMs }
          : {}),
        persistent: vm.options.persistent,
        tags: { ...vm.options.tags },
      }));
  }

  async stop(name: string): Promise<void> {
    this.events.push(`stop:${name}`);
    this.stops.push(name);
    if (this.stopError !== undefined) throw this.stopError;
    const named = this.stopErrors.get(name);
    if (named !== undefined) throw named;
    const record = this.vms.get(name);
    if (record === undefined || record.state === "stopped") return;
    record.state = "stopped";
    delete record.statusWord;
    for (const process of this.processes)
      if (process.vm === name && !process.ended) this.end(process, 137);
  }

  /** Removes the VM from the platform: it is no longer listed. Deleting one that is gone is not an error. */
  async delete(name: string): Promise<void> {
    this.events.push(`delete:${name}`);
    this.deletes.push(name);
    if (this.deleteError !== undefined) throw this.deleteError;
    const named = this.deleteErrors.get(name);
    if (named !== undefined) throw named;
    this.vms.delete(name);
  }

  // ---- internals -------------------------------------------------------------------------------

  private end(process: FakeProcessRecord, exitCode: number): void {
    process.ended = true;
    process.exit.resolve({ exitCode });
  }

  private answer(call: FakeExecCall): FakeExecResult {
    const line = `${call.cmd} ${call.args.join(" ")}`;
    const rule = this.rules.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (typeof candidate.match === "string"
          ? candidate.match === call.label
          : candidate.match.test(line)),
    );
    const given =
      rule === undefined
        ? {}
        : typeof rule.handler === "function"
          ? rule.handler(call)
          : rule.handler;
    if (rule !== undefined) rule.remaining -= 1;
    // The mounts of the VM as the commands made them (#760): what a read of its mountinfo would show, unless scripted.
    const mounts =
      rule === undefined &&
      call.cmd === "cat" &&
      call.args[0] === "/proc/self/mountinfo"
        ? {
            stdout: mountinfoAfter(
              this.execs.filter((other) => other.vm === call.vm),
            ),
          }
        : {};
    return { exitCode: 0, stdout: "", stderr: "", ...mounts, ...given };
  }

  private requireRunning(record: FakeVmRecord): void {
    if (record.state !== "running")
      throw new Error(`The sandbox ${record.name} is stopped.`);
  }

  private vm(record: FakeVmRecord) {
    return {
      name: record.name,
      exec: (request: FakeExecRequest, signal?: AbortSignal) => {
        this.requireRunning(record);
        if (signal?.aborted) return Promise.reject(abortError());
        this.events.push(`exec:${request.label}`);
        const call: FakeExecCall = { ...request, vm: record.name };
        this.execs.push(structuredClone(call));
        const line = `${call.cmd} ${call.args.join(" ")}`;
        if (
          this.holds.some((hold) =>
            typeof hold === "string" ? hold === call.label : hold.test(line),
          )
        )
          return new Promise<FakeExecResult>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(abortError()), {
              once: true,
            });
          });
        return Promise.resolve(this.answer(call));
      },
      start: (request: FakeExecRequest) => {
        this.requireRunning(record);
        this.events.push(`start:${request.label}`);
        const call: FakeExecCall = { ...request, vm: record.name };
        this.starts.push(structuredClone(call));
        const process: FakeProcessRecord = {
          vm: record.name,
          label: request.label,
          stdin: "",
          stdinClosed: false,
          exit: deferred(),
          ended: false,
          pendingWaits: new Set(),
        };
        this.processes.push(process);
        return Promise.resolve({
          writeStdin: (data: string) => {
            this.events.push(`stdin:${record.name}`);
            process.stdin += data;
            return Promise.resolve();
          },
          closeStdin: () => {
            process.stdinClosed = true;
            return Promise.resolve();
          },
          wait: (signal?: AbortSignal) => {
            const failures = this.waitFailures;
            if (failures !== undefined && failures.remaining > 0) {
              failures.remaining -= 1;
              return Promise.reject(failures.error);
            }
            return new Promise<{ exitCode: number }>((resolve, reject) => {
              process.pendingWaits.add(reject);
              const done = () => process.pendingWaits.delete(reject);
              void process.exit.promise.then((result) => {
                done();
                resolve(result);
              });
              if (signal?.aborted) {
                done();
                reject(abortError());
              }
              signal?.addEventListener(
                "abort",
                () => {
                  done();
                  reject(abortError());
                },
                { once: true },
              );
            });
          },
        });
      },
    };
  }
}
