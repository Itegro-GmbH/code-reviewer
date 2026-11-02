// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VCPUS,
  ENVIRONMENT_NAME_MAX_LENGTH,
  ENVIRONMENT_VCPUS,
  MEMORY_PER_VCPU_MB,
  SETUP_SCRIPT_MAX_BYTES,
  SETUP_SCRIPT_TIMEOUT_SECONDS,
  memoryGbOf,
} from "./limits.ts";

const SIZES = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "contracts",
      "environment-sizes.v1.json",
    ),
    "utf8",
  ),
) as {
  vcpus: number[];
  memoryPerVcpuMb: number;
  defaultVcpus: number;
  setupScript: { maxBytes: number; timeoutSeconds: number };
};

describe("the sizes and limits of an environment", () => {
  // #818-T01
  it("equal the contract file the Dispatcher is held to as well", () => {
    expect([...ENVIRONMENT_VCPUS]).toEqual(SIZES.vcpus);
    expect(MEMORY_PER_VCPU_MB).toBe(SIZES.memoryPerVcpuMb);
    expect(DEFAULT_VCPUS).toBe(SIZES.defaultVcpus);
    expect(SETUP_SCRIPT_MAX_BYTES).toBe(SIZES.setupScript.maxBytes);
    expect(SETUP_SCRIPT_TIMEOUT_SECONDS).toBe(SIZES.setupScript.timeoutSeconds);
  });

  // #818-T01
  it("state the decisions of the issue: 64 KB, 15 minutes, 2 GB per vCPU and the standard of 2 vCPU", () => {
    expect(SETUP_SCRIPT_MAX_BYTES).toBe(64 * 1024);
    expect(SETUP_SCRIPT_TIMEOUT_SECONDS).toBe(15 * 60);
    expect(ENVIRONMENT_VCPUS.map(memoryGbOf)).toEqual([2, 4, 8, 12, 16]);
    expect(DEFAULT_VCPUS).toBe(2);
    expect(ENVIRONMENT_NAME_MAX_LENGTH).toBeGreaterThan(0);
  });
});
