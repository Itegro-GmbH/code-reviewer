// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { profileInfosOf, profileRefsIn } from "./profile-refs.ts";
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
});
