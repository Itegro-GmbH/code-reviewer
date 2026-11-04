// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import { createResolver, type ProfileInfo } from "./resolver.ts";
import { tiny } from "./test-fixtures.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

// "scribe" changed its push right and its default result between versions: 1 cannot push and answers `answer`, 2 can push and
// answers `report`; 3 is only listed (the document does not name it, so nothing is known about it).
const SCRIBE: ProfileInfo = {
  name: "scribe",
  versions: [1, 2],
  facts: {
    1: {
      canPush: false,
      defaultResult: {
        type: "object",
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
    },
    2: {
      canPush: true,
      defaultResult: {
        type: "object",
        required: ["report"],
        properties: { report: { type: "string" } },
      },
    },
  },
};

const resolver = createResolver({
  environments: [{ name: "node" }],
  profiles: [SCRIBE],
});

/** The tiny workflow whose agent runs `profile` without a result of its own, then comments `body`. */
function document(profile: string, body: string): Json {
  const doc = tiny();
  const [step] = doc.steps as Json[];
  (step as Json).profile = profile;
  delete (step as Json).result;
  (doc.steps as Json[]).push({
    id: "say",
    kind: "action",
    connector: "github.issue.comment",
    issue: 7,
    body,
  });
  return doc;
}

function codes(profile: string, body: string): string[][] {
  return validateWorkflow(document(profile, body), resolver, {
    maxBudgetUsd: 100,
  }).errors.map((e) => [e.path, e.code]);
}

describe("the resolver reads profiles as data", () => {
  // #843-T40
  it("answers with the profiles it was given and nothing built in", () => {
    expect(resolver.profiles()).toEqual([SCRIBE]);
    expect(resolver.connectors()).toBe(BUILT_IN_CONNECTORS);
    const empty = createResolver({ environments: [], profiles: [] });
    expect(empty.profiles()).toEqual([]);
    expect(
      validateWorkflow(tiny(), empty, { maxBudgetUsd: 100 }).errors.map(
        (e) => e.code,
      ),
    ).toContain("profile_unknown");
  });

  // #843-T41
  it("lists the profiles and the versions that exist when the name or version is wrong", () => {
    const result = validateWorkflow(document("scribe@3", "x"), resolver, {
      maxBudgetUsd: 100,
    });
    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/profile",
        code: "profile_version_unknown",
        available: ["1", "2"],
      }),
    ]);
    const unknown = validateWorkflow(document("nobody", "x"), resolver, {
      maxBudgetUsd: 100,
    });
    expect(unknown.errors[0]).toMatchObject({
      code: "profile_unknown",
      available: ["scribe"],
    });
  });

  // #843-T42
  it("takes the push right of the version the step names, and of the newest when it names none", () => {
    expect(codes("scribe@1", "{{work.branch}}")).toEqual([
      ["/steps/1/body", "reference_fact_unavailable"],
    ]);
    expect(codes("scribe@2", "{{work.branch}}")).toEqual([]);
    // No version: the newest, which may push.
    expect(codes("scribe", "{{work.branch}}")).toEqual([]);
  });

  // #843-T43
  it("takes the default result schema of the version the step names", () => {
    expect(codes("scribe@1", "{{work.answer}}")).toEqual([]);
    expect(codes("scribe@1", "{{work.report}}")).toEqual([
      ["/steps/1/body", "reference_unknown_field"],
    ]);
    expect(codes("scribe@2", "{{work.report}}")).toEqual([]);
    expect(codes("scribe", "{{work.answer}}")).toEqual([
      ["/steps/1/body", "reference_unknown_field"],
    ]);
  });

  // #843-T44
  it("lets a result the step declares win over the default of the profile", () => {
    const doc = document("scribe@1", "{{work.summary}}");
    ((doc.steps as Json[])[0] as Json).result = {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    };
    expect(
      validateWorkflow(doc, resolver, { maxBudgetUsd: 100 }).errors,
    ).toEqual([]);
  });

  // #843-T45
  it("does not guess the facts of a version it was given none for: the step may push and has no default", () => {
    const partial = createResolver({
      environments: [{ name: "node" }],
      profiles: [{ name: "scribe", versions: [1, 2], facts: {} }],
    });
    const result = validateWorkflow(
      document("scribe@1", "{{work.branch}}"),
      partial,
      { maxBudgetUsd: 100 },
    );
    expect(result.errors).toEqual([]);
  });
});
