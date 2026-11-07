// SPDX-License-Identifier: LicenseRef-Proprietary

// The environment is part of the profile (#919): an agent step needs none, may name the profile's own, and is refused when it names
// another one. A profile version saved before has no environment, so its step names one as it always did. The two rules of a runner
// (a managed model, a harness other than OpenCode) are checked for the environment the step runs in.
import { describe, expect, it } from "vitest";
import { BUILT_IN_CONNECTORS } from "./connectors.ts";
import type { ProfileInfo, WorkflowResolver } from "./resolver.ts";
import { validateWorkflow } from "./validate.ts";

type Json = Record<string, unknown>;

const RESOLVER: WorkflowResolver = {
  profiles: (): readonly ProfileInfo[] => [
    {
      name: "builder",
      versions: [1],
      facts: {
        1: { canPush: true, managedModel: false, environmentId: "env-vm" },
      },
    },
    {
      name: "laptop-agent",
      versions: [1],
      facts: {
        1: {
          canPush: true,
          managedModel: false,
          harness: "claude-code",
          environmentId: "env-box",
        },
      },
    },
    {
      name: "managed-on-runner",
      versions: [1],
      facts: {
        1: { canPush: true, managedModel: true, environmentId: "env-box" },
      },
    },
    {
      name: "claude-on-vm",
      versions: [1],
      facts: {
        1: {
          canPush: true,
          managedModel: false,
          harness: "claude-code",
          environmentId: "env-vm",
        },
      },
    },
    {
      name: "orphan",
      versions: [1],
      facts: {
        1: { canPush: true, managedModel: false, environmentId: "env-gone" },
      },
    },
    // Saved before profiles had an environment.
    {
      name: "legacy",
      versions: [1],
      facts: { 1: { canPush: true, managedModel: false, environmentId: null } },
    },
    { name: "unread", versions: [1], facts: {} },
  ],
  environments: () => [
    { id: "env-vm", name: "Node", kind: "hosted" },
    { id: "env-box", name: "box", kind: "runner" },
  ],
  connectors: () => BUILT_IN_CONNECTORS,
};

function workflow(profile: string, environment?: string): Json {
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
        ...(environment === undefined ? {} : { environment }),
        instruction: "Do it.",
      },
    ],
  };
}

function check(profile: string, environment?: string) {
  return validateWorkflow(workflow(profile, environment), RESOLVER);
}

function codes(profile: string, environment?: string): string[][] {
  return check(profile, environment).errors.map((e) => [e.path, e.code]);
}

describe("the environment of a step whose profile names one (#919)", () => {
  // #919-T20
  it("is not needed: the step runs where its profile runs", () => {
    expect(codes("builder")).toEqual([]);
    expect(codes("laptop-agent")).toEqual([]);
  });

  // #919-T21
  it("may be written when it is the profile's own, whatever the case", () => {
    expect(codes("builder", "Node")).toEqual([]);
    expect(codes("builder", "node")).toEqual([]);
  });

  // #919-T22
  it("is refused when it is another one, and the profile's is said", () => {
    const result = check("builder", "box");

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/environment",
        code: "environment_mismatch",
        available: ["Node"],
      }),
    ]);
    expect(result.errors[0]?.message).toContain("leave");
  });

  // #919-T23
  it("is refused with the unknown name and the mismatch, so both are fixed in one pass", () => {
    expect(codes("builder", "ghost")).toEqual([
      ["/steps/0/environment", "environment_mismatch"],
      ["/steps/0/environment", "environment_unknown"],
    ]);
  });

  // #919-T24
  it("is checked at the profile when the environment of the version has been removed", () => {
    const result = check("orphan");

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/profile",
        code: "environment_unknown",
        available: ["Node", "box"],
      }),
    ]);
  });
});

describe("a profile version saved before it had an environment (#919)", () => {
  // #919-T25
  it("needs the environment in the step, as before", () => {
    expect(codes("legacy", "box")).toEqual([]);
    expect(codes("legacy", "Node")).toEqual([]);
  });

  // #919-T26
  it("is refused without one, with the environments that exist", () => {
    const result = check("legacy");

    expect(result.errors).toEqual([
      expect.objectContaining({
        path: "/steps/0/environment",
        code: "environment_required",
        available: ["Node", "box"],
      }),
    ]);
  });

  // #919-T27
  it("still reports the name of an environment nobody knows", () => {
    expect(codes("legacy", "ghost")).toEqual([
      ["/steps/0/environment", "environment_unknown"],
    ]);
  });

  // #919-T28
  it("is not guessed when the facts of the version were not read", () => {
    expect(codes("unread")).toEqual([]);
    expect(codes("unread", "box")).toEqual([]);
  });
});

describe("what a runner asks of a profile, for the environment of the profile (#919)", () => {
  // #919-T29
  it("is reported at the profile, because the step names no environment", () => {
    expect(codes("managed-on-runner")).toEqual([
      ["/steps/0/profile", "runner_needs_own_key"],
    ]);
    expect(codes("claude-on-vm")).toEqual([
      ["/steps/0/profile", "harness_needs_runner"],
    ]);
  });

  // #919-T30
  it("is fine where the profile fits its environment", () => {
    expect(codes("laptop-agent")).toEqual([]);
    expect(codes("builder")).toEqual([]);
  });
});
