// SPDX-License-Identifier: LicenseRef-Proprietary

// The references in the texts of a workflow (#833): `{{step.field}}`, optionally `{{step.field | default <JSON>}}`. No code, no
// functions: a path of names and, at most, a default written as a JSON value. `\{{` is a literal `{{`. Pure: it parses and renders,
// it does not know what a name refers to (that is `validate.ts`).
//
// Where a reference ends: at the first `}}` that is not inside a JSON string and does not close a `{` of the default. So
// `{{a.o | default {}}}` and `{{a.o | default "}}"}}` are one reference each. `REFERENCE_PATTERN` states the same thing as a regular
// expression, braces nested `DEFAULT_BRACE_DEPTH_MAX` deep: it is the `pattern` of `Reference` in `contracts/workflow.v1.json`, where a
// text must be exactly one reference, and the validator uses it for the same question.
import { DEFAULT_BRACE_DEPTH_MAX } from "./limits.ts";

export type Reference = {
  /** `["implement", "branch"]` */
  path: string[];
  /** The text between the braces, trimmed, for messages. */
  raw: string;
  /** Given with `| default <JSON>`; wrapped, because the default may itself be `null`-like falsy data. */
  default?: { value: unknown };
};

export type TemplatePart = { text: string } | { ref: Reference };

export type ParsedTemplate = {
  parts: TemplatePart[];
  /** What is wrong with the text, one sentence each. Empty when the template is well formed. */
  problems: string[];
};

const NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const JSON_STRING = String.raw`"(?:[^"\\]|\\[\s\S])*"`;
const PLAIN = String.raw`[^{}"]`;

/** A `{ … }` that holds text, JSON strings and, `levels - 1` deeper, more of itself. */
function braceGroup(levels: number): string {
  const inner = levels > 1 ? `|${braceGroup(levels - 1)}` : "";
  return String.raw`\{(?:${PLAIN}|${JSON_STRING}${inner})*\}`;
}

/**
 * Exactly one reference and nothing else: `{{`, text without braces and quotes in which only balanced braces and JSON strings may
 * hold `}`, `}}`. No whitespace around it. The branches of every alternation start with different characters, so a match is linear.
 */
export const REFERENCE_PATTERN = String.raw`^\{\{(?:${PLAIN}|${JSON_STRING}|${braceGroup(DEFAULT_BRACE_DEPTH_MAX)})*\}\}$`;

function parseReference(inner: string): Reference | string {
  const raw = inner.trim();
  if (raw === "") return "An empty {{ }} holds no reference.";
  const pipe = raw.indexOf("|");
  const pathText = (pipe === -1 ? raw : raw.slice(0, pipe)).trim();
  const path = pathText.split(".");
  if (!path.every((segment) => NAME.test(segment)))
    return `'${pathText}' is not a reference: write names joined by dots, like step.field (letters, digits, '_' and '-'; no indexes).`;
  if (pipe === -1) return { path, raw };
  const tail = raw.slice(pipe + 1).trim();
  if (!/^default(\s|$)/.test(tail))
    return `After '|' only 'default <JSON value>' is understood, not '${tail.slice(0, 30)}'.`;
  const literal = tail.slice("default".length).trim();
  try {
    return { path, raw, default: { value: JSON.parse(literal) as unknown } };
  } catch {
    return `The default of '${pathText}' must be a JSON value (a "text", a number, true, false, [] or {}), not '${literal.slice(0, 30)}'.`;
  }
}

/**
 * The index of the `}}` that closes the reference whose inner text starts at `from`: not inside a JSON string (where `\` skips the
 * next character), and not one that closes a `{` opened inside the reference.
 */
function findEnd(text: string, from: number): number | "open" | "too deep" {
  let depth = 0;
  let inString = false;
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (inString) {
      if (char === "\\") at += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") {
      depth += 1;
      if (depth > DEFAULT_BRACE_DEPTH_MAX) return "too deep";
    } else if (char === "}") {
      if (depth > 0) depth -= 1;
      else if (text[at + 1] === "}") return at;
    }
  }
  return "open";
}

export function parseTemplate(text: string): ParsedTemplate {
  const parts: TemplatePart[] = [];
  const problems: string[] = [];
  let literal = "";
  let index = 0;
  const flush = (): void => {
    if (literal !== "") parts.push({ text: literal });
    literal = "";
  };
  while (index < text.length) {
    if (text.startsWith("\\{{", index)) {
      literal += "{{";
      index += 3;
      continue;
    }
    if (!text.startsWith("{{", index)) {
      literal += text[index];
      index += 1;
      continue;
    }
    const end = findEnd(text, index + 2);
    if (end === "too deep") {
      problems.push(
        `A default may nest braces ${DEFAULT_BRACE_DEPTH_MAX} deep at most.`,
      );
      literal += text.slice(index);
      break;
    }
    if (end === "open") {
      problems.push(
        "A '{{' is never closed with '}}'. Write '\\{{' for a literal '{{'.",
      );
      literal += text.slice(index);
      break;
    }
    const parsed = parseReference(text.slice(index + 2, end));
    if (typeof parsed === "string") problems.push(parsed);
    else {
      flush();
      parts.push({ ref: parsed });
    }
    index = end + 2;
  }
  flush();
  return { parts, problems };
}

/** The whole text is one reference, so the value keeps its type instead of becoming text. */
export function isWholeReference(parsed: ParsedTemplate): boolean {
  return (
    parsed.problems.length === 0 &&
    parsed.parts.length === 1 &&
    "ref" in (parsed.parts[0] as TemplatePart)
  );
}

/** The text with its escapes undone when it holds no reference at all, `undefined` when it holds one or is not well formed. */
export function literalText(parsed: ParsedTemplate): string | undefined {
  if (parsed.problems.length > 0) return undefined;
  let text = "";
  for (const part of parsed.parts) {
    if (!("text" in part)) return undefined;
    text += part.text;
  }
  return text;
}

/**
 * How a value looks inside a text: a string as it is, a number or boolean as `3` or `true`, a list one entry per line starting with
 * `- ` (an entry that is an object as one line of JSON). An empty list is the empty text. An object on its own has no text form;
 * the validator refuses to put one in a text.
 */
export function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map(
        (entry: unknown) =>
          `- ${typeof entry === "object" && entry !== null ? JSON.stringify(entry) : renderValue(entry)}`,
      )
      .join("\n");
  return String(value);
}

/** The text of a template, given the value of each reference (the engine passes the run's values). */
export function renderTemplate(
  parsed: ParsedTemplate,
  valueOf: (path: string[]) => unknown,
): string {
  return parsed.parts
    .map((part) =>
      "text" in part ? part.text : renderValue(valueOf(part.ref.path)),
    )
    .join("");
}
