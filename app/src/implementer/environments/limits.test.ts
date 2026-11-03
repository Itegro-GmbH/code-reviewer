// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_MEMORY_MB,
  DEFAULT_VCPUS,
  ENVIRONMENT_NAME_MAX_LENGTH,
  ENVIRONMENT_VCPUS,
  MEMORY_PER_VCPU_MB,
  MIN_AGENT_MEMORY_MB,
  isEnvironmentVcpus,
  SETUP_SCRIPT_MAX_BYTES,
  SETUP_SCRIPT_TIMEOUT_SECONDS,
  memoryGbOf,
} from "./limits.ts";
import { AGENT_MEMORY_GB } from "../../runs/run-view.ts";

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
  environmentVcpus: number[];
  minAgentMemoryMb: number;
  memoryGuard: { minFloorMb: number; floorPercent: number };
  agentMemoryMb: Record<string, number>;
  memoryPerVcpuMb: number;
  defaultVcpus: number;
  setupScript: { maxBytes: number; timeoutSeconds: number };
};

describe("the sizes and limits of an environment", () => {
  // #818-T01
  it("equal the contract file the Dispatcher is held to as well", () => {
    expect([...ENVIRONMENT_VCPUS]).toEqual(SIZES.environmentVcpus);
    expect(AGENT_MEMORY_MB).toEqual(
      Object.fromEntries(
        Object.entries(SIZES.agentMemoryMb).map(([k, v]) => [Number(k), v]),
      ),
    );
    expect(MIN_AGENT_MEMORY_MB).toBe(SIZES.minAgentMemoryMb);
    expect(MEMORY_PER_VCPU_MB).toBe(SIZES.memoryPerVcpuMb);
    expect(DEFAULT_VCPUS).toBe(SIZES.defaultVcpus);
    expect(SETUP_SCRIPT_MAX_BYTES).toBe(SIZES.setupScript.maxBytes);
    expect(SETUP_SCRIPT_TIMEOUT_SECONDS).toBe(SIZES.setupScript.timeoutSeconds);
  });

  // #745-T06: the run page keeps its own copy of the GB (it is below the Implementer), and it is the figure the form shows
  it("show the same GB on the run page as in the form, for every size of the platform", () => {
    for (const vcpus of [1, ...ENVIRONMENT_VCPUS])
      expect(AGENT_MEMORY_GB[vcpus]).toBe(memoryGbOf(vcpus));
    expect(SIZES.memoryGuard).toEqual({ minFloorMb: 512, floorPercent: 8 });
  });

  // #818-T01
  it("state the decisions of the issue: 64 KB, 15 minutes, 2 GB per vCPU and the standard of 2 vCPU", () => {
    expect(SETUP_SCRIPT_MAX_BYTES).toBe(64 * 1024);
    expect(SETUP_SCRIPT_TIMEOUT_SECONDS).toBe(15 * 60);
    // The memory shown is the agent's: what the VM has left after the OS, Control, the model door, the network door, the readers and the memory guard's floor.
    expect(ENVIRONMENT_VCPUS.map(memoryGbOf)).toEqual([1.9, 5.7, 9.4, 13.1]);
    expect(DEFAULT_VCPUS).toBe(2);
    expect(ENVIRONMENT_NAME_MAX_LENGTH).toBeGreaterThan(0);
  });

  // #818-T02
  it("offer only the sizes that leave the agent enough memory, and 1 vCPU is not one of them", () => {
    for (const vcpus of ENVIRONMENT_VCPUS)
      expect(AGENT_MEMORY_MB[vcpus]).toBeGreaterThanOrEqual(
        MIN_AGENT_MEMORY_MB,
      );
    expect(AGENT_MEMORY_MB[1]).toBeLessThan(MIN_AGENT_MEMORY_MB);
    expect(isEnvironmentVcpus(1)).toBe(false);
    expect(isEnvironmentVcpus(3)).toBe(false);
    expect(isEnvironmentVcpus(2)).toBe(true);
    expect(memoryGbOf(1)).toBe(0);
  });
});
