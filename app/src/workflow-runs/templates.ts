// SPDX-License-Identifier: LicenseRef-Proprietary

// The references of a workflow at run time (#844): `{{trigger.input.x}}`, `{{step.field}}`, `{{step.branch}}`, each with its optional
// `| default <JSON>`. The validator decided where a reference may point; this resolves it against the values the run has. Pure.
//
// Values are data. A text is built in one pass from the parts of the template; what a reference yields is inserted as it is and never
// read again, so a result that holds `{{` or an instruction does nothing here. The default of a reference is a JSON value taken as it
// is. A value of an agent step that goes into the text of an action (a title, a comment) is defused: it cannot mention a person or a
// team, nor name an issue a pull request would close (`defuseMentions`). A value that goes into a text is cleaned of control characters (the Implementer refuses them) and cut at
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
};

const ZERO_WIDTH_SPACE = "\u200b";

/**
 * Text an agent wrote, made harmless where GitHub reads it: a zero-width space after `@` (no `@name`, no `@org/team`), after the `#`
 * of an issue reference (`#12`, `owner/repo#12`: no link, and no `Closes #12` that closes anything) and before the number of an issue
 * or pull request URL. The text reads the same to a person.
 */
export function defuseMentions(text: string): string {
  return text
    .replace(/@(?=[A-Za-z0-9_])/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`)
    .replace(/(\/(?:issues|pull)\/)(?=\d)/g, `$1${ZERO_WIDTH_SPACE}`);
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

function insertable(value: unknown, path: string, defuse: boolean): string {
  if (isRecord(value))
    throw new TemplateError(
      "template_invalid",
      `The value ${path} is an object and has no text form; refer to one of its fields.`,
    );
  const clean = cleanText(renderValue(value));
  const rendered = defuse ? defuseMentions(clean) : clean;
  if (textLength(rendered) <= TEMPLATE_VALUE_MAX_CHARS) return rendered;
  const kept = Array.from(rendered).slice(0, TEMPLATE_VALUE_MAX_CHARS).join("");
  return `${kept}… [cut: the value was ${textLength(rendered)} characters long]`;
}

function renderParts(
  template: ParsedTemplate,
  values: RunValues,
  maxChars: number,
  options: RenderOptions = {},
): string {
  let text = "";
  for (const part of template.parts)
    text +=
      "text" in part
        ? part.text
        : insertable(
            resolveReference(part.ref, values),
            part.ref.path.join("."),
            options.defuse === true &&
              values.agentSteps?.has(part.ref.path[0] ?? "") === true,
          );
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
