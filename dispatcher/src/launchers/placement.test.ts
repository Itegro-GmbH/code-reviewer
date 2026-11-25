// SPDX-License-Identifier: LicenseRef-Proprietary

// Two platforms behind one port (#1158): the placement of a call comes from the name of the VM, a listing asks both, and a failure of Cloudflare does
// not stop what belongs to Vercel.
import { describe, expect, it } from "vitest";
import { FakeSandboxService } from "../../../fakes/sandbox/service.ts";
import { FakeCfSandbox } from "../../../fakes/cf-sandbox/service.ts";
import { recordingLogger } from "../test-support/harness.ts";
import { createCfSandboxService } from "./cf-sandbox.ts";
import {
  cloudflareSuffix,
  createPlacementPlatform,
  placementOfVmName,
} from "./placement.ts";
import { jobVmName } from "./sandbox.ts";
import {
  SandboxServiceError,
  type SandboxCreateOptions,
} from "./sandbox-service.ts";
import { shapeOf } from "../reaper/vm-shape.ts";

const JOB = "0f8fad5b-d9cb-469f-a165-70867728950e";
const TOKEN = "t".repeat(40);

function options(name: string, placement?: "cloudflare"): SandboxCreateOptions {
  return {
    name,
    ...(placement === undefined ? {} : { placement }),
    snapshotId: "snap_1",
    region: "fra1",
    vcpus: 4,
    timeoutMs: 600_000,
    tags: {
      app: "code-reviewer",
      kind: "implementer",
      job: JOB,
      tenant: "reviewer",
    },
    persistent: false,
  };
}

function setup() {
  const vercel = new FakeSandboxService();
  const fake = new FakeCfSandbox({ token: TOKEN });
  const cloudflare = createCfSandboxService({
    baseUrl: "https://cr-sandbox.example",
    token: TOKEN,
    instanceTypes: new Map([[4, "standard-4"]]),
    fetch: fake.fetch,
  });
  const logger = recordingLogger();
  const platform = createPlacementPlatform({ vercel, cloudflare, logger });
  return { vercel, fake, platform, logger };
}

const CF_NAME = jobVmName("implementer", JOB, cloudflareSuffix("1a2b3c4d"));
const VERCEL_NAME = jobVmName("implementer", JOB, "1a2b3c4d");

describe("the name of a VM", () => {
  // #1158-P01
  it("carries the placement, stays inside the 63 characters of the Worker and is still a job VM of ours for the reaper and the stop route", () => {
    expect(CF_NAME).toBe(`cr-implementer-${JOB}-cf-1a2b3c4d`);
    expect(CF_NAME.length).toBeLessThanOrEqual(63);
    expect(placementOfVmName(CF_NAME)).toBe("cloudflare");
    expect(placementOfVmName(VERCEL_NAME)).toBe("vercel");
    expect(placementOfVmName("cr-canary-1a2b3c4d")).toBe("vercel");
    const tags = {
      app: "code-reviewer",
      kind: "implementer",
      job: JOB,
      tenant: "reviewer",
    };
    expect(
      shapeOf({ name: CF_NAME, createdAtMs: 0, status: "running", tags }),
    ).toEqual({ kind: "job", jobId: JOB, appId: "reviewer" });
    expect(
      shapeOf({ name: VERCEL_NAME, createdAtMs: 0, status: "running", tags }),
    ).toEqual({ kind: "job", jobId: JOB, appId: "reviewer" });
  });
});

describe("the placement platform", () => {
  // #1158-P02
  it("creates a VM where the options say, Vercel without a placement", async () => {
    const { vercel, fake, platform } = setup();

    await platform.create(options(VERCEL_NAME));
    await platform.create(options(CF_NAME, "cloudflare"));

    expect([...fake.vms.keys()]).toEqual([CF_NAME]);
    expect(vercel.requestText()).toContain(VERCEL_NAME);
    expect(vercel.requestText()).not.toContain(CF_NAME);
  });

  // #1158-P03
  it("reaches the fleet of a VM by its name: stop, delete and the network policy", async () => {
    const { vercel, fake, platform } = setup();
    await platform.create(options(VERCEL_NAME));
    await platform.create(options(CF_NAME, "cloudflare"));

    await platform.setNetworkPolicy(CF_NAME, { allow: ["github.com"] });
    await platform.setNetworkPolicy(VERCEL_NAME, "deny-all");
    expect(
      fake.requests.filter((r) => r.method === "PUT").map((r) => r.path),
    ).toEqual([`/v1/vms/${CF_NAME}/network`]);
    expect(vercel.policies).toEqual([
      { name: VERCEL_NAME, policy: "deny-all" },
    ]);

    await platform.stop(CF_NAME);
    expect(fake.vms.size).toBe(0);
    expect(vercel.requestText()).not.toContain(`stop ${CF_NAME}`);
    await platform.stop(VERCEL_NAME);
    await platform.delete(CF_NAME);
  });

  // #1158-P04
  it("lists both fleets for the reaper", async () => {
    const { platform } = setup();
    await platform.create(options(VERCEL_NAME));
    await platform.create(options(CF_NAME, "cloudflare"));

    const listed = await platform.list({
      namePrefix: `cr-implementer-${JOB}-`,
      tags: { app: "code-reviewer" },
    });

    expect(listed.map((vm) => vm.name).sort()).toEqual(
      [CF_NAME, VERCEL_NAME].sort(),
    );
  });

  // #1158-P05
  it("answers a listing with Vercel's VMs when Cloudflare cannot be listed, and says so in the log with a code and nothing else", async () => {
    const { vercel, fake, platform, logger } = setup();
    await platform.create(options(VERCEL_NAME));
    fake.failNext(503, { error: "unavailable" });

    const listed = await platform.list({
      namePrefix: "cr-",
      tags: { app: "code-reviewer" },
    });

    expect(listed.map((vm) => vm.name)).toEqual([VERCEL_NAME]);
    expect(logger.text()).toContain("cloudflare_list_failed");
    expect(logger.text()).toContain("unavailable");
    void vercel;
  });

  // #1158-P06
  it("fails the listing when Vercel's fails, as it always did, whatever Cloudflare says", async () => {
    const { vercel, platform } = setup();
    vercel.failNextList(new SandboxServiceError("unavailable"));

    await expect(
      platform.list({ namePrefix: "cr-", tags: { app: "code-reviewer" } }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  // #1158-P07
  it("is the Vercel platform itself where Cloudflare is not configured", () => {
    const vercel = new FakeSandboxService();
    expect(createPlacementPlatform({ vercel, logger: recordingLogger() })).toBe(
      vercel,
    );
  });
});
