// SPDX-License-Identifier: LicenseRef-Proprietary

// #920: the words of a question on a ticket: the comment that carries it, the edit that says it was answered, the record of an answer
// given on the page, and the marker of the first.
import { describe, expect, it } from "vitest";
import { workspacePath } from "../workspaces/paths.ts";
import type { StepAsk } from "./ask.ts";
import {
  MENTIONS_MAX,
  answerRecordComment,
  answeredComment,
  cancelledComment,
  markerOf,
  mentionsOf,
  questionComment,
  readMarker,
  runPagePath,
  safeText,
} from "./ask-comment.ts";

const IDENTITY = {
  runId: "7f0c1b3e-aaaa-4bbb-8ccc-0123456789ab",
  stepId: "plan",
  n: 2,
};
const ASK = {
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
  context: "client.ts tells the two apart.",
};
const ANSWERED: StepAsk = {
  ...ASK,
  n: 2,
  state: "answered",
  answer: {
    text: "Network errors and 5xx answers",
    choice: 2,
    by: "octocat",
    via: "comment",
    at: "2026-11-07T10:00:00.000Z",
  },
};

describe("the comment of a question", () => {
  // #920-T110
  it("starts with the hidden marker and holds the question, the numbered options, how to answer, the link and the people asked", () => {
    const body = questionComment({
      identity: IDENTITY,
      ask: ASK,
      link: "https://app.example/w/acme/workflows/wf-1/runs/run-1",
      mentions: ["@alice", "@bob"],
    });

    expect(body.split("\n")[0]).toBe(
      `<!-- factory ask run=${IDENTITY.runId} step=plan q=2 -->`,
    );
    expect(body).toContain("**Retry which failures?**");
    expect(body).toContain(
      "1. Network errors\n2. Network errors and 5xx answers",
    );
    expect(body).toContain("Reply with `/answer <n>` (a note may follow)");
    expect(body).toContain(
      "or answer in the factory: https://app.example/w/acme/workflows/wf-1/runs/run-1",
    );
    expect(body.trimEnd().endsWith("@alice @bob")).toBe(true);
  });

  // #920-T111
  it("asks for a text where the question has no options, and has no mention line without people", () => {
    const body = questionComment({
      identity: IDENTITY,
      ask: { question: "Which backoff?" },
      link: "https://app.example/run",
      mentions: [],
    });

    expect(body).toContain("Reply with `/answer <your answer>`");
    expect(body).not.toMatch(/^\d+\. /m);
    expect(body.trimEnd().endsWith("https://app.example/run")).toBe(true);
  });

  // #920-T112
  it("defuses what the agent wrote: no mention, no direction mark, no control character, however it is spelled", () => {
    const body = questionComment({
      identity: IDENTITY,
      ask: {
        question: "Ping @everyone‮ and @octocat?\u0007",
        options: ["@team/maintainers yes", "no"],
        context: "cc @alice",
      },
      link: "https://app.example/run",
      mentions: [],
    });

    expect(body).not.toMatch(/(^|[^\w`])@(everyone|octocat|alice|team)/);
    expect(body).not.toContain("‮");
    expect(body).not.toContain("\u0007");
  });

  // #920-T113
  it("keeps a question on one line and each option on one line", () => {
    const body = questionComment({
      identity: IDENTITY,
      ask: { question: "a\n\nb", options: ["c\nd"] },
      link: "https://app.example/run",
      mentions: [],
    });

    expect(body).toContain("**a b**");
    expect(body).toContain("1. c d");
  });
});

describe("the marker", () => {
  // #920-T114
  it("is read back for the state, the run, the step and the number, and from nothing else", () => {
    expect(readMarker(`text ${markerOf("ask", IDENTITY)} more`)).toEqual({
      state: "ask",
      ...IDENTITY,
    });
    expect(readMarker(markerOf("answered", IDENTITY))).toMatchObject({
      state: "answered",
    });
    for (const text of [
      "",
      "<!-- factory ask run=x step=plan q=0 -->",
      "<!-- factory ask run=x step=1plan q=1 -->",
      "<!-- factory ask run=x/y step=plan q=1 -->",
      "<!-- factory ask run=x step=plan -->",
      "factory ask run=x step=plan q=1",
    ])
      expect(readMarker(text), text).toBeUndefined();
  });
});

describe("the answered comment and the record of an answer", () => {
  // #920-T115
  it("says answered in its marker and who answered what, with the question above it", () => {
    const body = answeredComment({ identity: IDENTITY, ask: ANSWERED });

    expect(body.split("\n")[0]).toBe(
      `<!-- factory answered run=${IDENTITY.runId} step=plan q=2 -->`,
    );
    expect(body).toContain("**Retry which failures?**");
    expect(body).toContain(
      "Answered by @octocat: Network errors and 5xx answers",
    );
    expect(body).not.toContain("factory ask run=");
  });

  // #920-T116
  it("is a record in the name of the person for an answer given on the page, with its own marker", () => {
    const body = answerRecordComment({
      identity: IDENTITY,
      ask: {
        ...ANSWERED,
        answer: { ...ANSWERED.answer!, via: "ui", by: "octo cat" },
      },
    });

    expect(body).toContain("<!-- factory answer run=");
    expect(body).toContain(
      "Answer by @octocat: Network errors and 5xx answers",
    );
  });

  // #920-T117
  it("defuses the answer of a person like any text, and does not name nobody", () => {
    const body = answeredComment({
      identity: IDENTITY,
      ask: {
        ...ANSWERED,
        answer: { ...ANSWERED.answer!, text: "@everyone look", by: null },
      },
    });

    expect(body).not.toMatch(/(^|[^\w`])@everyone/);
    expect(body).toContain("Answered by a member of the workspace:");
  });
});

describe("the text and the people", () => {
  // #920-T118
  it("cuts a text at its bound and says nothing it cannot say", () => {
    expect(safeText("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    expect(safeText("  plain  ")).toBe("plain");
  });

  // #920-T119
  it("asks each login once, at most ten, and leaves out what is no GitHub login", () => {
    const logins = [
      "alice",
      "alice",
      "bob-1",
      "-bad",
      "bad-",
      "a b",
      "x".repeat(40),
      ...Array.from({ length: 20 }, (_, index) => `user${String(index)}`),
    ];

    const asked = mentionsOf(logins);

    expect(asked).toHaveLength(MENTIONS_MAX);
    expect(asked.slice(0, 2)).toEqual(["@alice", "@bob-1"]);
    expect(asked).not.toContain("@-bad");
  });
});

describe("the page of a run", () => {
  // #920-T90
  it("is the address the workspace paths give, with the ids encoded", () => {
    const run = { workflowId: "wf 1", id: "run/2" };
    expect(runPagePath("acme", run)).toBe(
      workspacePath("acme", "/workflows/wf%201/runs/run%2F2"),
    );
  });
});

describe("the question of a run that was stopped", () => {
  // #920-T119
  it("says nobody has to answer any more, keeps the question, and carries a marker that reads back", () => {
    const body = cancelledComment({ identity: IDENTITY, ask: ASK });

    expect(body).toContain("cancelled before it was answered");
    expect(body).toContain("**Retry which failures?**");
    expect(readMarker(body)).toEqual({ ...IDENTITY, state: "cancelled" });
    expect(markerOf("cancelled", IDENTITY)).toBe(
      `<!-- factory cancelled run=${IDENTITY.runId} step=plan q=2 -->`,
    );
  });
});
