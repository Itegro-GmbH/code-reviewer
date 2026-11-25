// SPDX-License-Identifier: LicenseRef-Proprietary

import { DurableObject } from "cloudflare:workers";
import type { VmEntry } from "./lifecycle.ts";
import {
  RegistryController,
  type ReserveAnswer,
} from "./registry-controller.ts";
import type { Env } from "./env.ts";
import type { ListFilter } from "./validate.ts";

/** The one registry of the Worker (named `global`): see registry-controller.ts. */
export class CrSandboxRegistry extends DurableObject<Env> {
  readonly #controller: RegistryController;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#controller = new RegistryController(
      {
        get: <T>(key: string) => ctx.storage.get<T>(key),
        put: (key, value) => ctx.storage.put(key, value),
        delete: async (key) => void (await ctx.storage.delete(key)),
        list: <T>(prefix: string) => ctx.storage.list<T>({ prefix }),
        getAlarm: () => ctx.storage.getAlarm(),
        setAlarm: (atMs) => ctx.storage.setAlarm(atMs),
      },
      { destroy: (name) => env.VM.getByName(name).destroy() },
      () => Date.now(),
    );
  }

  reserve(
    entry: Omit<VmEntry, "status">,
    maxVms: number,
  ): Promise<ReserveAnswer> {
    return this.#controller.reserve(entry, maxVms);
  }
  setRunning(name: string): Promise<void> {
    return this.#controller.setRunning(name);
  }
  remove(name: string): Promise<void> {
    return this.#controller.remove(name);
  }
  list(filter: ListFilter): Promise<VmEntry[]> {
    return this.#controller.list(filter);
  }
  override alarm(): Promise<void> {
    return this.#controller.alarm();
  }
}
