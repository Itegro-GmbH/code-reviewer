// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  checksStateOf,
  closedIssueNumbers,
  toCheckSuites,
  toTrackerItem,
} from "./tracker-map.ts";

const ISSUE = {
  number: 12,
  node_id: "I_12",
  title: "Cache the widget list",
  body: "Rebuilt on every request.",
  state: "open",
  state_reason: null,
  labels: [
    { id: 1, name: "enhancement", color: "a2eeef" },
    { name: "", color: "x" },
    "not a label",
  ],
  assignees: [{ login: "alice" }, { id: 5 }],
  type: { id: 501, name: "Task" },
  parent_issue_url: "https://api.github.com/repos/acme/widgets/issues/3",
  updated_at: "2026-11-06T10:00:00Z",
};

describe("the ticket of a GitHub issue", () => {
  // #923-T01
  it("keeps GitHub's words: state, reason and type as they are, labels and assignees by name", () => {
    expect(
      toTrackerItem(
        { ...ISSUE, state: "closed", state_reason: "not_planned" },
        "acme/widgets",
      ),
    ).toEqual({
      number: 12,
      nodeId: "I_12",
      kind: "issue",
      state: "closed",
      stateReason: "not_planned",
      type: "Task",
      title: "Cache the widget list",
      bodyExcerpt: "Rebuilt on every request.",
      labels: [{ name: "enhancement", color: "a2eeef" }],
      assignees: [{ login: "alice" }],
      parentNumber: 3,
      closes: [],
      updatedAt: "2026-11-06T10:00:00.000Z",
    });
  });

  // #923-T02
  it("cuts the description to its excerpt and the title to its bound", () => {
    const item = toTrackerItem(
      { ...ISSUE, body: "ä".repeat(900), title: "t".repeat(2000) },
      "acme/widgets",
    );

    expect(Array.from(item?.bodyExcerpt ?? "")).toHaveLength(500);
    expect(Array.from(item?.title ?? "")).toHaveLength(1000);
  });

  // #923-T03
  it("reads the parent only when it is an issue of the same repository, and says nothing when the field is absent", () => {
    const own = (url: unknown) =>
      toTrackerItem({ ...ISSUE, parent_issue_url: url }, "Acme/Widgets");
    const { parent_issue_url: _omitted, ...without } = ISSUE;

    expect(own(null)?.parentNumber).toBeNull();
    expect(own("https://api.github.com/repos/other/repo/issues/3")?.parentNumber).toBeNull();
    expect(own("https://api.github.com/repos/acme/widgets/issues/9")?.parentNumber).toBe(9);
    expect(toTrackerItem(without, "acme/widgets")).not.toHaveProperty(
      "parentNumber",
    );
  });

  // #923-T04
  it("tells a pull request by its key or by the caller, and a merged one by its reason", () => {
    const viaIssues = toTrackerItem(
      {
        ...ISSUE,
        state: "closed",
        pull_request: { merged_at: "2026-11-06T09:00:00Z" },
        body: "Fixes #3",
      },
      "acme/widgets",
    );
    const webhook = toTrackerItem(
      { ...ISSUE, state: "open", merged: false, body: "Closes #1, resolves #2" },
      "acme/widgets",
      { pullRequest: true },
    );

    expect(viaIssues).toMatchObject({
      kind: "pull_request",
      state: "closed",
      stateReason: "merged",
      type: null,
      closes: [3],
    });
    expect(viaIssues).not.toHaveProperty("parentNumber");
    expect(webhook).toMatchObject({
      kind: "pull_request",
      stateReason: null,
      closes: [1, 2],
    });
  });

  // #923-T05
  it.each([
    ["no number", { ...ISSUE, number: undefined }],
    ["no node id", { ...ISSUE, node_id: "" }],
    ["no title", { ...ISSUE, title: 5 }],
    ["a state of its own", { ...ISSUE, state: "merged" }],
    ["no time", { ...ISSUE, updated_at: "yesterday" }],
    ["no object", "text"],
  ])("is none for an object with %s", (_name, json) => {
    expect(toTrackerItem(json, "acme/widgets")).toBeNull();
  });
});

describe("the issues a pull request closes", () => {
  // #923-T06
  it("reads GitHub's keywords for this repository only, ascending and without duplicates", () => {
    const body = [
      "Closes #12",
      "also FIXES: #3 and resolved #12",
      "closes acme/widgets#7",
      "closes other/repo#99",
      "see #44",
      "closesnot #50",
    ].join("\n");

    expect(closedIssueNumbers(body, "acme/widgets")).toEqual([3, 7, 12]);
  });

  // #923-T07
  it("holds at most 50", () => {
    const body = Array.from({ length: 80 }, (_, i) => `closes #${i + 1}`).join(
      "\n",
    );

    expect(closedIssueNumbers(body, "a/b")).toHaveLength(50);
  });
});

describe("the state of the checks of a commit", () => {
  const done = (conclusion: string) => ({ status: "completed", conclusion });
  const running = (status: string) => ({ status, conclusion: null });

  // #923-T08
  it.each([
    ["no suite", [], null],
    ["a suite that failed beats one that runs", [running("in_progress"), done("failure"), done("success")], "failure"],
    ["the worst conclusion decides", [done("cancelled"), done("timed_out")], "timed_out"],
    ["a suite that is not done beats a success", [done("success"), running("queued")], "queued"],
    ["in progress beats queued", [running("queued"), running("in_progress")], "in_progress"],
    ["a success beats neutral", [done("neutral"), done("success")], "success"],
    ["neutral when nothing else", [done("skipped"), done("neutral")], "skipped"],
  ])("is decided by %s", (_name, suites, expected) => {
    expect(checksStateOf(suites)).toBe(expected);
  });

  // #923-T09
  it("reads the suites of GitHub's answer, and refuses an answer that is not one", () => {
    expect(
      toCheckSuites({
        check_suites: [{ status: "completed", conclusion: "success" }, { status: "queued" }],
      }),
    ).toEqual([
      { status: "completed", conclusion: "success" },
      { status: "queued", conclusion: null },
    ]);
    expect(toCheckSuites({ check_suites: [{ conclusion: "success" }] })).toBeNull();
    expect(toCheckSuites([])).toBeNull();
  });
});
