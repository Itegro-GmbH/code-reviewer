// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../snapshot/config.ts";
import type { GoldenRecord } from "../snapshot/record.ts";
import { compareWithHosted } from "./compare.ts";
import type { LocalRecipe } from "./compare.ts";

const WORKER_ID = `sha256:${"a".repeat(64)}`;
const AGENT_ID = `sha256:${"b".repeat(64)}`;

const record: GoldenRecord = {
  version: 1,
  snapshotId: "snap_abc",
  imageDigest: WORKER_ID,
  agentImageDigest: AGENT_ID,
  builtAt: "2026-11-09T10:00:00.000Z",
  region: "fra1",
  target: "sandbox",
};

/** What the local root file system reports, matching the hosted configuration. */
const local: LocalRecipe = {
  dockerd: `${DEFAULT_CONFIG.dockerVersion}-0ubuntu1`,
  buildx: `${DEFAULT_CONFIG.buildxVersion}-0ubuntu1`,
  sysbox: `${DEFAULT_CONFIG.sysboxVersion}-0.linux`,
  sysboxSha256: DEFAULT_CONFIG.sysboxSha256,
  images: {
    worker: { tag: DEFAULT_CONFIG.imageTag, id: WORKER_ID },
    agent: { tag: DEFAULT_CONFIG.agentImageTag, id: AGENT_ID },
  },
};

describe("the version check between the hosted snapshot and the local root file system", () => {
  // #976-T02
  it("finds the same dockerd, buildx, Sysbox and image digests", () => {
    const result = compareWithHosted({ config: DEFAULT_CONFIG, record }, local);

    expect(result.differences).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // #976-T02
  it("names a dockerd that is not the hosted pinned version", () => {
    const result = compareWithHosted(
      { config: DEFAULT_CONFIG, record },
      { ...local, dockerd: "29.2.0-0ubuntu1" },
    );

    expect(result.ok).toBe(false);
    expect(result.differences).toEqual([
      {
        field: "dockerd",
        hosted: DEFAULT_CONFIG.dockerVersion,
        local: "29.2.0-0ubuntu1",
      },
    ]);
  });

  // #976-T02
  it("names a Sysbox of another version and one of another package", () => {
    const result = compareWithHosted(
      { config: DEFAULT_CONFIG, record },
      { ...local, sysbox: "0.7.0-0.linux", sysboxSha256: "f".repeat(64) },
    );

    expect(result.differences.map((d) => d.field)).toEqual([
      "sysbox",
      "sysboxSha256",
    ]);
  });

  // #976-T02
  it("does not take 29.1.30 for 29.1.3: a version matches up to its package revision only", () => {
    const result = compareWithHosted(
      { config: DEFAULT_CONFIG, record },
      { ...local, dockerd: "29.1.30-0ubuntu1" },
    );

    expect(result.ok).toBe(false);
  });

  // #976-T02
  it("names an image that is not the hosted one, as a difference only when images are required", () => {
    const rebuilt = {
      ...local,
      images: {
        ...local.images,
        worker: { ...local.images.worker, id: `sha256:${"c".repeat(64)}` },
      },
    };

    const informational = compareWithHosted(
      { config: DEFAULT_CONFIG, record },
      rebuilt,
    );
    const strict = compareWithHosted(
      { config: DEFAULT_CONFIG, record },
      rebuilt,
      { requireImages: true },
    );

    expect(informational.ok).toBe(true);
    expect(informational.differences).toEqual([]);
    expect(informational.imageDifferences).toEqual([
      { field: "worker", hosted: WORKER_ID, local: `sha256:${"c".repeat(64)}` },
    ]);
    expect(strict.ok).toBe(false);
    expect(strict.differences.map((d) => d.field)).toEqual(["worker"]);
  });

  // #976-T02
  it("compares the agent image only when the hosted record has one (older records have none)", () => {
    const older = { ...record };
    delete older.agentImageDigest;
    const result = compareWithHosted(
      { config: DEFAULT_CONFIG, record: older },
      local,
      { requireImages: true },
    );

    expect(result.ok).toBe(true);
  });

  // #976-T02
  it("fails when the local image carries another tag than the hosted configuration's", () => {
    const result = compareWithHosted(
      { config: DEFAULT_CONFIG, record },
      {
        ...local,
        images: {
          ...local.images,
          agent: { ...local.images.agent, tag: "agent:golden" },
        },
      },
    );

    expect(result.differences.map((d) => d.field)).toEqual(["agentTag"]);
  });
});
