// SPDX-License-Identifier: LicenseRef-Proprietary

// #972: every call to a customer's dispatcher (the doorbell and the stop call) goes through the guarded connection
// (`guarded-fetch.ts`), and the platform's own dispatcher does not. The guard itself is proven in guarded-fetch.test.ts; the platform's own dispatcher keeps the plain `fetch`.
import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/schema.ts";
import type { RunnerDispatchesRepository } from "../db/repositories/runner-dispatches-repository.ts";
import type { DispatchFetch } from "./send.ts";

const guarded = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("./guarded-fetch.ts", () => ({
  customerDeliveryFetch: (): DispatchFetch => (url) => {
    guarded.calls.push(url);
    return Promise.resolve(new Response(null, { status: 202 }));
  },
}));
// The platform's job row says no wake-up was acknowledged, so the stop looks for a customer's dispatcher.
vi.mock("../db/repositories/job-dispatches-repository.ts", () => ({
  createJobDispatchesRepository: () => ({
    get: async () => undefined,
    workspaceOf: async () => undefined,
  }),
}));

const { createRingService } = await import("./rings.ts");
const { createStopService } = await import("./stop.ts");

describe("the connection to a customer's dispatcher", () => {
  it("is the guarded one for the doorbell", async () => {
    const pair = {
      jobId: "job-1",
      reviewKind: "implementer",
      jobAttempts: 0,
      harness: "opencode",
      runnerId: "runner-a",
      baseVersion: "1.0.0",
      manifest: {
        harnesses: { opencode: { version: "1", ready: true } },
        capabilities: [],
      },
      delivery: {
        url: "https://a.example.test/dispatch",
        keyId: "d-aaaaaaaa",
        sealedSecret: "crw_a-secret-0123456789abcdef0123456789abcdef",
      },
    };
    const rows = new Map<string, unknown>();
    const dispatches = {
      get: async () => rows.get("row"),
      create: async () => {
        rows.set("row", {
          jobId: "job-1",
          state: "pending",
          attempts: 0,
          consecutiveFailures: 0,
          nextDispatchAt: "2026-11-10T12:00:00.000Z",
          ackedAt: null,
          lastAttemptAt: null,
          lastStatus: null,
          lastCode: null,
        });
        return true;
      },
      claimSend: async () => true,
      record: async () => undefined,
      listDue: async () => [pair],
      endpointFailedSince: async () => false,
    } as unknown as RunnerDispatchesRepository;
    const service = createRingService({
      db: {} as Kysely<Database>,
      dispatches,
      openSecret: (_runnerId, sealed) => sealed,
      now: () => new Date("2026-11-10T12:00:00.000Z"),
      log: { warn: () => {}, error: () => {} },
    });

    await service.onEnqueued({
      status: "created",
      job: { id: "job-1", status: "queued", reviewKind: "implementer" },
      supersededJobIds: [],
    } as never);

    expect(guarded.calls).toEqual(["https://a.example.test/dispatch"]);
  });

  it("is the guarded one for the stop call of a customer's dispatcher", async () => {
    guarded.calls.length = 0;
    const stop = createStopService({
      db: {} as Kysely<Database>,
      config: {
        mode: "webhook",
        url: "https://platform.example.test/dispatch",
        currentKey: {
          kid: "k1",
          secret: "platform-secret-0123456789-0123456789-abc",
        },
      },
      vmRuns: () => ({}) as never,
      retryDelaysMs: [],
      log: { warn: () => {} },
      customerTarget: async () => ({
        url: "https://a.example.test/dispatch",
        key: {
          kid: "d-aaaaaaaa",
          secret: "crw_a-secret-0123456789abcdef0123456789abcdef",
        },
      }),
    });

    await stop.stopJobs(["job-1"]);

    expect(guarded.calls).toEqual(["https://a.example.test/stop"]);
  });
});
