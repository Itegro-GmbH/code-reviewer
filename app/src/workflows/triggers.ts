// SPDX-License-Identifier: LicenseRef-Proprietary

// The triggers of format v1 (#833, #916) and what each one hands to the steps: `{{trigger.<field>}}`. A workflow has several triggers,
// each with pre-steps of its own (`steps`), and then the shared steps run for all of them: every trigger must end with the same
// context, so the shared steps may only read what EVERY trigger yields (`commonTriggerType`).
import type { ResultSchema } from "./result-schema.ts";
import { objectTypeOf } from "./result-schema.ts";
import { TICKET_INPUT, TICKET_REPO_TYPE, TICKET_TYPE } from "./ticket-ref.ts";

export { TICKET_INPUT };
import {
  INTEGER,
  STRING,
  listOf,
  objectOf,
  type FieldType,
  type ObjectType,
  type ValueType,
} from "./value-type.ts";

/**
 * - `manual`: started by hand, `input` declares what the caller hands in. `api`: the same, started through the API only.
 * - `ticket.labeled`: a label put on a ticket (an issue of a repository of the workspace).
 * - `pullRequest.pushed`, `schedule`: reserved. The format knows and validates them, the engine starts no run from them yet.
 * - `github.issueLabeled`: the name `ticket.labeled` had before #916, accepted everywhere it was.
 */
export const TRIGGER_KINDS = [
  "manual",
  "api",
  "ticket.labeled",
  "pullRequest.pushed",
  "schedule",
  "github.issueLabeled",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The kinds as they are stored and shown: the old name of the label trigger is read as the new one. */
export type CanonicalTriggerKind = Exclude<TriggerKind, "github.issueLabeled">;

export function canonicalTriggerKind(kind: TriggerKind): CanonicalTriggerKind {
  return kind === "github.issueLabeled" ? "ticket.labeled" : kind;
}

/** The kinds a person or a script starts by calling the API (the start form offers `manual` only). */
export const STARTABLE_TRIGGER_KINDS = ["manual", "api"] as const;

export function isStartableKind(kind: string): boolean {
  return (STARTABLE_TRIGGER_KINDS as readonly string[]).includes(kind);
}

/** The keys of a trigger node, besides `id`, `kind` and `steps`. */
export const TRIGGER_FIELDS: Record<TriggerKind, readonly string[]> = {
  manual: ["input"],
  api: ["input"],
  "ticket.labeled": ["label"],
  "github.issueLabeled": ["label"],
  "pullRequest.pushed": [],
  schedule: ["cron"],
};

/** The id a trigger written the old way (the single `trigger`, without an id) has in the list it is read as. */
export function legacyTriggerId(kind: TriggerKind): string {
  const canonical = canonicalTriggerKind(kind);
  return canonical === "ticket.labeled"
    ? "labeled"
    : canonical === "pullRequest.pushed"
      ? "pushed"
      : canonical;
}

const ISSUE = objectOf({
  number: INTEGER,
  title: STRING,
  body: STRING,
  url: STRING,
  labels: listOf(STRING),
});

/** A trigger as the validator knows it after its form was checked. */
export type TriggerInfo = {
  id: string;
  kind: TriggerKind;
  input?: ResultSchema;
  /** The input failed its own check, which is reported where it is written. */
  inputInvalid?: boolean;
};

/** Whether the input declares a ticket the caller must hand in: the run's repository is the ticket's. */
export function declaresTicket(input: ResultSchema | undefined): boolean {
  return (
    input !== undefined &&
    Object.hasOwn(input.properties, TICKET_INPUT) &&
    input.properties[TICKET_INPUT]?.type === "ticket"
  );
}

/** Whether a trigger yields `{{trigger.ticket}}`: a label trigger always, a manual or api one when its input requires one. */
export function yieldsTicket(trigger: TriggerInfo): boolean {
  const kind = canonicalTriggerKind(trigger.kind);
  if (kind === "ticket.labeled") return true;
  return (
    (kind === "manual" || kind === "api") &&
    declaresTicket(trigger.input) &&
    (trigger.input?.required ?? []).includes(TICKET_INPUT)
  );
}

/** The fields of the input the caller hands in, without the ticket (which is read as `trigger.ticket`). */
function inputFieldsOf(input: ResultSchema): ObjectType {
  const { [TICKET_INPUT]: ticket, ...rest } = input.properties;
  return objectTypeOf({
    ...input,
    properties: ticket?.type === "ticket" ? rest : input.properties,
    ...(input.required === undefined
      ? {}
      : { required: input.required.filter((name) => name !== TICKET_INPUT) }),
  });
}

/**
 * What `trigger.*` holds for one trigger: `id` and `kind` always; then, by kind,
 * - `ticket.labeled`: `ticket`, and `issue` and `repo` as workflows written before #916 read them;
 * - `manual`, `api`: `input` (what the schema declares, without the ticket) and, when the input requires one, `ticket`;
 * - the reserved kinds: nothing more.
 */
export function triggerOutput(trigger: TriggerInfo): ObjectType {
  const kind = canonicalTriggerKind(trigger.kind);
  const facts = { id: STRING, kind: STRING };
  if (kind === "ticket.labeled")
    return objectOf({
      ...facts,
      ticket: TICKET_TYPE,
      issue: ISSUE,
      repo: TICKET_REPO_TYPE,
    });
  if (kind === "manual" || kind === "api") {
    const input =
      trigger.input === undefined ? objectOf({}) : inputFieldsOf(trigger.input);
    const fields: ObjectType["fields"] = {
      ...objectOf(facts).fields,
      input: { type: input, required: true },
      ...(yieldsTicket(trigger)
        ? { ticket: { type: TICKET_TYPE, required: true } }
        : {}),
    };
    return { kind: "object", fields };
  }
  return objectOf(facts);
}

function sameType(a: ValueType, b: ValueType): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * What every trigger yields: the fields all of them have, required when all of them require it; an object field is the common part
 * of the objects. A trigger whose type is unknown (its own check failed) leaves the type as the others' have it, so one mistake is
 * reported once.
 */
export function commonTriggerType(
  types: readonly (ObjectType | { kind: "unknown" })[],
): ObjectType | { kind: "unknown" } {
  const known = types.filter(
    (type): type is ObjectType => type.kind === "object",
  );
  const [first, ...others] = known;
  if (first === undefined) return { kind: "unknown" };
  const fields: Record<string, FieldType> = {};
  for (const [name, field] of Object.entries(first.fields)) {
    let type: ValueType | undefined = field.type;
    let required = field.required;
    for (const other of others) {
      const found = Object.hasOwn(other.fields, name)
        ? other.fields[name]
        : undefined;
      if (found === undefined) {
        type = undefined;
        break;
      }
      required = required && found.required;
      if (type.kind === "object" && found.type.kind === "object")
        type = commonTriggerType([type, found.type]);
      else if (!sameType(type, found.type)) {
        type = undefined;
        break;
      }
    }
    if (type !== undefined) fields[name] = { type, required };
  }
  return { kind: "object", fields };
}
