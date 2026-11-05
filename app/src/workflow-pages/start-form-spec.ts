// SPDX-License-Identifier: LicenseRef-Proprietary

// The form that starts a run by hand (#873), made from the workflow document: the fields are those of the `input` of the manual
// trigger, a result schema. Read on the server, where the page loads the workflow; the form component gets the plain list.
import { isRecord } from "../workflows/json.ts";
import { validateResultSchema } from "../workflows/result-schema.ts";

/** One field of the form that starts a run, made from the `input` schema of the manual trigger. */
export type StartField = {
  name: string;
  required: boolean;
  description?: string;
  kind: "string" | "integer" | "number" | "boolean" | "json";
  /** The allowed values of a string field with a list of names. */
  choices?: string[];
};

export type StartFormSpec =
  | { kind: "not_manual" }
  | { kind: "unusable" }
  | { kind: "form"; fields: StartField[] };

/** The form a workflow document asks for: the fields of the `input` of its manual trigger. */
export function startFormOf(document: unknown): StartFormSpec {
  if (!isRecord(document) || !isRecord(document.trigger))
    return { kind: "unusable" };
  if (document.trigger.kind !== "manual") return { kind: "not_manual" };
  const schema = validateResultSchema(document.trigger.input).schema;
  if (schema === undefined) return { kind: "unusable" };
  const required = new Set(schema.required ?? []);
  const fields = Object.entries(schema.properties).map(
    ([name, node]): StartField => {
      const field: StartField = {
        name,
        required: required.has(name),
        kind:
          node.type === "array" || node.type === "object" ? "json" : node.type,
      };
      if (node.description !== undefined) field.description = node.description;
      if (node.type === "string" && node.enum !== undefined)
        field.choices = [...node.enum];
      return field;
    },
  );
  // The repository comes first: every run works on one.
  fields.sort((a, b) => Number(b.name === "repo") - Number(a.name === "repo"));
  return { kind: "form", fields };
}
