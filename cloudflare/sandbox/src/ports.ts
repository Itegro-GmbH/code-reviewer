// SPDX-License-Identifier: LicenseRef-Proprietary

// What the controllers need of the platform, as small interfaces: the Durable Object classes (vm-do.ts, registry-do.ts) adapt
// `ctx.container` and `ctx.storage` to them, the tests use fakes. Nothing here imports `cloudflare:workers`.
import type { NetworkPolicy } from "./policy.ts";

export type InstanceOption =
  string | { vcpu: number; memoryMib: number; diskMb: number };

export interface ProcessHandle {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exitCode: Promise<number>;
  kill(signal?: number): void;
}

export interface ContainerPort {
  readonly running: boolean;
  /** The outbound handlers (the outer wall). Must be registered before `start`, and again after the Durable Object restarted. */
  registerIntercepts(): Promise<void>;
  start(options: { instance: InstanceOption; entrypoint: string[] }): void;
  exec(
    cmd: string[],
    options: { stdin?: ReadableStream<Uint8Array> },
  ): Promise<ProcessHandle>;
  setInactivityTimeout(ms: number): Promise<void>;
  destroy(reason: string): Promise<void>;
}

export interface VmStoragePort {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(atMs: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface RegistryRemover {
  remove(name: string): Promise<void>;
}

export interface Logger {
  /** Event names and numbers only: never a command, an output, a URL or a header. */
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
}

export type VmMeta = {
  name: string;
  instanceType: string;
  createdAtMs: number;
  timeoutMs: number;
};
export type StoredProcess = { label: string; startedAtMs: number };
export type StoredPolicy = NetworkPolicy;
