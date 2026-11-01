// SPDX-License-Identifier: LicenseRef-Proprietary

// A composed Dispatcher that serves two apps (#730), over HTTP: the sender is the key, a stop signed by one app never
// reaches a VM of another, the operator token opens the probe and the apps check and no app credential does, the logs
// mask every app's secrets, and a request made with the unchanged contract vectors is still accepted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSandboxService } from "../../fakes/sandbox/service.ts";
import type { DispatcherAppFake } from "../../fakes/dispatcher-app/server.ts";
import { composeDispatcher } from "./compose.ts";
import { createDispatcher } from "./dispatcher-app.ts";
import { webhookTrigger } from "./triggers/webhook.ts";
import { createFakeLauncher } from "./launchers/fake.ts";
import { createBackgroundTracker } from "./test-support/background.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  readContract,
  recordingLogger,
  settingsFor,
  signedRequest,
  signedStopRequest,
  startApp,
  stopBody,
  webhookBody,
} from "./test-support/harness.ts";

const FACTORY_TOKEN = "factory-dispatcher-token-for-tests-0001";
const FACTORY_SECRET = "factory-signing-secret-for-tests-000001";
const FACTORY_KEY = "factory-k1";
const FACTORY_PREVIOUS_SECRET = "factory-previous-signing-secret-000000";
const OPERATOR = "operator-token-for-the-tests-0000000001";
const CRON = "cron-secret-for-the-tests-00000000000001";
const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";
const OTHER_JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let reviewer: DispatcherAppFake;
let factory: DispatcherAppFake;
beforeEach(async () => {
  reviewer = await startApp();
  factory = await startApp({ dispatcherToken: FACTORY_TOKEN });
});
afterEach(async () => {
  await reviewer.close();
  await factory.close();
});

function environment(
  extra: Record<string, string> = {},
  kinds: readonly string[] = ["diff", "dynamic"],
): Record<string, string> {
  return {
    RUNNER_API_URL: reviewer.url,
    RUNNER_TOKEN: DISPATCHER_TOKEN,
    DISPATCHER_MAX_RUNNING: "2",
    DISPATCHER_SIGNING_KEY_ID: KEY_ID,
    DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
    DISPATCHER_APPS: JSON.stringify([
      {
        id: "factory",
        url: factory.url,
        kinds,
        keyId: FACTORY_KEY,
        maxRunning: 2,
      },
    ]),
    DISPATCHER_APP_FACTORY_TOKEN: FACTORY_TOKEN,
    DISPATCHER_APP_FACTORY_SIGNING_SECRET: FACTORY_SECRET,
    // Required with DISPATCHER_APPS: no app's credential opens `/probe` or `/apps/check`.
    DISPATCHER_OPERATOR_TOKEN: OPERATOR,
    ...extra,
  };
}

function build(
  options: {
    env?: Record<string, string>;
    withFleet?: boolean;
    launcher?: Parameters<typeof createFakeLauncher>[0];
  } = {},
) {
  const launcher = createFakeLauncher(options.launcher);
  const background = createBackgroundTracker();
  const logger = recordingLogger();
  const sandbox = new FakeSandboxService();
  const composed = composeDispatcher({
    env: options.env ?? environment(),
    launcher,
    background: background.run,
    logger,
    ...(options.withFleet === true
      ? {
          reaper: () => ({
            fleet: sandbox,
            jobLifetimeSeconds: 1500,
            canaryLifetimeSeconds: 450,
          }),
        }
      : {}),
  });
  return { ...composed, launcher, background, logger, sandbox };
}

const now = () => Math.floor(Date.now() / 1000);
const claimsAt = (app: DispatcherAppFake) =>
  app.requests().filter((request) => request.route === "claim");

describe("POST /dispatch with two apps", () => {
  // #730-T03
  it("claims at the factory when the call is signed with the factory's key, and at the reviewer when it is signed with the reviewer's", async () => {
    const factoryJob = factory.enqueue();
    const reviewerJob = reviewer.enqueue();
    const { app, launcher, background } = build();

    const forFactory = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId: factoryJob }),
        keyId: FACTORY_KEY,
        secret: FACTORY_SECRET,
        nowSeconds: now(),
      }),
    );
    await background.drain(1000);
    const forReviewer = await app.fetch(
      signedRequest({
        body: webhookBody({
          jobId: reviewerJob,
          dispatchId: "6e4b9d1f-02c5-4a7b-b3d8-4f9c2e8a5b03",
        }),
        nowSeconds: now(),
      }),
    );
    await background.drain(1000);

    expect(forFactory.status).toBe(202);
    expect(forReviewer.status).toBe(202);
    expect(claimsAt(factory)).toHaveLength(1);
    expect(claimsAt(reviewer)).toHaveLength(1);
    expect(launcher.launches.map((spec) => [spec.appId, spec.appUrl])).toEqual([
      ["factory", factory.url],
      ["reviewer", reviewer.url],
    ]);
  });

  // #730-T03
  it("does not let the body choose the app: a job of the reviewer named in a call signed by the factory is not claimed", async () => {
    const reviewerJob = reviewer.enqueue();
    const { app, launcher, background } = build();

    const response = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId: reviewerJob }),
        keyId: FACTORY_KEY,
        secret: FACTORY_SECRET,
        nowSeconds: now(),
      }),
    );
    await background.drain(1000);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ignored" });
    expect(claimsAt(reviewer)).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);
  });

  // #730-T05
  it("refuses an unknown key id, a wrong secret and an expired timestamp exactly as with one app, and a key's secret under another app's key id", async () => {
    const { app, logger } = build();
    const cases: Array<[string, Request, number]> = [
      [
        "unknown key id",
        signedRequest({ keyId: "nobody", nowSeconds: now() }),
        401,
      ],
      [
        "wrong secret",
        signedRequest({ secret: "x".repeat(40), nowSeconds: now() }),
        401,
      ],
      [
        "expired",
        signedRequest({ nowSeconds: now(), timestamp: String(now() - 301) }),
        401,
      ],
      [
        "factory's secret under the reviewer's key id",
        signedRequest({ secret: FACTORY_SECRET, nowSeconds: now() }),
        401,
      ],
      [
        "reviewer's secret under the factory's key id",
        signedRequest({ keyId: FACTORY_KEY, nowSeconds: now() }),
        401,
      ],
      [
        "malformed",
        signedRequest({
          nowSeconds: now(),
          headers: { "x-dispatch-signature": "nope" },
        }),
        400,
      ],
    ];

    for (const [name, request, status] of cases) {
      const response = await app.fetch(request);
      expect(response.status, name).toBe(status);
    }
    expect(factory.requests()).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(logger.text()).not.toContain("dispatch_received");
  });

  // #730-T05
  it("accepts the previous key of an app for that app only", async () => {
    const factoryJob = factory.enqueue();
    const { app, launcher, background } = build({
      env: environment({
        DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS: FACTORY_PREVIOUS_SECRET,
        DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS_KEY_ID: "factory-k0",
      }),
    });

    const previous = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId: factoryJob }),
        keyId: "factory-k0",
        secret: FACTORY_PREVIOUS_SECRET,
        nowSeconds: now(),
      }),
    );
    await background.drain(1000);
    // The same previous secret under the reviewer's key id is not a key of the reviewer.
    const crossed = await app.fetch(
      signedRequest({ secret: FACTORY_PREVIOUS_SECRET, nowSeconds: now() }),
    );

    expect(previous.status).toBe(202);
    expect(launcher.launches[0]).toMatchObject({ appId: "factory" });
    expect(crossed.status).toBe(401);
    expect(reviewer.requests()).toHaveLength(0);
  });

  // #730-T09
  it("answers 200 ignored with `not_capable` for a kind outside the app's kinds and makes no claim call at all", async () => {
    const jobId = factory.enqueue({ reviewKind: "dynamic" });
    const { app, logger } = build({ env: environment({}, ["diff"]) });

    const response = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId, reviewKind: "dynamic" }),
        keyId: FACTORY_KEY,
        secret: FACTORY_SECRET,
        nowSeconds: now(),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      version: 1,
      status: "ignored",
      reason: "not_capable",
    });
    expect(factory.requests()).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(logger.text()).toContain("kind_not_allowed");
  });

  // #759-T04
  it("answers `not_capable` to a wake-up for the implementer kind signed with the reviewer's key and claims nothing, and claims at the factory only when the factory signs it", async () => {
    const jobId = factory.enqueue({ reviewKind: "implementer" });
    const { app, launcher, background } = build({
      env: environment({}, ["diff", "dynamic", "implementer"]),
      launcher: { engines: ["pr-agent", "opencode", "implementer"] },
    });

    const forReviewer = await app.fetch(
      signedRequest({
        body: webhookBody({ jobId, reviewKind: "implementer" }),
        nowSeconds: now(),
      }),
    );
    await background.drain(1000);

    expect(forReviewer.status).toBe(200);
    expect(await forReviewer.json()).toStrictEqual({
      version: 1,
      status: "ignored",
      reason: "not_capable",
    });
    expect(factory.requests()).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
    expect(launcher.launches).toHaveLength(0);

    const forFactory = await app.fetch(
      signedRequest({
        body: webhookBody({
          jobId,
          reviewKind: "implementer",
          dispatchId: "6e4b9d1f-02c5-4a7b-b3d8-4f9c2e8a5b03",
        }),
        keyId: FACTORY_KEY,
        secret: FACTORY_SECRET,
        nowSeconds: now(),
      }),
    );
    await background.drain(1000);

    expect(forFactory.status).toBe(202);
    expect(claimsAt(factory)).toHaveLength(1);
    expect(reviewer.requests()).toHaveLength(0);
    expect(
      launcher.launches.map((spec) => [spec.appId, spec.appUrl, spec.kind]),
    ).toEqual([["factory", factory.url, "implementer"]]);
  });

  // #730-T18
  it("accepts every request of the unchanged contract vectors that is valid and refuses the rest, as an App of the current release sends them", async () => {
    const vectors = readContract<{
      keys: {
        current: { kid: string; secret: string };
        previous: { kid: string; secret: string };
      };
      vectors: Array<{
        name: string;
        now: number;
        headers: Record<string, string>;
        body: string;
        expected: string;
      }>;
    }>("dispatch-signing-vectors.json");
    const { webhookTrigger } = await import("./triggers/webhook.ts");
    const { createApp } = await import("./dispatcher-app.ts");
    const { settings } = build();
    for (const vector of vectors.vectors) {
      // The vector's clock is fixed; the receiver of the Dispatcher takes it from the trigger.
      const app = createApp({
        settings: settings.core,
        launcher: createFakeLauncher(),
        background: () => undefined,
        logger: recordingLogger(),
        trigger: webhookTrigger({
          keys: [
            { ...vectors.keys.current, appId: "reviewer" },
            { ...vectors.keys.previous, appId: "reviewer" },
            { kid: FACTORY_KEY, secret: FACTORY_SECRET, appId: "factory" },
          ],
          nowSeconds: () => vector.now,
        }),
      });

      const response = await app.fetch(
        new Request("http://dispatcher.test/dispatch", {
          method: "POST",
          headers: vector.headers,
          body: vector.body,
        }),
      );

      if (vector.expected === "ok")
        // Verified: the job is not in the fake App, so the claim is answered 204 and the call `ignored`.
        expect([200, 202, 503], vector.name).toContain(response.status);
      else expect([400, 401, 413], vector.name).toContain(response.status);
    }
  });
});

describe("POST /stop with two apps", () => {
  const vm = (
    sandbox: FakeSandboxService,
    jobId: string,
    tenant: string | undefined,
    suffix: string,
  ) => {
    const name = `cr-diff-${jobId}-${suffix}`;
    sandbox.seedVm({
      name,
      tags: {
        app: "code-reviewer",
        kind: "diff",
        job: jobId,
        ...(tenant === undefined ? {} : { tenant }),
      },
      createdAtMs: Date.now() - 600_000,
    });
    return name;
  };
  const stop = (
    keyed: "reviewer" | "factory",
    jobId: string,
    stopId = "7c1e2d44-6b0a-4f5b-9a3e-5d8f2b6c1e07",
  ) =>
    signedStopRequest({
      body: stopBody({ jobId, stopId }),
      nowSeconds: now(),
      ...(keyed === "factory"
        ? { keyId: FACTORY_KEY, secret: FACTORY_SECRET }
        : {}),
    });

  // #730-T13
  it("answers `no_vm` and stops nothing for a stop signed by the factory for a job id whose VM belongs to the reviewer", async () => {
    const { app, sandbox, background } = build({ withFleet: true });
    const reviewerVm = vm(sandbox, JOB, "reviewer", "11111111");
    const untagged = vm(sandbox, OTHER_JOB, undefined, "22222222");

    const forReviewerJob = await app.fetch(stop("factory", JOB));
    const forUntaggedJob = await app.fetch(stop("factory", OTHER_JOB));
    await background.drain(1000);

    expect(forReviewerJob.status).toBe(200);
    expect(await forReviewerJob.json()).toStrictEqual({
      version: 1,
      status: "ignored",
      reason: "no_vm",
    });
    expect(forUntaggedJob.status).toBe(200);
    expect(sandbox.stops).toStrictEqual([]);
    expect(reviewerVm).toBeDefined();
    expect(untagged).toBeDefined();
  });

  // #730-T13
  it("stops the VM of the reviewer's own job when the reviewer signs, also for a VM created before the tenant tag", async () => {
    const { app, sandbox, background } = build({ withFleet: true });
    const tagged = vm(sandbox, JOB, "reviewer", "11111111");
    const untagged = vm(sandbox, OTHER_JOB, undefined, "22222222");

    const first = await app.fetch(stop("reviewer", JOB));
    const second = await app.fetch(
      stop("reviewer", OTHER_JOB, "8d2f3e55-7c1b-4a6c-8b4f-6e9a3c7d2f18"),
    );
    await background.drain(1000);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect([...sandbox.stops].sort()).toStrictEqual([tagged, untagged].sort());
  });

  // #730-T13
  it("stops only the factory's VM when the factory signs for a job id that both apps have a VM for", async () => {
    const { app, sandbox, background } = build({ withFleet: true });
    const reviewerVm = vm(sandbox, JOB, "reviewer", "11111111");
    const factoryVm = vm(sandbox, JOB, "factory", "33333333");

    const response = await app.fetch(stop("factory", JOB));
    await background.drain(1000);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ vms: [factoryVm] });
    expect(sandbox.stops).toStrictEqual([factoryVm]);
    expect(sandbox.stops).not.toContain(reviewerVm);
  });

  // #730-T26
  it("keeps the leading fields of the `stop_received` line, which the hosted E2E reads, and adds the app after them", async () => {
    const { app, sandbox, background, logger } = build({ withFleet: true });
    vm(sandbox, JOB, "factory", "33333333");

    await app.fetch(stop("factory", JOB));
    await background.drain(1000);

    expect(
      logger.lines.some((line) =>
        line.startsWith(
          `info stop_received {"jobId":"${JOB}","vms":1,"app":"factory"}`,
        ),
      ),
    ).toBe(true);
  });

  // #730-T13
  it("does not let one app use up the stop id of another", async () => {
    const { app, sandbox, background } = build({ withFleet: true });
    const factoryVm = vm(sandbox, JOB, "factory", "33333333");
    const sameStopId = "9e3a4f66-8d2c-4b7d-9c5a-7fab4d8e3a29";

    // The reviewer's stop with this id finds nothing; the factory's with the same id must still be handled.
    const first = await app.fetch(stop("reviewer", JOB, sameStopId));
    const second = await app.fetch(stop("factory", JOB, sameStopId));
    await background.drain(1000);
    const replay = await app.fetch(stop("factory", JOB, sameStopId));

    expect(await first.json()).toMatchObject({ reason: "no_vm" });
    expect(second.status).toBe(202);
    expect(sandbox.stops).toStrictEqual([factoryVm]);
    expect(await replay.json()).toMatchObject({ reason: "replayed" });
  });
});

describe("the operator credential", () => {
  const probe = (token: string | undefined) =>
    new Request("http://dispatcher.test/probe", {
      method: "POST",
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  const probing = () =>
    createFakeLauncher({
      probe: () =>
        Promise.resolve({
          status: "passed",
          engines: ["pr-agent", "opencode"],
          reasons: [],
          checkedAt: "2026-10-10T12:00:00.000Z",
        }),
    });

  // #730-T15
  it("refuses the factory's token and the reviewer's token on /probe when the operator token is set, and accepts the operator's", async () => {
    const launcher = probing();
    const logger = recordingLogger();
    const { app } = composeDispatcher({
      env: environment({ DISPATCHER_OPERATOR_TOKEN: OPERATOR }),
      launcher,
      background: () => undefined,
      logger,
    });

    for (const token of [FACTORY_TOKEN, DISPATCHER_TOKEN, "wrong", undefined]) {
      const response = await app.fetch(probe(token));
      expect(response.status, String(token)).toBe(401);
    }
    // A refused call starts no canary.
    expect(launcher.probes).toBe(0);
    const accepted = await app.fetch(probe(OPERATOR));
    expect(accepted.status).toBe(200);
    expect(launcher.probes).toBe(1);
    expect(logger.text()).not.toContain("operator_token_missing");
  });

  // #730-T15
  it("refuses to start with DISPATCHER_APPS and no operator token, naming the variable: the reviewer's token never opens /probe next to another app", () => {
    const withoutOperator = environment();
    delete withoutOperator.DISPATCHER_OPERATOR_TOKEN;

    expect(() =>
      composeDispatcher({
        env: withoutOperator,
        launcher: probing(),
        background: () => undefined,
        logger: recordingLogger(),
      }),
    ).toThrow(/DISPATCHER_OPERATOR_TOKEN is required/);
  });

  // #730-T15
  it("opens /probe to nobody, and says so, when several apps are served without an operator token (an assembly that skipped the configuration)", async () => {
    const launcher = probing();
    const logger = recordingLogger();
    const { app } = createDispatcher({
      settings: settingsFor(reviewer.url, {
        more: [
          {
            id: "factory",
            url: factory.url,
            token: FACTORY_TOKEN,
            poolId: "factory",
            maxRunning: 2,
            kinds: ["diff", "dynamic"],
          },
        ],
      }),
      launcher,
      background: () => undefined,
      logger,
      trigger: webhookTrigger({ keys: [] }),
    });

    for (const token of [FACTORY_TOKEN, DISPATCHER_TOKEN, OPERATOR, undefined])
      expect((await app.fetch(probe(token))).status, String(token)).toBe(401);
    expect(launcher.probes).toBe(0);
    expect(
      logger.lines.some((line) =>
        line.startsWith("warn operator_token_missing"),
      ),
    ).toBe(true);
  });

  // #730-T15
  it("keeps the legacy behaviour with one app and no operator token: the reviewer's token opens /probe", async () => {
    const launcher = probing();
    const logger = recordingLogger();
    const { app } = composeDispatcher({
      env: {
        RUNNER_API_URL: reviewer.url,
        RUNNER_TOKEN: DISPATCHER_TOKEN,
        DISPATCHER_MAX_RUNNING: "2",
        DISPATCHER_SIGNING_KEY_ID: KEY_ID,
        DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
      },
      launcher,
      background: () => undefined,
      logger,
    });

    expect((await app.fetch(probe(DISPATCHER_TOKEN))).status).toBe(200);
    expect((await app.fetch(probe("wrong"))).status).toBe(401);
    // Nothing to warn about: with one app that is how it always was.
    expect(logger.text()).not.toContain("operator_token_missing");
  });
});

describe("POST /apps/check", () => {
  const check = (token: string | undefined) =>
    new Request("http://dispatcher.test/apps/check", {
      method: "POST",
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  // #730-T16
  it("refuses every app credential and every caller when no operator token is set", async () => {
    const { app } = build({
      env: {
        RUNNER_API_URL: reviewer.url,
        RUNNER_TOKEN: DISPATCHER_TOKEN,
        DISPATCHER_MAX_RUNNING: "2",
        DISPATCHER_SIGNING_KEY_ID: KEY_ID,
        DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
      },
    });

    for (const token of [FACTORY_TOKEN, DISPATCHER_TOKEN, OPERATOR, undefined])
      expect((await app.fetch(check(token))).status, String(token)).toBe(401);
    expect(factory.requests()).toHaveLength(0);
    expect(reviewer.requests()).toHaveLength(0);
  });

  // #730-T16
  it("reports each app with its own credential, and nothing but ids, booleans and stable codes", async () => {
    const { app, logger } = build({
      env: environment({ DISPATCHER_OPERATOR_TOKEN: OPERATOR }),
    });

    const response = await app.fetch(check(OPERATOR));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toStrictEqual({
      version: 1,
      ok: true,
      apps: [
        {
          id: "reviewer",
          reachable: true,
          credentialAccepted: true,
          missingFeatures: [],
          code: null,
        },
        {
          id: "factory",
          reachable: true,
          credentialAccepted: true,
          missingFeatures: [],
          code: null,
        },
      ],
    });
    // Each app was asked once, with its own token (the fake App rejects any other with 401).
    expect(reviewer.requests().map((entry) => entry.route)).toStrictEqual([
      "version",
    ]);
    expect(factory.requests().map((entry) => entry.route)).toStrictEqual([
      "version",
    ]);
    for (const secret of [
      DISPATCHER_TOKEN,
      FACTORY_TOKEN,
      OPERATOR,
      FACTORY_SECRET,
      factory.url,
      reviewer.url,
    ]) {
      expect(text).not.toContain(secret);
      expect(logger.text()).not.toContain(secret);
    }
  });

  // #730-T16
  it("reports an unreachable app, a rejected credential and a missing feature by stable code", async () => {
    const rejected = await startApp({
      dispatcherToken: "another-token-than-the-dispatchers-0001",
    });
    const gone = await startApp({ dispatcherToken: FACTORY_TOKEN });
    const goneUrl = gone.url;
    await gone.close();
    try {
      const env = environment({ DISPATCHER_OPERATOR_TOKEN: OPERATOR });
      for (const [apps, expected] of [
        [
          { url: rejected.url },
          { reachable: true, credentialAccepted: false, code: "app_rejected" },
        ],
        [
          { url: goneUrl },
          {
            reachable: false,
            credentialAccepted: null,
            code: "app_unreachable",
          },
        ],
      ] as const) {
        const { app } = build({
          env: {
            ...env,
            DISPATCHER_APPS: JSON.stringify([
              {
                id: "factory",
                url: apps.url,
                kinds: ["diff"],
                keyId: FACTORY_KEY,
                maxRunning: 2,
              },
            ]),
          },
        });

        const body = (await (await app.fetch(check(OPERATOR))).json()) as {
          ok: boolean;
          apps: Array<Record<string, unknown>>;
        };

        expect(body.ok).toBe(false);
        expect(body.apps[0]).toMatchObject({ id: "reviewer", code: null });
        expect(body.apps[1]).toMatchObject({ id: "factory", ...expected });
      }

      factory.script("version", [
        {
          status: 200,
          body: { version: 1, appVersion: "x", features: ["worker_api"] },
        },
      ]);
      const { app } = build({ env });
      const missing = (await (await app.fetch(check(OPERATOR))).json()) as {
        apps: Array<Record<string, unknown>>;
      };
      expect(missing.apps[1]).toMatchObject({
        id: "factory",
        reachable: true,
        credentialAccepted: true,
        code: "app_too_old",
        missingFeatures: ["claim_by_job_id", "pool_cap", "release"],
      });
    } finally {
      await rejected.close();
    }
  });

  // #730-T16
  it("validates against the contract", async () => {
    const { Ajv2020 } = await import("ajv/dist/2020.js");
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const schema = readContract<{ $id: string }>("dispatcher-ops.v1.json");
    ajv.addSchema(readContract("runner-api.v1.json"));
    ajv.addSchema(schema);
    const validate = ajv.getSchema(`${schema.$id}#/$defs/AppsCheckResponse`);
    if (validate === undefined) throw new Error("no AppsCheckResponse");
    const { app } = build({
      env: environment({ DISPATCHER_OPERATOR_TOKEN: OPERATOR }),
    });

    const answer = await (await app.fetch(check(OPERATOR))).json();

    expect(validate(answer), JSON.stringify(validate.errors)).toBe(true);
    const example = readContract(
      "examples/dispatcher-ops/AppsCheckResponse.json",
    );
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
    // Closed: a field of another shape is refused.
    expect(validate({ ...(answer as object), extra: 1 })).toBe(false);
  });
});

describe("the logger", () => {
  // #730-T17
  it("masks every app's token and signing secret, the previous keys, the operator token and the cron secret", () => {
    const written: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      written.push(String(line));
    });
    try {
      const { logger } = composeDispatcher({
        env: environment({
          DISPATCHER_OPERATOR_TOKEN: OPERATOR,
          CRON_SECRET: CRON,
          DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS:
            FACTORY_PREVIOUS_SECRET,
          DISPATCHER_APP_FACTORY_SIGNING_SECRET_PREVIOUS_KEY_ID: "factory-k0",
        }),
        launcher: createFakeLauncher(),
        background: () => undefined,
        reaper: () => ({
          fleet: new FakeSandboxService(),
          jobLifetimeSeconds: 1500,
          canaryLifetimeSeconds: 450,
        }),
      });
      const secrets = [
        DISPATCHER_TOKEN,
        FACTORY_TOKEN,
        SIGNING_SECRET,
        FACTORY_SECRET,
        FACTORY_PREVIOUS_SECRET,
        OPERATOR,
        CRON,
      ];

      for (const secret of secrets) logger.warn("probe", { value: secret });
      logger.error("with_header", {
        text: `Authorization: Bearer ${FACTORY_TOKEN}`,
      });

      expect(written).toHaveLength(secrets.length + 1);
      const text = written.join("\n");
      for (const secret of secrets) expect(text).not.toContain(secret);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the reaper with two apps", () => {
  const seed = (
    sandbox: FakeSandboxService,
    jobId: string,
    tenant: string | undefined,
    suffix: string,
  ) => {
    const name = `cr-diff-${jobId}-${suffix}`;
    sandbox.seedVm({
      name,
      tags: {
        app: "code-reviewer",
        kind: "diff",
        job: jobId,
        ...(tenant === undefined ? {} : { tenant }),
      },
      createdAtMs: Date.now() - 600_000,
    });
    return name;
  };
  const reap = (app: {
    fetch: (request: Request) => Response | Promise<Response>;
  }) =>
    app.fetch(
      new Request("http://dispatcher.test/api/cron/reap-sandboxes", {
        headers: { authorization: `Bearer ${CRON}` },
      }),
    );

  // #730-T14
  it("asks each VM's job at the app its tenant tag names, untagged at the reviewer, and keeps a VM of an unknown tenant", async () => {
    const reviewerJob = reviewer.enqueue({
      id: "00000000-0000-4000-8000-0000000000a1",
    });
    const factoryJob = factory.enqueue({
      id: "00000000-0000-4000-8000-0000000000a2",
    });
    const untaggedJob = reviewer.enqueue({
      id: "00000000-0000-4000-8000-0000000000a3",
    });
    // Same job id in both apps: two jobs, the answers must not mix.
    const sharedId = "00000000-0000-4000-8000-0000000000a4";
    reviewer.enqueue({ id: sharedId });
    factory.enqueue({ id: sharedId });
    reviewer.setJobStatus(reviewerJob, "running");
    reviewer.setJobStatus(untaggedJob, "succeeded");
    factory.setJobStatus(factoryJob, "succeeded");
    reviewer.setJobStatus(sharedId, "running");
    factory.setJobStatus(sharedId, "succeeded");
    const { app, sandbox } = build({
      env: environment({ CRON_SECRET: CRON }),
      withFleet: true,
    });
    const keptReviewer = seed(sandbox, reviewerJob, "reviewer", "00000001");
    const stoppedFactory = seed(sandbox, factoryJob, "factory", "00000002");
    const stoppedUntagged = seed(sandbox, untaggedJob, undefined, "00000003");
    const ghost = seed(sandbox, JOB, "ghost", "00000004");
    const sharedReviewer = seed(sandbox, sharedId, "reviewer", "00000005");
    const sharedFactory = seed(sandbox, sharedId, "factory", "00000006");

    const response = await reap(app);

    expect(response.status).toBe(200);
    expect([...sandbox.stops].sort()).toStrictEqual(
      [stoppedFactory, stoppedUntagged, sharedFactory].sort(),
    );
    expect(sandbox.stops).not.toContain(keptReviewer);
    expect(sandbox.stops).not.toContain(sharedReviewer);
    expect(sandbox.stops).not.toContain(ghost);
    // Nothing was asked of an app about a job that is not its own.
    const asked = (fake: DispatcherAppFake) =>
      fake.requests().filter((entry) => entry.route === "job_state");
    expect(
      asked(reviewer)
        .map((entry) => entry.jobId)
        .sort(),
    ).toStrictEqual([reviewerJob, untaggedJob, sharedId].sort());
    expect(
      asked(factory)
        .map((entry) => entry.jobId)
        .sort(),
    ).toStrictEqual([factoryJob, sharedId].sort());
  });

  // #730-T14
  it("stops a VM of an unknown tenant or with an unreadable state only when its lifetime is over", async () => {
    const { app, sandbox } = build({
      env: environment({ CRON_SECRET: CRON }),
      withFleet: true,
    });
    const young = seed(sandbox, JOB, "ghost", "00000001");
    const old = `cr-diff-${OTHER_JOB}-00000002`;
    sandbox.seedVm({
      name: old,
      tags: {
        app: "code-reviewer",
        kind: "diff",
        job: OTHER_JOB,
        tenant: "ghost",
      },
      createdAtMs: Date.now() - 10_000_000,
    });

    await reap(app);

    expect(sandbox.stops).toStrictEqual([old]);
    expect(sandbox.stops).not.toContain(young);
  });
});

describe("the cap of each app against the platform's fleet", () => {
  const seedLive = (
    sandbox: FakeSandboxService,
    tenant: string | undefined,
    count: number,
    first: number,
  ) => {
    for (let index = 0; index < count; index += 1) {
      const jobId = `00000000-0000-4000-8000-${String(first + index).padStart(12, "0")}`;
      sandbox.seedVm({
        name: `cr-diff-${jobId}-0000000${index}`,
        tags: {
          app: "code-reviewer",
          kind: "diff",
          job: jobId,
          ...(tenant === undefined ? {} : { tenant }),
        },
      });
    }
  };

  // #730-T22
  it("refuses the factory at its own cap with the VMs the platform lists, whatever the factory says, and still serves the reviewer", async () => {
    const { core, sandbox, launcher } = build({
      env: environment({ DISPATCHER_MAX_RUNNING: "3" }),
      withFleet: true,
    });
    // The factory's cap is 2 (the environment) and the Dispatcher tolerates 4 more: it has 6. The reviewer has 2 of its 3
    // (one of them untagged).
    seedLive(sandbox, "factory", 6, 100);
    seedLive(sandbox, "reviewer", 1, 200);
    seedLive(sandbox, undefined, 1, 300);

    const factoryJob = factory.enqueue();
    const forFactory = await core.handle({
      appId: "factory",
      jobId: factoryJob,
      reviewKind: "diff",
    });
    const reviewerJob = reviewer.enqueue();
    const forReviewer = await core.handle({
      appId: "reviewer",
      jobId: reviewerJob,
      reviewKind: "diff",
    });
    if (forReviewer.outcome === "started") await forReviewer.background;

    expect(forFactory).toStrictEqual({
      outcome: "busy",
      retryAfterSeconds: 30,
    });
    expect(factory.requests()).toHaveLength(0);
    expect(forReviewer.outcome).toBe("started");
    expect(launcher.launches.map((spec) => spec.appId)).toStrictEqual([
      "reviewer",
    ]);
  });

  // #802-T31
  it("logs the listing's time and size once for the claims that share it", async () => {
    const { core, sandbox, logger } = build({
      env: environment(),
      withFleet: true,
    });
    seedLive(sandbox, "factory", 1, 100);
    seedLive(sandbox, "reviewer", 1, 200);

    for (const [app, queue] of [
      ["factory", factory],
      ["reviewer", reviewer],
    ] as const) {
      const result = await core.handle({
        appId: app,
        jobId: queue.enqueue(),
        reviewKind: "diff",
      });
      if (result.outcome === "started") await result.background;
    }

    expect(
      logger.text().match(/fleet_listed \{"ms":\d+,"count":2\}/g),
    ).toHaveLength(1);
  });

  // #802-T02
  it("claims the job of an app below its cap when the platform cannot be listed", async () => {
    const { core, sandbox, launcher, logger } = build({
      env: environment(),
      withFleet: true,
    });
    sandbox.failNextList(new Error("platform down"));

    const result = await core.handle({
      appId: "factory",
      jobId: factory.enqueue(),
      reviewKind: "diff",
    });
    if (result.outcome === "started") await result.background;

    expect(result.outcome).toBe("started");
    expect(launcher.launches).toHaveLength(1);
    expect(logger.text()).toContain("fleet_list_failed");
    expect(logger.text()).not.toContain("fleet_listed");
  });

  // #730-T22
  it("does not list the platform for the cap in the single-app environment, the production of today", async () => {
    const legacy = environment();
    delete legacy.DISPATCHER_APPS;
    delete legacy.DISPATCHER_APP_FACTORY_TOKEN;
    delete legacy.DISPATCHER_APP_FACTORY_SIGNING_SECRET;
    delete legacy.DISPATCHER_OPERATOR_TOKEN;
    const { core, sandbox, launcher, logger } = build({
      env: legacy,
      withFleet: true,
    });
    // A platform that cannot be listed must not change what the single app gets.
    sandbox.failNextList(new Error("platform down"));

    const result = await core.handle({
      appId: "reviewer",
      jobId: reviewer.enqueue(),
      reviewKind: "diff",
    });
    if (result.outcome === "started") await result.background;

    expect(result.outcome).toBe("started");
    expect(sandbox.lists).toHaveLength(0);
    expect(launcher.launches).toHaveLength(1);
    expect(logger.text()).not.toContain("fleet_list_failed");
  });

  // #730-T22
  it("holds the reviewer to DISPATCHER_MAX_RUNNING plus the tolerance with the same count", async () => {
    const { core, sandbox } = build({
      env: environment({ DISPATCHER_MAX_RUNNING: "2" }),
      withFleet: true,
    });
    seedLive(sandbox, undefined, 1, 300);
    seedLive(sandbox, "reviewer", 5, 200);

    const result = await core.handle({
      appId: "reviewer",
      jobId: reviewer.enqueue(),
      reviewKind: "diff",
    });

    expect(result).toStrictEqual({ outcome: "busy", retryAfterSeconds: 30 });
    expect(reviewer.requests()).toHaveLength(0);
  });
});
