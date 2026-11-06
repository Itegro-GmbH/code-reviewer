// SPDX-License-Identifier: LicenseRef-Proprietary

// The references of a workflow at run time (#844): `{{trigger.input.x}}`, `{{step.field}}`, `{{step.branch}}`, each with its optional
// `| default <JSON>`. The validator decided where a reference may point; this resolves it against the values the run has. Pure.
//
// Values are data. A text is built in one pass from the parts of the template; what a reference yields is inserted as it is and never
// read again, so a result that holds `{{` or an instruction does nothing here. The default of a reference is a JSON value taken as it
// is. A value of an agent step that goes into the text of an action (a title, a comment) is defused, and so are the title, body and
// labels of the issue of a label trigger (#845: anyone who can open an issue wrote them), and the code and the message of a failure (#902: they may quote a
// connector, GitHub or a runner): it cannot mention a person or a
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
  /** The output of each step that succeeded; of a step that ran in several rounds, the latest. */
  steps: Readonly<Record<string, unknown>>;
  /** `previous.<step>`: the output a direct step of the innermost loop body had in the round before; empty in round one and outside loops. */
  previous?: Readonly<Record<string, unknown>>;
  /** #902: the facts of the failure the steps of `onFailure` read (`{{failure.status}}`, `.stepId`, `.code`, `.message`); not set in the steps of the workflow. */
  failure?: Readonly<Record<string, unknown>>;
  /** The ids of the steps in `steps` that an agent produced: what they report is text an agent wrote, not a literal of the workflow. */
  agentSteps?: ReadonlySet<string>;
};

export type RenderOptions = {
  /** For the text of an action: what an agent step reported, and the title, body and labels of the issue of a label trigger, are defused. Literals of the workflow and the other values of the trigger stay as they are. */
  defuse?: boolean;
  /** The text is no Markdown (a title): code spans and fences hide nothing there, so nothing is left out of the defusing. */
  plain?: boolean;
};

const ZERO_WIDTH_SPACE = "\u200b";

/**
 * The values of an issue a label started a run for (#845) that whoever opened the issue wrote: its title, its body and its labels.
 * They go into the text of an action defused, like what an agent wrote: an issue that says `@org/team` or `Closes #5` must not mention
 * that team or close that issue from a comment or a pull request the workflow writes. The number and the address are the platform's,
 * and so is the repository, and stay as they are (`Closes #{{trigger.issue.number}}` is the workflow's own sentence).
 */
const OUTSIDER_TRIGGER_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "body",
  "labels",
]);

/** What the failure of a run says besides its status and the id of a step of the workflow: a code a runner or a connector chose, and a message that may quote one. */
const FAILURE_TEXT_FIELDS: ReadonlySet<string> = new Set(["code", "message"]);

function isOutsiderText(path: readonly string[]): boolean {
  if (path[0] === "failure")
    return path[1] !== undefined && FAILURE_TEXT_FIELDS.has(path[1]);
  return (
    path[0] === "trigger" &&
    path[1] === "issue" &&
    path[2] !== undefined &&
    OUTSIDER_TRIGGER_FIELDS.has(path[2])
  );
}

/** Whether a reference reaches what an agent step wrote: a step by its id, or `previous.<step>` of the round before. */
function isAgentText(path: readonly string[], values: RunValues): boolean {
  const step = path[0] === "previous" ? path[1] : path[0];
  return values.agentSteps?.has(step ?? "") === true;
}

/** A part of a text that is put together; `agent` for what an agent step reported or an outsider wrote. */
export type TextSegment = { text: string; agent: boolean };

const NAME_CHARACTER = /[A-Za-z0-9_-]/;
const NAME_RUN = /[A-Za-z0-9_-]*/y;
// What GitHub does not take as part of a word in front of `@`, `#` and `GH-`: `_` is none (`_@octocat_` is emphasis around a mention).
const WORD_CHARACTER = /[A-Za-z0-9]/;
// An issue number: no leading-zero-only number (`#000` is a colour), and no letter after it (a hex colour such as `#` + `1a2b3c` is not a reference); `_` may follow (`_#1_`).
const ISSUE_NUMBER = /0*[1-9][0-9]*(?![A-Za-z0-9])/y;
const DIGITS = /[0-9]*/y;
// The start of HTML: `<` and a letter, `/` or `!` (a tag, a closing tag, a comment, a declaration).
const HTML_START = /<[A-Za-z\/!]/;
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
 * The parts are looked at as one text, after `cleanText` has taken out what no text may hold (direction marks, control characters):
 * nothing removes a character from it afterwards. A match is defused as soon as its range touches a part an agent wrote, where
 * the zero-width space goes (`@` and `octocat`; `Closes #` and `12`; `<!-` and `-`; a literal `cc @octo` and `cat`). Literals and
 * trigger values that touch no agent part stay raw. Where the text holds HTML (`<` and a letter, `/` or `!`), code is no longer left
 * out: HTML can end a code span early or make a block of it, and no parser here decides which.
 */
export function defuseSegments(
  segments: readonly TextSegment[],
  options: { plain?: boolean } = {},
): string {
  if (!segments.some((segment) => segment.agent && segment.text !== ""))
    return segments.map((segment) => segment.text).join("");
  // Nothing is removed from the text after this point.
  const cleaned = segments.map((segment) => ({
    text: cleanText(segment.text),
    agent: segment.agent,
  }));
  const text = cleaned.map((segment) => segment.text).join("");
  const agent: Array<[number, number]> = [];
  let at = 0;
  for (const segment of cleaned) {
    if (segment.agent && segment.text !== "")
      agent.push([at, at + segment.text.length]);
    at += segment.text.length;
  }

  const code = new Uint8Array(text.length);
  // Code is left out only where no HTML can end it early or turn it into something else.
  if (options.plain !== true && !HTML_START.test(text))
    for (const [from, to] of codeRanges(text)) code.fill(1, from, to);
  const inserts = new Map<number, string>();
  // A match is defused as soon as its range touches a part an agent wrote; the zero-width space goes at `point`.
  const insert = (from: number, to: number, point: number, extra: string) => {
    if (agent.some(([start, end]) => start < to && from < end))
      inserts.set(point, extra);
  };
  const run = (pattern: RegExp, from: number): number => {
    pattern.lastIndex = from;
    return pattern.exec(text)?.[0].length ?? 0;
  };
  for (let i = 0; i < text.length; i += 1) {
    const character = text.charAt(i);
    if (character === "<" && text.startsWith("<!--", i)) {
      insert(i, i + 4, i + 3, ZERO_WIDTH_SPACE);
      continue;
    }
    if (code[i] === 1) continue;
    const before = i === 0 ? "" : text.charAt(i - 1);
    if (character === "@") {
      if (
        NAME_CHARACTER.test(text.charAt(i + 1)) &&
        !WORD_CHARACTER.test(before)
      )
        insert(i, i + 1 + run(NAME_RUN, i + 1), i + 1, ZERO_WIDTH_SPACE);
    } else if (character === "#") {
      ISSUE_NUMBER.lastIndex = i + 1;
      const number = ISSUE_NUMBER.exec(text);
      const repository = REPOSITORY_BEFORE.exec(
        text.slice(Math.max(0, i - 140), i),
      );
      if (
        number !== null &&
        before !== "&" &&
        text.slice(Math.max(0, i - 2), i) !== "](" &&
        (!WORD_CHARACTER.test(before) || repository !== null)
      )
        insert(
          i - (repository?.[0].length ?? 0),
          i + 1 + number[0].length,
          i + 1,
          ZERO_WIDTH_SPACE,
        );
    } else if (character === "G" || character === "g") {
      if (
        /^gh-[0-9]/i.test(text.slice(i, i + 4)) &&
        !WORD_CHARACTER.test(before)
      )
        insert(i, i + 3 + run(DIGITS, i + 3), i + 3, ZERO_WIDTH_SPACE);
    } else if (character === "/") {
      ISSUE_ADDRESS.lastIndex = i;
      const found = ISSUE_ADDRESS.exec(text);
      if (found !== null) {
        const point = i + found[0].length;
        insert(i, point + run(DIGITS, point), point, ZERO_WIDTH_SPACE);
      }
    } else if (character === "&") {
      AT_OR_NUMBER_ENTITY.lastIndex = i;
      const entity = AT_OR_NUMBER_ENTITY.exec(text);
      if (entity !== null) insert(i, i + entity[0].length, i + 1, "amp;");
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

/** The characters that reorder how a line is shown (direction marks, embeddings, overrides, isolates): a text must read as it is written. */
export const BIDI_CONTROLS = /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/g;

/**
 * A text without the characters no task text may hold. Everything that is removed is removed here, before a text is defused: a
 * removal after it would join what the defusing had kept apart (`@`, a direction mark, `user`).
 */
export function cleanText(text: string): string {
  return text
    .replace(CONTROL, "")
    .replace(BIDI_CONTROLS, "")
    .replace(LONE_SURROGATE, "�");
}

/** The value of a reference, or `undefined` when the run has none (a missing field, a step that did not run). */
function lookup(path: readonly string[], values: RunValues): unknown {
  const [root, ...rest] = path;
  let at: unknown;
  let names = rest;
  if (root === "trigger") at = values.trigger;
  else if (root === "failure" && values.failure !== undefined)
    at = values.failure;
  else if (root === "previous") {
    // `previous.<step>.…` starts at the output of that step in the round before.
    const [step, ...inner] = rest;
    names = inner;
    if (
      step === undefined ||
      values.previous === undefined ||
      !Object.hasOwn(values.previous, step)
    )
      return undefined;
    at = values.previous[step];
  } else if (root !== undefined && Object.hasOwn(values.steps, root))
    at = values.steps[root];
  else return undefined;
  for (const name of names) {
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
          agent:
            isAgentText(part.ref.path, values) || isOutsiderText(part.ref.path),
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
