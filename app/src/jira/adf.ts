// SPDX-License-Identifier: LicenseRef-Proprietary

// The text of a Jira description or comment (#1039). Jira Cloud stores rich text as Atlassian Document Format (ADF), a JSON tree; the
// factory's neutral ticket has a plain text body. Block nodes are separated by a blank line, list items and table rows by a line break,
// inline marks are dropped (a link keeps its address). A node this reader does not know contributes the text inside it, never an
// error: Atlassian adds node types over time, and a ticket must stay readable. Pure; the input is untrusted data.

/** How deep nodes are followed: a hostile description cannot make the reader recurse without end. */
const MAX_DEPTH = 40;

type Node = {
  type?: unknown;
  text?: unknown;
  attrs?: unknown;
  marks?: unknown;
  content?: unknown;
};

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const children = (node: Node): Node[] =>
  Array.isArray(node.content) ? node.content.filter(isNode) : [];

const attr = (node: Node, name: string): unknown =>
  isNode(node.attrs)
    ? (node.attrs as Record<string, unknown>)[name]
    : undefined;

function linkOf(node: Node): string | undefined {
  if (!Array.isArray(node.marks)) return undefined;
  for (const mark of node.marks) {
    if (isNode(mark) && mark.type === "link") {
      const href = attr(mark, "href");
      if (typeof href === "string" && href !== "") return href;
    }
  }
  return undefined;
}

/** The blocks of a container, one blank line between them. */
function blocks(node: Node, depth: number): string {
  return children(node)
    .map((child) => render(child, depth + 1))
    .filter((text) => text !== "")
    .join("\n\n");
}

/** The inline content of a node as one string. */
function inline(node: Node, depth: number): string {
  return children(node)
    .map((child) => render(child, depth + 1))
    .join("");
}

function render(node: Node, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  switch (node.type) {
    case "text": {
      const text = typeof node.text === "string" ? node.text : "";
      const href = linkOf(node);
      return href === undefined || href === text ? text : `${text} (${href})`;
    }
    case "hardBreak":
      return "\n";
    case "rule":
      return "---";
    case "mention":
    case "emoji": {
      const text = attr(node, "text");
      if (typeof text === "string" && text !== "") return text;
      const short = attr(node, "shortName");
      return typeof short === "string" ? short : "";
    }
    case "inlineCard":
    case "blockCard": {
      const url = attr(node, "url");
      return typeof url === "string" ? url : "";
    }
    case "status": {
      const text = attr(node, "text");
      return typeof text === "string" ? text : "";
    }
    case "date": {
      const stamp = Number(attr(node, "timestamp"));
      return Number.isFinite(stamp) && stamp > 0
        ? new Date(stamp).toISOString().slice(0, 10)
        : "";
    }
    case "media":
    case "mediaSingle":
    case "mediaGroup":
    case "mediaInline":
      return "[attachment]";
    case "heading": {
      const level = Number(attr(node, "level"));
      const marks = "#".repeat(
        Number.isInteger(level) ? Math.min(6, Math.max(1, level)) : 1,
      );
      return `${marks} ${inline(node, depth)}`;
    }
    case "paragraph":
      return inline(node, depth);
    case "codeBlock":
      return `\`\`\`\n${inline(node, depth)}\n\`\`\``;
    case "blockquote":
      return blocks(node, depth)
        .split("\n")
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      return children(node)
        .map((item, index) => {
          const body = blocks(item, depth + 1).replace(/\n\n/g, "\n");
          return `${ordered ? `${String(index + 1)}.` : "-"} ${body}`;
        })
        .join("\n");
    }
    case "table":
      return children(node)
        .map((row) =>
          children(row)
            .map((cell) => blocks(cell, depth + 2).replace(/\n+/g, " "))
            .join(" | "),
        )
        .join("\n");
    default:
      // listItem, panel, expand, a node of a kind this reader does not know: the text inside it.
      return blocks(node, depth);
  }
}

/**
 * The plain text of an ADF document. A string (the older, non-rich description of Jira's v2 API) passes through; anything that is not a
 * document is the empty text.
 */
export function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isNode(value)) return "";
  return blocks(value, 0);
}
