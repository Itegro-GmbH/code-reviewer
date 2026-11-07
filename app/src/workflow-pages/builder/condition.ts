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

export type OperandKind = "text" | "number" | "boolean";

/** What an operand is: a number or true/false as such, everything else (a reference included) a text. */
export function operandKind(operand: unknown): OperandKind {
  return typeof operand === "number"
    ? "number"
    : typeof operand === "boolean"
      ? "boolean"
      : "text";
}

/**
 * The operand a text stands for, for the kind the person chose: a text stays a text however much it looks like a number (`"3"` is not
 * `3`); only a number field turns what is typed into a number (an empty one is 0, text that is no number leaves the operand as it was).
 */
export function operandFrom(
  text: string,
  kind: OperandKind,
  previous?: unknown,
): unknown {
  if (kind === "boolean") return text === "true";
  if (kind === "text") return text;
  if (text.trim() === "") return 0;
  const number = Number(text);
  return Number.isFinite(number) ? number : previous;
}

/** The operand with another kind: what can be carried over is (`"3"` to 3, `true` to the text "true"); the rest starts empty. */
export function operandOfKind(operand: unknown, kind: OperandKind): unknown {
  if (operandKind(operand) === kind) return operand;
  if (kind === "text") return operandText(operand);
  if (kind === "boolean") return operand === "true";
  const number = typeof operand === "string" ? Number(operand) : Number.NaN;
  return operand !== "" && Number.isFinite(number) ? number : 0;
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
