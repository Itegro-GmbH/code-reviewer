// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher's count of the live job VMs per app (#730): only a VM of exactly the shape of a job VM counts, for the app
// its tenant tag names, and an untagged one for `reviewer`.
import { describe, expect, it } from "vitest";
import type { ListedVm } from "../launchers/sandbox-service.ts";
import { recordingLogger } from "../test-support/harness.ts";
import { liveJobVmsByApp } from "./live-vms.ts";

const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";

function vm(overrides: Partial<ListedVm> & { tenant?: string }): ListedVm {
  const { tenant, ...rest } = overrides;
  return {
    name: `cr-diff-${JOB}-0000000${Math.floor(Math.random() * 9)}`,
    createdAtMs: 0,
    status: "running",
    persistent: false,
    tags: {
      app: "code-reviewer",
      kind: "diff",
      job: JOB,
      ...(tenant === undefined ? {} : { tenant }),
    },
    ...rest,
  };
}

describe("the live job VMs per app", () => {
  // #730-T22
  it("counts the VMs that are up for the app of their tenant tag, and an untagged one for the reviewer", async () => {
    const counter = liveJobVmsByApp({
      list: () =>
        Promise.resolve([
          vm({ tenant: "factory", name: `cr-diff-${JOB}-00000001` }),
          vm({
            tenant: "factory",
            name: `cr-diff-${JOB}-00000002`,
            status: "pending",
          }),
          vm({ tenant: "reviewer", name: `cr-diff-${JOB}-00000003` }),
          vm({ name: `cr-diff-${JOB}-00000004` }),
        ]),
    });

    const counts = await counter(new AbortController().signal);

    expect(Object.fromEntries(counts)).toStrictEqual({
      factory: 2,
      reviewer: 2,
    });
  });

  // #730-T22
  it("leaves out a canary, a persistent VM, a VM the platform is ending and a lookalike", async () => {
    const counter = liveJobVmsByApp({
      list: () =>
        Promise.resolve([
          vm({
            name: "cr-canary-0a1b2c3d",
            tags: { app: "code-reviewer", kind: "canary", job: "canary" },
          }),
          vm({
            tenant: "factory",
            name: `cr-diff-${JOB}-00000001`,
            persistent: true,
          }),
          vm({
            tenant: "factory",
            name: `cr-diff-${JOB}-00000002`,
            status: "stopping",
          }),
          vm({
            tenant: "factory",
            name: `cr-diff-${JOB}-00000003`,
            status: "stopped",
          }),
          vm({ tenant: "factory", name: "cr-diff-lookalike" }),
          vm({
            tenant: "factory",
            name: `cr-diff-${JOB}-00000005`,
            tags: {
              app: "someone-else",
              kind: "diff",
              job: JOB,
              tenant: "factory",
            },
          }),
        ]),
    });

    const counts = await counter(new AbortController().signal);

    expect([...counts]).toStrictEqual([]);
  });

  // #730-T22
  it("asks the platform for the VMs of ours across all pages and passes the signal on", async () => {
    const calls: Array<{ filter: unknown; signal: AbortSignal | undefined }> =
      [];
    const counter = liveJobVmsByApp({
      list: (filter, signal) => {
        calls.push({ filter, signal });
        return Promise.resolve([]);
      },
    });
    const controller = new AbortController();

    await counter(controller.signal);

    expect(calls).toStrictEqual([
      {
        filter: { namePrefix: "cr-", tags: { app: "code-reviewer" } },
        signal: controller.signal,
      },
    ]);
  });

  // #802-T30
  it("logs how long the listing took and how many VMs it returned, stopped ones included, once", async () => {
    const logger = recordingLogger();
    let clock = 1000;
    const counter = liveJobVmsByApp(
      {
        list: () => {
          clock += 5100;
          return Promise.resolve([
            vm({ name: `cr-diff-${JOB}-00000001` }),
            vm({ name: `cr-diff-${JOB}-00000002`, status: "stopped" }),
            vm({ name: "cr-canary-0a1b2c3d", status: "stopped" }),
          ]);
        },
      },
      { logger, now: () => clock },
    );

    await counter(new AbortController().signal);

    expect(logger.lines).toStrictEqual([
      'info fleet_listed {"ms":5100,"count":3}',
    ]);
  });

  // #802-T30
  it("logs no `fleet_listed` for a listing that failed, and passes the failure on", async () => {
    const logger = recordingLogger();
    const counter = liveJobVmsByApp(
      { list: () => Promise.reject(new Error("down")) },
      { logger },
    );

    await expect(counter(new AbortController().signal)).rejects.toThrow("down");

    expect(logger.lines).toStrictEqual([]);
  });
});
