// SPDX-License-Identifier: LicenseRef-Proprietary

// The values a node carries and the texts in them (#833): templates with references, the inputs of an action held to the types the
// connector declares, and the conditions of `if` and `until`. Reports issues; it does not stop at the first.
import type { TargetRoot } from "./connectors.ts";
import { isRecord, jsonTypeName, textLength } from "./json.ts";
import {
  CONDITION_DEPTH_MAX,
  ISSUE_NUMBER_MAX,
  TEMPLATE_MAX_LENGTH,
} from "./limits.ts";
import { issue, listNames, pointer, shown } from "./issues.ts";
import { resolveReference, type ScopeContext, type Use } from "./scope.ts";
import {
  isWholeReference,
  literalText,
  parseTemplate,
  REFERENCE_PATTERN,
  type ParsedTemplate,
  type Reference,
} from "./template.ts";
import {
  describeType,
  isAssignable,
  valueFits,
  type ValueType,
} from "./value-type.ts";

/** Whether a text is exactly one `{{ … }}` and nothing else: the `pattern` of `Reference` in the contract. */
const WHOLE_REFERENCE = new RegExp(REFERENCE_PATTERN, "u");

/**
 * Checks the references of a text. Returns the type of the value when the whole text is one reference (the value keeps its type),
 * and `undefined` when the text is text, however many references it has. An object in the middle of a text has no text form.
 */
export function checkText(
  text: string,
  context: ScopeContext,
  use: Use,
): { whole?: ValueType; ok: boolean; literal?: string } {
  if (tooLong(text, context, use)) return { ok: false };
  const parsed = parseChecked(text, context, use);
  if (parsed === undefined) return { ok: false };
  const whole = isWholeReference(parsed);
  for (const part of parsed.parts) {
    if (context.halted()) break;
    if (!("ref" in part)) continue;
    const resolved = resolveReference(part.ref, context, use);
    if (whole) return { whole: resolved.type, ok: true };
    if (resolved.type.kind === "object")
      context.report(
        issue(
          use.path,
          "reference_type_mismatch",
          `{{${clipRef(part.ref.raw)}}} is ${describeType(resolved.type)}, which has no text form inside a text. Use one of its fields.`,
          Object.keys(resolved.type.fields),
        ),
      );
  }
  const literal = literalText(parsed);
  return literal === undefined ? { ok: true } : { ok: true, literal };
}

function clipRef(raw: string): string {
  return shown(raw).slice(1, -1);
}

/** Reports a text over the limit. */
function tooLong(text: string, context: ScopeContext, use: Use): boolean {
  const length = textLength(text);
  if (length <= TEMPLATE_MAX_LENGTH) return false;
  context.report(
    issue(
      use.path,
      "limit_exceeded",
      `A text may have ${TEMPLATE_MAX_LENGTH} characters at most; this one has ${length}.`,
    ),
  );
  return true;
}

/** Parses a text; reports a text that is not well formed and returns nothing then. */
function parseChecked(
  text: string,
  context: ScopeContext,
  use: Use,
): ParsedTemplate | undefined {
  const parsed = parseTemplate(text);
  for (const problem of parsed.problems)
    context.report(issue(use.path, "template_syntax", problem));
  return parsed.problems.length > 0 ? undefined : parsed;
}

function optionsOf(expected: ValueType): ValueType[] {
  return expected.kind === "oneOf" ? [...expected.options] : [expected];
}

function textFits(expected: ValueType): boolean {
  return optionsOf(expected).some(
    (option) => option.kind === "string" || option.kind === "unknown",
  );
}

/**
 * An input that decides a TARGET (an issue, a branch, a label): the name of the input and where a reference in it may start. A
 * literal is always fine; so is exactly one reference rooted as `roots` says. Anything else is `target_from_untrusted_value`:
 * what an agent reported is data, and so is what whoever opened the issue wrote (its title, body and labels); data does not choose
 * what the platform acts on.
 */
export type TargetCheck = { input: string; roots: readonly TargetRoot[] };

const ROOT_WORDS: Record<TargetRoot, string> = {
  input: "an input of the caller of a manual trigger, {{trigger.input.<name>}}",
  issue:
    "the issue that started the run, {{trigger.issue}} or {{trigger.issue.number}}",
  ticket:
    "the ticket the run is about, {{trigger.ticket}} or {{trigger.ticket.number}}",
  defaultBranch:
    "the default branch of the repository, {{trigger.repo.defaultBranch}} or {{trigger.ticket.repo.defaultBranch}}",
  branch: "the branch of an agent step that may push, {{<step id>.branch}}",
};

function refuseTarget(
  target: TargetCheck,
  path: string,
  context: ScopeContext,
): void {
  context.report(
    issue(
      path,
      "target_from_untrusted_value",
      `'${target.input}' decides what the workflow acts on, so it takes a literal or exactly one reference to ${target.roots.map((root) => ROOT_WORDS[root]).join(" or ")}. Text around a reference, the title, body or labels of the issue (whoever opened it wrote them), a value an agent reported, a field of an action or loop and 'previous.…' are refused: such a value is data, not a command.`,
    ),
  );
}

/** Whether a reference is one a target input takes: `unresolved` when its step is not in reach, which the resolver reports. */
function targetVerdict(
  ref: { path: string[] },
  target: TargetCheck,
  use: Use,
): "ok" | "refused" | "unresolved" {
  const [root, field, ...more] = ref.path as [string, ...string[]];
  const takes = (wanted: TargetRoot): boolean => target.roots.includes(wanted);
  if (root === "trigger") {
    if (field === "input") return takes("input") ? "ok" : "refused";
    const only = (names: readonly string[]): boolean =>
      more.length === names.length && names.every((n, i) => more[i] === n);
    if (
      field === "ticket" &&
      takes("defaultBranch") &&
      only(["repo", "defaultBranch"])
    )
      return "ok";
    if (field === "issue" || field === "ticket")
      return takes(field) && (more.length === 0 || only(["number"]))
        ? "ok"
        : "refused";
    if (field === "repo")
      return takes("defaultBranch") && only(["defaultBranch"])
        ? "ok"
        : "refused";
    return "refused";
  }
  if (root === "previous") return "refused";
  const binding = use.env.scope.get(root);
  if (binding === undefined) return "unresolved";
  const branchOfAgent =
    binding.kind === "agent" && field === "branch" && more.length === 0;
  return branchOfAgent && takes("branch") ? "ok" : "refused";
}

/** What an issue number may be: a whole number a computer can hold exactly, from 1 to `ISSUE_NUMBER_MAX`. */
function isIssueNumber(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= ISSUE_NUMBER_MAX
  );
}

const ISSUE_NUMBER_WORDS = `a positive whole number (1 to ${ISSUE_NUMBER_MAX})`;

/**
 * Holds a value written in a node (a text with references, a number, a list) to the type the field expects. A text that is exactly
 * one reference takes the type of what it refers to; any other text is text. Where something other than a text is expected, only a
 * whole reference is a text that fits: `"{{a}} {{b}}"` is not one. A target input is also held to `target` and its identifiers to
 * strings and choices of names, never a number, true/false or list turned into text.
 */
export function checkInput(
  value: unknown,
  expected: ValueType,
  path: string,
  context: ScopeContext,
  use: Omit<Use, "path">,
  target?: TargetCheck,
): void {
  const here: Use = { ...use, path };
  const mismatch = (hint = ""): void =>
    context.report(
      issue(
        path,
        "wrong_type",
        `Expected ${describeType(expected)}, got ${jsonTypeName(value)}.${hint}`,
      ),
    );
  if (typeof value === "string") {
    checkString(value, expected, here, context, target, mismatch);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (
      !optionsOf(expected).some(
        (o) =>
          o.kind === "number" || o.kind === "integer" || o.kind === "unknown",
      )
    )
      mismatch();
    else if (target !== undefined && !isIssueNumber(value))
      context.report(
        issue(
          path,
          "invalid_value",
          `'${target.input}' is ${ISSUE_NUMBER_WORDS}.`,
        ),
      );
    return;
  }
  if (typeof value === "boolean") {
    if (
      !optionsOf(expected).some(
        (o) => o.kind === "boolean" || o.kind === "unknown",
      )
    )
      mismatch();
    return;
  }
  if (Array.isArray(value)) {
    const list = optionsOf(expected).find((o) => o.kind === "list");
    if (list === undefined || list.kind !== "list") {
      mismatch();
      return;
    }
    for (const [index, item] of value.entries()) {
      if (context.halted()) break;
      checkInput(item, list.items, pointer(path, index), context, use, target);
    }
    return;
  }
  mismatch();
}

/**
 * A text that must be a literal: no reference in it, `\{{` undone. Reports what is wrong with it (too long, not well formed, or a
 * reference, said by `refusal`) and returns nothing then.
 */
export function checkLiteral(
  text: string,
  context: ScopeContext,
  use: Use,
  refusal: string,
  code: "target_from_untrusted_value",
): string | undefined {
  if (tooLong(text, context, use)) return undefined;
  const parsed = parseChecked(text, context, use);
  if (parsed === undefined) return undefined;
  const literal = literalText(parsed);
  if (literal === undefined) context.report(issue(use.path, code, refusal));
  return literal;
}

const WHOLE_REFERENCE_HINT =
  ' Write exactly one reference, like "{{trigger.issue}}", and nothing around it.';

function checkString(
  value: string,
  expected: ValueType,
  here: Use,
  context: ScopeContext,
  target: TargetCheck | undefined,
  mismatch: (hint?: string) => void,
): void {
  if (tooLong(value, context, here)) return;
  if (!textFits(expected) && !WHOLE_REFERENCE.test(value)) {
    mismatch(WHOLE_REFERENCE_HINT);
    return;
  }
  if (target === undefined) {
    const checked = checkText(value, context, here);
    if (checked.ok && checked.whole !== undefined)
      checkWhole(checked.whole, value, expected, here, context, false);
    return;
  }
  const parsed = parseChecked(value, context, here);
  if (parsed === undefined || literalText(parsed) !== undefined) return;
  if (!isWholeReference(parsed)) {
    refuseTarget(target, here.path, context);
    return;
  }
  const ref = (parsed.parts[0] as { ref: Reference }).ref;
  const verdict = targetVerdict(ref, target, here);
  if (verdict === "refused") {
    refuseTarget(target, here.path, context);
    return;
  }
  checkWhole(
    resolveReference(ref, context, here).type,
    value,
    expected,
    here,
    context,
    true,
  );
  checkTargetDefault(ref, expected, target, here, context);
}

/**
 * Whether a value written out holds an integer that is not the number of an issue, anywhere the type has one: in a number, and in
 * the fields of an object. What does not have the shape of the type is not looked at: the type check reports it.
 */
function holdsBadIssueNumber(value: unknown, type: ValueType): boolean {
  switch (type.kind) {
    case "integer":
      return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        !isIssueNumber(value)
      );
    case "oneOf": {
      // An option is picked by the shape of the value: an object with more fields than the option names
      // fits no closed object option, and its number must still be looked at.
      const fits = type.options.filter((option) => valueFits(value, option));
      const fitting =
        fits.length > 0 || !isRecord(value)
          ? fits
          : type.options.filter((option) => option.kind === "object");
      return (
        fitting.length > 0 &&
        fitting.every((option) => holdsBadIssueNumber(value, option))
      );
    }
    case "object":
      return (
        isRecord(value) &&
        Object.entries(type.fields).some(
          ([name, field]) =>
            Object.hasOwn(value, name) &&
            holdsBadIssueNumber(value[name], field.type),
        )
      );
    default:
      return false;
  }
}

/** A default is a value written out like a literal, so it is held to what a literal is: an issue number is a positive whole number up to `ISSUE_NUMBER_MAX`, also the `number` of an issue object. */
function checkTargetDefault(
  ref: Reference,
  expected: ValueType,
  target: TargetCheck,
  here: Use,
  context: ScopeContext,
): void {
  if (ref.default === undefined) return;
  if (!holdsBadIssueNumber(ref.default.value, expected)) return;
  context.report(
    issue(
      here.path,
      "invalid_value",
      `The default of ${shown(ref.path.join("."))} is the number of an issue when the value is missing: '${target.input}' is ${ISSUE_NUMBER_WORDS}.`,
    ),
  );
}

/** A reference that is the whole text must be a value of the expected type. */
function checkWhole(
  actual: ValueType,
  text: string,
  expected: ValueType,
  here: Use,
  context: ScopeContext,
  exact: boolean,
): void {
  if (isAssignable(actual, expected, exact)) return;
  context.report(
    issue(
      here.path,
      "reference_type_mismatch",
      `Expected ${describeType(expected)}, but ${shown(text)} is ${describeType(actual)}.${exact ? " An identifier is a text; a number, true/false or a list is not turned into one." : ""}`,
    ),
  );
}

const CONDITION_KEYS = [
  "empty",
  "notEmpty",
  "equals",
  "notEquals",
  "all",
  "any",
  "not",
] as const;

type Operand = { type: ValueType; literal?: string };

function operand(
  value: unknown,
  path: string,
  context: ScopeContext,
  use: Omit<Use, "path">,
): Operand | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return { type: { kind: "number" } };
  if (typeof value === "boolean") return { type: { kind: "boolean" } };
  if (typeof value !== "string") {
    context.report(
      issue(
        path,
        "wrong_type",
        `An operand is a reference like "{{review.findings}}", a text, a number or true/false, not ${jsonTypeName(value)}.`,
      ),
    );
    return undefined;
  }
  const checked = checkText(value, context, { ...use, path });
  if (!checked.ok) return undefined;
  if (checked.whole !== undefined) return { type: checked.whole };
  return checked.literal === undefined
    ? { type: { kind: "string" } }
    : { type: { kind: "string" }, literal: checked.literal };
}

function scalarKind(type: ValueType): string | undefined {
  if (type.kind === "string" || type.kind === "enum") return "text";
  if (type.kind === "number" || type.kind === "integer") return "number";
  if (type.kind === "boolean") return type.kind;
  return undefined;
}

function checkComparison(
  items: unknown,
  path: string,
  context: ScopeContext,
  use: Omit<Use, "path">,
): void {
  if (!Array.isArray(items) || items.length !== 2) {
    context.report(
      issue(
        path,
        Array.isArray(items) ? "invalid_value" : "wrong_type",
        'A comparison takes a list of exactly two operands, like ["{{fix.exit}}", "until"].',
      ),
    );
    return;
  }
  const [left, right] = items.map((item: unknown, index) =>
    operand(item, pointer(path, index), context, use),
  );
  if (left === undefined || right === undefined) return;
  if (left.type.kind === "unknown" || right.type.kind === "unknown") return;
  const a = scalarKind(left.type);
  const b = scalarKind(right.type);
  if (a === undefined || b === undefined || a !== b) {
    context.report(
      issue(
        path,
        "condition_operand_type",
        `These cannot be compared: ${describeType(left.type)} and ${describeType(right.type)}. Compare two texts, two numbers or two true/false values.`,
      ),
    );
    return;
  }
  for (const [one, other, index] of [
    [left, right, 1],
    [right, left, 0],
  ] as const)
    if (one.type.kind === "enum" && other.literal !== undefined) {
      if (!one.type.values.includes(other.literal))
        context.report(
          issue(
            pointer(path, index),
            "condition_value_not_in_enum",
            `${shown(other.literal)} can never be equal to the other operand, which is one of ${listNames(one.type.values)}.`,
            one.type.values,
          ),
        );
    }
}

/** A condition of an `if` or a loop's `until`: one operator per object, nested at most `CONDITION_DEPTH_MAX` deep. */
export function checkCondition(
  value: unknown,
  path: string,
  context: ScopeContext,
  use: Omit<Use, "path">,
  depth = 1,
): void {
  if (!isRecord(value)) {
    context.report(
      issue(
        path,
        "wrong_type",
        `A condition is an object with one operator (${listNames(CONDITION_KEYS)}), not ${jsonTypeName(value)}.`,
        CONDITION_KEYS,
      ),
    );
    return;
  }
  const keys = Object.keys(value);
  const known = keys.filter((key) =>
    (CONDITION_KEYS as readonly string[]).includes(key),
  );
  for (const key of keys)
    if (!known.includes(key))
      context.report(
        issue(
          pointer(path, key),
          "unknown_field",
          `${shown(key)} is not a condition operator.`,
          CONDITION_KEYS,
        ),
      );
  if (known.length !== 1) {
    if (keys.length === known.length)
      context.report(
        issue(
          path,
          known.length === 0 ? "missing_field" : "invalid_value",
          known.length === 0
            ? `A condition needs one operator: ${listNames(CONDITION_KEYS)}.`
            : `A condition has exactly one operator; this one has ${known.length}. Combine them with all or any.`,
          CONDITION_KEYS,
        ),
      );
    return;
  }
  const operator = known[0] as (typeof CONDITION_KEYS)[number];
  const at = pointer(path, operator);
  const argument = value[operator];
  if (operator === "empty" || operator === "notEmpty") {
    const checked = operand(argument, at, context, use);
    if (checked === undefined || checked.type.kind === "unknown") return;
    if (checked.type.kind !== "list" && checked.type.kind !== "string")
      context.report(
        issue(
          at,
          "condition_operand_type",
          `${operator} asks whether a list or a text is empty; this is ${describeType(checked.type)}.`,
        ),
      );
    return;
  }
  if (operator === "equals" || operator === "notEquals") {
    checkComparison(argument, at, context, use);
    return;
  }
  if (depth >= CONDITION_DEPTH_MAX) {
    context.report(
      issue(
        at,
        "nesting_too_deep",
        `Conditions may be nested ${CONDITION_DEPTH_MAX} levels deep at most.`,
      ),
    );
    return;
  }
  if (operator === "not") {
    checkCondition(argument, at, context, use, depth + 1);
    return;
  }
  if (!Array.isArray(argument) || argument.length === 0) {
    context.report(
      issue(
        at,
        Array.isArray(argument) ? "invalid_value" : "wrong_type",
        `${operator} takes a list of at least one condition.`,
      ),
    );
    return;
  }
  for (const [index, item] of argument.entries()) {
    if (context.halted()) break;
    checkCondition(item, pointer(at, index), context, use, depth + 1);
  }
}
