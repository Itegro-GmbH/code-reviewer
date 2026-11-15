// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { adfToText } from "./adf.ts";
import { parseAnswerCommand } from "../integrations/comment-command.ts";
import {
  extractMarkers,
  markdownToAdf,
  plainTextToAdf,
  type AdfNode,
} from "./markdown-adf.ts";

/** The content a Jira blockquote allows (its schema): anything else is refused with a 400. */
const QUOTE_CONTENT = new Set([
  "paragraph",
  "bulletList",
  "orderedList",
  "codeBlock",
  "mediaSingle",
  "mediaGroup",
]);

function quoteViolations(nodes: readonly AdfNode[]): string[] {
  const found: string[] = [];
  for (const node of nodes) {
    if (node.type === "blockquote")
      for (const child of node.content ?? [])
        if (!QUOTE_CONTENT.has(child.type)) found.push(child.type);
    found.push(...quoteViolations(node.content ?? []));
  }
  return found;
}

const depthOf = (nodes: readonly AdfNode[]): number =>
  1 + Math.max(0, ...nodes.map((node) => depthOf(node.content ?? [])));

describe("extractMarkers", () => {
  // #1040-T01
  it("takes the leading HTML-comment lines out of the text and returns them in order", () => {
    const { markers, text } = extractMarkers(
      "<!-- factory ask run=r1 step=s q=1 -->\n<!-- factory answer run=r1 step=s q=1 -->\nThe question\n",
    );
    expect(markers).toEqual([
      "<!-- factory ask run=r1 step=s q=1 -->",
      "<!-- factory answer run=r1 step=s q=1 -->",
    ]);
    expect(text).toBe("The question\n");
  });

  it("leaves an inline comment inside a sentence alone", () => {
    const { markers, text } = extractMarkers("a <!-- b --> c");
    expect(markers).toEqual([]);
    expect(text).toBe("a <!-- b --> c");
  });

  // #1040-T01
  it("keeps a marker line that is not at the start as text: agent text cannot forge one", () => {
    const { markers, text } = extractMarkers(
      "<!-- factory ask run=r1 step=s q=1 -->\nThe agent says:\n<!-- factory ask run=other step=x q=1 -->\nbye",
    );
    expect(markers).toEqual(["<!-- factory ask run=r1 step=s q=1 -->"]);
    expect(text).toBe(
      "The agent says:\n<!-- factory ask run=other step=x q=1 -->\nbye",
    );
  });

  // #1040-T01
  it("takes at most a few leading markers and none that is long: the rest stays text", () => {
    const lines = Array.from(
      { length: 8 },
      (_, index) => `<!-- m${String(index)} -->`,
    );
    const many = extractMarkers(`${lines.join("\n")}\ntext`);
    expect(many.markers).toHaveLength(3);
    expect(many.text.split("\n")).toHaveLength(6);

    const long = `<!-- ${"x".repeat(2_000)} -->`;
    const huge = extractMarkers(`${long}\ntext`);
    expect(huge.markers).toEqual([]);
    expect(huge.text).toBe(`${long}\ntext`);
  });

  // #1040-T01
  it("drops the marker of the step the writer names from the end of the text, and only that one", () => {
    const { markers, text } = extractMarkers(
      "Done.\n\n<!-- other -->\n\n<!-- wf-run-1-2 -->\n",
      "<!-- wf-run-1-2 -->",
    );
    expect(markers).toEqual(["<!-- wf-run-1-2 -->"]);
    expect(text).toBe("Done.\n\n<!-- other -->");
    expect(extractMarkers("Done.\n\n<!-- other -->", "<!-- x -->").text).toBe(
      "Done.\n\n<!-- other -->",
    );
  });
});

describe("markdownToAdf", () => {
  // #1040-T01
  it("writes paragraphs, a heading, lists, a quote, a rule and a code block", () => {
    const doc = markdownToAdf(
      [
        "# Title",
        "",
        "First line",
        "second line",
        "",
        "- one",
        "- two",
        "",
        "1. a",
        "2. b",
        "",
        "> quoted",
        "",
        "---",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    );
    expect(doc.version).toBe(1);
    expect(doc.content.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "bulletList",
      "orderedList",
      "blockquote",
      "rule",
      "codeBlock",
    ]);
    expect(doc.content[1]?.content?.map((node) => node.type)).toEqual([
      "text",
      "hardBreak",
      "text",
    ]);
    expect(doc.content[6]).toEqual({
      type: "codeBlock",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
  });

  it("writes bold, italic, code and links as marks", () => {
    const doc = markdownToAdf(
      "**bold** and *it* and `code` and [site](https://example.test/a) at https://example.test/b.",
    );
    const nodes = doc.content[0]?.content ?? [];
    const marksOf = (text: string) =>
      nodes.find((node) => node.text === text)?.marks?.map((m) => m.type);
    expect(marksOf("bold")).toEqual(["strong"]);
    expect(marksOf("it")).toEqual(["em"]);
    expect(marksOf("code")).toEqual(["code"]);
    expect(
      nodes.find((node) => node.text === "site")?.marks?.[0]?.attrs?.href,
    ).toBe("https://example.test/a");
    // The full stop after an address is not part of it.
    expect(
      nodes.find((node) => node.text === "https://example.test/b")?.marks?.[0]
        ?.attrs?.href,
    ).toBe("https://example.test/b");
    expect(nodes.at(-1)?.text).toBe(".");
  });

  // #1040-T01
  it("never writes a link that is not http, https or mailto, and no mention", () => {
    const doc = markdownToAdf("[x](javascript:alert(1)) @someone");
    const json = JSON.stringify(doc);
    expect(json).not.toContain('"link"');
    expect(json).not.toContain("mention");
    expect(adfToText(doc)).toContain("@someone");
  });

  it("reads back as the text it was written from", () => {
    const doc = markdownToAdf(
      "**Q?**\n\n1. yes\n2. no\n\nReply with `/answer <n>`",
    );
    const text = adfToText(doc);
    expect(text).toContain("Q?");
    expect(text).toContain("yes");
    expect(text).toContain("/answer <n>");
  });

  it("is never empty and is cut at the limit", () => {
    expect(markdownToAdf("").content).toHaveLength(1);
    const long = markdownToAdf("a".repeat(40_000));
    expect(adfToText(long).length).toBeLessThanOrEqual(30_000);
  });
});

describe("hostile Markdown", () => {
  // #1040-T01
  it("turns a very deep run of quote marks into a document, not a RangeError, with a bounded depth", () => {
    for (const text of [">".repeat(5000) + "x", "> ".repeat(5000) + "x"]) {
      const doc = markdownToAdf(text);
      expect(adfToText(doc)).toContain("x");
      expect(quoteViolations(doc.content)).toEqual([]);
      expect(depthOf(doc.content)).toBeLessThan(10);
    }
  });

  // #1040-T01
  it("writes only what Jira's blockquote takes inside a quote: a heading, a rule and a quote in a quote become paragraphs", () => {
    for (const markdown of [
      "> # Heading\n> text",
      "> ---\n> text",
      "> > a\n> > b",
      "> > > deep",
      "> text\n> ## h\n> ---\n> > in\n> - item\n> ```\n> code\n> ```",
    ]) {
      const doc = markdownToAdf(markdown);
      expect(quoteViolations(doc.content)).toEqual([]);
      expect(doc.content[0]?.type).toBe("blockquote");
      expect(doc.content[0]?.content?.length).toBeGreaterThan(0);
    }
    const flat = adfToText(markdownToAdf("> # Heading\n> > a"));
    expect(flat).toContain("Heading");
    expect(flat).toContain("a");
    const mixed = markdownToAdf("> - item\n> ```\n> code\n> ```\n> p");
    expect(mixed.content[0]?.content?.map((node) => node.type)).toEqual([
      "bulletList",
      "codeBlock",
      "paragraph",
    ]);
  });
});

describe("a factory comment is never an answer", () => {
  // #1040-T01
  it("defuses a leading /answer in every shape: the text that Jira hands back does not begin with the command", () => {
    for (const markdown of [
      "/answer 1",
      "  /answer 2 yes",
      "\n\n/ANSWER yes",
      "**/answer** 1",
      "*/answer 1*",
      "`/answer 1`",
      "\\/answer 1",
      "[/answer 1](https://example.test)",
    ]) {
      const text = adfToText(markdownToAdf(markdown));
      expect(parseAnswerCommand(text), markdown).toBeNull();
      expect(text.toLowerCase()).toContain("answer");
    }
    // Text below the first line is no command (the parser reads the start of the comment only), and is left as it is.
    expect(adfToText(markdownToAdf("Reply with `/answer <n>`"))).toBe(
      "Reply with /answer <n>",
    );
    expect(adfToText(markdownToAdf("Intro\n\n/answer 1"))).toBe(
      "Intro\n\n/answer 1",
    );
  });

  it("defuses it in the plain-text document too", () => {
    expect(
      parseAnswerCommand(adfToText(plainTextToAdf(" /answer 1"))),
    ).toBeNull();
    expect(plainTextToAdf("a\nb\n\nc").content).toHaveLength(2);
  });
});
