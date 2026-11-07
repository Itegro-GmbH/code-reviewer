// SPDX-License-Identifier: LicenseRef-Proprietary

// The inputs of an action as the inspector shows them (#926): from the connector's own spec (`workflows/connectors.ts`), so the builder
// and the validator never disagree about which inputs a connector has, which are required and which are targets. Pure helpers.
import {
  BUILT_IN_CONNECTORS,
  type ConnectorSpec,
  type InputSpec,
} from "../../workflows/connectors.ts";
import type { ValueType } from "../../workflows/value-type.ts";
import type { Doc } from "./document.ts";

export type Control =
  | "text"
  | "longText"
  /** A whole number or a reference (`7`, `{{trigger.ticket}}`). */
  | "numberOrText"
  | "list"
  /** A list of names, or one reference to a list (`{{trigger.input.labels}}`); `"project members"` is a text too. */
  | "listOrText"
  | "boolean";

export const CONNECTOR_NAMES: readonly string[] = BUILT_IN_CONNECTORS.map(
  (spec) => spec.name,
);

export function specOf(connector: unknown): ConnectorSpec | undefined {
  return BUILT_IN_CONNECTORS.find((spec) => spec.name === connector);
}

function isListOfStrings(type: ValueType): boolean {
  return type.kind === "list" && type.items.kind === "string";
}

export function controlOf(name: string, input: InputSpec): Control {
  const type = input.type;
  if (type.kind === "boolean") return "boolean";
  if (type.kind === "integer") return "numberOrText";
  if (isListOfStrings(type)) return "list";
  if (type.kind === "oneOf") {
    if (type.options.some((option) => isListOfStrings(option)))
      return "listOrText";
    return "numberOrText";
  }
  return name === "body" || name === "title" ? "longText" : "text";
}

/** The text a value shows: a list one entry to a line. */
export function textOfValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value))
    return (value as unknown[])
      .filter((entry): entry is string => typeof entry === "string")
      .join("\n");
  return "";
}

const WHOLE_REFERENCE = /^\{\{[^{}]*\}\}$/;

/** The value a text stands for, for a field of this kind; `undefined` removes an optional input. */
export function valueOfText(
  control: Control,
  text: string,
  required: boolean,
): unknown {
  const empty = required ? "" : undefined;
  if (control === "list" || control === "listOrText") {
    const trimmed = text.trim();
    if (trimmed === "")
      return required ? (control === "list" ? [] : "") : undefined;
    if (
      control === "listOrText" &&
      (WHOLE_REFERENCE.test(trimmed) || trimmed === "project members")
    )
      return trimmed;
    if (control === "list" && WHOLE_REFERENCE.test(trimmed)) return trimmed;
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }
  if (text === "") return empty;
  if (control === "numberOrText" && /^\d{1,10}$/.test(text.trim()))
    return Number(text.trim());
  return text;
}

/** The ticket an input of the old `issue` name stands for under the new `ticket` name and the other way round. */
const RENAMED: Record<string, string> = { issue: "ticket", ticket: "issue" };

/**
 * The action with another connector: what it keeps are the inputs the new connector also has (an `issue` becomes a `ticket` and the
 * other way round); every required input the node lacks starts empty, or as `{{trigger.ticket}}` for the ticket.
 */
export function withConnector(node: Doc, connector: string): Doc {
  const spec = specOf(connector);
  const next: Doc = { id: node.id, kind: "action", connector };
  if (node.description !== undefined) next.description = node.description;
  if (spec === undefined) return next;
  for (const [name, input] of Object.entries(spec.inputs)) {
    const from = [name, RENAMED[name]].find(
      (key) => key !== undefined && node[key] !== undefined,
    );
    if (from !== undefined) next[name] = node[from];
    else if (input.required)
      next[name] =
        name === "ticket" || name === "issue"
          ? "{{trigger.ticket}}"
          : controlOf(name, input) === "list"
            ? []
            : "";
  }
  return next;
}

/** Inputs in the order the connector lists them, required ones first. */
export function inputsOf(spec: ConnectorSpec): [string, InputSpec][] {
  const entries = Object.entries(spec.inputs);
  return [
    ...entries.filter(([, input]) => input.required),
    ...entries.filter(([, input]) => !input.required),
  ];
}
