// SPDX-License-Identifier: LicenseRef-Proprietary

import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { loadSettings } from "../config.ts";
import { createApp } from "../dispatcher-app.ts";
import { createBackgroundTracker } from "../test-support/background.ts";
import type { Engine, ProbeResult } from "../core/types.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  readContract,
  recordingLogger,
  settingsFor,
  startApp,
} from "../test-support/harness.ts";
import { webhookTrigger } from "../triggers/webhook.ts";

let fake: DispatcherAppFake;
beforeEach(async () => {
  fake = await startApp();
});
afterEach(async () => {
  await fake.close();
});

const PASSED: ProbeResult = {
  status: "passed",
  engines: ["pr-agent", "opencode"],
  reasons: [],
  checkedAt: "2026-10-15T12:00:00.000Z",
};
const DENIED: ProbeResult = {
  status: "denied",
  engines: ["pr-agent"],
  reasons: ["ipv6_not_disabled"],
  checkedAt: "2026-10-15T12:00:00.000Z",
};

function build(
  probe?: () => Promise<ProbeResult>,
  engines: ("pr-agent" | "opencode")[] = ["pr-agent", "opencode"],
  imageDigest?: string,
  snapshotId?: string,
) {
  const launcher = createFakeLauncher(probe === undefined ? {} : { probe });
  const logger = recordingLogger();
  const app = createApp({
    settings: settingsFor(fake.url, { engines }),
    launcher,
    logger,
    background: createBackgroundTracker().run,
    trigger: webhookTrigger({
      keys: [{ kid: KEY_ID, secret: SIGNING_SECRET, appId: "reviewer" }],
    }),
    ...(imageDigest === undefined ? {} : { imageDigest }),
    ...(snapshotId === undefined ? {} : { snapshotId }),
  });
  return { app, launcher, logger };
}

function post(
  app: { fetch: (request: Request) => Response | Promise<Response> },
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request("http://dispatcher.test/probe", { method: "POST", headers }),
  );
}

const authorized = { authorization: `Bearer ${DISPATCHER_TOKEN}` };

function validReport(): (document: unknown) => boolean {
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(readContract("runner-api.v1.json") as object);
  const probe = readContract<{ $id: string }>("probe-verdict.v1.json");
  ajv.addSchema(probe);
  const check = ajv.getSchema(`${probe.$id}#/$defs/ProbeReport`);
  if (check === undefined) throw new Error("no ProbeReport");
  return (document) => check(document) === true;
}

describe("POST /probe", () => {
  // #331-T05
  it.each<[string, Record<string, string>]>([
    ["no credential", {}],
    ["a wrong credential", { authorization: "Bearer dummy-not-the-token" }],
    ["the token without its scheme", { authorization: DISPATCHER_TOKEN }],
    ["another scheme", { authorization: `Basic ${DISPATCHER_TOKEN}` }],
    ["an empty credential", { authorization: "Bearer " }],
  ])("answers 401 for %s and creates no canary VM", async (_name, headers) => {
    const { app, launcher } = build(() => Promise.resolve(PASSED));

    const response = await post(app, headers);

    expect(response.status).toBe(401);
    expect(await response.json()).toStrictEqual({
      error: {
        code: "RUNNER_UNAUTHORIZED",
        message: "The request could not be verified.",
      },
    });
    expect(launcher.probes).toBe(0);
  });

  // #331-T05
  it("answers every refusal with the same body, so that it does not say what was wrong", async () => {
    const { app } = build(() => Promise.resolve(PASSED));

    const refusals: Record<string, string>[] = [
      {},
      { authorization: "Bearer dummy-not-the-token" },
    ];
    const bodies = await Promise.all(
      refusals.map(async (headers) => (await post(app, headers)).text()),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  // #331-T05
  it("does not answer a GET", async () => {
    const { app, launcher } = build(() => Promise.resolve(PASSED));

    const response = await app.fetch(
      new Request("http://dispatcher.test/probe", { headers: authorized }),
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(launcher.probes).toBe(0);
  });

  // #331-T01
  it("forces a probe and answers 200 with the report when every configured engine is advertised", async () => {
    const { app, launcher } = build(() => Promise.resolve(PASSED));

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    const report: unknown = await response.json();
    expect(report).toStrictEqual({
      version: 1,
      status: "passed",
      ok: true,
      engines: ["pr-agent", "opencode"],
      reasons: [],
      required: ["pr-agent", "opencode"],
      checkedAt: "2026-10-15T12:00:00.000Z",
    });
    expect(validReport()(report)).toBe(true);
    expect(launcher.probes).toBe(1);
  });

  // #331-T02
  it("answers 503 with the stable reasons when the canary does not advertise a configured engine", async () => {
    const { app } = build(() => Promise.resolve(DENIED));

    const response = await post(app, authorized);

    expect(response.status).toBe(503);
    const report: unknown = await response.json();
    expect(report).toMatchObject({
      status: "denied",
      ok: false,
      engines: ["pr-agent"],
      reasons: ["ipv6_not_disabled"],
    });
    expect(validReport()(report)).toBe(true);
  });

  // #331-T02
  it("answers 503 with the failure code when the canary could not be run", async () => {
    const failed: ProbeResult = {
      status: "failed",
      engines: ["pr-agent"],
      reasons: [],
      failure: "probe_timeout",
      checkedAt: "2026-10-15T12:00:00.000Z",
    };
    const { app } = build(() => Promise.resolve(failed));

    const response = await post(app, authorized);

    expect(response.status).toBe(503);
    const report: unknown = await response.json();
    expect(report).toMatchObject({
      status: "failed",
      ok: false,
      failure: "probe_timeout",
    });
    expect(validReport()(report)).toBe(true);
  });

  // #331-T01
  it("does not need the canary to pass when the deployment is configured for Diff jobs only", async () => {
    const { app } = build(() => Promise.resolve(DENIED), ["pr-agent"]);

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  // #331-T02
  it("fails closed when the probe itself breaks, and says nothing of the error", async () => {
    const { app, logger } = build(() =>
      Promise.reject(
        new Error("boom with ghp_" + "0123456789abcdef0123456789abcdef0123"),
      ),
    );

    const response = await post(app, authorized);

    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("boom");
    expect(JSON.parse(text)).toMatchObject({
      status: "failed",
      ok: false,
      failure: "probe_error",
    });
    expect(logger.text()).not.toContain("ghp_");
  });

  // #331-T02
  it("says that nothing is proven when the Launcher has no probe, and what it advertises", async () => {
    const { app } = build(undefined);

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "failed",
      failure: "probe_not_supported",
      ok: true,
    });
  });
});

// #759: the engines a deployment serves come from `loadSettings`, so the tests start from the real configuration. A kind
// this Launcher cannot launch yet is not a reason to refuse a deploy; one it advertises is proven like the others.
describe("the engines of a Dispatcher that serves the implementer kind", () => {
  const OPERATOR = "operator-token-for-the-tests-0000000001";
  const FACTORY_TOKEN = "factory-dispatcher-token-for-tests-0001";
  const FACTORY_SECRET = "factory-signing-secret-for-tests-000001";

  function buildFromEnvironment(
    extra: Record<string, string>,
    launcherEngines: readonly Engine[] | undefined,
    probe: ProbeResult,
  ) {
    const { core } = loadSettings({
      RUNNER_API_URL: fake.url,
      RUNNER_TOKEN: DISPATCHER_TOKEN,
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: KEY_ID,
      DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
      DISPATCHER_APPS: JSON.stringify([
        {
          id: "factory",
          url: "https://factory.example",
          kinds: ["diff", "dynamic", "implementer"],
          keyId: "factory-k1",
          maxRunning: 2,
        },
      ]),
      DISPATCHER_APP_FACTORY_TOKEN: FACTORY_TOKEN,
      DISPATCHER_APP_FACTORY_SIGNING_SECRET: FACTORY_SECRET,
      DISPATCHER_OPERATOR_TOKEN: OPERATOR,
      ...extra,
    });
    const launcher = createFakeLauncher({
      probe: () => Promise.resolve(probe),
      ...(launcherEngines === undefined ? {} : { engines: launcherEngines }),
    });
    const app = createApp({
      settings: core,
      launcher,
      logger: recordingLogger(),
      background: createBackgroundTracker().run,
      operatorToken: OPERATOR,
      trigger: webhookTrigger({
        keys: [{ kid: KEY_ID, secret: SIGNING_SECRET, appId: "reviewer" }],
      }),
    });
    return { app, core };
  }

  const operator = { authorization: `Bearer ${OPERATOR}` };
  const WITH_IMPLEMENTER: ProbeResult = {
    ...PASSED,
    engines: ["pr-agent", "opencode", "implementer"],
  };

  // #759-T20
  it("answers 200 when the settings gained `implementer` from an app and the Launcher does not advertise it yet", async () => {
    const { app, core } = buildFromEnvironment({}, undefined, PASSED);
    expect(core.engines).toContain("implementer");

    const response = await post(app, operator);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  // #759-T20
  it("answers 200 when `implementer` is named in DISPATCHER_ENGINES and the Launcher does not advertise it yet", async () => {
    const { app, core } = buildFromEnvironment(
      { DISPATCHER_ENGINES: "pr-agent,opencode,implementer" },
      undefined,
      PASSED,
    );
    expect(core.engines).toContain("implementer");

    const response = await post(app, operator);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  // #759-T20
  it("still answers 503 when a reviewer engine is missing, with `implementer` in the settings", async () => {
    const { app } = buildFromEnvironment({}, undefined, DENIED);

    const response = await post(app, operator);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false });
  });

  // #759-T20
  it("requires `implementer` as soon as the Launcher advertises it, without a change of the route", async () => {
    const advertised: Engine[] = ["pr-agent", "opencode", "implementer"];
    const missing = buildFromEnvironment({}, advertised, PASSED);
    const proven = buildFromEnvironment({}, advertised, WITH_IMPLEMENTER);

    const refused = await post(missing.app, operator);
    const accepted = await post(proven.app, operator);

    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      ok: false,
      required: ["pr-agent", "opencode", "implementer"],
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ ok: true });
  });

  // #759-T20
  it("requires the engines of the reviewer kinds even when the Launcher does not advertise them, with `implementer` in the settings", async () => {
    // Only the engines of `diff` and `dynamic` are required unconditionally: what the Launcher advertises decides about the others.
    const { app } = buildFromEnvironment({}, ["pr-agent"], {
      ...PASSED,
      engines: ["pr-agent"],
    });

    const response = await post(app, operator);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      required: ["pr-agent", "opencode"],
    });
  });

  // #759-T20
  it("does not require `implementer` of a Diff-only deployment that names it nowhere", async () => {
    const { app } = buildFromEnvironment(
      { DISPATCHER_ENGINES: "pr-agent" },
      undefined,
      DENIED,
    );

    const response = await post(app, operator);

    expect(response.status).toBe(200);
  });
});

describe("the image id in the probe report", () => {
  const DIGEST = `sha256:${"a".repeat(64)}`;

  // #403-T12
  it("names the Worker image id this deployment is configured with, so that a deploy step can tell which image it proved", async () => {
    const { app } = build(() => Promise.resolve(PASSED), undefined, DIGEST);

    const response = await post(app, authorized);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ imageDigest: DIGEST });
  });

  // #403-T12
  it("leaves it out when no image is configured, and never takes it from anything but the configuration", async () => {
    const { app } = build(() => Promise.resolve(PASSED));

    const body = (await (await post(app, authorized)).json()) as Record<
      string,
      unknown
    >;

    expect(body).not.toHaveProperty("imageDigest");
  });

  // #403-T12
  it("drops a value that is not an image id", async () => {
    const { app } = build(
      () => Promise.resolve(PASSED),
      undefined,
      "sha256:not-a-digest",
    );

    const body = (await (await post(app, authorized)).json()) as Record<
      string,
      unknown
    >;

    expect(body).not.toHaveProperty("imageDigest");
  });

  // #403-T12
  it("is not shown to a caller without the credential", async () => {
    const { app } = build(() => Promise.resolve(PASSED), undefined, DIGEST);

    const response = await post(app);

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain(DIGEST);
  });
});

describe("the snapshot id in the probe report", () => {
  // #403-T12
  it("names the snapshot this deployment creates job VMs from, so that a pair that did not reach it is seen", async () => {
    const { app } = build(
      () => Promise.resolve(PASSED),
      undefined,
      undefined,
      "snap_example01",
    );

    const response = await post(app, authorized);

    expect(await response.json()).toMatchObject({
      snapshotId: "snap_example01",
    });
  });

  // #403-T12
  it.each(["", "snap x", "snap_\nid", "a".repeat(200)])(
    "drops %j: it is not a snapshot id",
    async (value) => {
      const { app } = build(
        () => Promise.resolve(PASSED),
        undefined,
        undefined,
        value,
      );

      const body = (await (await post(app, authorized)).json()) as Record<
        string,
        unknown
      >;

      expect(body).not.toHaveProperty("snapshotId");
    },
  );

  // #403-T12
  it("leaves it out when none is configured and from a refused call", async () => {
    const none = build(() => Promise.resolve(PASSED));
    expect(await (await post(none.app, authorized)).json()).not.toHaveProperty(
      "snapshotId",
    );

    const refused = build(
      () => Promise.resolve(PASSED),
      undefined,
      undefined,
      "snap_example01",
    );
    expect(
      JSON.stringify(await (await post(refused.app)).json()),
    ).not.toContain("snap_example01");
  });
});
