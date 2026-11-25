// SPDX-License-Identifier: LicenseRef-Proprietary

// The registry: one Durable Object that knows every live VM, for the cap, for the listing the Dispatcher's reaper reads, and as a
// second line behind each VM's own alarm (it destroys a VM that is past its deadline or never finished starting). Free of
// `cloudflare:workers`: the Durable Object class adapts storage and the VM stubs to these ports.
import {
  matchesFilter,
  overdueEntries,
  SWEEP_INTERVAL_MS,
  type VmEntry,
} from "./lifecycle.ts";
import type { ListFilter } from "./validate.ts";

export interface RegistryStoragePort {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list<T>(prefix: string): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(atMs: number): Promise<void>;
}

export interface VmDestroyer {
  destroy(name: string): Promise<void>;
}

export type ReserveAnswer = "ok" | "exists" | "full";
const PREFIX = "vm:";

export class RegistryController {
  readonly #storage: RegistryStoragePort;
  readonly #vms: VmDestroyer;
  readonly #now: () => number;

  constructor(
    storage: RegistryStoragePort,
    vms: VmDestroyer,
    now: () => number,
  ) {
    this.#storage = storage;
    this.#vms = vms;
    this.#now = now;
  }

  async #all(): Promise<VmEntry[]> {
    return [...(await this.#storage.list<VmEntry>(PREFIX)).values()];
  }

  /** Takes a place for a VM that is about to start: refused when the name is taken or the cap is reached. The Durable Object runs one call at a time, so two creates cannot both take the last place. */
  async reserve(
    entry: Omit<VmEntry, "status">,
    maxVms: number,
  ): Promise<ReserveAnswer> {
    if (await this.#storage.get(PREFIX + entry.name)) return "exists";
    if ((await this.#all()).length >= maxVms) return "full";
    await this.#storage.put(PREFIX + entry.name, {
      ...entry,
      status: "pending",
    } satisfies VmEntry);
    if ((await this.#storage.getAlarm()) === null)
      await this.#storage.setAlarm(this.#now() + SWEEP_INTERVAL_MS);
    return "ok";
  }

  async setRunning(name: string): Promise<void> {
    const entry = await this.#storage.get<VmEntry>(PREFIX + name);
    if (entry)
      await this.#storage.put(PREFIX + name, {
        ...entry,
        status: "running",
      } satisfies VmEntry);
  }

  async remove(name: string): Promise<void> {
    await this.#storage.delete(PREFIX + name);
  }

  async list(filter: ListFilter): Promise<VmEntry[]> {
    return (await this.#all())
      .filter((entry) => matchesFilter(entry, filter))
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }

  /** The sweep: destroys what is overdue, and runs again while any VM is left. */
  async alarm(): Promise<void> {
    for (const entry of overdueEntries(await this.#all(), this.#now())) {
      await this.#vms.destroy(entry.name).catch(() => undefined);
      await this.remove(entry.name);
    }
    if ((await this.#all()).length > 0)
      await this.#storage.setAlarm(this.#now() + SWEEP_INTERVAL_MS);
  }
}
