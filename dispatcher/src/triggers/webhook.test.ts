// SPDX-License-Identifier: LicenseRef-Proprietary

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createApp } from "../dispatcher-app.ts";
import { createBackgroundTracker } from "../test-support/background.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  PREVIOUS_KEY_ID,
  PREVIOUS_SIGNING_SECRET,
  SIGNING_SECRET,
  readContract,
  recordingLogger,
  settingsFor,
  signedRequest,
  startApp,
  webhookBody,
} from "../test-support/harness.ts";
import { webhookTrigger } from "./webhook.ts";

const NOW = 1_791_633_600;

let fake: DispatcherAppFake;
beforeEach(async () => {
  fake = await startApp();
});
afterEach(async () => {
  await fake.close();
});

function build(launcherOptions: Parameters<typeof createFakeLauncher>[0] = {}) {
  const launcher = createFakeLauncher(launcherOptions);
  const background = createBackgroundTracker();
  const logger = recordingLogger();
  const settings = settingsFor(fake.url);
  const app = createApp({
    settings,
    launcher,
    logger,
    background: background.run,
    trigger: webhookTrigger({
      keys: [
        { kid: KEY_ID, secret: SIGNING_SECRET, appId: "reviewer" },
        {
          kid: PREVIOUS_KEY_ID,
          secret: PREVIOUS_SIGNING_SECRET,
          appId: "reviewer",
        },
      ],
      nowSeconds: () => NOW,
    }),
  });
  return { app, launcher, background, logger };
}

const claims = () => fake.requests().filter((r) => r.route !== "version");

describe("POST /dispatch", () => {
  // #327-T01
  it("answers 202 at once for a valid call and starts the Worker once, with the credential, in the background", async () => {
    const jobId = fake.enqueue();
    const { app, launcher, background } = build();

    const response = await app.fetch(
      signedRequest({ body: webhookBody({ jobId }), nowSeconds: NOW }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toStrictEqual(
      readContract("examples/dispatch-webhook/DispatchAccepted.json"),
    );
    await background.drain(1000);
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]).toMatchObject({ jobId, kind: "diff" });
    expect(launcher.launches[0]?.credential).toMatch(/^crj_[A-Za-z0-9_-]{43}$/);
  });

  // #327-T01
  it("hands the launch to the platform's waitUntil and does not wait for it", async () => {
    const jobId = fake.enqueue();
    let finish: () => void = () => undefined;
    const { app, launcher, background } = build({
      onLaunch: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });

    const response = await app.fetch(
      signedRequest({ body: webhookBody({ jobId }), nowSeconds: NOW }),
    );

    expect(response.status).toBe(202);
    expect(background.size()).toBe(1);
    finish();
    await background.drain(1000);
    expect(launcher.launches).toHaveLength(1);
  });

  // #327-T02
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
    ["no content type", { headers: { "content-type": null } }, 400],
    ["no signature", { headers: { "x-dispatch-signature": null } }, 400],
    ["a malformed timestamp", { timestamp: "12:00" }, 400],
  ] as const)("refuses %s and makes no claim", async (_name, input, status) => {
    const jobId = fake.enqueue();
    const { app, launcher, background } = build();

    const response = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId }),
        nowSeconds: NOW,
        ...input,
      }),
    );

    expect(response.status).toBe(status);
    await background.drain(100);
    expect(fake.requests()).toStrictEqual([]);
    expect(launcher.launches).toStrictEqual([]);
  });

  // #972-T06
  it("refuses a doorbell signed with another dispatcher's secret, under its own key id or under this one's, and makes no claim", async () => {
    const other = (
      readContract("dispatch-signing-vectors.json") as {
        otherDispatcher: { kid: string; secret: string };
      }
    ).otherDispatcher;
    const jobId = fake.enqueue();
    const { app, launcher, background } = build();

    for (const input of [
      // Another dispatcher's secret under this dispatcher's key id: a bad signature.
      { secret: other.secret },
      // Its own key id and secret: this dispatcher does not know the key.
      { secret: other.secret, keyId: other.kid },
    ]) {
      const response = await app.fetch(
        signedRequest({
          body: webhookBody({ jobId }),
          nowSeconds: NOW,
          ...input,
        }),
      );
      expect(response.status).toBe(401);
    }

    await background.drain(100);
    expect(fake.requests()).toStrictEqual([]);
    expect(launcher.launches).toStrictEqual([]);
  });

  // #327-T02
  it("refuses an oversize body with 413 before it is read or verified, and makes no claim", async () => {
    const jobId = fake.enqueue();
    const { app } = build();
    const rawBody = JSON.stringify({
      ...webhookBody({ jobId }),
      padding: "x".repeat(2048),
    });

    const response = await app.fetch(
      signedRequest({ rawBody, nowSeconds: NOW }),
    );

    expect(response.status).toBe(413);
    expect(fake.requests()).toStrictEqual([]);
  });

  // #327-T02
  it("refuses an oversize body whose content-length is a lie", async () => {
    const { app } = build();
    const request = new Request("http://dispatcher.test/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "10" },
      body: "x".repeat(5000),
    });

    const response = await app.fetch(request);

    expect(response.status).toBe(413);
  });

  // #327-T02
  it("answers every failed verification with the same body, so a caller learns nothing about which check failed", async () => {
    const { app } = build();
    const bodies: string[] = [];
    for (const input of [
      { secret: "another-secret-0000000000000000000000" },
      { timestamp: String(NOW - 600) },
      { keyId: "k9" },
    ])
      bodies.push(
        await (
          await app.fetch(signedRequest({ nowSeconds: NOW, ...input }))
        ).text(),
      );

    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("RUNNER_UNAUTHORIZED");
    expect(bodies[0]).not.toContain(SIGNING_SECRET);
  });

  // #327-T02
  it.each([
    ["an unknown field (the body is closed)", { ...webhookBody(), token: "x" }],
    ["a secret-shaped field", { ...webhookBody(), credential: "crj_x" }],
    ["a wrong type", { ...webhookBody(), type: "job.other" }],
    ["a job id that is not a UUID", { ...webhookBody(), jobId: "../etc" }],
    ["an unknown review kind", { ...webhookBody(), reviewKind: "other" }],
    ["an attempt out of range", { ...webhookBody(), attempt: 0 }],
  ])(
    "refuses a correctly signed call with %s with 400 and makes no claim",
    async (_name, body) => {
      const { app } = build();

      const response = await app.fetch(
        signedRequest({
          rawBody: JSON.stringify(body),
          body: webhookBody(),
          nowSeconds: NOW,
        }),
      );

      expect(response.status).toBe(400);
      expect(fake.requests()).toStrictEqual([]);
    },
  );

  // #327-T02
  it("refuses a body that is not JSON, and a dispatch id that differs from the header", async () => {
    const { app } = build();

    const notJson = await app.fetch(
      signedRequest({ rawBody: "not json", nowSeconds: NOW }),
    );
    const otherId = await app.fetch(
      signedRequest({
        rawBody: JSON.stringify(
          webhookBody({ dispatchId: "11111111-1111-4111-8111-111111111111" }),
        ),
        nowSeconds: NOW,
      }),
    );

    expect([notJson.status, otherId.status]).toStrictEqual([400, 400]);
    expect(fake.requests()).toStrictEqual([]);
  });

  // #327-T02
  it("answers 404 to other methods and routes, and GET /health with 200", async () => {
    const { app } = build();

    const get = await app.fetch(new Request("http://dispatcher.test/dispatch"));
    const other = await app.fetch(
      new Request("http://dispatcher.test/other", { method: "POST" }),
    );
    const health = await app.fetch(
      new Request("http://dispatcher.test/health"),
    );

    expect([get.status, other.status]).toStrictEqual([404, 404]);
    expect(health.status).toBe(200);
    expect(await health.json()).toStrictEqual({ status: "ok" });
  });

  // #327-T03
  it("answers 200 ignored (not_claimable) for a duplicate call and starts nothing", async () => {
    const jobId = fake.enqueue();
    const { app, launcher, background } = build();
    const send = () =>
      app.fetch(
        signedRequest({ body: webhookBody({ jobId }), nowSeconds: NOW }),
      );
    await send();
    await background.drain(1000);

    const duplicate = await send();

    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toStrictEqual({
      version: 1,
      status: "ignored",
      reason: "not_claimable",
    });
    expect(launcher.launches).toHaveLength(1);
  });

  // #327-T05
  it("answers 200 ignored (not_capable) without a claim when the kind cannot be run", async () => {
    const jobId = fake.enqueue({ reviewKind: "dynamic" });
    const { app } = build({ engines: ["pr-agent"] });

    const response = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId, reviewKind: "dynamic" }),
        nowSeconds: NOW,
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      version: 1,
      status: "ignored",
      reason: "not_capable",
    });
    expect(fake.requests()).toStrictEqual([]);
  });

  // #327-T04
  it("answers 202 and releases the job when the launch fails afterwards", async () => {
    const jobId = fake.enqueue();
    const { app, background } = build({
      onLaunch: () => Promise.reject(new Error("no vm")),
    });

    const response = await app.fetch(
      signedRequest({ body: webhookBody({ jobId }), nowSeconds: NOW }),
    );
    await background.drain(1000);

    expect(response.status).toBe(202);
    expect(claims().map((r) => r.route)).toStrictEqual(["claim", "release"]);
  });

  // #327-T06
  it("answers 429 with Retry-After while the pool is busy launching, and 503 with Retry-After when the app is down", async () => {
    const jobId = fake.enqueue();
    fake.script("claim", [{ status: 503, retryAfterSeconds: 42 }]);
    const { app } = build();

    const down = await app.fetch(
      signedRequest({ body: webhookBody({ jobId }), nowSeconds: NOW }),
    );
    fake.script("claim", [{ status: 429, retryAfterSeconds: 7 }]);
    const busy = await app.fetch(
      signedRequest({ body: webhookBody({ jobId }), nowSeconds: NOW }),
    );

    expect(down.status).toBe(503);
    expect(down.headers.get("retry-after")).toBe("42");
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("7");
  });

  // #327-T07
  it("never puts a secret into a response or a log, for any answer", async () => {
    const jobId = fake.enqueue();
    const { app, logger, background } = build();
    const responses = [
      await app.fetch(
        signedRequest({ body: webhookBody({ jobId }), nowSeconds: NOW }),
      ),
      await app.fetch(
        signedRequest({
          nowSeconds: NOW,
          secret: "another-secret-0000000000000000000000",
        }),
      ),
    ];
    await background.drain(1000);

    const text = [
      ...(await Promise.all(responses.map((r) => r.text()))),
      logger.text(),
    ].join("\n");

    for (const secret of [
      SIGNING_SECRET,
      PREVIOUS_SIGNING_SECRET,
      DISPATCHER_TOKEN,
    ])
      expect(text).not.toContain(secret);
    expect(text).not.toMatch(/crj_[A-Za-z0-9_-]{10,}/);
    expect(text).not.toMatch(/v1=[0-9a-f]{64}/);
  });

  // #327-T10
  it("accepts a call signed with the previous key while it is configured", async () => {
    const jobId = fake.enqueue();
    const { app, launcher, background } = build();

    const response = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId }),
        nowSeconds: NOW,
        keyId: PREVIOUS_KEY_ID,
        secret: PREVIOUS_SIGNING_SECRET,
      }),
    );
    await background.drain(1000);

    expect(response.status).toBe(202);
    expect(launcher.launches).toHaveLength(1);
  });

  // #327-T10
  it("refuses the previous key once it is no longer configured", async () => {
    const launcher = createFakeLauncher();
    const app = createApp({
      settings: settingsFor(fake.url),
      launcher,
      logger: recordingLogger(),
      background: createBackgroundTracker().run,
      trigger: webhookTrigger({
        keys: [{ kid: KEY_ID, secret: SIGNING_SECRET, appId: "reviewer" }],
        nowSeconds: () => NOW,
      }),
    });

    const response = await app.fetch(
      signedRequest({
        nowSeconds: NOW,
        keyId: PREVIOUS_KEY_ID,
        secret: PREVIOUS_SIGNING_SECRET,
      }),
    );

    expect(response.status).toBe(401);
  });
});
