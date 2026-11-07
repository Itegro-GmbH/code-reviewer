// SPDX-License-Identifier: LicenseRef-Proprietary

// Conditions as the inspector edits them (#926): one operator with its operands (`docs/workflows.md`, "Conditions"). Pure helpers; the
// validator judges whether the operands fit.
import { isRecord } from "../../workflows/json.ts";
import { operatorOf, type ConditionOperator } from "./describe.ts";

export type Condition = Record<string, unknown>;

/** What an operand shows in its text box: a text as it is, a number or true/false as it is written. */
export function operandText(operand: unknown): string {
  return typeof operand === "string"
    ? operand
    : typeof operand === "number" || typeof operand === "boolean"
      ? String(operand)
      : "";
}

/**
 * The operand a text stands for. An operand is a reference, a text, a number or true/false: text that is a number or true/false is read
 * as one, unless it is what the operand already was (a text `"3"` stays a text while it is not edited).
 */
export function operandFrom(text: string, previous: unknown): unknown {
  if (operandText(previous) === text && previous !== undefined) return previous;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === "true") return true;
  if (text === "false") return false;
  return text;
}

export function emptyCondition(): Condition {
  return { notEmpty: "" };
}

/** The condition with another operator: the operands that fit stay, the rest start empty; a simple condition is kept inside `all`, `any` and `not`. */
export function convertCondition(
  value: unknown,
  operator: ConditionOperator,
): Condition {
  const current = operatorOf(value);
  const body =
    isRecord(value) && current !== undefined ? value[current] : undefined;
  const simple = current === "empty" || current === "notEmpty";
  const pair = current === "equals" || current === "notEquals";
  switch (operator) {
    case "empty":
    case "notEmpty":
      return {
        [operator]: simple
          ? body
          : pair && Array.isArray(body)
            ? (body[0] ?? "")
            : "",
      };
    case "equals":
    case "notEquals":
      return {
        [operator]:
          pair && Array.isArray(body) ? body : [simple ? (body ?? "") : "", ""],
      };
    case "all":
    case "any":
      return {
        [operator]:
          current === "all" || current === "any"
            ? body
            : [current === undefined ? emptyCondition() : value],
      };
    case "not":
      return {
        not:
          current === undefined || current === "not"
            ? (body ?? emptyCondition())
            : value,
      };
  }
}

export function pairOf(value: unknown): [unknown, unknown] {
  const list = Array.isArray(value) ? (value as unknown[]) : [];
  return [list[0] ?? "", list[1] ?? ""];
}
