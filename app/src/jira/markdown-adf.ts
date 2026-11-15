// SPDX-License-Identifier: LicenseRef-Proprietary

// Our Markdown as Atlassian Document Format (#1040): what the factory writes below a Jira issue (a lane's comment, the question of an agent)
// is Markdown, and Jira Cloud's REST API v3 takes comments as ADF only. A small, closed converter for the Markdown the factory itself
// writes: paragraphs, headings, bullet and numbered lists, block quotes, fenced code, rules, and inside a line code, bold, italic and links.
// Anything else is text. The input is partly written by agents and by whoever opened the ticket (untrusted): it only ever becomes text,
// marks and links with an http(s) or mailto address, never a mention, a media node or anything else that reaches somebody. Pure.
//
// The hidden markers the factory puts in its comments (`<!-- factory ask run=… -->`, an HTML comment on a line of its own) are not
// written into the document (ADF cannot hide text); `extractMarkers` returns them so that the provider can keep them in a comment
// property of Jira instead, where the factory finds its own comment again.

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

/** The HTML-comment markers of a Markdown text (one per line of their own, in order) and the text without those lines. */
export function extractMarkers(markdown: string): {
  markers: string[];
  text: string;
} {
  const markers: string[] = [];
  const kept: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (MARKER_LINE.test(line)) markers.push(line.trim());
    else kept.push(line);
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

function blocks(lines: readonly string[]): AdfNode[] {
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
      out.push({
        type: "heading",
        attrs: { level: (heading[1] ?? "#").length },
        content,
      });
      at += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ type: "rule" });
      at += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (at < lines.length && QUOTE.test(lines[at] ?? "")) {
        quoted.push(QUOTE.exec(lines[at] ?? "")?.[1] ?? "");
        at += 1;
      }
      const inner = blocks(quoted);
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

/** The ADF document of a Markdown text (markers already taken out with `extractMarkers`). Never empty: Jira refuses a document without content. */
export function markdownToAdf(markdown: string): AdfDocument {
  const bounded =
    Array.from(markdown).length > ADF_TEXT_MAX_CHARS
      ? `${Array.from(markdown)
          .slice(0, ADF_TEXT_MAX_CHARS - 1)
          .join("")}…`
      : markdown;
  const content = blocks(bounded.replace(/\r\n?/g, "\n").split("\n"));
  return {
    version: 1,
    type: "doc",
    content: content.length === 0 ? [paragraph(["(empty)"])] : content,
  };
}
