// SPDX-License-Identifier: LicenseRef-Proprietary

// The hosted runners (#1105, ADR 0007, decisions 5 and 16): the types are the sizes the platform offers an environment, read from
// contracts/environment-sizes.v1.json (not written a second time), and the concurrency the operator may set for the first rows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_VCPUS } from "../implementer/environments/limits.ts";
import {
  HOSTED_RUNNER_CONCURRENCY_MAX,
  HOSTED_RUNNER_DEFAULT_CONCURRENCY,
  HOSTED_RUNNER_VCPUS,
  cloudflareRunnerVcpus,
  hostedRunnerDefaultConcurrency,
  hostedRunnerName,
  isHostedConcurrency,
} from "./hosted.ts";

const sizes = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "contracts",
      "environment-sizes.v1.json",
    ),
    "utf8",
  ),
) as { environmentVcpus: number[] };

describe("the hosted runner types", () => {
  // #1105-R60
  it("are the sizes an environment may name in contracts/environment-sizes.v1.json: 2, 4, 6 and 8 vCPU, never 1", () => {
    expect([...HOSTED_RUNNER_VCPUS]).toEqual(sizes.environmentVcpus);
    expect([...HOSTED_RUNNER_VCPUS]).toEqual([...ENVIRONMENT_VCPUS]);
    expect([...HOSTED_RUNNER_VCPUS]).toEqual([2, 4, 6, 8]);
  });

  // #1105-R61
  it("are named by their size", () => {
    expect(HOSTED_RUNNER_VCPUS.map((vcpus) => hostedRunnerName(vcpus))).toEqual(
      [
        "Vercel Sandbox 2 vCPU",
        "Vercel Sandbox 4 vCPU",
        "Vercel Sandbox 6 vCPU",
        "Vercel Sandbox 8 vCPU",
      ],
    );
  });

  // #1105-R62
  it("start with the concurrency the operator set when it is a whole number from 1 to the bound, and with 2 otherwise", () => {
    expect(hostedRunnerDefaultConcurrency({})).toBe(
      HOSTED_RUNNER_DEFAULT_CONCURRENCY,
    );
    expect(HOSTED_RUNNER_DEFAULT_CONCURRENCY).toBe(2);
    const set = (value: string) =>
      hostedRunnerDefaultConcurrency({
        HOSTED_RUNNER_DEFAULT_CONCURRENCY: value,
      });
    expect(set("5")).toBe(5);
    expect(set(" 7 ")).toBe(7);
    expect(set(String(HOSTED_RUNNER_CONCURRENCY_MAX))).toBe(
      HOSTED_RUNNER_CONCURRENCY_MAX,
    );
    for (const bad of ["0", "-1", "2.5", "many", "", "1e3", "101", "0x5"])
      expect(set(bad)).toBe(HOSTED_RUNNER_DEFAULT_CONCURRENCY);
  });

  it("holds a concurrency to a whole number from 1 to the bound", () => {
    expect(isHostedConcurrency(1)).toBe(true);
    expect(isHostedConcurrency(HOSTED_RUNNER_CONCURRENCY_MAX)).toBe(true);
    for (const bad of [
      0,
      -1,
      1.5,
      HOSTED_RUNNER_CONCURRENCY_MAX + 1,
      "2",
      null,
    ])
      expect(isHostedConcurrency(bad)).toBe(false);
  });
});

describe("the Cloudflare placement of the hosted runners (#1158)", () => {
  it("names a type by its placement and size, and keeps the name of a Vercel one", () => {
    expect(hostedRunnerName(4, "cloudflare")).toBe(
      "Cloudflare Container 4 vCPU",
    );
    expect(hostedRunnerName(4, "vercel")).toBe("Vercel Sandbox 4 vCPU");
    expect(hostedRunnerName(4)).toBe("Vercel Sandbox 4 vCPU");
  });

  it("has no size until the operator enables one: CLOUDFLARE_RUNNER_SIZES unset or empty is the placement off", () => {
    expect(cloudflareRunnerVcpus({})).toEqual([]);
    expect(cloudflareRunnerVcpus({ CLOUDFLARE_RUNNER_SIZES: "" })).toEqual([]);
    expect(cloudflareRunnerVcpus({ CLOUDFLARE_RUNNER_SIZES: "  " })).toEqual(
      [],
    );
  });

  it("reads a comma list of sizes of the platform, smallest first, each once", () => {
    const sizesOf = (value: string) =>
      cloudflareRunnerVcpus({ CLOUDFLARE_RUNNER_SIZES: value });
    expect(sizesOf("4")).toEqual([4]);
    expect(sizesOf(" 8 , 4,4")).toEqual([4, 8]);
    expect(sizesOf("2,4,6,8")).toEqual([2, 4, 6, 8]);
  });

  it("ignores what is no size an environment may name, so a typo or a size nobody offers enables nothing", () => {
    const sizesOf = (value: string) =>
      cloudflareRunnerVcpus({ CLOUDFLARE_RUNNER_SIZES: value });
    expect(sizesOf("1")).toEqual([]);
    expect(sizesOf("3,four,,4.5,-4,0x4,16")).toEqual([]);
    expect(sizesOf("4,nope")).toEqual([4]);
  });
});
