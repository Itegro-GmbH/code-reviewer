// SPDX-License-Identifier: LicenseRef-Proprietary

// The text of a Jira description or comment (#1039): Jira stores them as Atlassian Document Format, the factory reads plain text.
import { describe, expect, it } from "vitest";
import { adfToText } from "./adf.ts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const t = (text: string, marks?: unknown[]) => ({
  type: "text",
  text,
  ...(marks === undefined ? {} : { marks }),
});

describe("adfToText", () => {
  // #1039
  it("joins paragraphs with a blank line and keeps hard breaks as line breaks", () => {
    expect(
      adfToText(
        doc(
          p(t("First "), t("line"), { type: "hardBreak" }, t("second")),
          p(t("Next paragraph")),
        ),
      ),
    ).toBe("First line\nsecond\n\nNext paragraph");
  });

  // #1039
  it("writes headings, lists, quotes and code blocks as readable text", () => {
    const text = adfToText(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [t("Goal")] },
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [p(t("one"))] },
            { type: "listItem", content: [p(t("two"))] },
          ],
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [p(t("a"))] },
            { type: "listItem", content: [p(t("b"))] },
          ],
        },
        { type: "blockquote", content: [p(t("quoted"))] },
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [t("const x = 1;")],
        },
      ),
    );
    expect(text).toBe(
      "## Goal\n\n- one\n- two\n\n1. a\n2. b\n\n> quoted\n\n```\nconst x = 1;\n```",
    );
  });

  // #1039
  it("reads mentions, links, emoji and media as text and never fails on a node it does not know", () => {
    const text = adfToText(
      doc(
        p(
          { type: "mention", attrs: { id: "abc", text: "@Ada" } },
          t(" see "),
          t("the docs", [
            { type: "link", attrs: { href: "https://example.test/docs" } },
          ]),
          t(" "),
          { type: "emoji", attrs: { shortName: ":smile:", text: "🙂" } },
        ),
        {
          type: "mediaSingle",
          content: [{ type: "media", attrs: { id: "x" } }],
        },
        { type: "somethingNew", content: [p(t("inside the unknown"))] },
      ),
    );
    expect(text).toBe(
      "@Ada see the docs (https://example.test/docs) 🙂\n\n[attachment]\n\ninside the unknown",
    );
  });

  // #1039
  it("turns a table into one line per row", () => {
    const cell = (s: string) => ({
      type: "tableCell",
      content: [p(t(s))],
    });
    expect(
      adfToText(
        doc({
          type: "table",
          content: [
            { type: "tableRow", content: [cell("a"), cell("b")] },
            { type: "tableRow", content: [cell("c"), cell("d")] },
          ],
        }),
      ),
    ).toBe("a | b\nc | d");
  });

  // #1039
  it("passes a plain string through, and answers an empty text for anything else", () => {
    expect(adfToText("plain text")).toBe("plain text");
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
    expect(adfToText(42)).toBe("");
    expect(adfToText({ type: "doc" })).toBe("");
  });

  // #1039
  it("stops at a bounded depth instead of recursing without end", () => {
    let node: unknown = p(t("deep"));
    for (let i = 0; i < 500; i += 1)
      node = { type: "blockquote", content: [node] };
    expect(() => adfToText(doc(node))).not.toThrow();
  });
});
