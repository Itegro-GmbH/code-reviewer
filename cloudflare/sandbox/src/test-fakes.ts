// SPDX-License-Identifier: LicenseRef-Proprietary

// Fakes of the platform for the controllers' tests: no Cloudflare call anywhere.
import type {
  ContainerPort,
  InstanceOption,
  Logger,
  ProcessHandle,
  VmStoragePort,
} from "./ports.ts";
import type { RegistryStoragePort } from "./registry-controller.ts";

const encoder = new TextEncoder();

export type FakeExec = {
  /** Ends with this status at once; absent: the command runs until `finish()` or a kill. */
  exit?: number;
  stdout?: string;
  stderr?: string;
};

export class FakeProcess implements ProcessHandle {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exitCode: Promise<number>;
  readonly killed: number[] = [];
  readonly stdinChunks: string[] = [];
  stdinClosed = false;
  #resolve!: (code: number) => void;
  #outController!: ReadableStreamDefaultController<Uint8Array>;
  #errController!: ReadableStreamDefaultController<Uint8Array>;

  constructor(
    readonly cmd: string[],
    script: FakeExec,
    stdin: ReadableStream<Uint8Array> | undefined,
  ) {
    this.stdout = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#outController = c;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (c) => {
        this.#errController = c;
      },
    });
    this.exitCode = new Promise<number>((resolve) => (this.#resolve = resolve));
    if (script.stdout)
      this.#outController.enqueue(encoder.encode(script.stdout));
    if (script.stderr)
      this.#errController.enqueue(encoder.encode(script.stderr));
    if (script.exit !== undefined) this.finish(script.exit);
    if (stdin) void this.#readStdin(stdin);
  }

  async #readStdin(stdin: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stdin.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        this.stdinClosed = true;
        return;
      }
      this.stdinChunks.push(new TextDecoder().decode(value));
    }
  }

  finish(code: number): void {
    try {
      this.#outController.close();
      this.#errController.close();
    } catch {
      // closed already
    }
    this.#resolve(code);
  }

  kill(signal?: number): void {
    this.killed.push(signal ?? 15);
    this.finish(137);
  }
}

export class FakeContainer implements ContainerPort {
  running = false;
  readonly started: { instance: InstanceOption; entrypoint: string[] }[] = [];
  readonly execs: FakeProcess[] = [];
  readonly interceptCalls: number[] = [];
  inactivityTimeouts: number[] = [];
  destroyed: string[] = [];
  /** What each command does: by the first word of the command, or the default of an immediate success. */
  scripts = new Map<string, FakeExec>();
  failIntercepts = false;
  failExec = false;

  async registerIntercepts(): Promise<void> {
    this.interceptCalls.push(this.interceptCalls.length);
    if (this.failIntercepts) throw new Error("intercepts");
  }
  start(options: { instance: InstanceOption; entrypoint: string[] }): void {
    this.started.push(options);
    this.running = true;
  }
  async exec(
    cmd: string[],
    options: { stdin?: ReadableStream<Uint8Array> },
  ): Promise<ProcessHandle> {
    if (this.failExec) throw new Error("exec");
    const script = this.scripts.get(cmd[0] ?? "") ?? { exit: 0 };
    const process = new FakeProcess(cmd, script, options.stdin);
    this.execs.push(process);
    return process;
  }
  async setInactivityTimeout(ms: number): Promise<void> {
    this.inactivityTimeouts.push(ms);
  }
  async destroy(reason: string): Promise<void> {
    this.destroyed.push(reason);
    this.running = false;
  }
}

export class FakeVmStorage implements VmStoragePort {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async deleteAll(): Promise<void> {
    this.data.clear();
  }
  async setAlarm(atMs: number): Promise<void> {
    this.alarm = atMs;
  }
  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

export class FakeRegistryStorage implements RegistryStoragePort {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
  async list<T>(prefix: string): Promise<Map<string, T>> {
    return new Map(
      [...this.data].filter(([key]) => key.startsWith(prefix)) as [string, T][],
    );
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(atMs: number): Promise<void> {
    this.alarm = atMs;
  }
}

export class RecordingLogger implements Logger {
  events: {
    event: string;
    fields?: Record<string, string | number | boolean>;
  }[] = [];
  warn(
    event: string,
    fields?: Record<string, string | number | boolean>,
  ): void {
    this.events.push({ event, fields });
  }
}
