// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { OVERDUE_GRACE_MS, SWEEP_INTERVAL_MS } from "./lifecycle.ts";
import { RegistryController } from "./registry-controller.ts";
import { FakeRegistryStorage } from "./test-fakes.ts";

const NOW = 5_000_000;
const entry = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  instanceType: "standard-4",
  createdAtMs: NOW,
  timeoutMs: 60_000,
  tags: { cr: "job" },
  ...over,
});

function setup() {
  const storage = new FakeRegistryStorage();
  const destroyed: string[] = [];
  let clock = NOW;
  const registry = new RegistryController(
    storage,
    { destroy: async (name) => void destroyed.push(name) },
    () => clock,
  );
  return {
    storage,
    destroyed,
    registry,
    advance: (ms: number) => (clock += ms),
  };
}

describe("registry", () => {
  // #1159-T19
  it("reserves a place, refuses a name that is taken and the place beyond the cap", async () => {
    const { registry } = setup();
    expect(await registry.reserve(entry("a"), 2)).toBe("ok");
    expect(await registry.reserve(entry("a"), 2)).toBe("exists");
    expect(await registry.reserve(entry("b"), 2)).toBe("ok");
    expect(await registry.reserve(entry("c"), 2)).toBe("full");
    await registry.remove("a");
    expect(await registry.reserve(entry("c"), 2)).toBe("ok");
  });

  // #1159-T19
  it("lists pending and running VMs, oldest first, narrowed by prefix and tag", async () => {
    const { registry } = setup();
    await registry.reserve(entry("job-2", { createdAtMs: NOW + 2 }), 10);
    await registry.reserve(entry("job-1", { createdAtMs: NOW + 1 }), 10);
    await registry.reserve(entry("canary-1", { tags: { cr: "canary" } }), 10);
    await registry.setRunning("job-1");
    const all = await registry.list({ namePrefix: "", tag: null });
    expect(all.map((v) => `${v.name}:${v.status}`)).toEqual([
      "canary-1:pending",
      "job-1:running",
      "job-2:pending",
    ]);
    expect(
      (await registry.list({ namePrefix: "job-", tag: null })).length,
    ).toBe(2);
    expect(
      (
        await registry.list({
          namePrefix: "",
          tag: { key: "cr", value: "canary" },
        })
      ).map((v) => v.name),
    ).toEqual(["canary-1"]);
    await registry.setRunning("nobody");
  });

  // #1159-T19
  it("schedules the sweep with the first VM and keeps it while any VM is left", async () => {
    const { storage, registry, advance } = setup();
    expect(storage.alarm).toBeNull();
    await registry.reserve(entry("a"), 10);
    expect(storage.alarm).toBe(NOW + SWEEP_INTERVAL_MS);
    advance(SWEEP_INTERVAL_MS);
    await registry.alarm();
    expect(storage.alarm).toBe(NOW + 2 * SWEEP_INTERVAL_MS);
  });

  // #1159-T20
  it("destroys and forgets the VMs that are past their deadline and leaves the others", async () => {
    const { destroyed, registry, advance } = setup();
    await registry.reserve(entry("old", { timeoutMs: 60_000 }), 10);
    await registry.setRunning("old");
    await registry.reserve(entry("young", { timeoutMs: 6 * 3_600_000 }), 10);
    await registry.setRunning("young");
    advance(60_000 + OVERDUE_GRACE_MS + 1);
    await registry.alarm();
    expect(destroyed).toEqual(["old"]);
    expect(
      (await registry.list({ namePrefix: "", tag: null })).map((v) => v.name),
    ).toEqual(["young"]);
  });
});
