// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { SnapshotPipelineError } from "./errors.ts";
import { resolveConfig } from "./config.ts";

describe("the pipeline configuration", () => {
  // #330-T01
  it("has the defaults the spike measured: fra1, a 2 vCPU builder, the sandbox target, two snapshots kept", () => {
    const config = resolveConfig();
    expect(config).toMatchObject({
      region: "fra1",
      builderVcpus: 2,
      target: "sandbox",
      dockerfile: "runner/Dockerfile",
      keep: 2,
      requiredEngines: ["pr-agent", "opencode"],
    });
    expect(config.dockerVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("pins Sysbox to a release and its checksum, and the proof's image to a digest", () => {
    const config = resolveConfig();
    expect(config.sysboxVersion).toBe("0.7.1");
    expect(config.sysboxSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(config.sysboxProbeImage).toMatch(/@sha256:[0-9a-f]{64}$/);
  });

  it.each([
    ["dockerVersion", "29.1.3; rm -rf /"],
    ["dockerVersion", "$(id)"],
    ["buildxVersion", "0.30.1 && true"],
    ["target", "sandbox --privileged"],
    ["target", ""],
    ["dockerfile", "../../etc/passwd"],
    ["dockerfile", "runner/Dockerfile'x"],
    ["imageTag", "tag with space"],
    ["probeMemory", "1g;reboot"],
    ["probeMemory", "1g"], // below the reservation of the container spec: the renderer refuses it
    ["sysboxVersion", "0.7.1; reboot"],
    ["sysboxSha256", "9d6d5484"],
    ["sysboxSha256", "G".repeat(64)],
    ["sysboxProbeImage", "docker.io/library/docker:dind"], // a tag is not content: only a digest is accepted
    ["sysboxProbeImage", "docker@sha256:abc"],
    ["keep", 0],
    ["keep", 11],
    ["keep", 1.5],
    ["requiredEngines", []],
    ["requiredEngines", ["opencode;x"]],
    ["pinnedSnapshotIds", ["snap_ok", "bad id"]],
  ])("refuses %s = %j without echoing it", (field, value) => {
    let error: unknown;
    try {
      resolveConfig({ [field]: value } as never);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SnapshotPipelineError);
    const refusal = error as SnapshotPipelineError;
    expect(refusal.code).toBe("configuration_invalid");
    expect(refusal.detail).toEqual([field]);
    if (String(value).length > 1)
      expect(refusal.message).not.toContain(String(value));
  });

  it("accepts a changed target and a snapshot to keep", () => {
    const config = resolveConfig({
      target: "dynamic",
      pinnedSnapshotIds: ["snap_abc123"],
    });
    expect(config.target).toBe("dynamic");
    expect(config.pinnedSnapshotIds).toEqual(["snap_abc123"]);
  });
});
