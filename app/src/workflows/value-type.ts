// SPDX-License-Identifier: LicenseRef-Proprietary

// The types of values that flow between the nodes of a workflow (#833): what a step yields, what an action input takes. They are
// the types of the result schema subset (`result-schema.ts`) and nothing more, so a node can only describe itself in the terms the
// schema has. `unknown` is the type of a value whose node already failed the check: it fits everywhere, so one mistake is
// reported once and not again at every use.

export type ValueType =
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "list"; items: ValueType }
  | { kind: "object"; fields: Readonly<Record<string, FieldType>> }
  /** Only as an expected type: any of these. */
  | { kind: "oneOf"; options: readonly ValueType[] }
  | { kind: "unknown" };

export type FieldType = { type: ValueType; required: boolean };
export type ObjectType = Extract<ValueType, { kind: "object" }>;

export const STRING: ValueType = { kind: "string" };
export const NUMBER: ValueType = { kind: "number" };
export const BOOLEAN: ValueType = { kind: "boolean" };
export const UNKNOWN: ValueType = { kind: "unknown" };

export function listOf(items: ValueType): ValueType {
  return { kind: "list", items };
}

export function enumOf(...values: string[]): ValueType {
  return { kind: "enum", values };
}

/** An object type; every field is required unless it is listed in `optional`. */
export function objectOf(
  fields: Record<string, ValueType>,
  optional: readonly string[] = [],
): ObjectType {
  return {
    kind: "object",
    fields: Object.fromEntries(
      Object.entries(fields).map(([name, type]) => [
        name,
        { type, required: !optional.includes(name) },
      ]),
    ),
  };
}

/** For a message: `string`, `list of number`, `one of 'bug', 'risk'`, `object with fields a, b`. */
export function describeType(type: ValueType): string {
  switch (type.kind) {
    case "string":
    case "number":
    case "boolean":
      return type.kind;
    case "enum":
      return `one of ${type.values.map((value) => `'${value}'`).join(", ")}`;
    case "list":
      return `list of ${describeType(type.items)}`;
    case "object": {
      const names = Object.keys(type.fields);
      return names.length === 0
        ? "object without fields"
        : `object with fields ${names.join(", ")}`;
    }
    case "oneOf":
      return type.options.map(describeType).join(" or ");
    case "unknown":
      return "a value";
  }
}

/**
 * Whether a value of type `actual` may be used where `expected` is wanted.
 * - A string wanted takes any scalar and any list: they have a text form (`renderValue`). An object has none.
 * - An object wanted takes an object that has at least its required fields, each of a fitting type: more fields do no harm.
 */
export function isAssignable(actual: ValueType, expected: ValueType): boolean {
  if (actual.kind === "unknown" || expected.kind === "unknown") return true;
  if (expected.kind === "oneOf")
    return expected.options.some((option) => isAssignable(actual, option));
  if (actual.kind === "oneOf")
    return actual.options.every((option) => isAssignable(option, expected));
  switch (expected.kind) {
    case "string":
      return actual.kind !== "object";
    case "number":
    case "boolean":
      return actual.kind === expected.kind;
    case "enum":
      return (
        actual.kind === "enum" &&
        actual.values.every((value) => expected.values.includes(value))
      );
    case "list":
      return (
        actual.kind === "list" && isAssignable(actual.items, expected.items)
      );
    case "object": {
      if (actual.kind !== "object") return false;
      return Object.entries(expected.fields).every(([name, field]) => {
        const have = actual.fields[name];
        if (have === undefined) return !field.required;
        if (field.required && !have.required) return false;
        return isAssignable(have.type, field.type);
      });
    }
  }
}

/** Whether a value that is written out (not a reference) is a member of the type, for the defaults of references. */
export function valueFits(value: unknown, type: ValueType): boolean {
  switch (type.kind) {
    case "unknown":
      return true;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && type.values.includes(value);
    case "list":
      return (
        Array.isArray(value) &&
        value.every((item: unknown) => valueFits(item, type.items))
      );
    case "oneOf":
      return type.options.some((option) => valueFits(value, option));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
      const record = value as Record<string, unknown>;
      return (
        Object.keys(record).every((key) => key in type.fields) &&
        Object.entries(type.fields).every(([name, field]) =>
          name in record
            ? valueFits(record[name], field.type)
            : !field.required,
        )
      );
    }
  }
}
