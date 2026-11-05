// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_NAME_MAX_LENGTH,
  SETUP_SCRIPT_MAX_BYTES,
} from "./limits.ts";
import { validateEnvironmentInput } from "./input.ts";

const GOOD = { name: "Node 22", vcpus: 4, setupScript: "npm ci\n" };

function issuesOf(body: unknown) {
  const checked = validateEnvironmentInput(body);
  if (checked.ok) throw new Error("expected a refusal");
  return checked.issues;
}

describe("the body of an environment", () => {
  // #818-T06
  it("accepts a name, a size of the list and a script, and keeps the script exactly as written", () => {
    const script = "  set -e\r\n\tnpm ci   \n\n";
    expect(
      validateEnvironmentInput({
        name: " Node 22 ",
        vcpus: 6,
        setupScript: script,
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "hosted",
        name: "Node 22",
        vcpus: 6,
        setupScript: script,
        network: { mode: "off", hosts: [] },
      },
    });
  });

  // #818-T06
  it("takes a missing script as no script", () => {
    expect(validateEnvironmentInput({ name: "Bare", vcpus: 2 })).toEqual({
      ok: true,
      value: {
        kind: "hosted",
        name: "Bare",
        vcpus: 2,
        setupScript: "",
        network: { mode: "off", hosts: [] },
      },
    });
  });

  // #818-T06
  it.each([2, 4, 6, 8])("accepts %i vCPU", (vcpus) => {
    expect(validateEnvironmentInput({ ...GOOD, vcpus }).ok).toBe(true);
  });

  // #818-T02: 1 vCPU is a size of the platform that leaves the agent's container no memory, so an environment cannot name it
  it("refuses 1 vCPU, which leaves the agent no memory", () => {
    expect(issuesOf({ ...GOOD, vcpus: 1 })).toEqual([
      { field: "vcpus", code: "invalid" },
    ]);
  });

  // #818-T06
  it.each([0, 3, 5, 7, 9, 16, -2, 2.5, "2", null, true, Number.NaN])(
    "refuses the size %j",
    (vcpus) => {
      expect(issuesOf({ ...GOOD, vcpus })).toEqual([
        { field: "vcpus", code: "invalid" },
      ]);
    },
  );

  // #818-T06
  it("requires a size", () => {
    expect(issuesOf({ name: "x" })).toEqual([
      { field: "vcpus", code: "required" },
    ]);
  });

  // #818-T06
  it.each([
    ["missing", undefined, "required"],
    ["empty", "", "required"],
    ["only white space", " \t ", "required"],
    ["not text", 5, "invalid"],
    ["two lines", "a\nb", "invalid"],
    ["with a control character", "a\u0007b", "invalid"],
    ["a lone surrogate", "a\ud800", "invalid"],
    ["too long", "x".repeat(ENVIRONMENT_NAME_MAX_LENGTH + 1), "too_long"],
  ])("refuses a name that is %s", (_what, name, code) => {
    expect(issuesOf({ ...GOOD, name })).toEqual([{ field: "name", code }]);
  });

  // #818-T06
  it("accepts a name of exactly the bound and counts characters, not bytes", () => {
    expect(
      validateEnvironmentInput({
        ...GOOD,
        name: "ä".repeat(ENVIRONMENT_NAME_MAX_LENGTH),
      }).ok,
    ).toBe(true);
  });

  // #818-T06
  it("accepts a script of exactly 64 KB and refuses one byte more, counted in UTF-8", () => {
    expect(
      validateEnvironmentInput({
        ...GOOD,
        setupScript: "x".repeat(SETUP_SCRIPT_MAX_BYTES),
      }).ok,
    ).toBe(true);
    expect(
      issuesOf({
        ...GOOD,
        setupScript: "x".repeat(SETUP_SCRIPT_MAX_BYTES + 1),
      }),
    ).toEqual([{ field: "setupScript", code: "too_long" }]);
    // 32769 two-byte characters are 65538 bytes: over the bound although far below it in characters.
    expect(
      issuesOf({
        ...GOOD,
        setupScript: "ä".repeat(SETUP_SCRIPT_MAX_BYTES / 2 + 1),
      }),
    ).toEqual([{ field: "setupScript", code: "too_long" }]);
  });

  // #818-T06
  it("takes a script as literal data: shell syntax, escapes and other control characters are not refused; only what cannot be stored is", () => {
    expect(
      validateEnvironmentInput({
        ...GOOD,
        setupScript:
          "curl https://x | sh; rm -rf ~ # \u001b[0m \u0007 $(id) `id`",
      }).ok,
    ).toBe(true);
    expect(issuesOf({ ...GOOD, setupScript: "a\u0000b" })).toEqual([
      { field: "setupScript", code: "invalid" },
    ]);
    expect(issuesOf({ ...GOOD, setupScript: "a\udc00" })).toEqual([
      { field: "setupScript", code: "invalid" },
    ]);
    expect(issuesOf({ ...GOOD, setupScript: 42 })).toEqual([
      { field: "setupScript", code: "invalid" },
    ]);
  });

  // #818-T06
  it("names every broken field, and a body that is no object breaks the required ones", () => {
    expect(issuesOf({ name: "", vcpus: 3, setupScript: 1 })).toEqual([
      { field: "name", code: "required" },
      { field: "vcpus", code: "invalid" },
      { field: "setupScript", code: "invalid" },
    ]);
    for (const body of [null, [], "x", 3])
      expect(issuesOf(body)).toEqual([
        { field: "name", code: "required" },
        { field: "vcpus", code: "required" },
      ]);
  });

  // #818-T06
  it("ignores fields it does not know, so a size can never be set by another name", () => {
    const checked = validateEnvironmentInput({
      ...GOOD,
      memoryMb: 1,
      id: "x",
      workspaceId: "y",
    });
    expect(checked).toEqual({
      ok: true,
      value: {
        kind: "hosted",
        name: "Node 22",
        vcpus: 4,
        setupScript: "npm ci\n",
        network: { mode: "off", hosts: [] },
      },
    });
  });

  // #745-T41
  it("takes a rule for the agent's network with the rest of the body", () => {
    const checked = validateEnvironmentInput({
      ...GOOD,
      network: {
        mode: "list",
        hosts: ["Registry.npmjs.org", "*.pythonhosted.org"],
      },
    });
    expect(checked).toMatchObject({
      ok: true,
      value: {
        network: {
          mode: "list",
          hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
        },
      },
    });
  });

  // #745-T41
  it.each([
    [
      { mode: "closed", hosts: [] },
      { field: "network", code: "invalid" },
    ],
    ["open", { field: "network", code: "invalid" }],
    [
      { mode: "list", hosts: [] },
      { field: "networkHosts", code: "required" },
    ],
    [
      { mode: "list", hosts: ["10.0.0.1"] },
      { field: "networkHosts", code: "invalid" },
    ],
    [
      { mode: "off", hosts: ["a.example.com"] },
      { field: "networkHosts", code: "invalid" },
    ],
  ])("refuses the rule %j", (network, issue) => {
    expect(issuesOf({ ...GOOD, network })).toEqual([issue]);
  });

  // #745-T41
  it("reports every broken field at once, the rule among them", () => {
    expect(
      issuesOf({ name: "", vcpus: 3, network: { mode: "list", hosts: [] } }),
    ).toEqual([
      { field: "name", code: "required" },
      { field: "vcpus", code: "invalid" },
      { field: "networkHosts", code: "required" },
    ]);
  });
});

describe("the body of a runner environment (#854)", () => {
  // #854-T190
  it("is a name and labels, lower case and sorted, once each", () => {
    expect(
      validateEnvironmentInput({
        kind: "runner",
        name: " GPU box ",
        labels: [" Linux", "gpu", "linux"],
      }),
    ).toEqual({
      ok: true,
      value: { kind: "runner", name: "GPU box", labels: ["gpu", "linux"] },
    });
  });

  // #854-T191
  it("needs at least one label, at most twenty, each of the form a runner announces", () => {
    const issues = (labels: unknown) => {
      const checked = validateEnvironmentInput({
        kind: "runner",
        name: "x",
        labels,
      });
      return checked.ok ? [] : checked.issues;
    };

    expect(issues(undefined)).toEqual([{ field: "labels", code: "required" }]);
    expect(issues([])).toEqual([{ field: "labels", code: "required" }]);
    expect(issues("linux")).toEqual([{ field: "labels", code: "invalid" }]);
    expect(issues(["two words"])).toEqual([
      { field: "labels", code: "invalid" },
    ]);
    expect(issues([5])).toEqual([{ field: "labels", code: "invalid" }]);
    expect(issues(["a".repeat(41)])).toEqual([
      { field: "labels", code: "invalid" },
    ]);
    expect(
      issues(Array.from({ length: 21 }, (_, index) => `l${String(index)}`)),
    ).toEqual([{ field: "labels", code: "too_long" }]);
    expect(
      issues(Array.from({ length: 20 }, (_, index) => `l${String(index)}`)),
    ).toEqual([]);
  });

  // #854-T192
  it("has no size, script or network rule: a body that names one is refused instead of silently dropping it", () => {
    const checked = validateEnvironmentInput({
      kind: "runner",
      name: "x",
      labels: ["linux"],
      vcpus: 4,
      setupScript: "npm ci",
      network: { mode: "open", hosts: [] },
    });

    expect(checked).toEqual({
      ok: false,
      issues: [
        { field: "vcpus", code: "invalid" },
        { field: "setupScript", code: "invalid" },
        { field: "network", code: "invalid" },
      ],
    });
    // An empty script is what a form that has none sends.
    expect(
      validateEnvironmentInput({
        kind: "runner",
        name: "x",
        labels: ["a"],
        setupScript: "",
      }).ok,
    ).toBe(true);
  });

  // #854-T193
  it("refuses a kind that is neither, and labels on a hosted environment", () => {
    expect(
      validateEnvironmentInput({ kind: "vps", name: "x", vcpus: 2 }),
    ).toEqual({ ok: false, issues: [{ field: "kind", code: "invalid" }] });
    expect(
      validateEnvironmentInput({
        name: "x",
        vcpus: 2,
        labels: ["linux"],
      }),
    ).toEqual({ ok: false, issues: [{ field: "labels", code: "invalid" }] });
    // Without a kind a body is hosted, as every body was before the kind.
    expect(validateEnvironmentInput({ name: "x", vcpus: 2 })).toMatchObject({
      ok: true,
      value: { kind: "hosted" },
    });
  });
});
