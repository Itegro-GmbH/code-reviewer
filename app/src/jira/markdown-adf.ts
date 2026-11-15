// SPDX-License-Identifier: LicenseRef-Proprietary

// Our Markdown as Atlassian Document Format (#1040): what the factory writes below a Jira issue (a lane's comment, the question of an agent)
// is Markdown, and Jira Cloud's REST API v3 takes comments as ADF only. A small, closed converter for the Markdown the factory itself
// writes: paragraphs, headings, bullet and numbered lists, block quotes, fenced code, rules, and inside a line code, bold, italic and links.
// Anything else is text. The input is partly written by agents and by whoever opened the ticket (untrusted): it only ever becomes text,
// marks and links with an http(s) or mailto address, never a mention, a media node or anything else that reaches somebody. Pure.
//
// The hidden markers the factory puts in its comments (`<!-- factory ask run=… -->`, an HTML comment on a line of its own) are not
// written into the document (ADF cannot hide text); `extractMarkers` returns them so that the provider can keep them in a comment
// property of Jira instead, where the factory finds its own comment again. The factory writes its markers first, so only the lines at the
// start of the comment are markers (and only a few, none long); the same line further down is text of an agent and stays text.
//
// A comment of the factory is written as the person who connected Jira, so the webhook sees it as that person's comment: it must never begin
// with `/answer` (`defuseAnswer`), or a factory comment could answer a question. And the result is valid for Jira's schema (a blockquote holds
// paragraphs, lists and code only; the depth of quotes is bounded), because Jira answers a document it does not take with a 400.
import { parseAnswerCommand } from "../integrations/comment-command.ts";
import { adfToText } from "./adf.ts";

/** A node of an ADF document: the shapes this converter writes. */
export type AdfNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
};
export type AdfDocument = { version: 1; type: "doc"; content: AdfNode[] };

/** A comment is cut here (Jira refuses a body of more than about 32 000 characters of ADF text). */
export const ADF_TEXT_MAX_CHARS = 30_000;

const MARKER_LINE = /^[ \t]*<!--[^\n]*?-->[ \t]*$/;

/** How many marker lines at the start of a comment count (the factory writes one), and how long one may be: the property stays small. */
export const MARKERS_MAX = 3;
export const MARKER_MAX_CHARS = 300;

/**
 * The HTML-comment markers at the start of a Markdown text (one per line of their own, in order) and the text without those lines. A line
 * of the same shape further down is text. `own` is the marker of the step that wrote the comment (the connectors of GitHub put it at the
 * end of the body): that line is taken from the end too.
 */
export function extractMarkers(
  markdown: string,
  own?: string,
): {
  markers: string[];
  text: string;
} {
  const lines = markdown.split(/\r?\n/);
  const markers: string[] = [];
  let at = 0;
  while (
    at < lines.length &&
    markers.length < MARKERS_MAX &&
    MARKER_LINE.test(lines[at] ?? "") &&
    (lines[at] ?? "").trim().length <= MARKER_MAX_CHARS
  ) {
    markers.push((lines[at] ?? "").trim());
    at += 1;
  }
  const kept = lines.slice(at);
  if (own !== undefined) {
    let end = kept.length;
    while (end > 0 && (kept[end - 1] ?? "").trim() === "") end -= 1;
    if (end > 0 && (kept[end - 1] ?? "").trim() === own.trim()) {
      markers.push(own.trim());
      kept.length = end - 1;
      while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "")
        kept.pop();
    }
  }
  return { markers, text: kept.join("\n") };
}

const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s<>"]{1,2000}$/i;

function textNode(text: string, marks: AdfNode["marks"] = []): AdfNode {
  return {
    type: "text",
    text,
    ...(marks.length === 0 ? {} : { marks }),
  };
}

/** The inline Markdown of one line as text nodes with marks. An unclosed mark is text. */
function inline(
  source: string,
  marks: NonNullable<AdfNode["marks"]> = [],
): AdfNode[] {
  const nodes: AdfNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain !== "") nodes.push(textNode(plain, marks));
    plain = "";
  };
  let at = 0;
  while (at < source.length) {
    const rest = source.slice(at);
    const char = source.charAt(at);
    if (char === "\\" && at + 1 < source.length) {
      plain += source.charAt(at + 1);
      at += 2;
      continue;
    }
    if (char === "`") {
      const close = source.indexOf("`", at + 1);
      if (close > at + 1) {
        flush();
        // A code mark takes no other mark, except a link.
        nodes.push(
          textNode(source.slice(at + 1, close), [
            ...marks.filter((mark) => mark.type === "link"),
            { type: "code" },
          ]),
        );
        at = close + 1;
        continue;
      }
    }
    const strong = /^\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/.exec(rest);
    if (strong !== null) {
      flush();
      nodes.push(...inline(strong[1] ?? "", [...marks, { type: "strong" }]));
      at += strong[0].length;
      continue;
    }
    const emphasis = /^(\*|_)(?=\S)([^*_]+?)(?<=\S)\1(?![A-Za-z0-9])/.exec(
      rest,
    );
    if (
      emphasis !== null &&
      (char === "*" || at === 0 || /\W/.test(source.charAt(at - 1)))
    ) {
      flush();
      nodes.push(...inline(emphasis[2] ?? "", [...marks, { type: "em" }]));
      at += emphasis[0].length;
      continue;
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      const href = link[2] ?? "";
      if (SAFE_HREF.test(href)) {
        flush();
        nodes.push(
          ...inline(link[1] ?? "", [
            ...marks.filter((mark) => mark.type !== "link"),
            { type: "link", attrs: { href } },
          ]),
        );
        at += link[0].length;
        continue;
      }
    }
    const bare = /^https?:\/\/[^\s<>"]+/i.exec(rest);
    if (bare !== null && !marks.some((mark) => mark.type === "link")) {
      // A trailing punctuation mark belongs to the sentence, not to the address.
      const address = bare[0].replace(/[.,;:!?)\]]+$/, "");
      if (SAFE_HREF.test(address)) {
        flush();
        nodes.push(
          textNode(address, [
            ...marks,
            { type: "link", attrs: { href: address } },
          ]),
        );
        at += address.length;
        continue;
      }
    }
    plain += char;
    at += 1;
  }
  flush();
  return nodes;
}

/** The lines of a paragraph as inline nodes, a line break between them. */
function paragraphNodes(lines: readonly string[]): AdfNode[] {
  const nodes: AdfNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: "hardBreak" });
    nodes.push(...inline(line.trim()));
  });
  return nodes;
}

const paragraph = (lines: readonly string[]): AdfNode => ({
  type: "paragraph",
  content: paragraphNodes(lines),
});

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^( {0,3})[-*+]\s+(.*)$/;
const ORDERED = /^( {0,3})\d{1,9}[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    QUOTE.test(line) ||
    RULE.test(line)
  );
}

/** Quotes inside quotes: Jira's blockquote holds no quote, so what is deeper than this is text of the paragraph it is in. */
const QUOTE_DEPTH_MAX = 5;
const QUOTE_PREFIX = /^(?: {0,3}>[ ]?)+/;

/** `depth` is the number of quotes the lines are in; inside a quote only paragraphs, lists and code are written (Jira's schema). */
function blocks(lines: readonly string[], depth = 0): AdfNode[] {
  const inQuote = depth > 0;
  const out: AdfNode[] = [];
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    if (line.trim() === "") {
      at += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const mark = fence[1] ?? "```";
      const body: string[] = [];
      at += 1;
      while (at < lines.length) {
        const next = lines[at] ?? "";
        at += 1;
        if (next.trim().startsWith(mark)) break;
        body.push(next);
      }
      const code = body.join("\n");
      out.push({
        type: "codeBlock",
        ...((fence[2] ?? "") === "" ? {} : { attrs: { language: fence[2] } }),
        content: code === "" ? [] : [{ type: "text", text: code }],
      });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const content = inline((heading[2] ?? "").trim());
      out.push(
        inQuote
          ? { type: "paragraph", content }
          : {
              type: "heading",
              attrs: { level: (heading[1] ?? "#").length },
              content,
            },
      );
      at += 1;
      continue;
    }
    if (RULE.test(line)) {
      if (!inQuote) out.push({ type: "rule" });
      at += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? "")) {
        quoted.push(QUOTE.exec(lines[at] ?? "")?.[1] ?? "");
        at += 1;
      }
      if (depth >= QUOTE_DEPTH_MAX) {
        out.push(paragraph(quoted.map((q) => q.replace(QUOTE_PREFIX, ""))));
        continue;
      }
      const inner = blocks(quoted, depth + 1);
      // A quote in a quote is not nested (Jira refuses that): its blocks are the blocks of the quote around it.
      if (inQuote) out.push(...inner);
      else
        out.push({
          type: "blockquote",
          content: inner.length === 0 ? [paragraph([""])] : inner,
        });
      continue;
    }
    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      const pattern = ordered ? ORDERED : BULLET;
      const items: AdfNode[] = [];
      while (at < lines.length && pattern.test(lines[at] ?? "")) {
        const item: string[] = [pattern.exec(lines[at] ?? "")?.[2] ?? ""];
        at += 1;
        // A line that is indented belongs to the item (a wrapped line); anything else ends it.
        while (
          at < lines.length &&
          /^ {2,}\S/.test(lines[at] ?? "") &&
          !pattern.test(lines[at] ?? "")
        ) {
          item.push(lines[at] ?? "");
          at += 1;
        }
        items.push({ type: "listItem", content: [paragraph(item)] });
      }
      out.push({
        type: ordered ? "orderedList" : "bulletList",
        content: items,
      });
      continue;
    }
    const text: string[] = [line];
    at += 1;
    while (
      at < lines.length &&
      (lines[at] ?? "").trim() !== "" &&
      !isBlockStart(lines[at] ?? "")
    ) {
      text.push(lines[at] ?? "");
      at += 1;
    }
    out.push(paragraph(text));
  }
  return out;
}

/** The text cut at the limit of a comment (counted in characters, not in UTF-16 units). */
function bounded(text: string): string {
  const characters = Array.from(text);
  return characters.length > ADF_TEXT_MAX_CHARS
    ? `${characters.slice(0, ADF_TEXT_MAX_CHARS - 1).join("")}…`
    : text;
}

const ZERO_WIDTH_SPACE = "\u200b";

/**
 * Makes sure the text of the document does not begin with `/answer` (the way the webhook reads a comment, whatever the formatting around
 * it): an invisible character goes in front of the first word. The document is changed in place.
 */
function defuseAnswer(doc: AdfDocument): AdfDocument {
  if (parseAnswerCommand(adfToText(doc)) === null) return doc;
  const first = (nodes: readonly AdfNode[]): AdfNode | undefined => {
    for (const node of nodes) {
      if (node.type === "text" && (node.text ?? "").trim() !== "") return node;
      const inner = first(node.content ?? []);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  const node = first(doc.content);
  if (node?.text !== undefined)
    node.text = node.text.replace(/^(\s*)/, `$1${ZERO_WIDTH_SPACE}`);
  return doc;
}

/** The ADF document of a Markdown text (markers already taken out with `extractMarkers`). Never empty: Jira refuses a document without content. */
export function markdownToAdf(markdown: string): AdfDocument {
  const content = blocks(bounded(markdown).replace(/\r\n?/g, "\n").split("\n"));
  return defuseAnswer({
    version: 1,
    type: "doc",
    content: content.length === 0 ? [paragraph(["(empty)"])] : content,
  });
}

/** The text as it is, no Markdown: paragraphs at the blank lines, a line break between lines. What a comment falls back to when Jira refuses the formatted one. */
export function plainTextToAdf(text: string): AdfDocument {
  const paragraphs = bounded(text)
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((part) => part.split("\n").filter((line) => line.trim() !== ""))
    .filter((lines) => lines.length > 0)
    .map((lines): AdfNode => ({
      type: "paragraph",
      content: lines.flatMap((line, index) => [
        ...(index === 0 ? [] : [{ type: "hardBreak" }]),
        { type: "text", text: line.trim() },
      ]),
    }));
  return defuseAnswer({
    version: 1,
    type: "doc",
    content: paragraphs.length === 0 ? [paragraph(["(empty)"])] : paragraphs,
  });
}
