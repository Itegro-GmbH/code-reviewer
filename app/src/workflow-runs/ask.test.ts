// SPDX-License-Identifier: LicenseRef-Proprietary

// #920: the question an agent step ended its turn with, as the engine stores it with the step, and the answer to it.
import { describe, expect, it } from "vitest";
import { boundAgentAsk } from "../db/agent-ask.ts";
import {
  answerInstruction,
  parseStepAsk,
  resolveAnswer,
  serializeAsk,
  type StepAsk,
} from "./ask.ts";

const ASKED: StepAsk = {
  n: 1,
  state: "open",
  question: "Retry which failures?",
  options: ["Network errors", "Network errors and 5xx answers"],
  context: "client.ts tells the two apart.",
};

describe("the question of an agent", () => {
  // #920-T20
  it("is a closed object within its bounds, without the parts it does not have", () => {
    expect(boundAgentAsk({ question: "q" })).toEqual({ question: "q" });
    expect(boundAgentAsk({ question: "q", options: [], context: "c" })).toEqual(
      { question: "q", context: "c" },
    );
    expect(boundAgentAsk({ question: "" })).toBeUndefined();
    expect(boundAgentAsk({ question: "q", extra: 1 })).toBeUndefined();
    expect(boundAgentAsk({ question: "q".repeat(2001) })).toBeUndefined();
    expect(
      boundAgentAsk({ question: "q", options: Array(11).fill("a") }),
    ).toBeUndefined();
    expect(boundAgentAsk({ question: "q", options: [3] })).toBeUndefined();
    expect(boundAgentAsk(["q"])).toBeUndefined();
    expect(boundAgentAsk(null)).toBeUndefined();
  });

  // #920-T21
  it("is stored with the step as JSON and read back; what cannot be read is no question", () => {
    expect(parseStepAsk(serializeAsk(ASKED))).toEqual(ASKED);
    expect(parseStepAsk(null)).toBeUndefined();
    expect(parseStepAsk("not json")).toBeUndefined();
    expect(parseStepAsk(JSON.stringify({ ...ASKED, n: 0 }))).toBeUndefined();
    expect(
      parseStepAsk(JSON.stringify({ ...ASKED, state: "gone" })),
    ).toBeUndefined();
    // An answered question without its answer is not one a step can go on with.
    expect(
      parseStepAsk(JSON.stringify({ ...ASKED, state: "answered" })),
    ).toBeUndefined();
  });
});

describe("the answer to a question", () => {
  // #920-T22
  it("is an option by its number, taken as the option's own words", () => {
    expect(resolveAnswer(ASKED, { choice: 2 })).toEqual({
      ok: true,
      text: "Network errors and 5xx answers",
      choice: 2,
    });
  });

  // #920-T23
  it("keeps a note that follows an option, and takes a free text where there is no option", () => {
    expect(resolveAnswer(ASKED, { choice: 1, text: "  and log it\n" })).toEqual(
      { ok: true, text: "Network errors\n\nand log it", choice: 1 },
    );
    expect(resolveAnswer(ASKED, { text: "Neither: do not retry." })).toEqual({
      ok: true,
      text: "Neither: do not retry.",
    });
    expect(resolveAnswer({}, { text: "Use Redis." })).toEqual({
      ok: true,
      text: "Use Redis.",
    });
  });

  // #920-T24
  it("is refused when it is empty, too long, or names an option the question does not have", () => {
    expect(resolveAnswer(ASKED, {})).toEqual({
      ok: false,
      code: "answer_empty",
    });
    expect(resolveAnswer(ASKED, { text: "   " })).toEqual({
      ok: false,
      code: "answer_empty",
    });
    expect(resolveAnswer(ASKED, { text: "x".repeat(4001) })).toEqual({
      ok: false,
      code: "answer_too_long",
    });
    for (const choice of [0, 3, -1, 1.5])
      expect(resolveAnswer(ASKED, { choice })).toEqual({
        ok: false,
        code: "option_unknown",
      });
    expect(resolveAnswer({}, { choice: 1 })).toEqual({
      ok: false,
      code: "option_unknown",
    });
  });

  // #920-T25
  it("is handed to the agent with the question it belongs to and who gave it", () => {
    const text = answerInstruction(ASKED, {
      text: "Network errors",
      choice: 1,
      by: "octocat",
      via: "comment",
      at: "2026-11-07T10:00:00.000Z",
    });

    expect(text).toContain("You asked: Retry which failures?");
    expect(text).toContain("The answer of octocat:\nNetwork errors");
    expect(text).toContain("Go on with the task");
  });
});

describe("the question as the fix round of #920 keeps it", () => {
  // #920-T100
  it("keeps when the step began to wait, and reads a row from before without it", () => {
    const asked = { ...ASKED, askedAt: "2026-11-07T09:00:00.000Z" };
    expect(parseStepAsk(serializeAsk(asked))).toEqual(asked);
    expect(parseStepAsk(serializeAsk(ASKED))?.askedAt).toBeUndefined();
    expect(
      parseStepAsk(JSON.stringify({ ...ASKED, askedAt: "no time" }))?.askedAt,
    ).toBeUndefined();
  });

  // #920-T101
  it("counts the bounds of the question in UTF-16 code units, as the runner does", () => {
    const emoji = "\u{1F600}";
    expect(boundAgentAsk({ question: emoji.repeat(1000) })).toBeDefined();
    expect(boundAgentAsk({ question: emoji.repeat(1001) })).toBeUndefined();
  });

  // #920-T102
  it("cleans the answer first and refuses what is empty or too long as it will be stored, before the question is touched", () => {
    expect(resolveAnswer(ASKED, { text: "\u0001\u200e \n" })).toEqual({
      ok: false,
      code: "answer_empty",
    });
    expect(resolveAnswer(ASKED, { text: "Use\u0000 Redis\u202e." })).toEqual({
      ok: true,
      text: "Use Redis.",
    });
    expect(resolveAnswer(ASKED, { choice: 1, text: "\u0007" })).toEqual({
      ok: true,
      text: "Network errors",
      choice: 1,
    });
    // Too long counts what is kept, not what was removed.
    const padded = `${"a".repeat(4000)}${"\u0000".repeat(50)}`;
    expect(resolveAnswer(ASKED, { text: padded })).toMatchObject({ ok: true });
    expect(resolveAnswer(ASKED, { text: `${padded}a` })).toEqual({
      ok: false,
      code: "answer_too_long",
    });
  });
});
