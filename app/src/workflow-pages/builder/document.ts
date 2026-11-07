// SPDX-License-Identifier: LicenseRef-Proprietary

// The lane builder's model (#926): the workflow document itself, edited as plain JSON with small immutable operations. There is no second
// representation to keep in step with the validator: what the builder shows is the document, what it saves is the document, and a node is
// found by the JSON pointer the validator's errors use. Nothing here validates; the validator does (`./validation.ts` asks it).
import { LOOP_ROUNDS_MAX, STEPS_MAX } from "../../workflows/limits.ts";
import { canonicalJson, isRecord } from "../../workflows/json.ts";
import { legacyTriggerId, TRIGGER_KINDS } from "../../workflows/triggers.ts";
import type { TriggerKind } from "../../workflows/triggers.ts";

export type Doc = Record<string, unknown>;
/** A JSON pointer into the document (`/steps/2/body/0`); `""` is the document. The same strings the validator reports as `path`. */
export type Pointer = string;
export type NodeKind = "trigger" | "agent" | "action" | "loop" | "if";

export { LOOP_ROUNDS_MAX, STEPS_MAX };

// --- pointers

function escapeSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function segmentsOf(pointer: Pointer): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function pointerOf(...segments: (string | number)[]): Pointer {
  return segments
    .map((segment) => `/${escapeSegment(String(segment))}`)
    .join("");
}

function child(base: Pointer, ...segments: (string | number)[]): Pointer {
  return `${base}${pointerOf(...segments)}`;
}

/** The lists of steps a node holds, by the key they sit under. */
const CHILD_LISTS = ["body", "then", "else"] as const;

// --- reading

function valueAt(doc: unknown, segments: readonly string[]): unknown {
  let current: unknown = doc;
  for (const segment of segments) {
    if (Array.isArray(current))
      current = (current as unknown[])[Number(segment)];
    else if (isRecord(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

export function getAt(doc: Doc, pointer: Pointer): unknown {
  return valueAt(doc, segmentsOf(pointer));
}

export function nodeAt(doc: Doc, pointer: Pointer): Doc | undefined {
  const found = getAt(doc, pointer);
  return isRecord(found) ? found : undefined;
}

/** Where a node's list is and the node's place in it: `/steps/2` is index 2 of `/steps`. Undefined for the document and a trigger. */
function splitNode(
  pointer: Pointer,
): { list: Pointer; index: number } | undefined {
  if (isTriggerPointer(pointer)) return undefined;
  const segments = segmentsOf(pointer);
  const last = segments.at(-1);
  if (last === undefined || !/^\d+$/.test(last)) return undefined;
  return { list: pointerOf(...segments.slice(0, -1)), index: Number(last) };
}

export function isTriggerPointer(pointer: Pointer): boolean {
  return /^\/triggers\/\d+$/.test(pointer);
}

export function kindOf(doc: Doc, pointer: Pointer): NodeKind | undefined {
  if (isTriggerPointer(pointer)) return "trigger";
  const kind = nodeAt(doc, pointer)?.kind;
  return kind === "agent" ||
    kind === "action" ||
    kind === "loop" ||
    kind === "if"
    ? kind
    : undefined;
}

function listAt(doc: Doc, list: Pointer): unknown[] {
  const found = getAt(doc, list);
  return Array.isArray(found) ? (found as unknown[]) : [];
}

/** The nodes of a list, each with its pointer. A list that is not there (an `if` without `else`) has none. */
export function nodesOf(
  doc: Doc,
  list: Pointer,
): { pointer: Pointer; node: Doc }[] {
  return listAt(doc, list).flatMap((entry, index) =>
    isRecord(entry) ? [{ pointer: child(list, index), node: entry }] : [],
  );
}

// --- writing: copies the path to the change and shares the rest

function withValue(
  current: unknown,
  segments: readonly string[],
  value: unknown,
): unknown {
  const [head, ...rest] = segments;
  if (head === undefined) return value;
  if (Array.isArray(current)) {
    const copy = [...(current as unknown[])];
    copy[Number(head)] = withValue(copy[Number(head)], rest, value);
    return copy;
  }
  const record = isRecord(current) ? current : {};
  return { ...record, [head]: withValue(record[head], rest, value) };
}

/** The document with `value` at `pointer`; `undefined` removes a key. */
export function setAt(doc: Doc, pointer: Pointer, value: unknown): Doc {
  const segments = segmentsOf(pointer);
  if (value === undefined) {
    const parent = valueAt(doc, segments.slice(0, -1));
    const key = segments.at(-1);
    if (key === undefined || !isRecord(parent)) return doc;
    const kept = { ...parent };
    delete kept[key];
    return withValue(doc, segments.slice(0, -1), kept) as Doc;
  }
  return withValue(doc, segments, value) as Doc;
}

/** The node with `patch` applied: a key set to `undefined` is removed. */
export function patchNode(
  doc: Doc,
  pointer: Pointer,
  patch: Record<string, unknown>,
): Doc {
  const node = nodeAt(doc, pointer);
  if (node === undefined) return doc;
  const next: Doc = { ...node };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return setAt(doc, pointer, next);
}

/** Writes a list; an empty `else` or `onFailure` is left out instead of kept as `[]`. */
function setList(doc: Doc, list: Pointer, entries: unknown[]): Doc {
  const key = segmentsOf(list).at(-1);
  const optional = key === "else" || key === "onFailure";
  return setAt(
    doc,
    list,
    optional && entries.length === 0 ? undefined : entries,
  );
}

export function insertNode(
  doc: Doc,
  list: Pointer,
  index: number,
  node: Doc,
): { doc: Doc; pointer: Pointer } {
  const entries = [...listAt(doc, list)];
  const at = Math.max(0, Math.min(index, entries.length));
  entries.splice(at, 0, node);
  return { doc: setList(doc, list, entries), pointer: child(list, at) };
}

/** Removes a node of a list; the pointer of the node that takes its place in the view (the previous one, else the list's owner). */
export function removeNode(
  doc: Doc,
  pointer: Pointer,
): { doc: Doc; selection: Pointer } {
  const place = splitNode(pointer);
  if (place === undefined) return { doc, selection: pointer };
  const entries = [...listAt(doc, place.list)];
  entries.splice(place.index, 1);
  const selection =
    place.index > 0
      ? child(place.list, place.index - 1)
      : ownerOf(
          place.list,
          entries.length > 0 ? child(place.list, 0) : undefined,
        );
  return { doc: setList(doc, place.list, entries), selection };
}

/** The pointer to select when a list has no node left: the loop, `if` or trigger that holds it, else the first shared step. */
function ownerOf(list: Pointer, firstLeft: Pointer | undefined): Pointer {
  if (firstLeft !== undefined) return firstLeft;
  const segments = segmentsOf(list);
  const key = segments.at(-1);
  if (key === "steps" && segments.length > 1)
    return pointerOf(...segments.slice(0, -1));
  if (key === "body" || key === "then" || key === "else")
    return pointerOf(...segments.slice(0, -1));
  return "/steps/0";
}

export function canMove(
  doc: Doc,
  pointer: Pointer,
  direction: -1 | 1,
): boolean {
  const place = splitNode(pointer);
  if (place === undefined) return false;
  const length = listAt(doc, place.list).length;
  const target = place.index + direction;
  return target >= 0 && target < length;
}

export function moveNode(
  doc: Doc,
  pointer: Pointer,
  direction: -1 | 1,
): { doc: Doc; pointer: Pointer } {
  const place = splitNode(pointer);
  if (place === undefined || !canMove(doc, pointer, direction))
    return { doc, pointer };
  const entries = [...listAt(doc, place.list)];
  const target = place.index + direction;
  const [moved] = entries.splice(place.index, 1);
  entries.splice(target, 0, moved);
  return {
    doc: setAt(doc, place.list, entries),
    pointer: child(place.list, target),
  };
}

// --- ids

/** Every id in the document: triggers, and steps at any depth (pre-steps, shared steps, branches, loop bodies, onFailure). */
export function idsIn(doc: Doc): string[] {
  const ids: string[] = [];
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries as unknown[]) {
      if (!isRecord(entry)) continue;
      if (typeof entry.id === "string") ids.push(entry.id);
      visit(entry.steps);
      for (const key of CHILD_LISTS) visit(entry[key]);
    }
  };
  visit(doc.triggers);
  visit(doc.steps);
  visit(doc.onFailure);
  return ids;
}

export function uniqueId(doc: Doc, base: string): string {
  const taken = new Set(idsIn(doc));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** How many steps the document has, counted the way the validator counts them (`STEPS_MAX`): through branches and bodies, pre-steps and `onFailure` included. */
export function stepCountOf(doc: Doc): number {
  const count = (entries: unknown): number => {
    if (!Array.isArray(entries)) return 0;
    return (entries as unknown[]).reduce<number>(
      (sum, entry) =>
        isRecord(entry)
          ? sum + 1 + count(entry.body) + count(entry.then) + count(entry.else)
          : sum,
      0,
    );
  };
  const pre = Array.isArray(doc.triggers)
    ? (doc.triggers as unknown[]).reduce<number>(
        (sum, trigger) => sum + (isRecord(trigger) ? count(trigger.steps) : 0),
        0,
      )
    : 0;
  return pre + count(doc.steps) + count(doc.onFailure);
}

// --- reading what an older document says

/**
 * The document as the builder edits it: the single `trigger` of the format before #916 becomes `triggers` with that one entry, with the id
 * the engine gives it, so the pointers of the validator's errors (which the builder validates, in this form) lead to the nodes shown.
 * Everything else is left as it was; a document that is not an object is not editable.
 */
export function normalise(document: unknown): Doc | undefined {
  if (!isRecord(document)) return undefined;
  if (Array.isArray(document.triggers) || !isRecord(document.trigger))
    return document;
  const { trigger, ...rest } = document;
  const legacy = trigger as Doc;
  const kind = legacy.kind;
  const known = (TRIGGER_KINDS as readonly unknown[]).includes(kind);
  const entry: Doc = {
    id: known ? legacyTriggerId(kind as TriggerKind) : "trigger1",
    ...legacy,
    steps: [],
  };
  // Keep the keys in the order a document written today has them: `triggers` where `trigger` was.
  const out: Doc = {};
  let placed = false;
  for (const key of Object.keys(document)) {
    if (key === "trigger") {
      out.triggers = [entry];
      placed = true;
    } else out[key] = rest[key];
  }
  if (!placed) out.triggers = [entry];
  return out;
}

/**
 * The document to save: the one the builder edits, except that a lane written with the single `trigger` keeps that shape while the person
 * has not touched the trigger (the `id` and `steps` that `normalise` added are dropped again). `original` is what the server holds.
 * Editing the trigger, or adding a step to it, saves `triggers`.
 */
export function forSave(doc: Doc, original: unknown): Doc {
  if (
    !isRecord(original) ||
    Array.isArray(original.triggers) ||
    !isRecord(original.trigger)
  )
    return doc;
  const before = normalise(original)?.triggers;
  const now = doc.triggers;
  if (
    !Array.isArray(before) ||
    !Array.isArray(now) ||
    now.length !== 1 ||
    canonicalJson(now[0]) !== canonicalJson(before[0])
  )
    return doc;
  const out: Doc = {};
  for (const key of Object.keys(doc))
    if (key === "triggers") out.trigger = original.trigger;
    else out[key] = doc[key];
  return out;
}

// --- new nodes

export type NodeDefaults = {
  /** The profile a new agent step starts with (the first the workspace has), or nothing. */
  profile?: string;
};

/**
 * A new step, as small as the format allows and not yet valid where only the person knows (an empty instruction, an empty condition):
 * the validator says what is missing. A new agent step names no `environment`: its profile says where it runs (#919).
 */
export function newNode(
  doc: Doc,
  kind: Exclude<NodeKind, "trigger">,
  defaults: NodeDefaults = {},
): Doc {
  switch (kind) {
    case "agent": {
      return {
        id: uniqueId(doc, "agent"),
        kind: "agent",
        profile: defaults.profile ?? "",
        session: "new",
        instruction: "",
      };
    }
    case "action":
      return {
        id: uniqueId(doc, "action"),
        kind: "action",
        connector: "ticket.comment",
        ticket: "{{trigger.ticket}}",
        body: "",
      };
    case "loop":
      return {
        id: uniqueId(doc, "loop"),
        kind: "loop",
        maxRounds: 3,
        body: [],
        until: { notEmpty: "" },
      };
    case "if":
      return {
        id: uniqueId(doc, "if"),
        kind: "if",
        when: { notEmpty: "" },
        then: [],
      };
  }
}

/** The fields a trigger of this kind starts with when its kind is changed. */
export function triggerFields(kind: string): Doc {
  switch (kind) {
    case "ticket.labeled":
    case "github.issueLabeled":
      return { label: "agent implement" };
    case "manual":
    case "api":
      return {
        input: {
          type: "object",
          required: ["ticket"],
          properties: { ticket: { type: "ticket" } },
        },
      };
    case "schedule":
      return { cron: "0 2 * * *" };
    default:
      return {};
  }
}

/** The trigger with another kind: the fields of the old kind go, the new kind's start. */
export function withTriggerKind(doc: Doc, pointer: Pointer, kind: string): Doc {
  const node = nodeAt(doc, pointer);
  if (node === undefined) return doc;
  const steps = node.steps;
  return setAt(doc, pointer, {
    id: node.id,
    kind,
    ...triggerFields(kind),
    ...(steps === undefined ? {} : { steps }),
  });
}

// --- where a step may go

/** The list a step added "after" a node goes into, and the index after it. */
export function afterNode(
  pointer: Pointer,
): { list: Pointer; index: number } | undefined {
  const place = splitNode(pointer);
  return place === undefined
    ? undefined
    : { list: place.list, index: place.index + 1 };
}

/** The key of the list a node sits in (`steps`, `body`, `then`, `else`, `onFailure`). */
export function listKeyOf(pointer: Pointer): string | undefined {
  const place = splitNode(pointer);
  return place === undefined ? undefined : segmentsOf(place.list).at(-1);
}

/** Whether the node sits in a loop's body, at any depth (a reference to `previous.*` and `instruction.next` are for these). */
export function isInLoop(doc: Doc, pointer: Pointer): boolean {
  const segments = segmentsOf(pointer);
  for (let at = segments.length - 1; at > 0; at -= 1) {
    if (segments[at - 1] !== "body" || !/^\d+$/.test(segments[at] ?? ""))
      continue;
    return true;
  }
  return false;
}

/** Whether the node is in the steps that run after a failure. */
export function isInOnFailure(pointer: Pointer): boolean {
  return segmentsOf(pointer)[0] === "onFailure";
}

/** The ids of the agent steps in the document, in document order: what `session.continue` may name. */
export function agentIds(doc: Doc): string[] {
  const ids: string[] = [];
  const visit = (entries: unknown): void => {
    if (!Array.isArray(entries)) return;
    for (const entry of entries as unknown[]) {
      if (!isRecord(entry)) continue;
      if (entry.kind === "agent" && typeof entry.id === "string")
        ids.push(entry.id);
      visit(entry.steps);
      for (const key of CHILD_LISTS) visit(entry[key]);
    }
  };
  visit(doc.triggers);
  visit(doc.steps);
  return ids;
}

export function hasEnvironment(node: Doc): boolean {
  return Object.hasOwn(node, "environment");
}
