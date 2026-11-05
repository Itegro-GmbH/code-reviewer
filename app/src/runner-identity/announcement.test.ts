// SPDX-License-Identifier: LicenseRef-Proprietary

// What a runner says about itself (#854): the check is pure and never trusts a type.
import { describe, expect, it } from "vitest";
import {
  checkAnnouncement,
  checkRunnerName,
  labelsFromText,
  labelsToText,
  limitsFromText,
  manifestFromText,
  normalizeLabels,
} from "./announcement.ts";

const GOOD = {
  labels: ["gpu", "linux"],
  baseVersion: "1.0.0",
  manifest: {
    harnesses: { opencode: { version: "1.19.0", ready: true } },
    capabilities: ["agent-docker"],
  },
  limits: { cpus: 8, memoryMb: 16384 },
};

function fieldsOf(body: unknown): string[] {
  const checked = checkAnnouncement(body);
  if (checked.ok) throw new Error("expected a refusal");
  return checked.fields.map((issue) => issue.field);
}

describe("the announcement of a runner", () => {
  // #854-T10
  it("is taken as it is when it fits, with the labels lower case and sorted", () => {
    const checked = checkAnnouncement({
      ...GOOD,
      labels: [" GPU ", "linux", "gpu"],
    });

    expect(checked).toEqual({
      ok: true,
      value: { ...GOOD, labels: ["gpu", "linux"] },
    });
  });

  // #854-T11
  it("needs labels and a base version, and nothing else", () => {
    expect(checkAnnouncement({ labels: [], baseVersion: "0.1.0" })).toEqual({
      ok: true,
      value: {
        labels: [],
        baseVersion: "0.1.0",
        manifest: { harnesses: {}, capabilities: [] },
        limits: {},
      },
    });
    expect(fieldsOf({})).toEqual(["labels", "baseVersion"]);
    expect(fieldsOf(null)).toEqual(["labels", "baseVersion"]);
    expect(fieldsOf([GOOD])).toEqual(["labels", "baseVersion"]);
  });

  // #854-T12
  it.each([
    ["a label with a space", { labels: ["two words"] }, "labels[0]"],
    ["a label that is not text", { labels: [3] }, "labels[0]"],
    ["a label of 41 characters", { labels: ["a".repeat(41)] }, "labels[0]"],
    [
      "21 labels",
      { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) },
      "labels",
    ],
    ["labels that are not a list", { labels: "linux" }, "labels"],
    ["a base version of two numbers", { baseVersion: "1.0" }, "baseVersion"],
    ["a base version that is a number", { baseVersion: 1 }, "baseVersion"],
    ["a manifest that is a list", { manifest: [] }, "manifest"],
    [
      "a harness without readiness",
      { manifest: { harnesses: { opencode: { version: "1" } } } },
      "manifest.harnesses.opencode.ready",
    ],
    [
      "a harness with a name in capitals",
      { manifest: { harnesses: { OpenCode: { version: "1", ready: true } } } },
      "manifest.harnesses",
    ],
    [
      "a capability with a space",
      { manifest: { capabilities: ["agent docker"] } },
      "manifest.capabilities[0]",
    ],
    ["a limit of zero", { limits: { cpus: 0 } }, "limits.cpus"],
    ["a limit that is not whole", { limits: { diskGb: 1.5 } }, "limits.diskGb"],
    ["limits that are text", { limits: "8" }, "limits"],
  ] as const)("refuses %s", (_what, change, field) => {
    expect(fieldsOf({ ...GOOD, ...change })).toContain(field);
  });

  // #854-T13
  it("drops a field it does not know, in the manifest and the limits too", () => {
    const checked = checkAnnouncement({
      ...GOOD,
      mood: "fine",
      limits: { cpus: 2, gpus: 4 },
      manifest: { ...GOOD.manifest, motd: "hi" },
    });

    expect(checked).toEqual({
      ok: true,
      value: { ...GOOD, limits: { cpus: 2 } },
    });
  });

  it("accepts a harness the runner describes itself", () => {
    const checked = checkAnnouncement({
      ...GOOD,
      manifest: {
        harnesses: { "custom/my-tool": { version: "0.3", ready: false } },
      },
    });

    expect(checked.ok).toBe(true);
  });

  it("does not list a value in the field it refuses", () => {
    const checked = checkAnnouncement({ ...GOOD, labels: ["SECRET value"] });

    expect(JSON.stringify(checked)).not.toContain("SECRET");
  });
});

describe("a runner's name", () => {
  it("is one line of 1 to 80 characters, trimmed", () => {
    expect(checkRunnerName("  build box 1 ")).toBe("build box 1");
    expect(checkRunnerName("")).toBeNull();
    expect(checkRunnerName("   ")).toBeNull();
    expect(checkRunnerName("a".repeat(81))).toBeNull();
    expect(checkRunnerName("two\nlines")).toBeNull();
    expect(checkRunnerName("lone \ud800 half")).toBeNull();
    for (const hidden of ["\u202e", "\u200b", "\u0085", "\u2028", "\ufeff"]) {
      expect(checkRunnerName(`box${hidden}1`)).toBeNull();
    }
    expect(checkRunnerName(7)).toBeNull();
  });
});

describe("the stored forms", () => {
  it("keep the labels one on each line, and read none as an empty list", () => {
    expect(labelsToText(["a", "b"])).toBe("a\nb");
    expect(labelsFromText("a\nb")).toEqual(["a", "b"]);
    expect(labelsFromText("")).toEqual([]);
    expect(normalizeLabels(["B", "a", "b"])).toEqual(["a", "b"]);
  });

  it("read a manifest or limits text that does not fit as empty", () => {
    expect(manifestFromText("not json")).toEqual({
      harnesses: {},
      capabilities: [],
    });
    expect(manifestFromText('{"harnesses":[]}')).toEqual({
      harnesses: {},
      capabilities: [],
    });
    expect(limitsFromText("not json")).toEqual({});
    expect(limitsFromText('{"cpus":-1}')).toEqual({});
    expect(limitsFromText('{"cpus":4}')).toEqual({ cpus: 4 });
  });
});
