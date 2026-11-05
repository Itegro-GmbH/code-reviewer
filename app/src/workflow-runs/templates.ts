// SPDX-License-Identifier: LicenseRef-Proprietary

// The references of a workflow at run time (#844): `{{trigger.input.x}}`, `{{step.field}}`, `{{step.branch}}`, each with its optional
// `| default <JSON>`. The validator decided where a reference may point; this resolves it against the values the run has. Pure.
//
// Values are data. A text is built in one pass from the parts of the template; what a reference yields is inserted as it is and never
// read again, so a result that holds `{{` or an instruction does nothing here. The default of a reference is a JSON value taken as it
// is. A value of an agent step that goes into the text of an action (a title, a comment) is defused: it cannot mention a person or a
// team, nor name an issue a pull request would close, nor rebuild the marker of a comment (`defuseSegments`). The text is defused
// once it is put together, so what a boundary between two parts would form (`@` and `octocat`) is caught too. A value that goes into a text is cleaned of control characters (the Implementer refuses them) and cut at
// `TEMPLATE_VALUE_MAX_CHARS` with a note that says so; the text as a whole must fit the bound of the place it goes to, or the step
// fails: nothing is cut silently where it would change what a person reads as the task. A value that is missing, and has no default,
// fails the step with the path that was missing.
import { isRecord, textLength } from "../workflows/json.ts";
import {
  isWholeReference,
  parseTemplate,
  renderValue,
  type ParsedTemplate,
  type Reference,
} from "../workflows/template.ts";
import { TEMPLATE_TEXT_MAX_CHARS, TEMPLATE_VALUE_MAX_CHARS } from "./limits.ts";

/** What a reference can reach: the trigger (`trigger.input.…`) and the output of each step that ended, by step id. */
export type RunValues = {
  trigger: Record<string, unknown>;
  steps: Readonly<Record<string, unknown>>;
  /** The ids of the steps in `steps` that an agent produced: what they report is text an agent wrote, not a literal of the workflow. */
  agentSteps?: ReadonlySet<string>;
};

export type RenderOptions = {
  /** For the text of an action: what an agent step reported is defused. Literals of the workflow and values of the trigger stay as they are. */
  defuse?: boolean;
  /** The text is no Markdown (a title): code spans and fences hide nothing there, so nothing is left out of the defusing. */
  plain?: boolean;
};

const ZERO_WIDTH_SPACE = "\u200b";

/** A part of a text that is put together; `agent` for what an agent step reported. */
export type TextSegment = { text: string; agent: boolean };

const NAME_CHARACTER = /[A-Za-z0-9_-]/;
const WORD_CHARACTER = /[A-Za-z0-9_]/;
// An issue number: no leading-zero-only number (`#000` is a colour), and no letter after it (a hex colour such as `#` + `1a2b3c` is not a reference).
const ISSUE_NUMBER = /0*[1-9][0-9]*(?![A-Za-z0-9_])/y;
const ISSUE_ADDRESS = /\/(?:issues|pull)\/(?=[0-9])/y;
// `owner/repo` right before a `#`; not the tail of a longer path or address (`github.com/acme/api#3` is no reference).
const REPOSITORY_BEFORE =
  /(?<![A-Za-z0-9_.\/-])[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/;
// The characters `@` and `#` as HTML entities (decimal, hexadecimal, named), with or without the closing `;`.
const AT_OR_NUMBER_ENTITY =
  /&(?:#0*(?:64|35)(?![0-9])|#x0*(?:40|23)(?![0-9a-f])|commat(?![a-z0-9])|num(?![a-z0-9]))/iy;
// A line that starts a block of its own (a list item, a quote, a heading, a rule, a tag): a code span does not run across it.
const BLOCK_START =
  /^ {0,3}(?:[-+*](?:\s|$)|\d{1,9}[.)](?:\s|$)|#{1,6}(?:\s|$)|>|<|[-*_=]{3,}\s*$)/;
const INDENTED = /^(?: {4}|\t)/;
const OPENING_FENCE = /^ {0,3}(`{3,})[^`]*$|^ {0,3}(~{3,})/;

/** The ranges `[from, to)` of a Markdown text that are code: fenced blocks (open until the end if never closed) and code spans. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { mark: string; length: number; from: number } | undefined;
  let paragraph: { from: number; text: string } | undefined;
  const closeParagraph = () => {
    if (paragraph !== undefined) spans(paragraph.text, paragraph.from, ranges);
    paragraph = undefined;
  };
  let offset = 0;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    if (fence !== undefined) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
      if (
        closing !== undefined &&
        closing.startsWith(fence.mark) &&
        closing.length >= fence.length
      ) {
        ranges.push([fence.from, end]);
        fence = undefined;
      }
    } else {
      const opening = OPENING_FENCE.exec(line);
      const run = opening?.[1] ?? opening?.[2];
      if (run !== undefined) {
        closeParagraph();
        fence = { mark: run.charAt(0), length: run.length, from: offset };
      } else if (line.trim() === "") closeParagraph();
      else if (paragraph === undefined && INDENTED.test(line)) {
        // Code or part of a nested block: its backticks open nothing, and it is not left out of the defusing.
      } else if (line.includes("|")) closeParagraph();
      // A table row: a pipe cuts a code span, so nothing in it is left out.
      else {
        if (BLOCK_START.test(line)) closeParagraph();
        paragraph =
          paragraph === undefined
            ? { from: offset, text: line }
            : { from: paragraph.from, text: `${paragraph.text}\n${line}` };
      }
    }
    offset = end + 1;
  }
  closeParagraph();
  if (fence !== undefined) ranges.push([fence.from, text.length]);
  return ranges;
}

/** The code spans of one paragraph: a run of backticks closed by the next run of the same length; a backslash escapes the next character. */
function spans(
  paragraph: string,
  from: number,
  ranges: Array<[number, number]>,
): void {
  let at = 0;
  while (at < paragraph.length) {
    const character = paragraph.charAt(at);
    if (character === "\\") at += 2;
    else if (character !== "`") at += 1;
    else {
      let length = 1;
      while (paragraph.charAt(at + length) === "`") length += 1;
      let close = at + length;
      let closed = false;
      while (!closed && close < paragraph.length) {
        if (paragraph.charAt(close) !== "`") close += 1;
        else {
          let run = 1;
          while (paragraph.charAt(close + run) === "`") run += 1;
          if (run === length) closed = true;
          else close += run;
        }
      }
      if (closed) {
        ranges.push([from + at, from + close + length]);
        at = close + length;
      } else at += length;
    }
  }
}

/**
 * Text an agent wrote, made harmless where GitHub reads it. A zero-width space goes after `@` that is followed by a name (no
 * `@name`, no `@org/team`; `john@example.com` stays), after the `#` of an issue reference (`#12`, `owner/repo#12`: no link, and no
 * `Closes #12` that closes anything; `#000`, a hex colour with letters, `[link](#2-section)` stay), after `GH-` before a number, before the number of
 * an issue or pull request address, and inside `<!--` (no marker of a comment can be rebuilt). `@` and `#` as HTML entities get
 * `&amp;` for their `&`. Code (a fenced block, a code span) mentions nobody and is left out, except for `<!--`, which is read
 * from the raw text. The text reads the same to a person.
 *
 * The parts are looked at as one text: a zero-width space also goes where an agent's part begins or ends at the point of such a
 * pattern (`@` and `octocat`; `Closes #` and `12`; `<!-` and `-`). Only trigger values and literals of the workflow stay raw.
 */
export function defuseSegments(
  segments: readonly TextSegment[],
  options: { plain?: boolean } = {},
): string {
  const text = segments.map((segment) => segment.text).join("");
  const agent: Array<[number, number]> = [];
  let at = 0;
  for (const segment of segments) {
    if (segment.agent) agent.push([at, at + segment.text.length]);
    at += segment.text.length;
  }
  if (agent.length === 0) return text;

  const code = new Uint8Array(text.length);
  if (options.plain !== true)
    for (const [from, to] of codeRanges(text)) code.fill(1, from, to);
  const inserts = new Map<number, string>();
  const insert = (point: number, extra: string) => {
    if (agent.some(([from, to]) => from <= point && point <= to))
      inserts.set(point, extra);
  };
  for (let i = 0; i < text.length; i += 1) {
    const character = text.charAt(i);
    if (character === "<" && text.startsWith("<!--", i)) {
      insert(i + 3, ZERO_WIDTH_SPACE);
      continue;
    }
    if (code[i] === 1) continue;
    const before = i === 0 ? "" : text.charAt(i - 1);
    if (character === "@") {
      if (
        NAME_CHARACTER.test(text.charAt(i + 1)) &&
        !WORD_CHARACTER.test(before)
      )
        insert(i + 1, ZERO_WIDTH_SPACE);
    } else if (character === "#") {
      ISSUE_NUMBER.lastIndex = i + 1;
      if (
        ISSUE_NUMBER.test(text) &&
        before !== "&" &&
        text.slice(Math.max(0, i - 2), i) !== "](" &&
        (!WORD_CHARACTER.test(before) ||
          REPOSITORY_BEFORE.test(text.slice(Math.max(0, i - 140), i)))
      )
        insert(i + 1, ZERO_WIDTH_SPACE);
    } else if (character === "G" || character === "g") {
      if (
        /^gh-[0-9]/i.test(text.slice(i, i + 4)) &&
        !WORD_CHARACTER.test(before)
      )
        insert(i + 3, ZERO_WIDTH_SPACE);
    } else if (character === "/") {
      ISSUE_ADDRESS.lastIndex = i;
      const found = ISSUE_ADDRESS.exec(text);
      if (found !== null) insert(i + found[0].length, ZERO_WIDTH_SPACE);
    } else if (character === "&") {
      AT_OR_NUMBER_ENTITY.lastIndex = i;
      if (AT_OR_NUMBER_ENTITY.test(text)) insert(i + 1, "amp;");
    }
  }
  if (inserts.size === 0) return text;
  let result = "";
  for (let i = 0; i <= text.length; i += 1)
    result += `${inserts.get(i) ?? ""}${text.charAt(i)}`;
  return result;
}

/** One text an agent wrote, defused as a whole (`defuseSegments`). */
export function defuseMentions(text: string): string {
  return defuseSegments([{ text, agent: true }]);
}

export type TemplateFailureCode =
  "template_missing_value" | "template_invalid" | "template_too_large";

export class TemplateError extends Error {
  readonly code: TemplateFailureCode;
  constructor(code: TemplateFailureCode, message: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

// Control characters other than tab, line feed and carriage return; a lone surrogate half is not text at all (the Implementer refuses both).
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** A text without the characters no task text may hold. */
export function cleanText(text: string): string {
  return text.replace(CONTROL, "").replace(LONE_SURROGATE, "�");
}

/** The value of a reference, or `undefined` when the run has none (a missing field, a step that did not run). */
function lookup(path: readonly string[], values: RunValues): unknown {
  const [root, ...rest] = path;
  let at: unknown;
  if (root === "trigger") at = values.trigger;
  else if (root !== undefined && Object.hasOwn(values.steps, root))
    at = values.steps[root];
  else return undefined;
  for (const name of rest) {
    if (!isRecord(at) || !Object.hasOwn(at, name)) return undefined;
    at = at[name];
  }
  return at;
}

function resolveReference(ref: Reference, values: RunValues): unknown {
  const found = lookup(ref.path, values);
  if (found !== undefined && found !== null) return found;
  if (ref.default !== undefined) return ref.default.value;
  throw new TemplateError(
    "template_missing_value",
    `The value ${ref.path.join(".")} does not exist in this run, and the reference has no default.`,
  );
}

function parsed(text: string): ParsedTemplate {
  const result = parseTemplate(text);
  if (result.problems.length > 0)
    throw new TemplateError(
      "template_invalid",
      result.problems[0] ?? "The text is not a template.",
    );
  return result;
}

/**
 * The value of a text that is exactly one reference, with its type (a number, a list, a whole object); any other text is the text
 * itself with its references rendered. For the inputs of an action, where a number or a list is wanted.
 */
export function resolveValue(
  text: string,
  values: RunValues,
  options: RenderOptions = {},
): unknown {
  const template = parsed(text);
  const only = template.parts[0];
  if (isWholeReference(template) && only !== undefined && "ref" in only)
    return resolveReference(only.ref, values);
  return renderParts(template, values, TEMPLATE_TEXT_MAX_CHARS, options);
}

function insertable(value: unknown, path: string): string {
  if (isRecord(value))
    throw new TemplateError(
      "template_invalid",
      `The value ${path} is an object and has no text form; refer to one of its fields.`,
    );
  const clean = cleanText(renderValue(value));
  if (textLength(clean) <= TEMPLATE_VALUE_MAX_CHARS) return clean;
  const kept = Array.from(clean).slice(0, TEMPLATE_VALUE_MAX_CHARS).join("");
  return `${kept}… [cut: the value was ${textLength(clean)} characters long]`;
}

function renderParts(
  template: ParsedTemplate,
  values: RunValues,
  maxChars: number,
  options: RenderOptions = {},
): string {
  const segments: TextSegment[] = template.parts.map((part) =>
    "text" in part
      ? { text: part.text, agent: false }
      : {
          text: insertable(
            resolveReference(part.ref, values),
            part.ref.path.join("."),
          ),
          agent: values.agentSteps?.has(part.ref.path[0] ?? "") === true,
        },
  );
  const text =
    options.defuse === true
      ? defuseSegments(segments, { plain: options.plain === true })
      : segments.map((segment) => segment.text).join("");
  if (textLength(text) > maxChars)
    throw new TemplateError(
      "template_too_large",
      `The text is ${textLength(text)} characters long once its references are filled in; at most ${maxChars} fit.`,
    );
  return text;
}

/** A text with its references filled in. */
export function renderText(
  text: string,
  values: RunValues,
  maxChars: number = TEMPLATE_TEXT_MAX_CHARS,
  options: RenderOptions = {},
): string {
  return renderParts(parsed(text), values, maxChars, options);
}
