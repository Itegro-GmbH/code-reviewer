// SPDX-License-Identifier: LicenseRef-Proprietary

// The form that starts a run by hand (#873), made from the workflow document: the fields are those of the `input` of the manual
// trigger, a result schema. Read on the server, where the page loads the workflow; the form component gets the plain list.
import { isRecord } from "../workflows/json.ts";
import { validateResultSchema } from "../workflows/result-schema.ts";

/** One field of the form that starts a run by hand, made from the `input` schema of a manual trigger. */
export type StartField = {
  name: string;
  required: boolean;
  description?: string;
  /** `ticket` (#916) is a reference to a ticket, written like `github:owner/repo#128`: a text in the form. */
  kind: "string" | "integer" | "number" | "boolean" | "json" | "ticket";
  /** The allowed values of a string field with a list of names. */
  choices?: string[];
};

/** The form of one manual trigger. `trigger` is its id, sent with the start; a document with the single `trigger` of before #916 has none. */
export type StartFormFields = { fields: StartField[]; trigger?: string };

export type StartFormSpec =
  | { kind: "not_manual" }
  | { kind: "unusable" }
  | ({ kind: "form" } & StartFormFields)
  /** Several manual triggers (#916): one form each, the person starts the one they mean. */
  | { kind: "forms"; forms: (StartFormFields & { trigger: string })[] };

function fieldsOf(input: unknown): StartField[] | undefined {
  const schema = validateResultSchema(input, "", { allowTicket: true }).schema;
  if (schema === undefined) return undefined;
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
  // The repository (or the ticket, which names it) comes first: every run works on one.
  const first = (name: string): number =>
    Number(name === "repo" || name === "ticket");
  fields.sort((a, b) => first(b.name) - first(a.name));
  return fields;
}

/**
 * The form a workflow document asks for: the fields of the `input` of its manual trigger. A document with `triggers` has one form for
 * each trigger of the kind `manual` (an `api` trigger is started through the API only).
 */
export function startFormOf(document: unknown): StartFormSpec {
  if (!isRecord(document)) return { kind: "unusable" };
  if (Array.isArray(document.triggers)) {
    const forms: (StartFormFields & { trigger: string })[] = [];
    for (const trigger of document.triggers as unknown[]) {
      if (!isRecord(trigger) || typeof trigger.id !== "string")
        return { kind: "unusable" };
      if (trigger.kind !== "manual") continue;
      const fields = fieldsOf(trigger.input);
      if (fields === undefined) return { kind: "unusable" };
      forms.push({ trigger: trigger.id, fields });
    }
    const [only, ...more] = forms;
    if (only === undefined) return { kind: "not_manual" };
    return more.length === 0
      ? { kind: "form", ...only }
      : { kind: "forms", forms };
  }
  if (!isRecord(document.trigger)) return { kind: "unusable" };
  if (document.trigger.kind !== "manual") return { kind: "not_manual" };
  const fields = fieldsOf(document.trigger.input);
  return fields === undefined ? { kind: "unusable" } : { kind: "form", fields };
}
