// SPDX-License-Identifier: LicenseRef-Proprietary

// The Cloudflare placement from the environment (#1158): `CF_SANDBOX_URL`, `CF_SANDBOX_TOKEN` and `CF_SANDBOX_INSTANCE_TYPES`, all three or none; with none the Dispatcher
// is as it was and never names `placement_cloudflare`. The Worker's health is read for the claim features and cached briefly.
import { describe, expect, it } from "vitest";
import { FakeCfSandbox } from "../../../fakes/cf-sandbox/service.ts";
import { ConfigError } from "../config.ts";
import {
  CLOUDFLARE_HEALTH_FAILURE_TTL_MS,
  CLOUDFLARE_HEALTH_TTL_MS,
  cloudflareFromEnvironment,
} from "./cloudflare-env.ts";

const TOKEN = "t".repeat(40);
const ENV = {
  CF_SANDBOX_URL: "https://cr-sandbox.example.workers.dev",
  CF_SANDBOX_TOKEN: TOKEN,
  CF_SANDBOX_INSTANCE_TYPES: "4=standard-4",
};

function refusal(env: Record<string, string>): ConfigError {
  try {
    cloudflareFromEnvironment(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("the configuration was expected to be refused");
}

describe("the Cloudflare placement's configuration", () => {
  // #1158-E01
  it("is off when none of the three variables is set: no client, nothing named", () => {
    expect(cloudflareFromEnvironment({})).toBeUndefined();
    expect(
      cloudflareFromEnvironment({
        CF_SANDBOX_URL: " ",
        CF_SANDBOX_TOKEN: "",
      }),
    ).toBeUndefined();
  });

  // #1158-E02
  it.each(["CF_SANDBOX_URL", "CF_SANDBOX_TOKEN", "CF_SANDBOX_INSTANCE_TYPES"])(
    "refuses to start with %s missing: one without the others is a mistake, not off",
    (missing) => {
      const env: Record<string, string> = { ...ENV };
      delete env[missing];
      const error = refusal(env);
      expect(error.variable).toBe(missing);
      expect(error.reason).toBe("required");
    },
  );

  // #1158-E03
  it.each<[string, Record<string, string>, string]>([
    [
      "a plain http address",
      { CF_SANDBOX_URL: "http://cr-sandbox.example" },
      "CF_SANDBOX_URL",
    ],
    [
      "an address with a path",
      { CF_SANDBOX_URL: "https://cr-sandbox.example/v1" },
      "CF_SANDBOX_URL",
    ],
    [
      "an address with credentials",
      { CF_SANDBOX_URL: "https://user:pw@cr-sandbox.example" },
      "CF_SANDBOX_URL",
    ],
    [
      "an address with a query",
      { CF_SANDBOX_URL: "https://cr-sandbox.example?x=1" },
      "CF_SANDBOX_URL",
    ],
    [
      "an address that is none",
      { CF_SANDBOX_URL: "cr-sandbox.example" },
      "CF_SANDBOX_URL",
    ],
    [
      "a token under 32 characters",
      { CF_SANDBOX_TOKEN: "short" },
      "CF_SANDBOX_TOKEN",
    ],
    [
      "a token with a space",
      { CF_SANDBOX_TOKEN: `${"t".repeat(20)} ${"t".repeat(20)}` },
      "CF_SANDBOX_TOKEN",
    ],
    [
      "a size that is no pair",
      { CF_SANDBOX_INSTANCE_TYPES: "standard-4" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "a size no environment may name",
      { CF_SANDBOX_INSTANCE_TYPES: "1=lite" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "a size twice",
      { CF_SANDBOX_INSTANCE_TYPES: "4=standard-4,4=standard-5" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "an instance type that is spelled wrong",
      { CF_SANDBOX_INSTANCE_TYPES: "4=Standard 4" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "an empty entry",
      { CF_SANDBOX_INSTANCE_TYPES: "4=standard-4,," },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "a memory that is no number",
      { CF_SANDBOX_INSTANCE_TYPES: "8=custom-8:big" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "an empty memory",
      { CF_SANDBOX_INSTANCE_TYPES: "8=custom-8:" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "a memory twice",
      { CF_SANDBOX_INSTANCE_TYPES: "8=custom-8:32768:32768" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "a memory below the 1024 MiB the agent needs alone",
      { CF_SANDBOX_INSTANCE_TYPES: "8=custom-8:512" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "a memory with a unit",
      { CF_SANDBOX_INSTANCE_TYPES: "8=custom-8:32GiB" },
      "CF_SANDBOX_INSTANCE_TYPES",
    ],
    [
      "a Sysbox proof that is none",
      { CF_SANDBOX_SYSBOX_PROOF: "maybe" },
      "CF_SANDBOX_SYSBOX_PROOF",
    ],
  ])(
    "refuses %s, naming the variable and never the value",
    (_name, overrides, variable) => {
      const error = refusal({ ...ENV, ...overrides });
      expect(error.variable).toBe(variable);
      expect(error.reason).toBe("invalid");
      expect(error.message).not.toContain(TOKEN);
    },
  );

  // #1158-E04
  it("reads the sizes with their instance types, the token as a secret, and `proven` as the Sysbox verdict unless it says otherwise", () => {
    const cloudflare = cloudflareFromEnvironment({
      ...ENV,
      CF_SANDBOX_INSTANCE_TYPES: " 8 = custom-8 , 4=standard-4 ",
    });

    expect(cloudflare?.placement.sizes).toEqual([4, 8]);
    expect(cloudflare?.placement.sysboxProof).toBe("proven");
    expect(cloudflare?.secrets).toEqual([TOKEN]);
    expect(
      cloudflareFromEnvironment({ ...ENV, CF_SANDBOX_SYSBOX_PROOF: "unproven" })
        ?.placement.sysboxProof,
    ).toBe("unproven");
  });
});

describe("the memory of the instance types (#1178)", () => {
  const memoryOf = (types: string) =>
    cloudflareFromEnvironment({ ...ENV, CF_SANDBOX_INSTANCE_TYPES: types })
      ?.placement.memoryMb;

  // #1178-E01
  it("knows the memory of standard-4 (12 GiB) so that the form `4=standard-4` stays valid and unchanged", () => {
    expect(memoryOf("4=standard-4")).toEqual(new Map([[4, 12288]]));
  });

  // #1178-E02
  it("takes the memory of a custom type from the `:<MiB>` after its name, next to the built-in type", () => {
    expect(memoryOf("4=standard-4, 8=custom-8:32768")).toEqual(
      new Map([
        [4, 12288],
        [8, 32768],
      ]),
    );
  });

  // #1178-E03
  it("lets the memory of an entry win over the built-in table", () => {
    expect(memoryOf("4=standard-4:10240")).toEqual(new Map([[4, 10240]]));
  });

  // #1178-E04
  it("plans a custom type without a memory (the form of before #1178) with the 2048 MiB per vCPU of the Vercel ratio, the cautious value", () => {
    expect(memoryOf("8=custom-8")).toEqual(new Map([[8, 16384]]));
  });

  // #1178-E05
  it("does not put the memory into the instance type the Worker is asked for", async () => {
    const fake = new FakeCfSandbox({
      token: TOKEN,
      instanceTypes: ["custom-8"],
    });
    const cloudflare = cloudflareFromEnvironment(
      { ...ENV, CF_SANDBOX_INSTANCE_TYPES: "8=custom-8:32768" },
      { fetch: fake.fetch },
    );
    await cloudflare?.client.create({
      name: "cr-implementer-x-cf-00000000",
      placement: "cloudflare",
      snapshotId: "cloudflare-image",
      region: "cloudflare",
      vcpus: 8,
      timeoutMs: 60_000,
      tags: {},
      persistent: false,
    });
    expect([...fake.vms.values()][0]?.instanceType).toBe("custom-8");
  });
});

describe("the health of the Worker, cached", () => {
  function setup(options: ConstructorParameters<typeof FakeCfSandbox>[0]) {
    const fake = new FakeCfSandbox(options);
    let now = 1_000_000;
    const cloudflare = cloudflareFromEnvironment(ENV, {
      fetch: fake.fetch,
      now: () => now,
    });
    if (cloudflare === undefined) throw new Error("not configured");
    return {
      fake,
      cloudflare,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }
  const calls = (fake: FakeCfSandbox) =>
    fake.requests.filter((r) => r.path === "/health").length;

  // #1158-E10
  it("is read once for as long as the answer is fresh, and again after that", async () => {
    const { fake, cloudflare, advance } = setup({ token: TOKEN });

    await cloudflare.health();
    await cloudflare.health();
    expect(calls(fake)).toBe(1);
    advance(CLOUDFLARE_HEALTH_TTL_MS + 1);
    await cloudflare.health();
    expect(calls(fake)).toBe(2);
  });

  // #1158-E11
  it("is undefined while the Worker does not answer, remembered for a short while so a claim does not wait for a Worker that is down every time", async () => {
    const { fake, cloudflare, advance } = setup({ token: TOKEN });
    fake.healthDown();

    expect(await cloudflare.health()).toBeUndefined();
    expect(await cloudflare.health()).toBeUndefined();
    expect(calls(fake)).toBe(1);
    fake.healthDown(false);
    advance(CLOUDFLARE_HEALTH_FAILURE_TTL_MS + 1);
    expect(await cloudflare.health()).toMatchObject({ ok: true });
  });

  // #1158-E12
  it("is unusable without an image id or without any instance type the Dispatcher is configured with: then it is undefined and the placement is not named", async () => {
    const noImage = setup({ token: TOKEN, workerImageId: null });
    expect(await noImage.cloudflare.health()).toBeUndefined();

    const otherTypes = setup({ token: TOKEN, instanceTypes: ["standard-1"] });
    expect(await otherTypes.cloudflare.health()).toBeUndefined();
  });

  // #1158-E13
  it("gives the claim features: the placement and the image features both images list, nothing of the placement while the Worker is unusable", async () => {
    const { fake, cloudflare } = setup({
      token: TOKEN,
      workerFeatures: ["implementer_workspace_token"],
    });
    const features = cloudflare.claimFeatures([
      "implementer_multi_repo",
      "implementer_workspace_token",
    ]);

    expect(await features()).toEqual([
      "implementer_workspace_token",
      "placement_cloudflare",
    ]);
    fake.healthDown();
    // Fresh in the cache: still the same answer; once it is stale and the Worker is down, the placement is gone.
  });

  // #1158-E14
  it("names no placement when the Worker is down, with every Vercel feature kept", async () => {
    const { fake, cloudflare } = setup({ token: TOKEN });
    fake.healthDown();

    expect(
      await cloudflare.claimFeatures(["implementer_multi_repo"])(),
    ).toEqual(["implementer_multi_repo"]);
  });
});
