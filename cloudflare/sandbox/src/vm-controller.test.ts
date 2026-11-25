// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import { FakeContainer, FakeVmStorage, RecordingLogger } from "./test-fakes.ts";
import {
  BOOT_COMMAND,
  ENTRYPOINT,
  EXIT_LOST,
  EXIT_TIMEOUT,
  VmController,
  type StartRequest,
} from "./vm-controller.ts";

const NOW = 1_000_000;
const START: StartRequest = {
  name: "job-1",
  instanceType: "standard-4",
  instance: "standard-4",
  timeoutMs: 3_600_000,
  createdAtMs: NOW,
};

function setup() {
  const container = new FakeContainer();
  const storage = new FakeVmStorage();
  const logger = new RecordingLogger();
  const removed: string[] = [];
  let clock = NOW;
  let ids = 0;
  const controller = new VmController({
    container,
    storage,
    registry: { remove: async (name) => void removed.push(name) },
    logger,
    now: () => clock,
    newId: () => `id${++ids}`,
  });
  return {
    container,
    storage,
    logger,
    removed,
    controller,
    advance: (ms: number) => (clock += ms),
  };
}

describe("start", () => {
  // #1159-T12
  it("starts the Container on the configured type without internet, boots it and keeps it alive with the inactivity timeout and the alarm", async () => {
    const { container, storage, controller } = setup();
    expect(await controller.start(START)).toEqual({ ok: true, value: null });
    expect(container.started).toEqual([
      { instance: "standard-4", entrypoint: ENTRYPOINT },
    ]);
    expect(container.interceptCalls.length).toBe(1);
    expect(container.execs[0]?.cmd).toEqual(BOOT_COMMAND);
    expect(container.inactivityTimeouts).toEqual([120_000]);
    expect(storage.alarm).toBe(NOW + 45_000);
    expect(await controller.getPolicy()).toBe("allow-all");
  });

  // #1159-T12
  it("destroys the VM and says unavailable when the boot fails, and never logs what the boot printed", async () => {
    const { container, storage, logger, controller } = setup();
    container.scripts.set(BOOT_COMMAND[0] ?? "", {
      exit: 1,
      stderr: "SECRET-LOOKING-OUTPUT",
    });
    expect(await controller.start(START)).toEqual({
      ok: false,
      kind: "unavailable",
    });
    expect(container.destroyed.length).toBe(1);
    expect(storage.data.size).toBe(0);
    expect(JSON.stringify(logger.events)).not.toContain("SECRET");
  });

  // #1159-T12
  it("destroys the VM when the platform throws", async () => {
    const { container, controller } = setup();
    container.failIntercepts = true;
    expect(await controller.start(START)).toEqual({
      ok: false,
      kind: "unavailable",
    });
    expect(container.started.length).toBe(0);
  });

  // #1159-T12
  it("refuses a second start of the same VM", async () => {
    const { controller } = setup();
    await controller.start(START);
    expect(await controller.start(START)).toEqual({
      ok: false,
      kind: "rejected",
    });
  });
});

describe("exec", () => {
  // #1159-T13
  it("runs a command to its end and answers its status and output", async () => {
    const { container, controller } = setup();
    await controller.start(START);
    container.scripts.set("docker", { exit: 3, stdout: "out", stderr: "err" });
    const result = await controller.exec({
      label: "image-id",
      cmd: "docker",
      args: ["image", "inspect"],
      timeoutMs: 5000,
    });
    expect(result).toEqual({
      ok: true,
      value: { exitCode: 3, stdout: "out", stderr: "err", truncated: false },
    });
    expect(container.execs.at(-1)?.cmd).toEqual(["docker", "image", "inspect"]);
  });

  // #1159-T13
  it("kills a command at its timeout and answers 124", async () => {
    vi.useFakeTimers();
    try {
      const { container, controller } = setup();
      await controller.start(START);
      container.scripts.set("sleep", {});
      const pending = controller.exec({
        label: "slow",
        cmd: "sleep",
        args: ["99"],
        timeoutMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(1100);
      const result = await pending;
      expect(result.ok && result.value.exitCode).toBe(EXIT_TIMEOUT);
      expect(container.execs.at(-1)?.killed).toEqual([9]);
    } finally {
      vi.useRealTimers();
    }
  });

  // #1159-T13
  it("is not_ready for a VM that does not run", async () => {
    const { controller } = setup();
    expect(
      await controller.exec({
        label: "x",
        cmd: "true",
        args: [],
        timeoutMs: 1000,
      }),
    ).toEqual({ ok: false, kind: "not_ready" });
  });

  // #1159-T13
  it("says unavailable when the platform fails the exec", async () => {
    const { container, controller } = setup();
    await controller.start(START);
    container.failExec = true;
    expect(
      await controller.exec({
        label: "x",
        cmd: "true",
        args: [],
        timeoutMs: 1000,
      }),
    ).toEqual({ ok: false, kind: "unavailable" });
  });
});

describe("processes", () => {
  // #1159-T14
  it("starts a process with stdin open, passes what is written, closes it and reports the exit", async () => {
    const { container, controller } = setup();
    await controller.start(START);
    container.scripts.set("docker", {});
    const started = await controller.startProcess({
      label: "docker-run",
      cmd: "docker",
      args: ["run"],
    });
    expect(started.ok).toBe(true);
    const id = started.ok ? started.value.processId : "";
    expect(id).toBe("p-id1");
    expect(await controller.waitProcess(id, 0)).toEqual({
      ok: true,
      value: { running: true },
    });

    await controller.writeStdin(id, '{"a":1}\n');
    await controller.closeStdin(id);
    const process = container.execs.at(-1);
    await vi.waitFor(() => expect(process?.stdinClosed).toBe(true));
    expect(process?.stdinChunks).toEqual(['{"a":1}\n']);

    process?.finish(0);
    expect(await controller.waitProcess(id, 100)).toEqual({
      ok: true,
      value: { running: false, exitCode: 0 },
    });
  });

  // #1159-T14
  it("waits at most waitMs for a process that keeps running", async () => {
    vi.useFakeTimers();
    try {
      const { container, controller } = setup();
      await controller.start(START);
      container.scripts.set("docker", {});
      const started = await controller.startProcess({
        label: "docker-run",
        cmd: "docker",
        args: [],
      });
      const id = started.ok ? started.value.processId : "";
      const pending = controller.waitProcess(id, 25_000);
      await vi.advanceTimersByTimeAsync(25_001);
      expect(await pending).toEqual({ ok: true, value: { running: true } });
    } finally {
      vi.useRealTimers();
    }
  });

  // #1159-T14
  it("answers an unknown process as not_ready, and a process of an earlier life of the object as ended with 255", async () => {
    const { container, storage, controller } = setup();
    await controller.start(START);
    expect(await controller.waitProcess("p-none", 0)).toEqual({
      ok: false,
      kind: "not_ready",
    });
    expect(await controller.writeStdin("p-none", "x")).toEqual({
      ok: false,
      kind: "not_ready",
    });
    expect(await controller.closeStdin("p-none")).toEqual({
      ok: false,
      kind: "not_ready",
    });
    storage.data.set("proc:p-lost", { label: "docker-run", startedAtMs: NOW });
    expect(await controller.waitProcess("p-lost", 0)).toEqual({
      ok: true,
      value: { running: false, exitCode: EXIT_LOST },
    });
    expect(container.running).toBe(true);
  });

  // #1159-T14
  it("ignores a write to a process that has ended and closes stdin twice without a fault", async () => {
    const { container, controller } = setup();
    await controller.start(START);
    container.scripts.set("docker", { exit: 0 });
    const started = await controller.startProcess({
      label: "docker-run",
      cmd: "docker",
      args: [],
    });
    const id = started.ok ? started.value.processId : "";
    await controller.waitProcess(id, 50);
    expect(await controller.writeStdin(id, "late")).toEqual({
      ok: true,
      value: null,
    });
    expect(await controller.closeStdin(id)).toEqual({ ok: true, value: null });
    expect(await controller.closeStdin(id)).toEqual({ ok: true, value: null });
  });
});

describe("policy", () => {
  // #1159-T15
  it("fails closed without a VM, sets a policy for the next request and reads it back", async () => {
    const { controller } = setup();
    expect(await controller.getPolicy()).toBe("deny-all");
    expect(await controller.setPolicy({ allow: ["github.com"] })).toEqual({
      ok: false,
      kind: "not_ready",
    });
    await controller.start(START);
    expect(await controller.setPolicy({ allow: ["github.com"] })).toEqual({
      ok: true,
      value: null,
    });
    expect(await controller.getPolicy()).toEqual({ allow: ["github.com"] });
  });

  // #1159-T15
  it("reads a stored policy again after the object restarted", async () => {
    const { container, storage, removed } = setup();
    storage.data.set("policy", "deny-all");
    const again = new VmController({
      container,
      storage,
      registry: { remove: async (n) => void removed.push(n) },
      logger: new RecordingLogger(),
      now: () => NOW,
      newId: () => "x",
    });
    expect(await again.getPolicy()).toBe("deny-all");
  });
});

describe("alarm and destroy", () => {
  // #1159-T16
  it("renews the alarm while the VM lives and destroys it at its deadline, telling the registry", async () => {
    const { container, storage, removed, controller, advance } = setup();
    await controller.start(START);
    advance(45_000);
    await controller.alarm();
    expect(storage.alarm).toBe(NOW + 90_000);
    expect(container.running).toBe(true);

    advance(START.timeoutMs);
    await controller.alarm();
    expect(container.running).toBe(false);
    expect(container.destroyed).toEqual(["destroyed"]);
    expect(removed).toEqual(["job-1"]);
    expect(storage.data.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });

  // #1159-T16
  it("cleans up when the platform stopped the Container under it", async () => {
    const { container, removed, controller, advance } = setup();
    await controller.start(START);
    container.running = false;
    advance(45_000);
    await controller.alarm();
    expect(removed).toEqual(["job-1"]);
  });

  // #1159-T16
  it("does nothing for an alarm of a VM that is gone", async () => {
    const { removed, controller } = setup();
    await controller.alarm();
    expect(removed).toEqual([]);
  });

  // #1159-T17
  it("destroys the Container, kills its processes and forgets everything; a second destroy is harmless", async () => {
    const { container, storage, controller } = setup();
    await controller.start(START);
    container.scripts.set("docker", {});
    await controller.startProcess({
      label: "docker-run",
      cmd: "docker",
      args: [],
    });
    await controller.destroy();
    expect(container.execs.at(-1)?.killed).toEqual([9]);
    expect(container.running).toBe(false);
    expect(storage.data.size).toBe(0);
    await expect(controller.destroy()).resolves.toBeUndefined();
    expect(await controller.getPolicy()).toBe("deny-all");
  });

  // #1159-T18
  it("sets the inactivity timeout again when the object wakes with a running Container, and not otherwise", async () => {
    const { container, controller } = setup();
    await controller.wake();
    expect(container.inactivityTimeouts).toEqual([]);
    container.running = true;
    await controller.wake();
    expect(container.inactivityTimeouts).toEqual([120_000]);
    expect(container.interceptCalls.length).toBe(1);
    container.failIntercepts = true;
    await expect(controller.wake()).resolves.toBeUndefined();
  });
});
