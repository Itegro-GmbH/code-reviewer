// SPDX-License-Identifier: LicenseRef-Proprietary

// The claim of a composed Dispatcher names the features that depend on the Worker image from `SANDBOX_WORKER_FEATURES` (#1098): the
// variable of the active snapshot pair, set with the snapshot id by the deployment. Whatever is not exactly a list that has the
// feature (no variable, an old pair, `none`, garbage) leaves it out, so a multi-repo job stays queued for a Dispatcher that can run it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../fakes/dispatcher-app/server.ts";
import { composeDispatcher } from "./compose.ts";
import { createFakeLauncher } from "./launchers/fake.ts";
import {
  DISPATCHER_TOKEN,
  KEY_ID,
  SIGNING_SECRET,
  recordingLogger,
  signedRequest,
  startApp,
  webhookBody,
} from "./test-support/harness.ts";

let app: DispatcherAppFake;
beforeEach(async () => {
  app = await startApp();
});
afterEach(async () => {
  await app.close();
});

async function claimFeaturesWith(
  extra: Record<string, string>,
): Promise<string[]> {
  const jobId = app.enqueue();
  const bodies: unknown[] = [];
  const recording: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.endsWith("/claim"))
      bodies.push(JSON.parse(await request.clone().text()));
    return fetch(request);
  };
  const pending: Promise<unknown>[] = [];
  const { app: dispatcher } = composeDispatcher({
    env: {
      RUNNER_API_URL: app.url,
      RUNNER_TOKEN: DISPATCHER_TOKEN,
      DISPATCHER_MAX_RUNNING: "2",
      DISPATCHER_SIGNING_KEY_ID: KEY_ID,
      DISPATCHER_SIGNING_SECRET: SIGNING_SECRET,
      ...extra,
    },
    launcher: createFakeLauncher(),
    background: (work) => pending.push(work),
    logger: recordingLogger(),
    fetch: recording,
  });
  const response = await dispatcher.fetch(
    signedRequest({
      body: webhookBody({ jobId }),
      nowSeconds: Math.floor(Date.now() / 1000),
    }),
  );
  expect(response.status).toBe(202);
  await Promise.all(pending);
  expect(bodies).toHaveLength(1);
  return (bodies[0] as { features: string[] }).features;
}

const SNAPSHOT = { SANDBOX_SNAPSHOT_ID: "snap_example_0001" };

describe("the claim of a composed Dispatcher", () => {
  // #1098-T10
  it("names implementer_multi_repo when the pair's list has it", async () => {
    expect(
      await claimFeaturesWith({
        ...SNAPSHOT,
        SANDBOX_WORKER_FEATURES: "implementer_ask,implementer_multi_repo",
      }),
    ).toEqual(["worker_credential", "vm_lifecycle", "implementer_multi_repo"]);
  });

  // #1098-T10
  it.each([
    ["an old pair without the variable", {}],
    ["none", { SANDBOX_WORKER_FEATURES: "none" }],
    [
      "a list without the feature",
      { SANDBOX_WORKER_FEATURES: "implementer_ask" },
    ],
    [
      "a value nobody can read",
      { SANDBOX_WORKER_FEATURES: "implementer_multi_repo;x" },
    ],
  ])(
    "leaves it out for %s, so a multi-repo job stays queued",
    async (_name, extra) => {
      expect(await claimFeaturesWith({ ...SNAPSHOT, ...extra })).toEqual([
        "worker_credential",
        "vm_lifecycle",
      ]);
    },
  );

  // #1098-T10
  it("leaves it out without a snapshot, whatever the variable says", async () => {
    expect(
      await claimFeaturesWith({
        SANDBOX_WORKER_FEATURES: "implementer_multi_repo",
      }),
    ).toEqual(["worker_credential", "vm_lifecycle"]);
  });
});
