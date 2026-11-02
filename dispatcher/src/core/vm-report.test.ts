// SPDX-License-Identifier: LicenseRef-Proprietary

// The Dispatcher reports the VM it created to the App (#493): right after the Launcher created it, with the per-job
// credential it holds during the launch, best effort with a bounded retry, and only to an App that lists the feature
// `vm_lifecycle`. A failed report is logged with one stable code and never fails or delays a launch or a job transition.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DispatcherAppFake } from "../../../fakes/dispatcher-app/server.ts";
import { createFakeLauncher } from "../launchers/fake.ts";
import { ManualClock, settle } from "../test-support/manual-clock.ts";
import {
  DISPATCHER_TOKEN,
  recordingLogger,
  settingsFor,
  startApp,
} from "../test-support/harness.ts";
import { createDispatcherCore } from "./dispatcher.ts";
import type { CreatedVm, HandleResult } from "./types.ts";

let app: DispatcherAppFake;
let clock: ManualClock;

beforeEach(async () => {
  app = await startApp();
  clock = new ManualClock();
});
afterEach(async () => {
  await app.close();
});

const VM: CreatedVm = {
  name: "cr-diff-0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10-ab12cd34",
  startedAt: new Date("2026-10-19T10:00:00.250Z"),
  timeoutSeconds: 1500,
};

type Call = { url: string; method: string; headers: Headers; body: unknown };

function recordingFetch() {
  const calls: Call[] = [];
  const fetchRecorded: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: text === "" ? null : (JSON.parse(text) as unknown),
    });
    return fetch(request);
  };
  return { calls, fetch: fetchRecorded };
}

/** A core whose launcher creates a VM and tells the core, like the Sandbox-Launcher does right after the create. */
function build(
  launcherOptions: Parameters<typeof createFakeLauncher>[0] = {},
  overrides: Parameters<typeof settingsFor>[1] = {},
) {
  const logger = recordingLogger();
  const launcher = createFakeLauncher({
    onLaunch: (spec) => {
      spec.onVmCreated?.(VM);
      return Promise.resolve();
    },
    ...launcherOptions,
  });
  const recorded = recordingFetch();
  const core = createDispatcherCore({
    settings: settingsFor(app.url, overrides),
    launcher,
    clock,
    logger,
    fetch: recorded.fetch,
  });
  return { core, launcher, logger, recorded };
}

async function drive(background: Promise<void>): Promise<void> {
  let done = false;
  void background.then(() => {
    done = true;
  });
  for (let step = 0; step < 100 && !done; step += 1) {
    await clock.advance(10_000);
    await settle();
  }
  await background;
}

async function handled(result: Promise<HandleResult>): Promise<HandleResult> {
  const outcome = await result;
  if (outcome.outcome === "started") await drive(outcome.background);
  return outcome;
}

const vmCalls = (calls: Call[]) =>
  calls.filter((call) => call.url.endsWith("/vm"));
const vmRequests = () =>
  app.requests().filter((request) => request.route === "vm");

describe("the report of the VM", () => {
  // #493-T05
  it("is sent with the job credential once the Launcher created the VM, and the launch goes on", async () => {
    const jobId = app.enqueue();
    const { core, launcher, logger, recorded } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    const [call] = vmCalls(recorded.calls);
    expect(call?.url).toBe(`${app.url}/api/runners/v1/jobs/${jobId}/vm`);
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe(
      `Bearer ${DISPATCHER_TOKEN}`,
    );
    expect(call?.body).toStrictEqual({
      credential: launcher.launches[0]?.credential,
      vmName: VM.name,
      startedAt: "2026-10-19T10:00:00.250Z",
      timeoutSeconds: 1500,
    });
    expect(vmRequests()).toHaveLength(1);
    expect(logger.text()).toContain("launched");
    expect(app.requests().filter((r) => r.route === "release")).toHaveLength(0);
  });

  // #493-T05
  it("is repeated a bounded number of times, then logged once with a stable code; the launch is not failed", async () => {
    const jobId = app.enqueue();
    app.script("vm", [{ status: 503 }, { status: 500 }, { status: 502 }]);
    const { core, logger } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    expect(vmRequests()).toHaveLength(3);
    const lines = logger.lines.filter((line) => line.includes("vm_report"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("vm_report_failed");
    expect(lines[0]).toContain(jobId);
    expect(logger.text()).toContain("launched");
    expect(app.requests().filter((r) => r.route === "release")).toHaveLength(0);
  });

  // #493-T05
  it("takes a repeat that succeeds, and does not repeat a refusal of the App", async () => {
    const jobId = app.enqueue();
    app.script("vm", [{ status: 503 }]);
    const first = build();
    await handled(
      first.core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );
    expect(vmRequests().map((request) => request.status)).toStrictEqual([
      503, 200,
    ]);
    expect(first.logger.text()).not.toContain("vm_report_failed");

    app.reset();
    const next = app.enqueue();
    app.script("vm", [{ status: 409 }]);
    const second = build();
    await handled(
      second.core.handle({
        appId: "reviewer",
        jobId: next,
        reviewKind: "diff",
      }),
    );
    expect(vmRequests().map((request) => request.status)).toStrictEqual([409]);
    expect(second.logger.text()).toContain("vm_report_failed");
  });

  // #493-T05
  it("never puts the credential or the body of an answer into the log", async () => {
    const jobId = app.enqueue();
    app.script("vm", [
      { status: 500, body: { error: { code: "X", message: "secret-text" } } },
      { status: 500 },
      { status: 500 },
    ]);
    const { core, logger, launcher } = build();

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(logger.text()).not.toContain(
      launcher.launches[0]?.credential ?? "x",
    );
    expect(logger.text()).not.toContain("secret-text");
  });

  // #493-T12
  it("is not sent to an App that does not list vm_lifecycle", async () => {
    const jobId = app.enqueue();
    app.script("version", [
      {
        status: 200,
        body: {
          version: 1,
          appVersion: "old",
          features: ["worker_api", "claim_by_job_id", "pool_cap", "release"],
        },
      },
    ]);
    const { core, logger } = build();

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    expect(vmRequests()).toHaveLength(0);
    expect(logger.text()).toContain("launched");
  });

  // #493-T12
  it("does not fail a launch whose Launcher never reports a VM (a Launcher that creates none)", async () => {
    const jobId = app.enqueue();
    const { core } = build({ onLaunch: () => Promise.resolve() });

    const result = await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(result.outcome).toBe("started");
    expect(vmRequests()).toHaveLength(0);
  });

  // #493-T05
  it("is still sent when the launch fails after the VM was created, and the job is given back as before", async () => {
    const jobId = app.enqueue();
    const { core } = build({
      onLaunch: (spec) => {
        spec.onVmCreated?.(VM);
        return Promise.reject(new Error("boom"));
      },
    });

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(vmRequests()).toHaveLength(1);
    expect(app.requests().filter((r) => r.route === "release")).toHaveLength(1);
  });
});

describe("the size of the VM (#818)", () => {
  const SIZED: CreatedVm = { ...VM, vcpus: 6 };

  // #818-T35
  it("is reported for a job of the Implementer, as the Launcher says it", async () => {
    const jobId = app.enqueue({ reviewKind: "implementer" });
    const { core, recorded } = build(
      {
        engines: ["pr-agent", "opencode", "implementer"],
        onLaunch: (spec) => {
          spec.onVmCreated?.(SIZED);
          return Promise.resolve();
        },
      },
      {
        engines: ["pr-agent", "opencode", "implementer"],
        kinds: ["diff", "dynamic", "implementer"],
      },
    );

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "implementer" }),
    );

    expect(vmCalls(recorded.calls)[0]?.body).toMatchObject({ vcpus: 6 });
  });

  // #818-T35
  it("is left out of the report of a review: an App of the release before refuses a field it does not know", async () => {
    const jobId = app.enqueue();
    const { core, recorded } = build({
      onLaunch: (spec) => {
        spec.onVmCreated?.(SIZED);
        return Promise.resolve();
      },
    });

    await handled(
      core.handle({ appId: "reviewer", jobId, reviewKind: "diff" }),
    );

    expect(vmCalls(recorded.calls)[0]?.body).toStrictEqual({
      credential: expect.any(String),
      vmName: VM.name,
      startedAt: "2026-10-19T10:00:00.250Z",
      timeoutSeconds: 1500,
    });
  });
});
