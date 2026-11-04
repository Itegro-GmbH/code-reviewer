// SPDX-License-Identifier: LicenseRef-Proprietary

// The values a node carries and the texts in them (#833): templates with references, the inputs of an action held to the types the
// connector declares, and the conditions of `if` and `until`. Reports issues; it does not stop at the first.
import { CONDITION_DEPTH_MAX, TEMPLATE_MAX_LENGTH } from "./limits.ts";
import { issue, listNames, pointer } from "./issues.ts";
import { resolveReference, type ScopeContext, type Use } from "./scope.ts";
import { isWholeReference, parseTemplate } from "./template.ts";
import { describeType, isAssignable, type ValueType } from "./value-type.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function jsonTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (isRecord(value)) return "an object";
  return typeof value === "string"
    ? "a text"
    : typeof value === "number"
      ? "a number"
      : "true/false";
}

/**
 * Checks the references of a text. Returns the type of the value when the whole text is one reference (the value keeps its type),
 * and `undefined` when the text is text, however many references it has. An object in the middle of a text has no text form.
 */
export function checkText(
  text: string,
  context: ScopeContext,
  use: Use,
): { whole?: ValueType; ok: boolean } {
  if (text.length > TEMPLATE_MAX_LENGTH) {
    context.report(
      issue(
        use.path,
        "limit_exceeded",
        `A text may have ${TEMPLATE_MAX_LENGTH} characters at most; this one has ${text.length}.`,
      ),
    );
    return { ok: false };
  }
  const parsed = parseTemplate(text);
  for (const problem of parsed.problems)
    context.report(issue(use.path, "template_syntax", problem));
  if (parsed.problems.length > 0) return { ok: false };
  const whole = isWholeReference(parsed);
  for (const part of parsed.parts) {
    if (!("ref" in part)) continue;
    const resolved = resolveReference(part.ref, context, use);
    if (whole) return { whole: resolved.type, ok: true };
    if (resolved.type.kind === "object")
      context.report(
        issue(
          use.path,
          "reference_type_mismatch",
          `{{${part.ref.raw}}} is ${describeType(resolved.type)}, which has no text form inside a text. Use one of its fields.`,
          Object.keys(resolved.type.fields),
        ),
      );
  }
  return { ok: true };
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
 * Holds a value written in a node (a text with references, a number, a list, an object) to the type the field expects. A text that
 * is exactly one reference takes the type of what it refers to; any other text is text.
 */
export function checkInput(
  value: unknown,
  expected: ValueType,
  path: string,
  context: ScopeContext,
  use: Omit<Use, "path">,
): void {
  const here: Use = { ...use, path };
  const mismatch = (): void =>
    context.report(
      issue(
        path,
        "wrong_type",
        `Expected ${describeType(expected)}, got ${jsonTypeName(value)}.`,
      ),
    );
  if (typeof value === "string") {
    const checked = checkText(value, context, here);
    if (!checked.ok) return;
    if (checked.whole !== undefined) {
      if (!isAssignable(checked.whole, expected))
        context.report(
          issue(
            path,
            "reference_type_mismatch",
            `Expected ${describeType(expected)}, but ${value.trim()} is ${describeType(checked.whole)}.`,
          ),
        );
      return;
    }
    if (!textFits(expected)) mismatch();
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (
      !optionsOf(expected).some(
        (o) => o.kind === "number" || o.kind === "unknown",
      )
    )
      mismatch();
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
    value.forEach((item: unknown, index) =>
      checkInput(item, list.items, pointer(path, index), context, use),
    );
    return;
  }
  if (isRecord(value)) {
    const object = optionsOf(expected).find((o) => o.kind === "object");
    if (object === undefined || object.kind !== "object") {
      mismatch();
      return;
    }
    const names = Object.keys(object.fields);
    for (const key of Object.keys(value))
      if (!(key in object.fields))
        context.report(
          issue(
            pointer(path, key),
            "unknown_field",
            `'${key}' is not a field here. Fields: ${listNames(names)}.`,
            names,
          ),
        );
    for (const [name, field] of Object.entries(object.fields)) {
      if (name in value)
        checkInput(value[name], field.type, pointer(path, name), context, use);
      else if (field.required)
        context.report(
          issue(pointer(path, name), "missing_field", `'${name}' is required.`),
        );
    }
    return;
  }
  mismatch();
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
  return { type: { kind: "string" }, literal: value };
}

function scalarKind(type: ValueType): string | undefined {
  if (type.kind === "string" || type.kind === "enum") return "text";
  if (type.kind === "number" || type.kind === "boolean") return type.kind;
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
            `'${other.literal}' can never be equal to the other operand, which is one of ${listNames(one.type.values)}.`,
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
          `'${key}' is not a condition operator.`,
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
  argument.forEach((item: unknown, index) =>
    checkCondition(item, pointer(at, index), context, use, depth + 1),
  );
}
