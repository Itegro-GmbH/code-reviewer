// SPDX-License-Identifier: LicenseRef-Proprietary

import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { applyOverrides, assertHardenedSpec } from "./container.ts";
import {
  IMPLEMENTER_CONTAINER_SPEC,
  SANDBOX_LAUNCHER_ADDITIONS,
  WORKER_CONTAINER_SPEC,
} from "./container-spec.ts";

function example(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        `../../../contracts/examples/worker-container/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

describe("the spec the launcher ships", () => {
  // #325-T02
  it("equals the example spec of the contract, which equals both compose files", () => {
    expect(WORKER_CONTAINER_SPEC).toEqual(example("WorkerContainerSpec"));
  });

  // #325-T02
  it("is hardened", () => {
    expect(() => assertHardenedSpec(WORKER_CONTAINER_SPEC)).not.toThrow();
  });

  // #325-T05
  it("accepts the example overrides of the contract", () => {
    const overrides = example("WorkerContainerOverrides");

    expect(
      applyOverrides(WORKER_CONTAINER_SPEC, overrides as never).memory,
    ).toEqual({ limit: "1536m", reservation: "1280m", swap: "1536m" });
  });

  // #325-T08
  it("ships the Sandbox additions of the contract: the two IPv6 switches, nothing more", () => {
    expect(SANDBOX_LAUNCHER_ADDITIONS).toEqual(
      example("WorkerContainerLauncherAdditions"),
    );
    // The shared spec itself has no sysctl: the self-hosted compose files carry none.
    expect(WORKER_CONTAINER_SPEC).not.toHaveProperty("sysctls");
  });
});

describe("the implementer profile the launcher ships", () => {
  // #760-T01
  it("equals the example profile of the contract and is hardened", () => {
    expect(IMPLEMENTER_CONTAINER_SPEC).toEqual(
      example("ImplementerContainerSpec"),
    );
    expect(() => assertHardenedSpec(IMPLEMENTER_CONTAINER_SPEC)).not.toThrow();
  });

  // #760-T01
  it("differs from the default spec in exactly the work volume, the memory, the pids limit and the environment names", () => {
    const keys = new Set([
      ...Object.keys(WORKER_CONTAINER_SPEC),
      ...Object.keys(IMPLEMENTER_CONTAINER_SPEC),
    ]);
    const differing = [...keys].filter(
      (key) =>
        !isDeepStrictEqual(
          (WORKER_CONTAINER_SPEC as unknown as Record<string, unknown>)[key],
          (IMPLEMENTER_CONTAINER_SPEC as unknown as Record<string, unknown>)[
            key
          ],
        ),
    );

    expect(differing.sort()).toStrictEqual([
      "allowedEnvironment",
      "memory",
      "pids",
      "workVolume",
    ]);
    expect(IMPLEMENTER_CONTAINER_SPEC.pids).toStrictEqual({ limit: 2048 });
    expect(IMPLEMENTER_CONTAINER_SPEC.workVolume).toStrictEqual({
      path: "/work",
      options: ["rw", "nosuid", "nodev"],
      source: "named-volume",
    });
    // The default list is kept whole; the profile adds the three names of the Implementer to it.
    expect(IMPLEMENTER_CONTAINER_SPEC.allowedEnvironment).toStrictEqual([
      ...WORKER_CONTAINER_SPEC.allowedEnvironment,
      "RUNNER_IMPLEMENTER_WORK_DIR",
      "RUNNER_IMPLEMENTER_EGRESS_PORT",
      "RUNNER_IMPLEMENTER_NETWORK",
    ]);
  });

  // #760-T01
  it("keeps the floor of the default spec for every field it does not change", () => {
    for (const key of [
      "user",
      "capDrop",
      "capAdd",
      "securityOpt",
      "readOnly",
      "tmpfs",
      "network",
      "forbiddenKeys",
      "overridable",
    ] as const)
      expect(IMPLEMENTER_CONTAINER_SPEC[key]).toStrictEqual(
        WORKER_CONTAINER_SPEC[key],
      );
  });
});
