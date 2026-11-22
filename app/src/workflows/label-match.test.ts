// SPDX-License-Identifier: LicenseRef-Proprietary

// #1129: which Jira label a lane's label stands for, and which labels a changelog text added.
import { describe, expect, it } from "vitest";
import {
  jiraLabel,
  labelsAdded,
  labelsOfChangelogText,
  laneLabelIsAmong,
} from "./label-match.ts";

describe("label match", () => {
  // #1129-T04
  it("writes a label with spaces as Jira does, with a hyphen", () => {
    expect(jiraLabel("ready for agent")).toBe("ready-for-agent");
    expect(jiraLabel("  ready   for\tagent ")).toBe("ready-for-agent");
    expect(jiraLabel("ready-for-agent")).toBe("ready-for-agent");
    expect(jiraLabel("x".repeat(300))).toHaveLength(255);
  });

  // #1129-T04
  it("matches a lane label with spaces or hyphens to the Jira label, case counts", () => {
    const put = new Set(["ready-for-agent"]);
    expect(laneLabelIsAmong("ready for agent", put)).toBe(true);
    expect(laneLabelIsAmong("ready-for-agent", put)).toBe(true);
    expect(laneLabelIsAmong("Ready for agent", put)).toBe(false);
    expect(laneLabelIsAmong("ready for agent now", put)).toBe(false);
    expect(laneLabelIsAmong("   ", new Set([""]))).toBe(false);
  });

  // #1129-T02
  it("splits a changelog text at any run of whitespace, each label once", () => {
    expect(labelsOfChangelogText("a  b\tc a")).toEqual(["a", "b", "c"]);
    expect(labelsOfChangelogText("")).toEqual([]);
    expect(labelsOfChangelogText(null)).toEqual([]);
  });

  // #1129-T01
  it("says what the new list has and the old list had not", () => {
    expect(labelsAdded("a b", "a b c")).toEqual(["c"]);
    expect(labelsAdded("a b", "a")).toEqual([]);
    expect(labelsAdded(null, "a")).toEqual(["a"]);
    expect(labelsAdded("a", null)).toEqual([]);
  });
});
