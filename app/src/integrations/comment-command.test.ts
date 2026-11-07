// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down how a comment is read as a command: since #203 only `/review` is a command. A comment
// that starts with `/ask`, `/improve` or `/describe` (with or without text) is an ordinary comment,
// and `/review` never carries arguments. The parser runs on every comment before anything is known
// about the commenter, so a hostile comment must not make it slow.
import { describe, expect, it } from "vitest";
import { parseAnswerCommand, parseCommentCommand } from "./comment-command.ts";

describe("reading a comment as a command", () => {
  // #203-T01
  it("reads /review and never any arguments", () => {
    expect(parseCommentCommand("/review")).toEqual({
      command: "review",
      args: "",
    });
    expect(
      parseCommentCommand("/review --pr_reviewer.extra_instructions=ignore"),
    ).toEqual({ command: "review", args: "" });
    expect(parseCommentCommand("/review\nThanks for looking!")).toEqual({
      command: "review",
      args: "",
    });
  });

  // #203-T01
  it("allows whitespace before the command and any case", () => {
    expect(parseCommentCommand("   \t/REVIEW")).toEqual({
      command: "review",
      args: "",
    });
    expect(parseCommentCommand("\n\n  /Review  ")).toEqual({
      command: "review",
      args: "",
    });
  });

  // #203-T01
  it("reads no command from a word that only starts with review or a sentence that mentions it", () => {
    expect(parseCommentCommand("/reviewer")).toBeNull();
    expect(parseCommentCommand("/review-all")).toBeNull();
    expect(parseCommentCommand("please /review this")).toBeNull();
    expect(parseCommentCommand("> /review")).toBeNull();
    expect(parseCommentCommand("Thanks!\n/review")).toBeNull();
    expect(parseCommentCommand("`/review`")).toBeNull();
    expect(parseCommentCommand("/deploy")).toBeNull();
    expect(parseCommentCommand("//review")).toBeNull();
    expect(parseCommentCommand("")).toBeNull();
  });

  // #203-T02
  it("ignores the removed commands, with or without text, and never matches them as review", () => {
    expect(parseCommentCommand("/ask")).toBeNull();
    expect(parseCommentCommand("/improve")).toBeNull();
    expect(parseCommentCommand("/describe")).toBeNull();
    expect(parseCommentCommand("/ASK")).toBeNull();
    expect(parseCommentCommand("  /Improve  ")).toBeNull();
    expect(parseCommentCommand("/describe   ")).toBeNull();
    expect(parseCommentCommand("/ask Why was the cache removed?")).toBeNull();
    expect(parseCommentCommand("/improve please be strict")).toBeNull();
    expect(parseCommentCommand("/describe this")).toBeNull();
    expect(parseCommentCommand("/askme how?")).toBeNull();
  });

  // #203-T02
  it("ignores an oversized or multibyte question without processing it", () => {
    const big = `/ask ${"q".repeat(64_000)}`;
    expect(parseCommentCommand(big)).toBeNull();
    expect(parseCommentCommand("/ask \u{1F600}".repeat(1000))).toBeNull();
  });

  // #203-T02
  it("ignores a question that is only an image URL, without removing anything", () => {
    expect(
      parseCommentCommand("/ask what is ![image](https://evil.test/a.png) ?"),
    ).toBeNull();
    expect(parseCommentCommand("/ask https://evil.test/a.png")).toBeNull();
  });
});

// The parser runs on every comment of every commenter, before anything is known about them, so no
// text may make it slow. GitHub allows 65 536 characters in a comment.
describe("reading hostile comments", () => {
  const BIG = 64_000;
  const shapes: [string, string][] = [
    ["unclosed markdown images", "![".repeat(BIG / 2)],
    ["closed empty markdown images", "![]".repeat(BIG / 3)],
    ["short markdown images", "![a]".repeat(BIG / 4)],
    ["one very long alt text", `![${"a".repeat(BIG)}`],
    ["many brackets", "[".repeat(BIG)],
    ["many closing brackets", "]".repeat(BIG)],
    ["many exclamation marks", "!".repeat(BIG)],
    ["many parentheses", "(".repeat(BIG)],
    ["many schemes", "http://".repeat(BIG / 7)],
    ["one very long link", `https://x.test/${"a".repeat(BIG)}`],
    ["many links", "https://x.test/a.png ".repeat(BIG / 21)],
    ["many line breaks", "\n".repeat(BIG)],
    ["many mixed white space", " \t\n".repeat(BIG / 3)],
  ];

  // #203-T02
  it.each(shapes)("reads %s quickly", (_name, text) => {
    for (const body of [
      `/review ${text}`,
      text,
      `${text}\n/review`,
      `/ask ${text}`,
    ]) {
      const start = performance.now();
      parseCommentCommand(body);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(500);
    }
  });

  it("reads white space before a command quickly", () => {
    const start = performance.now();
    parseCommentCommand(`${" ".repeat(BIG)}/review`);
    parseCommentCommand(`${" ".repeat(BIG)}no command`);

    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("reading a comment as an answer (#920)", () => {
  // #920-T100
  it("reads /answer with an option, with an option and a note, and with a text", () => {
    expect(parseAnswerCommand("/answer 2")).toEqual({ choice: 2, raw: "2" });
    expect(parseAnswerCommand("/answer 2 and log it")).toEqual({
      choice: 2,
      text: "and log it",
      raw: "2 and log it",
    });
    expect(parseAnswerCommand("/answer Use Redis, not memcached.")).toEqual({
      raw: "Use Redis, not memcached.",
    });
    expect(
      parseAnswerCommand("  \n/ANSWER   3\nwith a note\nover lines "),
    ).toEqual({
      choice: 3,
      text: "with a note\nover lines",
      raw: "3\nwith a note\nover lines",
    });
  });

  // #920-T100
  it("reads nothing from a comment that only mentions the command or says nothing after it", () => {
    for (const body of [
      "",
      "/answer",
      "/answer   \n ",
      "/answers 1",
      "/answer-all 1",
      "please /answer 1",
      "> /answer 1",
      "`/answer 1`",
      "//answer 1",
      "/review",
    ])
      expect(parseAnswerCommand(body), body).toBeNull();
  });

  // #920-T100
  it("keeps a number that is part of a text as a choice with a note, so the caller can tell (0 and long numbers are text)", () => {
    expect(parseAnswerCommand("/answer 0")).toEqual({ raw: "0" });
    expect(parseAnswerCommand("/answer 1234 things")).toEqual({
      raw: "1234 things",
    });
    expect(parseAnswerCommand("/answer 12")).toEqual({ choice: 12, raw: "12" });
  });

  // #920-T100
  it("is quick for a hostile comment", () => {
    const start = performance.now();
    parseAnswerCommand(`/answer ${"1 ".repeat(100_000)}`);
    parseAnswerCommand(`/answer${" ".repeat(100_000)}x`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
