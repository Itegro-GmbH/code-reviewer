// SPDX-License-Identifier: LicenseRef-Proprietary

// The conditions of a workflow at run time (#846): the `when` of an `if` and the `until` of a `loop`. The validator decided what a
// condition may hold (one operator, operands that can be compared, `condition_operand_type`); this evaluates it against the values the
// run has. Pure, and a value is only ever compared or measured, never read again as a template or as a command.
import { isRecord } from "../workflows/json.ts";
import { CONDITION_DEPTH_MAX } from "../workflows/limits.ts";
import { resolveValue, type RunValues } from "./templates.ts";

/** A condition that cannot be evaluated although the document was valid (a value it needs is not what the validator assumed). */
export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionError";
  }
}

/**
 * An operand: a number or true/false as they are, a text with its references filled in. A text that is exactly one reference keeps the
 * type of the value (a list, a number); a reference to a value the run does not have fails, unless it carries a `| default`.
 */
function operandValue(operand: unknown, values: RunValues): unknown {
  if (typeof operand === "number" || typeof operand === "boolean")
    return operand;
  if (typeof operand === "string") return resolveValue(operand, values);
  throw new ConditionError(
    "An operand is a reference, a text, a number or true/false.",
  );
}

function isEmpty(operand: unknown, values: RunValues): boolean {
  const value = operandValue(operand, values);
  if (Array.isArray(value) || typeof value === "string")
    return value.length === 0;
  throw new ConditionError("empty and notEmpty ask about a list or a text.");
}

function pair(argument: unknown, values: RunValues): [unknown, unknown] {
  if (!Array.isArray(argument) || argument.length !== 2)
    throw new ConditionError("A comparison takes a list of two operands.");
  return [operandValue(argument[0], values), operandValue(argument[1], values)];
}

function conditions(argument: unknown): unknown[] {
  if (!Array.isArray(argument) || argument.length === 0)
    throw new ConditionError("all and any take a list of conditions.");
  return argument;
}

/** Whether the condition holds. Throws `ConditionError` (or the `TemplateError` of a missing value) when it cannot be told. */
export function conditionHolds(
  condition: unknown,
  values: RunValues,
  depth = 1,
): boolean {
  if (!isRecord(condition))
    throw new ConditionError("A condition is an object with one operator.");
  if (depth > CONDITION_DEPTH_MAX + 1)
    throw new ConditionError("The condition is nested too deep.");
  const keys = Object.keys(condition);
  const operator = keys[0];
  if (keys.length !== 1 || operator === undefined)
    throw new ConditionError("A condition has exactly one operator.");
  const argument = condition[operator];
  switch (operator) {
    case "empty":
      return isEmpty(argument, values);
    case "notEmpty":
      return !isEmpty(argument, values);
    case "equals": {
      const [left, right] = pair(argument, values);
      return left === right;
    }
    case "notEquals": {
      const [left, right] = pair(argument, values);
      return left !== right;
    }
    case "not":
      return !conditionHolds(argument, values, depth + 1);
    case "all":
      return conditions(argument).every((item) =>
        conditionHolds(item, values, depth + 1),
      );
    case "any":
      return conditions(argument).some((item) =>
        conditionHolds(item, values, depth + 1),
      );
    default:
      throw new ConditionError("The operator of the condition is not known.");
  }
}
