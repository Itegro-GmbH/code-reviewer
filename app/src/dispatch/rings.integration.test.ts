// SPDX-License-Identifier: LicenseRef-Proprietary

// The doorbell to the webhook dispatchers of customers (#972) against a real Postgres: which (job, dispatcher) pairs there are (the join of
// `runner-dispatches-repository.ts` is the claim's rule written as a query), that the claim stays the only way to a job (the first claim
// wins, the others get 204), that a polling runner is never rung, and the rows of the pairs.
import { describe, expect, it } from "vitest";
import { createRunnerCredentialsRepository } from "../db/repositories/runner-credentials-repository.ts";
import { createRunnerDispatchesRepository } from "../db/repositories/runner-dispatches-repository.ts";
import {
  mintDeliverySecret,
  openDeliverySecret,
  sealDeliverySecret,
} from "../runner-identity/delivery.ts";
import {
  startRunnerApiHarness,
  TEST_APP_SECRET,
} from "../test-support/runner-api-harness.ts";
import {
  createFakeDispatchReceiver,
  ignored,
} from "../test-support/fake-dispatch-receiver.ts";
import { addWorkspace } from "../test-support/workspaces.ts";
import { WAITING_MIN_GAP_MS } from "../db/repositories/job-dispatches-repository.ts";
import { customerRunnerId } from "../runner-identity/tokens.ts";
import type { DispatchFetch } from "./send.ts";
import { createRingService } from "./rings.ts";
import { createStopService } from "./stop.ts";

const ENV = { id: "env-1", name: "Box", labels: ["linux"] };

async function start() {
  return startRunnerApiHarness({ implementer: true, llmKey: null });
}
type Harness = Awaited<ReturnType<typeof start>>;

/**
 * The claim of a customer's runner as the queue makes it (`claim.ts` hands the runner's own labels over): the oldest due turn it matches,
 * or null. The HTTP answer of that is 200 with the job or 204.
 */
async function claimAs(
  h: Harness,
  runner: { runnerId: string },
  labels: string[] = ["linux"],
) {
  const claimed = await h.queue.claimNext(
    customerRunnerId(runner.runnerId),
    ["implementer"],
    { customerRunner: { workspaceId: h.workspaceId, labels } },
  );
  return claimed === null ? null : claimed.job.id;
}

/** A runner that announced a webhook: its address and the secret the app minted for it. */
async function webhookRunner(
  h: Harness,
  name: string,
  options: { labels?: string[]; workspaceId?: string } = {},
) {
  const runner = await h.registerRunner({
    labels: options.labels ?? ["linux"],
    ...(options.workspaceId === undefined
      ? {}
      : { workspaceId: options.workspaceId }),
  });
  const url = `https://${name}.example.test/dispatch`;
  const stored = await createRunnerCredentialsRepository(h.db, {
    now: h.clock.now,
  }).setDelivery(runner.runnerId, {
    mode: "webhook",
    url,
    rotateSecret: false,
    mintKey: () => {
      const key = mintDeliverySecret();
      return {
        ...key,
        sealed: sealDeliverySecret(
          TEST_APP_SECRET,
          runner.runnerId,
          key.secret,
        ),
      };
    },
  });
  if (stored?.mode !== "webhook" || stored.secret === undefined)
    throw new Error("delivery not stored");
  return { ...runner, url, keyId: stored.keyId, secret: stored.secret };
}
type WebhookRunner = Awaited<ReturnType<typeof webhookRunner>>;

/** The rings of the harness: every dispatcher is a fake receiver that knows only its own key. */
function rings(h: Harness, dispatchers: readonly WebhookRunner[]) {
  const receivers = new Map(
    dispatchers.map((d) => [
      d.url,
      createFakeDispatchReceiver({
        keys: [{ kid: d.keyId, secret: d.secret }],
        now: h.clock.now,
      }),
    ]),
  );
  const fetch: DispatchFetch = (url, init) => {
    const receiver = receivers.get(url);
    return receiver === undefined
      ? Promise.reject(new TypeError("down"))
      : receiver.fetch(url, init);
  };
  const lines: string[] = [];
  const service = createRingService({
    db: h.db,
    openSecret: (runnerId, sealed) =>
      openDeliverySecret(TEST_APP_SECRET, runnerId, sealed),
    fetch,
    now: h.clock.now,
    log: { warn: (l) => lines.push(l), error: (l) => lines.push(l) },
  });
  return {
    service,
    lines,
    received: (d: WebhookRunner) => receivers.get(d.url)?.received ?? [],
    reply: (
      d: WebhookRunner,
      ...replies: Parameters<
        ReturnType<typeof createFakeDispatchReceiver>["reply"]
      >
    ) => receivers.get(d.url)?.reply(...replies),
  };
}

const created = (turn: Awaited<ReturnType<Harness["enqueueTurn"]>>) => ({
  status: "created" as const,
  job: turn.job,
  supersededJobIds: [],
});

describe("ringing the webhook dispatchers of a workspace", () => {
  // #972-T01
  it("rings every dispatcher that matches the job, each with its own key, and the first claim wins: the other gets 204", async () => {
    const h = await start();
    const a = await webhookRunner(h, "a");
    const b = await webhookRunner(h, "b");
    const turn = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    const r = rings(h, [a, b]);

    await r.service.onEnqueued(created(turn));

    for (const d of [a, b])
      expect(r.received(d)).toMatchObject([
        {
          verdict: "ok",
          body: { type: "job.ready", jobId: turn.job.id },
          headers: { "x-dispatch-key-id": d.keyId },
        },
      ]);
    // The doorbell is not the job: whoever claims first gets it, the other claim finds nothing.
    expect(await claimAs(h, a)).toBe(turn.job.id);
    expect(await claimAs(h, b)).toBeNull();
  });

  // #972-T04
  it("never rings a runner that polls, nor one of another workspace, nor one that lacks a label, nor a revoked one", async () => {
    const h = await start();
    const polling = await h.registerRunner({ labels: ["linux"] });
    const other = await addWorkspace(h.db, "other");
    const foreign = await webhookRunner(h, "foreign", { workspaceId: other });
    const lacking = await webhookRunner(h, "lacking", { labels: ["gpu"] });
    const revoked = await webhookRunner(h, "revoked");
    await h.db
      .updateTable("runners")
      .set({ revoked_at: "2026-11-10T00:00:00.000Z" })
      .where("id", "=", revoked.runnerId)
      .execute();
    const wanted = await webhookRunner(h, "wanted");
    const turn = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    const r = rings(h, [foreign, lacking, revoked, wanted]);

    await r.service.onEnqueued(created(turn));

    expect(r.received(wanted)).toHaveLength(1);
    for (const d of [foreign, lacking, revoked])
      expect(r.received(d)).toHaveLength(0);
    // The runner that polls has no row and no call: it claims by itself.
    const { rows } = await createRunnerDispatchesRepository(h.db)
      .listDue(h.clock.now(), 50)
      .then((pairs) => ({ rows: pairs }));
    expect(rows.map((pair) => pair.runnerId)).not.toContain(polling.runnerId);
    expect(await claimAs(h, polling)).toBe(turn.job.id);
  });

  it("does not ring for a hosted job, and leaves a runner that was rung alone until its row is due", async () => {
    const h = await start();
    const a = await webhookRunner(h, "a");
    const hosted = await h.enqueueTurn({});
    const runnerTurn = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    const r = rings(h, [a]);

    await r.service.onEnqueued(created(hosted));
    expect(r.received(a)).toHaveLength(0);
    await r.service.onEnqueued(created(runnerTurn));
    await r.service.ringDue();

    expect(r.received(a)).toHaveLength(1);
  });

  it("signs with the secret of the dispatcher it rings: the receiver of another dispatcher refuses the call", async () => {
    const h = await start();
    const a = await webhookRunner(h, "a");
    const b = await webhookRunner(h, "b");
    const turn = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    const r = rings(h, [a, b]);
    await r.service.onEnqueued(created(turn));

    const toA = r.received(a)[0];
    // B's receiver, handed what A was sent.
    const bsReceiver = createFakeDispatchReceiver({
      keys: [{ kid: a.keyId, secret: b.secret }],
      now: h.clock.now,
    });
    await bsReceiver.fetch(a.url, {
      method: "POST",
      headers: toA?.headers,
      body: toA?.rawBody,
    });

    expect(bsReceiver.received[0]?.verdict).toBe("bad_signature");
  });
});

describe("a dispatcher that is full", () => {
  // #972-T02
  it("is not rung again for that job by the repair work or a second hook until an event or the sweep, and nothing is lost", async () => {
    const h = await start();
    const a = await webhookRunner(h, "a");
    const turn = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    const r = rings(h, [a]);
    r.reply(a, ignored("busy"));

    await r.service.onEnqueued(created(turn));
    h.clock.advance(60_000);
    await r.service.ringDue(20, { minAgeMs: 50_000 });
    await r.service.onEnqueued(created(turn));

    expect(r.received(a)).toHaveLength(1);
    expect(
      await createRunnerDispatchesRepository(h.db, h.clock.now).get(
        turn.job.id,
        a.runnerId,
      ),
    ).toMatchObject({ state: "pending", lastCode: "ignored_busy" });
    // Nothing was lost: the job still waits and the dispatcher claims it by itself when it has a slot.
    expect(await h.queue.get(turn.job.id)).toMatchObject({ status: "queued" });
    expect(await claimAs(h, a)).toBe(turn.job.id);
  });

  // #972-T02
  it("is rung again by the sweep after its rest", async () => {
    const h = await start();
    const a = await webhookRunner(h, "a");
    const turn = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    const r = rings(h, [a]);
    r.reply(a, ignored("busy"));
    await r.service.onEnqueued(created(turn));

    h.clock.advance(3 * 60 * 60_000);
    const { rung } = await r.service.ringDue();

    expect(rung).toBe(1);
    expect(r.received(a)).toHaveLength(2);
  });
});

describe("ringing again when a job of a label group ends", () => {
  // #972-T03
  it("rings the waiting jobs that group can take, and not those that need a label it does not have", async () => {
    const h = await start();
    const a = await webhookRunner(h, "a", { labels: ["linux"] });
    const gpu = await webhookRunner(h, "gpu", { labels: ["gpu", "linux"] });
    const running = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    const waitingLinux = await h.enqueueTurn({
      runnerEnvironment: { ...ENV, id: "env-2" },
    });
    const waitingGpu = await h.enqueueTurn({
      runnerEnvironment: { ...ENV, id: "env-3", labels: ["gpu", "linux"] },
    });
    const r = rings(h, [a, gpu]);
    r.reply(a, ignored("busy"), ignored("busy"));
    r.reply(gpu, ignored("busy"), ignored("busy"));
    for (const turn of [waitingLinux, waitingGpu])
      await r.service.onEnqueued(created(turn));
    const before = {
      a: r.received(a).length,
      gpu: r.received(gpu).length,
    };
    // `a` takes the first job and it ends: a slot of the group of `a` freed.
    expect(await claimAs(h, a)).toBe(running.job.id);
    h.clock.advance(WAITING_MIN_GAP_MS + 1_000);

    const { rung } = await r.service.ringGroupsOf([running.job.id]);

    // `a` has `linux`: the waiting job that needs `linux` is rung (on both dispatchers that could take it); the one that needs `gpu` too is not.
    const calls = [...r.received(a), ...r.received(gpu)].slice();
    expect(rung).toBeGreaterThan(0);
    expect(r.received(a).length).toBe(before.a + 1);
    expect(
      calls.filter((call) => call.body?.jobId === waitingGpu.job.id),
    ).toHaveLength(
      r.received(gpu).filter((c) => c.body?.jobId === waitingGpu.job.id).length,
    );
    expect(
      r.received(a).filter((call) => call.body?.jobId === waitingGpu.job.id),
    ).toHaveLength(0);
  });
});

describe("the stop call of a job that a customer's dispatcher holds", () => {
  it("goes to the dispatcher that holds the job, signed with its own secret, and to no other", async () => {
    const h = await start();
    const a = await webhookRunner(h, "a");
    const b = await webhookRunner(h, "b");
    const turn = await h.enqueueTurn({
      runnerEnvironment: ENV,
    });
    expect(await claimAs(h, a)).toBe(turn.job.id);
    const receivers = new Map(
      [a, b].map((d) => [
        d.url.replace(/dispatch$/, "stop"),
        createFakeDispatchReceiver({
          keys: [{ kid: d.keyId, secret: d.secret }],
          now: h.clock.now,
        }),
      ]),
    );
    const holders = createRunnerDispatchesRepository(h.db, h.clock.now);
    const stop = createStopService({
      db: h.db,
      config: {
        mode: "webhook",
        url: "https://platform.example.test/dispatch",
        currentKey: {
          kid: "k1",
          secret: "platform-secret-0123456789-0123456789-abc",
        },
      },
      fetch: (url, init) =>
        receivers.get(url)?.fetch(url, init) ??
        Promise.reject(new TypeError("down")),
      now: h.clock.now,
      retryDelaysMs: [],
      customerTarget: async (jobId) => {
        const holder = await holders.holderDelivery(jobId);
        if (holder === undefined) return undefined;
        const dispatcher = [a, b].find((d) => d.runnerId === holder.runnerId);
        return dispatcher === undefined
          ? undefined
          : {
              url: holder.url,
              key: { kid: holder.keyId, secret: dispatcher.secret },
            };
      },
    });

    await stop.stopJobs([turn.job.id]);

    const toA = receivers.get(a.url.replace(/dispatch$/, "stop"))?.received;
    const toB = receivers.get(b.url.replace(/dispatch$/, "stop"))?.received;
    expect(toA).toHaveLength(1);
    expect(toA?.[0]?.verdict).toBe("ok");
    expect(toB).toHaveLength(0);
  });
});
