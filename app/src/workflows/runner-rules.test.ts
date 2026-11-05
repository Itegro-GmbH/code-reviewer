// SPDX-License-Identifier: LicenseRef-Proprietary

// What a profile and an environment can only do together (#854): a managed model has no place in an environment that runs on a
// runner (a runner works with the workspace's own key), and a harness that is not OpenCode runs only on a runner.
import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import type { ProfileInfo, WorkflowResolver } from "./resolver.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const RESOLVER: WorkflowResolver = {
  profiles: (): readonly ProfileInfo[] => [
    {
      name: "managed",
      versions: [1],
      facts: { 1: { canPush: true, managedModel: true } },
    },
    {
      name: "own",
      versions: [1],
      facts: { 1: { canPush: true, managedModel: false } },
    },
    {
      name: "exotic",
      versions: [1],
      facts: {
        1: { canPush: true, managedModel: false, harness: "claude-code" },
      },
    },
    // Facts that were not read are not known: nothing is refused on a guess.
    { name: "unread", versions: [1], facts: {} },
  ],
  environments: () => [
    { name: "vm", kind: "hosted" },
    { name: "plain" },
    { name: "box", kind: "runner" },
  ],
  connectors: () => BUILT_IN_CONNECTORS,
};

function workflow(profile: string, environment: string): Json {
  return {
    version: 1,
    name: "Rules",
    trigger: { kind: "github.issueLabeled", label: "ready" },
    budgetUsd: 5,
    steps: [
      {
        id: "work",
        kind: "agent",
        profile,
        environment,
        instruction: "Do it.",
      },
    ],
  };
}

function codes(profile: string, environment: string): string[][] {
  return validateWorkflow(workflow(profile, environment), RESOLVER).errors.map(
    (e) => [e.path, e.code],
  );
}

describe("a managed model and an environment that runs on a runner (#854)", () => {
  // #854-T170
  it("is refused where the environment is written", () => {
    expect(codes("managed", "box")).toEqual([
      ["/steps/0/environment", "runner_needs_own_key"],
    ]);
  });

  // #854-T171
  it("is fine on a platform VM, and a model of the workspace's own key is fine on a runner", () => {
    expect(codes("managed", "vm")).toEqual([]);
    expect(codes("managed", "plain")).toEqual([]);
    expect(codes("own", "box")).toEqual([]);
  });

  // #854-T172
  it("takes the environment's name without regard to case, as the rest of the validator does", () => {
    expect(codes("managed", "BOX")).toEqual([
      ["/steps/0/environment", "runner_needs_own_key"],
    ]);
  });
});

describe("a harness that is not OpenCode (#854)", () => {
  // #854-T173
  it("is refused on a platform VM and fine on a runner", () => {
    expect(codes("exotic", "vm")).toEqual([
      ["/steps/0/environment", "harness_needs_runner"],
    ]);
    expect(codes("exotic", "plain")).toEqual([
      ["/steps/0/environment", "harness_needs_runner"],
    ]);
    expect(codes("exotic", "box")).toEqual([]);
  });

  // #854-T174
  it("is not guessed when the facts of the version were not read, or the names are unknown", () => {
    expect(codes("unread", "box")).toEqual([]);
    expect(codes("ghost", "box")).toEqual([
      ["/steps/0/profile", "profile_unknown"],
    ]);
    expect(codes("own", "ghost")).toEqual([
      ["/steps/0/environment", "environment_unknown"],
    ]);
  });
});
