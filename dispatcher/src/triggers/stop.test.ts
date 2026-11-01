// SPDX-License-Identifier: LicenseRef-Proprietary

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { createBackgroundTracker } from "../test-support/background.ts";
import { SandboxServiceError } from "../launchers/sandbox-service.ts";
import {
  KEY_ID,
  PREVIOUS_KEY_ID,
  PREVIOUS_SIGNING_SECRET,
  SIGNING_SECRET,
  readContract,
  recordingLogger,
  signedRequest,
  signedStopRequest,
  stopBody,
  webhookBody,
} from "../test-support/harness.ts";
import { mountStopRoute } from "./stop.ts";
import { webhookTrigger } from "./webhook.ts";

const NOW = 1_791_633_600;
const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";
const OTHER_JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function build() {
  const sandbox = new FakeSandboxService();
  const background = createBackgroundTracker();
  const logger = recordingLogger();
  const app = new Hono();
  mountStopRoute(app, {
    keys: [
      { kid: KEY_ID, secret: SIGNING_SECRET, appId: "reviewer" },
      {
        kid: PREVIOUS_KEY_ID,
        secret: PREVIOUS_SIGNING_SECRET,
        appId: "reviewer",
      },
    ],
    fleet: sandbox,
    logger,
    background: background.run,
    nowSeconds: () => NOW,
  });
  return { app, sandbox, background, logger };
}

function jobVm(
  sandbox: FakeSandboxService,
  jobId: string,
  kind: "diff" | "dynamic" = "diff",
  suffix = "abcd1234",
) {
  const name = `cr-${kind}-${jobId}-${suffix}`;
  sandbox.seedVm({
    name,
    tags: { app: "code-reviewer", kind, job: jobId },
    createdAtMs: Date.now() - 600_000,
  });
  return name;
}

describe("POST /stop", () => {
  // #487-T01
  it("stops the VMs of the job and nothing else, and a second identical call (a new stop id) finds nothing to do", async () => {
    const { app, sandbox, background } = build();
    const diff = jobVm(sandbox, JOB, "diff", "11111111");
    const dynamic = jobVm(sandbox, JOB, "dynamic", "22222222");
    const other = jobVm(sandbox, OTHER_JOB);
    sandbox.seedVm({
      name: "cr-canary-abcd1234",
      tags: { app: "code-reviewer", kind: "canary", job: "canary" },
      createdAtMs: Date.now() - 600_000,
    });

    const response = await app.fetch(
      signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
    );

    expect(response.status).toBe(202);
    // #493-T06: the answer names the VMs it is stopping, so the App can take its own clock as their end.
    expect(await response.json()).toStrictEqual({
      ...(readContract(
        "examples/dispatch-webhook/DispatchStopAccepted.json",
      ) as object),
      vms: [diff, dynamic].sort(),
    });
    await background.drain(1000);
    expect([...sandbox.stops].sort()).toStrictEqual([diff, dynamic].sort());
    expect(sandbox.stops).not.toContain(other);

    // The same job again, with a stop id of its own: the VMs are stopped already, so there is nothing to stop and it is 200.
    sandbox.stops.length = 0;
    const again = await app.fetch(
      signedStopRequest({
        body: stopBody({
          jobId: JOB,
          stopId: "11111111-1111-4111-8111-111111111111",
        }),
        nowSeconds: NOW,
      }),
    );
    expect(again.status).toBe(200);
    expect(await again.json()).toStrictEqual(
      readContract("examples/dispatch-webhook/DispatchStopIgnored.json"),
    );
    await background.drain(1000);
    expect(sandbox.stops).toStrictEqual([]);
  });

  // #487-T01
  it("answers 200 and stops nothing for a job without a VM", async () => {
    const { app, sandbox, background } = build();
    jobVm(sandbox, OTHER_JOB);

    const response = await app.fetch(
      signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
    );

    expect(response.status).toBe(200);
    await background.drain(1000);
    expect(sandbox.stops).toStrictEqual([]);
  });

  // #487-T01
  it("accepts a call signed with the previous key", async () => {
    const { app, sandbox, background } = build();
    jobVm(sandbox, JOB);

    const response = await app.fetch(
      signedStopRequest({
        body: stopBody({ jobId: JOB }),
        nowSeconds: NOW,
        keyId: PREVIOUS_KEY_ID,
        secret: PREVIOUS_SIGNING_SECRET,
      }),
    );

    expect(response.status).toBe(202);
    await background.drain(1000);
    expect(sandbox.stops).toHaveLength(1);
  });

  // #487-T01
  it("stops only a VM that has exactly the shape of one the Launcher creates for this job", async () => {
    const { app, sandbox, background } = build();
    const mine = jobVm(sandbox, JOB);
    // The name says this job, the tags do not (or there is none): not ours.
    sandbox.seedVm({
      name: `cr-diff-${JOB}-deadbeef`,
      tags: { app: "code-reviewer", kind: "diff", job: OTHER_JOB },
      createdAtMs: Date.now() - 600_000,
    });
    sandbox.seedVm({
      name: `cr-diff-${JOB}-cafebabe`,
      tags: { kind: "diff", job: JOB },
      createdAtMs: Date.now() - 600_000,
    });
    sandbox.seedVm({
      name: `cr-diff-${JOB}-feedface`,
      tags: { app: "code-reviewer", kind: "diff", job: JOB },
      persistent: true,
      createdAtMs: Date.now() - 600_000,
    });
    sandbox.seedVm({
      name: `cr-diff-${JOB}-0badf00d`,
      tags: { app: "code-reviewer", kind: "diff", job: JOB },
      status: "stopped",
      createdAtMs: Date.now() - 600_000,
    });

    const response = await app.fetch(
      signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
    );

    expect(response.status).toBe(202);
    await background.drain(1000);
    expect(sandbox.stops).toStrictEqual([mine]);
  });

  // #487-T01
  it("looks up the VMs by the job id's own name prefix with the app tag, never by anything else the caller sent", async () => {
    const { app, sandbox, background } = build();

    await app.fetch(
      signedStopRequest({
        body: stopBody({ jobId: JOB.toUpperCase() }),
        nowSeconds: NOW,
      }),
    );
    await background.drain(1000);

    expect(sandbox.lists).toStrictEqual([
      { namePrefix: `cr-diff-${JOB}-`, tags: { app: "code-reviewer" } },
      { namePrefix: `cr-dynamic-${JOB}-`, tags: { app: "code-reviewer" } },
      // #759: the app `reviewer` never has the kind `implementer`, so its prefix is not listed (another app's is, see
      // the stop lookup in reaper/vm-shape.test.ts).
    ]);
  });

  // #487-T01
  it("answers 503 with Retry-After when the platform cannot be asked, and the same stop id can be sent again", async () => {
    const { app, sandbox, background, logger } = build();
    const vm = jobVm(sandbox, JOB);
    sandbox.failNextList(new SandboxServiceError("unavailable"));
    const call = () =>
      app.fetch(
        signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
      );

    const failed = await call();

    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(sandbox.stops).toStrictEqual([]);
    expect(logger.text()).toContain("stop_list_failed");
    expect(logger.text()).not.toContain("unavailable");

    const retried = await call();
    expect(retried.status).toBe(202);
    await background.drain(1000);
    expect(sandbox.stops).toStrictEqual([vm]);
  });

  // #487-T01
  it("logs a stop that failed on the platform with a stable code and leaves the VM to the reaper", async () => {
    const { app, sandbox, background, logger } = build();
    const vm = jobVm(sandbox, JOB);
    sandbox.failStops(new Error("platform said: secret-looking text"));

    const response = await app.fetch(
      signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
    );

    expect(response.status).toBe(202);
    await background.drain(1000);
    expect(logger.text()).toContain("vm_stop_failed");
    expect(logger.text()).toContain(vm);
    expect(logger.text()).not.toContain("secret-looking text");
  });

  // #487-T03
  it("does nothing for a stop id it has handled: a replay, even of an identical valid call, stops no VM", async () => {
    const { app, sandbox, background } = build();
    const vm = jobVm(sandbox, JOB);
    const call = () =>
      app.fetch(
        signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
      );

    expect((await call()).status).toBe(202);
    await background.drain(1000);
    expect(sandbox.stops).toStrictEqual([vm]);

    // A new VM of the same job (a later attempt) must not be stopped by the replay of the earlier stop.
    const later = jobVm(sandbox, JOB, "diff", "99999999");
    sandbox.stops.length = 0;
    sandbox.lists.length = 0;
    const replay = await call();

    expect(replay.status).toBe(200);
    expect(await replay.json()).toStrictEqual({
      version: 1,
      status: "ignored",
      reason: "replayed",
    });
    await background.drain(1000);
    expect(sandbox.stops).toStrictEqual([]);
    expect(sandbox.lists).toStrictEqual([]);
    expect(later).toBeTruthy();
  });

  // #487-T03
  it("treats two calls with one stop id that arrive together as one", async () => {
    const { app, sandbox, background } = build();
    jobVm(sandbox, JOB);
    const call = () =>
      app.fetch(
        signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
      );

    const [first, second] = await Promise.all([call(), call()]);

    expect([first.status, second.status].sort()).toStrictEqual([200, 202]);
    await background.drain(1000);
    expect(sandbox.stops).toHaveLength(1);
  });

  // #487-T03
  it("does not remember the stop id of a call it refused: a refused call cannot use up the id of a real one", async () => {
    const { app, sandbox, background } = build();
    jobVm(sandbox, JOB);

    const forged = await app.fetch(
      signedStopRequest({
        body: stopBody({ jobId: JOB }),
        nowSeconds: NOW,
        secret: "another-secret-0000000000000000000000",
      }),
    );
    expect(forged.status).toBe(401);

    const real = await app.fetch(
      signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
    );
    expect(real.status).toBe(202);
    await background.drain(1000);
    expect(sandbox.stops).toHaveLength(1);
  });

  // #487-T02
  it.each([
    [
      "a bad signature",
      { secret: "another-secret-0000000000000000000000" },
      401,
    ],
    ["an old timestamp", { timestamp: String(NOW - 301) }, 401],
    ["a timestamp in the future", { timestamp: String(NOW + 301) }, 401],
    ["an unknown key id", { keyId: "k9" }, 401],
    [
      "a wrong content type",
      { headers: { "content-type": "text/plain" } },
      400,
    ],
    ["no signature", { headers: { "x-dispatch-signature": null } }, 400],
    ["a malformed timestamp", { timestamp: "12:00" }, 400],
  ] as const)("refuses %s and stops nothing", async (_name, input, status) => {
    const { app, sandbox, background } = build();
    jobVm(sandbox, JOB);

    const response = await app.fetch(
      signedStopRequest({
        body: stopBody({ jobId: JOB }),
        nowSeconds: NOW,
        ...input,
      }),
    );

    expect(response.status).toBe(status);
    await background.drain(100);
    expect(sandbox.stops).toStrictEqual([]);
    expect(sandbox.lists).toStrictEqual([]);
  });

  // #487-T02
  it("refuses an oversize body with 413, and an extra field, a wrong type, a bad job id and a stop id that is not the header with 400, and stops nothing", async () => {
    const { app, sandbox, background } = build();
    jobVm(sandbox, JOB);
    const cases: Array<[string, Request, number]> = [
      [
        "oversize",
        signedStopRequest({
          rawBody: JSON.stringify({
            ...stopBody({ jobId: JOB }),
            pad: "x".repeat(2000),
          }),
          nowSeconds: NOW,
        }),
        413,
      ],
      [
        "an extra field",
        signedStopRequest({
          rawBody: JSON.stringify({ ...stopBody({ jobId: JOB }), extra: 1 }),
          nowSeconds: NOW,
        }),
        400,
      ],
      [
        "the wake-up call's body",
        signedStopRequest({
          rawBody: JSON.stringify(webhookBody({ jobId: JOB })),
          nowSeconds: NOW,
        }),
        400,
      ],
      [
        "a job id that is not a UUID",
        signedStopRequest({
          body: stopBody({ jobId: `${JOB}/../x` }),
          nowSeconds: NOW,
        }),
        400,
      ],
      [
        "a stop id that is not the header",
        signedStopRequest({
          body: stopBody({ jobId: JOB }),
          nowSeconds: NOW,
          headers: { "x-dispatch-id": "22222222-2222-4222-8222-222222222222" },
        }),
        401,
      ],
    ];
    for (const [name, request, status] of cases) {
      const response = await app.fetch(request);
      expect(response.status, name).toBe(status);
    }
    await background.drain(100);
    expect(sandbox.stops).toStrictEqual([]);
    expect(sandbox.lists).toStrictEqual([]);
  });

  // #487-T02
  it("answers every refusal of a kind with the body /dispatch gives for it", async () => {
    const { app } = build();
    // The refusals come before the core is asked, so a core that is never called stands in for it.
    const probe = new Hono();
    webhookTrigger({
      keys: [
        { kid: KEY_ID, secret: SIGNING_SECRET, appId: "reviewer" },
        {
          kid: PREVIOUS_KEY_ID,
          secret: PREVIOUS_SIGNING_SECRET,
          appId: "reviewer",
        },
      ],
      nowSeconds: () => NOW,
    }).mount(probe, {
      core: {
        handle: () => Promise.reject(new Error("never called")),
        abort: () => undefined,
      },
      background: () => undefined,
      logger: recordingLogger(),
    });
    const pairs: Array<[Request, Request]> = [
      [
        signedStopRequest({ nowSeconds: NOW, secret: "x".repeat(40) }),
        signedRequest({ nowSeconds: NOW, secret: "x".repeat(40) }),
      ],
      [
        signedStopRequest({ nowSeconds: NOW, timestamp: String(NOW - 999) }),
        signedRequest({ nowSeconds: NOW, timestamp: String(NOW - 999) }),
      ],
      [
        signedStopRequest({
          nowSeconds: NOW,
          headers: { "content-type": "text/plain" },
        }),
        signedRequest({
          nowSeconds: NOW,
          headers: { "content-type": "text/plain" },
        }),
      ],
      [
        signedStopRequest({
          rawBody: "x".repeat(2000),
          nowSeconds: NOW,
        }),
        signedRequest({ rawBody: "x".repeat(2000), nowSeconds: NOW }),
      ],
    ];
    for (const [stop, dispatch] of pairs) {
      const a = await app.fetch(stop);
      const b = await probe.fetch(dispatch);
      expect(a.status).toBe(b.status);
      expect(await a.text()).toBe(await b.text());
    }
  });

  // #487-T02
  it("logs neither a key nor a signature", async () => {
    const { app, sandbox, background, logger } = build();
    jobVm(sandbox, JOB);

    await app.fetch(
      signedStopRequest({
        body: stopBody({ jobId: JOB }),
        nowSeconds: NOW,
        secret: "another-secret-0000000000000000000000",
      }),
    );
    await app.fetch(
      signedStopRequest({ body: stopBody({ jobId: JOB }), nowSeconds: NOW }),
    );
    await background.drain(1000);

    for (const secret of [SIGNING_SECRET, PREVIOUS_SIGNING_SECRET])
      expect(logger.text()).not.toContain(secret);
    expect(logger.text()).not.toMatch(/v1=[0-9a-f]{64}/);
  });
});
