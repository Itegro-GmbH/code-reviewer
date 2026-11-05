// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  PROFILE_REFS_MAX,
  profileInfosOf,
  profileRefsIn,
} from "./profile-refs.ts";
import { tiny } from "./test-fixtures.ts";

describe("the profiles a workflow document names", () => {
  // #843-T130
  it("finds the name and the version of every agent step, inside branches and loop bodies too", () => {
    const doc = {
      steps: [
        { id: "a", kind: "agent", profile: "implementer@2" },
        {
          id: "b",
          kind: "loop",
          body: [{ id: "c", kind: "agent", profile: "reviewer" }],
        },
        {
          id: "d",
          kind: "if",
          then: [{ id: "e", kind: "agent", profile: "implementer@1" }],
          else: [{ id: "f", kind: "agent", profile: "implementer@2" }],
        },
      ],
    };

    const refs = profileRefsIn(doc);

    expect(
      [...refs.entries()].map(([name, v]) => [name, [...v].sort()]),
    ).toEqual([
      ["implementer", [1, 2]],
      ["reviewer", ["latest"]],
    ]);
  });

  // #843-T131
  it("skips what is not a profile reference and never throws on a document of any shape", () => {
    for (const doc of [
      null,
      5,
      "x",
      [],
      {},
      { profile: 3 },
      { profile: "Not Valid" },
      { profile: { a: 1 } },
      { steps: [null, 1, { profile: ["a"] }] },
    ])
      expect(profileRefsIn(doc).size).toBe(0);
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 20_000; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.profile = "deep";
    expect([...profileRefsIn(deep).keys()]).toEqual(["deep"]);
    expect(profileRefsIn(tiny()).has("implementer")).toBe(true);
  });

  // #843-T132
  it("builds the profiles of the resolver: versions 1 to the current one, the facts of the versions the document names and of the newest", () => {
    const refs = profileRefsIn({
      steps: [
        { profile: "scribe@1" },
        { profile: "scribe@9" },
        { profile: "reviewer" },
      ],
    });
    const live = [
      { id: "p-1", name: "scribe", version: 3 },
      { id: "p-2", name: "reviewer", version: 1 },
      { id: "p-3", name: "unnamed", version: 2 },
    ];

    expect(profileInfosOf(live, refs).wanted).toEqual([
      { profileId: "p-1", version: 1 },
      { profileId: "p-1", version: 3 },
      { profileId: "p-2", version: 1 },
    ]);
    const infos = profileInfosOf(live, refs).build([
      { profileId: "p-1", version: 1, canPush: false, defaultResult: null },
      {
        profileId: "p-1",
        version: 3,
        canPush: true,
        defaultResult: '{"type":"object","properties":{}}',
      },
      { profileId: "p-2", version: 1, canPush: false, defaultResult: null },
    ]);
    expect(infos).toEqual([
      {
        name: "scribe",
        versions: [1, 2, 3],
        facts: {
          1: { canPush: false },
          3: {
            canPush: true,
            defaultResult: { type: "object", properties: {} },
          },
        },
      },
      { name: "reviewer", versions: [1], facts: { 1: { canPush: false } } },
      { name: "unnamed", versions: [1, 2], facts: {} },
    ]);
  });

  // #843-T133
  it("reads at most twice the steps a document may hold of distinct references, so a crafted document cannot make the service ask for thousands of versions", () => {
    const crafted = {
      steps: Array.from({ length: 1000 }, (_, i) => ({
        id: `s${i}`,
        kind: "agent",
        profile: `p${i}@${(i % 3) + 1}`,
      })),
    };

    const refs = profileRefsIn(crafted);

    const pairs = [...refs.values()].reduce((sum, v) => sum + v.size, 0);
    expect(PROFILE_REFS_MAX).toBe(100);
    expect(pairs).toBe(PROFILE_REFS_MAX);
    // The same reference twice is one.
    expect(
      profileRefsIn({
        steps: Array.from({ length: 500 }, () => ({ profile: "same@2" })),
      }).get("same"),
    ).toEqual(new Set([2]));
  });

  // #843-T134
  it("lets the resolver know only what was read when the cap was reached: the rest is an unknown profile or version", () => {
    const names = Array.from({ length: 150 }, (_, i) => `p${i}`);
    const refs = profileRefsIn({
      steps: names.map((profile) => ({ profile })),
    });
    const live = names.map((name, i) => ({ id: `id-${i}`, name, version: 2 }));

    const { wanted, build } = profileInfosOf(live, refs);

    expect(wanted.length).toBeLessThanOrEqual(PROFILE_REFS_MAX * 2);
    const infos = build([]);
    expect(infos.length).toBe(refs.size);
    expect(infos.map((info) => info.name).sort()).toEqual(
      [...refs.keys()].sort(),
    );
  });
});
