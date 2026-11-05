// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it, vi } from "vitest";
import type { Job } from "../jobs/job-types.ts";
import type { ImplementerStepsRepository } from "../db/repositories/implementer-steps-repository.ts";
import { storeSteps, type StepsDeps } from "./steps.ts";

const job = {
  id: "job-1",
  workspaceId: "workspace-1",
  reviewKind: "implementer",
  status: "running",
} as Job;
const parsed = {
  records: [{ kind: "text", partId: "prt_1", seq: 1, text: "hello" }],
  unknownKind: 0,
};

function deps(holding: Job | undefined) {
  const recordSteps = vi.fn<ImplementerStepsRepository["recordSteps"]>(
    async () => ({ status: "ok", stored: 1, stale: 0, dropped: 0 }),
  );
  const knownSecrets = vi.fn(async () => []);
  const claimedKeys = {
    keysOf: vi.fn(async () => []),
    modelsOf: vi.fn(async () => []),
    wasNative: vi.fn(async () => false),
  };
  const managedModels = vi.fn(async () => ({ managed: false, models: [] }));
  const all: StepsDeps = {
    queue: { get: async () => job, holding: async () => holding },
    steps: () => ({
      recordSteps,
      listAfter: async () => [],
      lastStep: async () => undefined,
    }),
    logger: { info: () => undefined, error: () => undefined },
    knownSecrets,
    claimedKeys,
    managedModels,
  };
  return { all, recordSteps, knownSecrets, claimedKeys, managedModels };
}

describe("storing the steps of a batch", () => {
  // #745-T13
  it("does not look up the secrets or the models for a caller that does not hold the running claim", async () => {
    for (const holding of [undefined, { ...job, status: "failed" } as Job]) {
      const d = deps(holding);

      const outcome = await storeSteps(d.all, {
        job,
        leaseToken: "lease-token-1",
        parsed,
        who: "runner=r1",
        extraSecrets: [],
      });

      expect(outcome).toStrictEqual({ lost: true });
      expect(d.knownSecrets).not.toHaveBeenCalled();
      expect(d.claimedKeys.keysOf).not.toHaveBeenCalled();
      expect(d.claimedKeys.modelsOf).not.toHaveBeenCalled();
      expect(d.managedModels).not.toHaveBeenCalled();
      expect(d.recordSteps).not.toHaveBeenCalled();
    }
  });

  // #745-T10
  it("looks them up and stores for the holder of the running claim", async () => {
    const d = deps(job);

    const outcome = await storeSteps(d.all, {
      job,
      leaseToken: "lease-token-1",
      parsed,
      who: "runner=r1",
      extraSecrets: [],
    });

    expect("response" in outcome).toBe(true);
    expect(d.knownSecrets).toHaveBeenCalledTimes(1);
    expect(d.recordSteps).toHaveBeenCalledTimes(1);
  });
});
