// SPDX-License-Identifier: LicenseRef-Proprietary

// The result schema (an agent's `result`) and the `input` of a manual trigger as a table of fields (#926): the rows are the properties of
// the root object, and a row can be added, renamed, retyped (to a type with no inner shape), made required and removed. A field whose type
// is a list or an object keeps its inner shape untouched: its type is not changed here and it can be renamed, made required or removed.
import { isRecord } from "../../workflows/json.ts";

export type SchemaRow = {
  name: string;
  type: string;
  required: boolean;
  /** A list or an object: its inner shape is not edited in the table. */
  nested: boolean;
};

export const SIMPLE_TYPES = ["string", "integer", "number", "boolean"] as const;

type Schema = Record<string, unknown> & {
  properties: Record<string, unknown>;
  required?: unknown;
};

function asSchema(value: unknown): Schema {
  if (isRecord(value) && isRecord(value.properties)) return value as Schema;
  return { type: "object", properties: {} };
}

function requiredOf(schema: Schema): string[] {
  return Array.isArray(schema.required)
    ? (schema.required as unknown[]).filter(
        (name): name is string => typeof name === "string",
      )
    : [];
}

export function rowsOf(value: unknown): SchemaRow[] {
  const schema = asSchema(value);
  const required = new Set(requiredOf(schema));
  return Object.entries(schema.properties).map(([name, field]) => {
    const type =
      isRecord(field) && typeof field.type === "string" ? field.type : "?";
    return {
      name,
      type,
      required: required.has(name),
      nested: type === "array" || type === "object",
    };
  });
}

function withRequired(schema: Schema, required: string[]): Schema {
  const next = { ...schema, required };
  if (required.length === 0) delete (next as { required?: string[] }).required;
  return next;
}

export function freeName(value: unknown, base = "field"): string {
  const taken = new Set(Object.keys(asSchema(value).properties));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1)
    if (!taken.has(`${base}${String(n)}`)) return `${base}${String(n)}`;
}

export function addRow(value: unknown): Schema {
  const schema = asSchema(value);
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [freeName(schema)]: { type: "string" },
    },
  };
}

export function removeRow(value: unknown, name: string): Schema {
  const schema = asSchema(value);
  const properties = { ...schema.properties };
  delete properties[name];
  return withRequired(
    { ...schema, properties },
    requiredOf(schema).filter((each) => each !== name),
  );
}

/** Renames a field, keeping its place and its `required`; false-y names and names that are taken change nothing. */
export function renameRow(value: unknown, from: string, to: string): Schema {
  const schema = asSchema(value);
  if (to === "" || to === from || Object.hasOwn(schema.properties, to))
    return schema;
  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([name, field]) => [
      name === from ? to : name,
      field,
    ]),
  );
  return withRequired(
    { ...schema, properties },
    requiredOf(schema).map((name) => (name === from ? to : name)),
  );
}

/** A field of a simple type: its `description` stays, what only another type has (`enum`, lengths) goes. */
export function retypeRow(value: unknown, name: string, type: string): Schema {
  const schema = asSchema(value);
  const old = schema.properties[name];
  const description =
    isRecord(old) && typeof old.description === "string"
      ? { description: old.description }
      : {};
  return {
    ...schema,
    properties: { ...schema.properties, [name]: { type, ...description } },
  };
}

export function requireRow(value: unknown, name: string, on: boolean): Schema {
  const schema = asSchema(value);
  const others = requiredOf(schema).filter((each) => each !== name);
  return withRequired(schema, on ? [...others, name] : others);
}
