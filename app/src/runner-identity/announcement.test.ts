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
    harnesses: [{ harness: "opencode", version: "1.19.0", auth: "app-key" }],
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
        manifest: { harnesses: [], capabilities: [] },
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
        harnesses: [
          { harness: "custom/my-tool", version: "0.3", auth: "local-key" },
        ],
      },
    });

    expect(checked.ok).toBe(true);
  });

  it("does not list a value in the field it refuses", () => {
    const checked = checkAnnouncement({ ...GOOD, labels: ["SECRET value"] });

    expect(JSON.stringify(checked)).not.toContain("SECRET");
  });
});

describe("the harness entries of a manifest (#973)", () => {
  const manifestOf = (harnesses: unknown) =>
    checkAnnouncement({ ...GOOD, manifest: { harnesses } });

  // #973-T05
  it("are a list of harness, version, auth and, for a device's access, models (sorted, no repeats)", () => {
    const checked = manifestOf([
      { harness: "opencode", version: "1.19.0", auth: "app-key" },
      { harness: "opencode", version: "1.19.0", auth: "local-key" },
      {
        harness: "claude-code",
        version: "2.1.311",
        auth: "subscription",
        models: ["sonnet", "opus", "sonnet", "haiku"],
      },
    ]);

    expect(checked).toMatchObject({
      ok: true,
      value: {
        manifest: {
          harnesses: [
            { harness: "opencode", version: "1.19.0", auth: "app-key" },
            { harness: "opencode", version: "1.19.0", auth: "local-key" },
            {
              harness: "claude-code",
              version: "2.1.311",
              auth: "subscription",
              models: ["haiku", "opus", "sonnet"],
            },
          ],
        },
      },
    });
  });

  // #973-T05
  it.each([
    ["an entry that is no object", ["opencode"], "manifest.harnesses[0]"],
    [
      "a harness in capitals",
      [{ harness: "OpenCode", version: "1", auth: "app-key" }],
      "manifest.harnesses[0].harness",
    ],
    [
      "no version",
      [{ harness: "opencode", auth: "app-key" }],
      "manifest.harnesses[0].version",
    ],
    [
      "no auth",
      [{ harness: "opencode", version: "1" }],
      "manifest.harnesses[0].auth",
    ],
    [
      "an auth that is none of the four",
      [{ harness: "opencode", version: "1", auth: "token" }],
      "manifest.harnesses[0].auth",
    ],
    [
      "models on a key of the app",
      [{ harness: "opencode", version: "1", auth: "app-key", models: ["x"] }],
      "manifest.harnesses[0].models",
    ],
    [
      "models on the platform's access",
      [{ harness: "opencode", version: "1", auth: "managed", models: ["x"] }],
      "manifest.harnesses[0].models",
    ],
    [
      "an empty list of models",
      [
        {
          harness: "claude-code",
          version: "1",
          auth: "subscription",
          models: [],
        },
      ],
      "manifest.harnesses[0].models",
    ],
    [
      "a model with a space",
      [
        {
          harness: "claude-code",
          version: "1",
          auth: "subscription",
          models: ["a b"],
        },
      ],
      "manifest.harnesses[0].models",
    ],
    [
      "the same harness and auth twice",
      [
        { harness: "opencode", version: "1", auth: "app-key" },
        { harness: "opencode", version: "2", auth: "app-key" },
      ],
      "manifest.harnesses[1]",
    ],
    [
      "more than 16 entries",
      Array.from({ length: 17 }, (_, i) => ({
        harness: `h${String(i)}`,
        version: "1",
        auth: "app-key",
      })),
      "manifest.harnesses",
    ],
  ] as const)("refuse %s", (_what, harnesses, field) => {
    const checked = manifestOf(harnesses);
    if (checked.ok) throw new Error("expected a refusal");
    expect(checked.fields.map((issue) => issue.field)).toContain(field);
  });

  // #973-T04
  it("read the old map form: OpenCode as a key of the app, Claude Code as a subscription, an entry that is not ready as none", () => {
    const checked = manifestOf({
      opencode: { version: "1.19.0", ready: true },
      "claude-code": { version: "2.1.311", ready: true },
      "custom/tool": { version: "0.3", ready: true },
      "custom/idle": { version: "0.1", ready: false },
    });

    expect(checked).toMatchObject({
      ok: true,
      value: {
        manifest: {
          harnesses: [
            { harness: "opencode", version: "1.19.0", auth: "app-key" },
            {
              harness: "claude-code",
              version: "2.1.311",
              auth: "subscription",
            },
            { harness: "custom/tool", version: "0.3", auth: "app-key" },
          ],
        },
      },
    });
  });

  // #973-T04
  it("keep the field errors of the old map form", () => {
    expect(
      fieldsOf({
        ...GOOD,
        manifest: { harnesses: { opencode: { version: "1" } } },
      }),
    ).toEqual(["manifest.harnesses.opencode.ready"]);
  });

  it("are read back from the stored text, in either form", () => {
    const entry = { harness: "opencode", version: "1.19.0", auth: "app-key" };
    expect(
      manifestFromText(JSON.stringify({ harnesses: [entry] })).harnesses,
    ).toEqual([entry]);
    expect(
      manifestFromText(
        JSON.stringify({
          harnesses: { opencode: { version: "1.19.0", ready: true } },
        }),
      ).harnesses,
    ).toEqual([entry]);
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
      harnesses: [],
      capabilities: [],
    });
    expect(manifestFromText('{"harnesses":[]}')).toEqual({
      harnesses: [],
      capabilities: [],
    });
    expect(manifestFromText('{"harnesses":"x"}')).toEqual({
      harnesses: [],
      capabilities: [],
    });
    expect(limitsFromText("not json")).toEqual({});
    expect(limitsFromText('{"cpus":-1}')).toEqual({});
    expect(limitsFromText('{"cpus":4}')).toEqual({ cpus: 4 });
  });
});
