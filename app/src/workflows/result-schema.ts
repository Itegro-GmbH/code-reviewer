// SPDX-License-Identifier: LicenseRef-Proprietary

// Result schemas (#833): the small subset of JSON Schema in which an agent step says what its result looks like
// (`contracts/result-schema.v1.json`). A result is an object; its fields are strings (optionally one of a list of names), numbers,
// booleans, lists and objects. Required fields and length caps are the only constraints. The agent's finish tool (M2) is made from
// the same schema and checks what the agent hands in with `checkResultValue`, so the workflow only ever sees data of the declared
// shape. Pure: no database, no I/O.
import {
  LIST_MAX_ITEMS_DEFAULT,
  LIST_MAX_ITEMS_LIMIT,
  RESULT_DEPTH_MAX,
  RESULT_DESCRIPTION_MAX_LENGTH,
  RESULT_ENUM_VALUE_MAX_LENGTH,
  RESULT_ENUM_VALUES_MAX,
  RESULT_FIELD_NAME_PATTERN,
  RESULT_PROPERTIES_MAX,
  RESULT_PROPERTIES_TOTAL_MAX,
  STRING_MAX_LENGTH_DEFAULT,
  STRING_MAX_LENGTH_LIMIT,
} from "./limits.ts";
import {
  clip,
  issue,
  listNames,
  pointer,
  shown,
  sortIssues,
  type Issue,
} from "./issues.ts";
import { isRecord, jsonTypeName, textLength } from "./json.ts";
import {
  BOOLEAN,
  INTEGER,
  NUMBER,
  STRING,
  listOf,
  type FieldType,
  type ObjectType,
  type ValueType,
} from "./value-type.ts";

export type StringNode = {
  type: "string";
  description?: string;
  maxLength?: number;
  enum?: string[];
};
export type NumberNode = { type: "number"; description?: string };
export type IntegerNode = { type: "integer"; description?: string };
export type BooleanNode = { type: "boolean"; description?: string };
export type ArrayNode = {
  type: "array";
  description?: string;
  items: SchemaNode;
  maxItems?: number;
};
export type ObjectNode = {
  type: "object";
  description?: string;
  properties: Record<string, SchemaNode>;
  required?: string[];
  additionalProperties?: false;
};
export type SchemaNode =
  StringNode | NumberNode | IntegerNode | BooleanNode | ArrayNode | ObjectNode;
/** The root of a result schema is always an object. */
export type ResultSchema = ObjectNode;

const NODE_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
] as const;
const KEYS: Record<(typeof NODE_TYPES)[number], readonly string[]> = {
  string: ["type", "description", "maxLength", "enum"],
  number: ["type", "description"],
  integer: ["type", "description"],
  boolean: ["type", "description"],
  array: ["type", "description", "items", "maxItems"],
  object: [
    "type",
    "description",
    "properties",
    "required",
    "additionalProperties",
  ],
};

type Walk = { issues: Issue[]; fields: number };

function description(
  node: Record<string, unknown>,
  path: string,
  walk: Walk,
): void {
  const text = node.description;
  if (text === undefined) return;
  if (typeof text !== "string")
    walk.issues.push(
      issue(
        pointer(path, "description"),
        "wrong_type",
        `description must be a string, not ${jsonTypeName(text)}.`,
      ),
    );
  else if (textLength(text) > RESULT_DESCRIPTION_MAX_LENGTH)
    walk.issues.push(
      issue(
        pointer(path, "description"),
        "limit_exceeded",
        `description is ${textLength(text)} characters; at most ${RESULT_DESCRIPTION_MAX_LENGTH}.`,
      ),
    );
}

function cap(
  node: Record<string, unknown>,
  key: "maxLength" | "maxItems",
  limit: number,
  path: string,
  walk: Walk,
): void {
  const value = node[key];
  if (value === undefined) return;
  const where = pointer(path, key);
  if (typeof value !== "number" || !Number.isInteger(value))
    walk.issues.push(
      issue(where, "wrong_type", `${key} must be a whole number.`),
    );
  else if (value < 1)
    walk.issues.push(
      issue(where, "invalid_value", `${key} must be at least 1.`),
    );
  else if (value > limit)
    walk.issues.push(
      issue(where, "limit_exceeded", `${key} may be at most ${limit}.`),
    );
}

function enumeration(
  node: Record<string, unknown>,
  path: string,
  walk: Walk,
): void {
  const values = node.enum;
  if (values === undefined) return;
  const where = pointer(path, "enum");
  if (!Array.isArray(values)) {
    walk.issues.push(
      issue(where, "wrong_type", "enum must be a list of strings."),
    );
    return;
  }
  if (values.length === 0)
    walk.issues.push(
      issue(where, "invalid_value", "enum needs at least one value."),
    );
  if (values.length > RESULT_ENUM_VALUES_MAX)
    walk.issues.push(
      issue(
        where,
        "limit_exceeded",
        `enum has ${values.length} values; at most ${RESULT_ENUM_VALUES_MAX}.`,
      ),
    );
  const seen = new Set<string>();
  values.forEach((value: unknown, index) => {
    const at = pointer(where, index);
    if (typeof value !== "string")
      walk.issues.push(
        issue(
          at,
          "wrong_type",
          `An enum value must be a string, not ${jsonTypeName(value)}.`,
        ),
      );
    else if (
      value.length === 0 ||
      textLength(value) > RESULT_ENUM_VALUE_MAX_LENGTH
    )
      walk.issues.push(
        issue(
          at,
          "invalid_value",
          `An enum value is 1 to ${RESULT_ENUM_VALUE_MAX_LENGTH} characters.`,
        ),
      );
    else if (seen.has(value))
      walk.issues.push(
        issue(
          at,
          "invalid_value",
          `The enum value ${shown(value)} is listed twice.`,
        ),
      );
    else seen.add(value);
  });
}

function properties(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  walk: Walk,
): void {
  const where = pointer(path, "properties");
  const props = node.properties;
  if (props === undefined) {
    walk.issues.push(
      issue(
        where,
        "missing_field",
        "An object needs 'properties': a map from field name to the schema of the field.",
      ),
    );
  } else if (!isRecord(props)) {
    walk.issues.push(
      issue(
        where,
        "wrong_type",
        `properties must be an object, not ${jsonTypeName(props)}.`,
      ),
    );
  } else {
    const names = Object.keys(props);
    if (names.length === 0)
      walk.issues.push(
        issue(where, "invalid_value", "properties needs at least one field."),
      );
    if (names.length > RESULT_PROPERTIES_MAX)
      walk.issues.push(
        issue(
          where,
          "limit_exceeded",
          `An object has ${names.length} fields; at most ${RESULT_PROPERTIES_MAX}.`,
        ),
      );
    walk.fields += names.length;
    for (const name of names) {
      const at = pointer(where, name);
      if (!RESULT_FIELD_NAME_PATTERN.test(name)) {
        // What lies below a name that is refused is not looked at: fix the name first, the next answer reports the rest.
        walk.issues.push(
          issue(
            at,
            "invalid_value",
            "A field name starts with a letter or '_' and has letters, digits and '_' only (64 at most).",
          ),
        );
        continue;
      }
      schemaNode(props[name], at, depth + 1, walk);
    }
  }
  const required = node.required;
  if (required === undefined) return;
  const requiredAt = pointer(path, "required");
  if (!Array.isArray(required)) {
    walk.issues.push(
      issue(
        requiredAt,
        "wrong_type",
        "required must be a list of field names.",
      ),
    );
    return;
  }
  const known = isRecord(props) ? Object.keys(props) : [];
  const seen = new Set<string>();
  required.forEach((name: unknown, index) => {
    const at = pointer(requiredAt, index);
    if (typeof name !== "string")
      walk.issues.push(
        issue(at, "wrong_type", "A required entry is a field name (a string)."),
      );
    else if (!known.includes(name) && isRecord(props))
      walk.issues.push(
        issue(
          at,
          "required_field_unknown",
          `${shown(name)} is required but is not one of the properties.`,
          known.map(clip),
        ),
      );
    else if (seen.has(name))
      walk.issues.push(
        issue(
          at,
          "invalid_value",
          `${shown(name)} is listed twice in required.`,
        ),
      );
    else seen.add(name);
  });
}

function schemaNode(
  value: unknown,
  path: string,
  depth: number,
  walk: Walk,
): void {
  if (!isRecord(value)) {
    walk.issues.push(
      issue(
        path,
        "wrong_type",
        `A field schema must be an object like {"type": "string"}, not ${jsonTypeName(value)}.`,
      ),
    );
    return;
  }
  const type = value.type;
  if (type === undefined) {
    walk.issues.push(
      issue(
        pointer(path, "type"),
        "missing_field",
        `A field schema needs 'type': ${listNames(NODE_TYPES)}.`,
        NODE_TYPES,
      ),
    );
    return;
  }
  if (
    typeof type !== "string" ||
    !(NODE_TYPES as readonly string[]).includes(type)
  ) {
    walk.issues.push(
      issue(
        pointer(path, "type"),
        "invalid_value",
        `'type' is ${typeof type === "string" ? shown(type) : jsonTypeName(type)}, which the format does not have. Lists are 'array', and a choice of names is a 'string' with 'enum'.`,
        NODE_TYPES,
      ),
    );
    return;
  }
  const kind = type as (typeof NODE_TYPES)[number];
  for (const key of Object.keys(value))
    if (!KEYS[kind].includes(key))
      walk.issues.push(
        issue(
          pointer(path, key),
          "unknown_field",
          `${shown(key)} is not a keyword of a ${kind} schema.`,
          KEYS[kind],
        ),
      );
  description(value, path, walk);
  if (kind === "string") {
    cap(value, "maxLength", STRING_MAX_LENGTH_LIMIT, path, walk);
    enumeration(value, path, walk);
    return;
  }
  if (kind === "array") {
    cap(value, "maxItems", LIST_MAX_ITEMS_LIMIT, path, walk);
    if (value.items === undefined)
      walk.issues.push(
        issue(
          pointer(path, "items"),
          "missing_field",
          "An array needs 'items': the schema of one entry.",
        ),
      );
    else {
      if (depth + 1 > RESULT_DEPTH_MAX)
        walk.issues.push(depthIssue(pointer(path, "items")));
      else schemaNode(value.items, pointer(path, "items"), depth + 1, walk);
    }
    return;
  }
  if (kind === "object") {
    if (
      value.additionalProperties !== undefined &&
      value.additionalProperties !== false
    )
      walk.issues.push(
        issue(
          pointer(path, "additionalProperties"),
          "invalid_value",
          "Objects are closed: additionalProperties may only be false (or left out).",
        ),
      );
    if (depth > RESULT_DEPTH_MAX) {
      walk.issues.push(depthIssue(path));
      return;
    }
    properties(value, path, depth, walk);
  }
}

function depthIssue(path: string): Issue {
  return issue(
    path,
    "nesting_too_deep",
    `A result schema may have ${RESULT_DEPTH_MAX} levels of objects and lists at most.`,
  );
}

/**
 * Checks a result schema written in a workflow (or a profile). `base` is the pointer of the schema inside the document that is
 * reported on. The schema is returned only when there is no issue.
 */
export function validateResultSchema(
  value: unknown,
  base = "",
): { issues: Issue[]; schema?: ResultSchema } {
  const walk: Walk = { issues: [], fields: 0 };
  if (!isRecord(value)) {
    return {
      issues: [
        issue(
          base,
          "wrong_type",
          `A result schema is an object like {"type": "object", "properties": {...}}, not ${jsonTypeName(value)}.`,
        ),
      ],
    };
  }
  if (value.type !== "object") {
    return {
      issues: [
        value.type === undefined
          ? issue(
              pointer(base, "type"),
              "missing_field",
              'A result schema is an object: "type": "object".',
            )
          : issue(
              pointer(base, "type"),
              "invalid_value",
              'The root of a result schema must have "type": "object".',
              ["object"],
            ),
      ],
    };
  }
  schemaNode(value, base, 1, walk);
  if (walk.fields > RESULT_PROPERTIES_TOTAL_MAX)
    walk.issues.push(
      issue(
        base,
        "result_schema_too_large",
        `The schema has ${walk.fields} fields in all; at most ${RESULT_PROPERTIES_TOTAL_MAX}.`,
      ),
    );
  const issues = sortIssues(walk.issues);
  return issues.length === 0
    ? { issues, schema: value as ResultSchema }
    : { issues };
}

function typeOfNode(node: SchemaNode): ValueType {
  switch (node.type) {
    case "string":
      return node.enum === undefined
        ? STRING
        : { kind: "enum", values: node.enum };
    case "number":
      return NUMBER;
    case "integer":
      return INTEGER;
    case "boolean":
      return BOOLEAN;
    case "array":
      return listOf(typeOfNode(node.items));
    case "object":
      return objectTypeOf(node);
  }
}

/** The type of a result: what the steps after the one that declared it can refer to. */
export function objectTypeOf(node: ObjectNode): ObjectType {
  const required = new Set(node.required ?? []);
  // `fromEntries` defines each name as a property of its own, also `__proto__`; an assignment would change the prototype.
  const fields: Record<string, FieldType> = Object.fromEntries(
    Object.entries(node.properties).map(([name, child]) => [
      name,
      { type: typeOfNode(child), required: required.has(name) },
    ]),
  );
  return { kind: "object", fields };
}

/**
 * Checks what an agent handed in against the schema it was given. The value is untrusted data; every problem is listed with the
 * pointer into the value, so the message can go back to the agent as it is. Strings and lists that set no cap get the defaults.
 */
export function checkResultValue(
  schema: ResultSchema,
  value: unknown,
): Issue[] {
  const issues: Issue[] = [];
  const check = (node: SchemaNode, at: unknown, path: string): void => {
    switch (node.type) {
      case "string": {
        if (typeof at !== "string") {
          issues.push(
            issue(
              path,
              "wrong_type",
              `Expected a string, got ${jsonTypeName(at)}.`,
            ),
          );
          return;
        }
        const max = node.maxLength ?? STRING_MAX_LENGTH_DEFAULT;
        if (textLength(at) > max)
          issues.push(
            issue(
              path,
              "limit_exceeded",
              `The text is ${textLength(at)} characters; at most ${max}.`,
            ),
          );
        if (node.enum !== undefined && !node.enum.includes(at))
          issues.push(
            issue(
              path,
              "invalid_value",
              `Not one of the allowed values.`,
              node.enum,
            ),
          );
        return;
      }
      case "number":
        if (typeof at !== "number" || !Number.isFinite(at))
          issues.push(
            issue(
              path,
              "wrong_type",
              `Expected a number, got ${jsonTypeName(at)}.`,
            ),
          );
        return;
      case "integer":
        if (typeof at !== "number" || !Number.isSafeInteger(at))
          issues.push(
            issue(
              path,
              "wrong_type",
              `Expected a whole number, got ${jsonTypeName(at)}.`,
            ),
          );
        return;
      case "boolean":
        if (typeof at !== "boolean")
          issues.push(
            issue(
              path,
              "wrong_type",
              `Expected true or false, got ${jsonTypeName(at)}.`,
            ),
          );
        return;
      case "array": {
        if (!Array.isArray(at)) {
          issues.push(
            issue(
              path,
              "wrong_type",
              `Expected a list, got ${jsonTypeName(at)}.`,
            ),
          );
          return;
        }
        const max = node.maxItems ?? LIST_MAX_ITEMS_DEFAULT;
        if (at.length > max)
          issues.push(
            issue(
              path,
              "limit_exceeded",
              `The list has ${at.length} entries; at most ${max}.`,
            ),
          );
        at.slice(0, max + 1).forEach((item: unknown, index) =>
          check(node.items, item, pointer(path, index)),
        );
        return;
      }
      case "object": {
        if (!isRecord(at)) {
          issues.push(
            issue(
              path,
              "wrong_type",
              `Expected an object, got ${jsonTypeName(at)}.`,
            ),
          );
          return;
        }
        const names = Object.keys(node.properties);
        for (const key of Object.keys(at))
          if (!names.includes(key))
            issues.push(
              issue(
                pointer(path, key),
                "unknown_field",
                `${shown(key)} is not a field of the result.`,
                names,
              ),
            );
        for (const name of names) {
          const child = node.properties[name] as SchemaNode;
          if (Object.hasOwn(at, name))
            check(child, at[name], pointer(path, name));
          else if ((node.required ?? []).includes(name))
            issues.push(
              issue(
                pointer(path, name),
                "missing_field",
                `The required field ${shown(name)} is missing.`,
              ),
            );
        }
      }
    }
  };
  check(schema, value, "");
  return sortIssues(issues);
}
