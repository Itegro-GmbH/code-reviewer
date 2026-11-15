// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { adfToText } from "./adf.ts";
import { extractMarkers, markdownToAdf } from "./markdown-adf.ts";

describe("extractMarkers", () => {
  // #1040-T01
  it("takes the HTML-comment lines out of the text and returns them in order", () => {
    const { markers, text } = extractMarkers(
      "<!-- factory ask run=r1 step=s q=1 -->\nThe question\n\n<!-- run-key -->",
    );
    expect(markers).toEqual([
      "<!-- factory ask run=r1 step=s q=1 -->",
      "<!-- run-key -->",
    ]);
    expect(text).toBe("The question\n");
  });

  it("leaves an inline comment inside a sentence alone", () => {
    const { markers, text } = extractMarkers("a <!-- b --> c");
    expect(markers).toEqual([]);
    expect(text).toBe("a <!-- b --> c");
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
