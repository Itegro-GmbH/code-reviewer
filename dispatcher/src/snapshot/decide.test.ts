// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { decide, type DecideDeps } from "./decide.ts";
import { IMAGE_INPUT_PATHS, type SnapshotPair } from "./pair.ts";

const OLD = "1".repeat(40);
const NEW = "2".repeat(40);
const PAIR: SnapshotPair = {
  snapshotId: "snap_example01",
  imageDigest: `sha256:${"a".repeat(64)}`,
  commit: OLD,
  sysbox: "proven",
};

function deps(overrides: Partial<DecideDeps> = {}): DecideDeps & {
  asked: Array<{ from: string; to: string; paths: readonly string[] }>;
} {
  const asked: Array<{ from: string; to: string; paths: readonly string[] }> =
    [];
  return {
    asked,
    live: () => Promise.resolve(undefined),
    projectPair: () => PAIR,
    projectSnapshotId: () => PAIR.snapshotId,
    snapshotExists: () => Promise.resolve("yes"),
    commitKnown: () => Promise.resolve(true),
    changed: (from, to, paths) => {
      asked.push({ from, to, paths });
      return Promise.resolve(false);
    },
    ...overrides,
  };
}

describe("whether the snapshot of the pair still exists", () => {
  // #403-T21
  it("rebuilds when the snapshot of a pair that would be reused is gone (a rollback past the previous one, a snapshot deleted by hand)", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ snapshotExists: () => Promise.resolve("no") }),
    });

    expect(decision).toMatchObject({
      rebuild: true,
      reason: "snapshot_missing",
    });
    expect(decision.pair).toBeUndefined();
    expect(decision.repair).toBe(false);
  });

  // #403-T21
  it("stops the run, and does not guess, when the platform cannot say whether the snapshot exists", async () => {
    await expect(
      decide({
        sha: NEW,
        force: false,
        deps: deps({ snapshotExists: () => Promise.resolve("unavailable") }),
      }),
    ).rejects.toThrow(/snapshot_lookup_failed/);
  });

  // #403-T21
  it("asks only about a pair it is about to reuse: a rebuild needs no answer", async () => {
    let asked = 0;
    const count = () => {
      asked += 1;
      return Promise.resolve("yes" as const);
    };
    await decide({
      sha: NEW,
      force: true,
      deps: deps({ snapshotExists: count }),
    });
    await decide({
      sha: NEW,
      force: false,
      deps: deps({
        changed: () => Promise.resolve(true),
        snapshotExists: count,
      }),
    });
    expect(asked).toBe(0);
  });

  // #403-T21
  it("stops the run when the live deployment cannot be read, rather than decide from stale variables", async () => {
    await expect(
      decide({
        sha: NEW,
        force: false,
        deps: deps({
          live: () => Promise.reject(new Error("live_pair_unavailable")),
        }),
      }),
    ).rejects.toThrow(/live_pair_unavailable/);
  });
});

describe("a pair set up by hand, before the pipeline", () => {
  // #403-T21
  it("keeps the snapshot of an incomplete pair as the one to keep, so that the first cleanup does not delete what the previous deployment runs", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({
        projectPair: () => undefined,
        projectSnapshotId: () => "snap_by_hand01",
      }),
    });

    expect(decision).toMatchObject({
      rebuild: true,
      reason: "pair_missing",
      previousSnapshotId: "snap_by_hand01",
    });
  });

  // #403-T21
  it("has nothing to keep on a first deployment", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({
        projectPair: () => undefined,
        projectSnapshotId: () => undefined,
      }),
    });

    expect(decision.previousSnapshotId).toBeUndefined();
  });
});

describe("whether the snapshot has to be rebuilt", () => {
  // #403-T13
  it("reuses the pair when no input of the Worker image changed since its commit", async () => {
    const d = deps();

    const decision = await decide({ sha: NEW, force: false, deps: d });

    expect(decision).toEqual({
      rebuild: false,
      reason: "inputs_unchanged",
      pair: PAIR,
      previousSnapshotId: PAIR.snapshotId,
      repair: false,
    });
    expect(d.asked).toEqual([{ from: OLD, to: NEW, paths: IMAGE_INPUT_PATHS }]);
  });

  // #403-T13
  it("rebuilds when an input of the Worker image changed", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ changed: () => Promise.resolve(true) }),
    });

    expect(decision).toMatchObject({ rebuild: true, reason: "inputs_changed" });
    expect(decision.pair).toBeUndefined();
    // The pair that production runs now is the one to keep next to the new one.
    expect(decision.previousSnapshotId).toBe(PAIR.snapshotId);
  });

  // #403-T13
  it("rebuilds when the commit of the pair is not in this clone", async () => {
    const d = deps({ commitKnown: () => Promise.resolve(false) });

    const decision = await decide({ sha: NEW, force: false, deps: d });

    expect(decision).toMatchObject({ rebuild: true, reason: "commit_unknown" });
    expect(d.asked).toEqual([]);
  });

  // #403-T13
  it("rebuilds when no complete pair is configured (the first deployment, or a value that is missing)", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({
        projectPair: () => undefined,
        projectSnapshotId: () => undefined,
      }),
    });

    expect(decision).toMatchObject({ rebuild: true, reason: "pair_missing" });
    expect(decision.previousSnapshotId).toBeUndefined();
  });

  // #403-T13
  it("rebuilds when asked to, without looking at the inputs", async () => {
    const d = deps();

    const decision = await decide({ sha: NEW, force: true, deps: d });

    expect(decision).toMatchObject({ rebuild: true, reason: "forced" });
    expect(decision.previousSnapshotId).toBe(PAIR.snapshotId);
    expect(d.asked).toEqual([]);
  });

  // #403-T13
  it("stops the run, and does not guess, when the inputs cannot be compared", async () => {
    await expect(
      decide({
        sha: NEW,
        force: false,
        deps: deps({ changed: () => Promise.reject(new Error("git failed")) }),
      }),
    ).rejects.toThrow();
  });

  // #403-T13
  it("trusts the live deployment over the variables when they differ, and asks for the variables to be repaired", async () => {
    const livePair: SnapshotPair = {
      snapshotId: "snap_example02",
      imageDigest: `sha256:${"b".repeat(64)}`,
      commit: NEW,
      sysbox: "proven",
    };
    const d = deps({ live: () => Promise.resolve(livePair) });

    const decision = await decide({ sha: NEW, force: false, deps: d });

    // A run that promoted and then could not write the variables left them behind: the live pair is the truth.
    expect(decision).toEqual({
      rebuild: false,
      reason: "inputs_unchanged",
      pair: livePair,
      previousSnapshotId: livePair.snapshotId,
      repair: true,
    });
    expect(d.asked[0]).toMatchObject({ from: NEW, to: NEW });
  });

  // #403-T13
  it("does not ask for a repair when the live deployment and the variables agree", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ live: () => Promise.resolve(PAIR) }),
    });

    expect(decision.repair).toBe(false);
  });

  // #403-T13
  it("falls back to the variables when the live deployment carries no pair (a deployment made by hand)", async () => {
    const decision = await decide({
      sha: NEW,
      force: false,
      deps: deps({ live: () => Promise.resolve(undefined) }),
    });

    expect(decision).toMatchObject({
      rebuild: false,
      pair: PAIR,
      previousSnapshotId: PAIR.snapshotId,
      repair: false,
    });
  });
});
