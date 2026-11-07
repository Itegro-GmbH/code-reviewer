// SPDX-License-Identifier: LicenseRef-Proprietary

// What a step can reach, for the picker of the lane builder (#927): the values `{{…}}` may name at one place of a document, with their
// types and, when the lane has run, a sample. The reach is the validator's own: the document is checked with a probe that reads the
// scope at the node, so what the picker offers is what the validator accepts there (trigger facts, the steps that ran before on every
// path, `previous.*` only inside a loop body, `failure.*` only in `onFailure`) and nothing is worked out a second time. A target input
// is held to the same rule as in the validator (`targetVerdict`): only the values it takes are listed. A field that wants a kind of
// value (`wants`: a text, an operand of a comparison, an operand of `empty`) lists the values of that kind by the validator's own type
// rules, and both filters apply before the answer is cut at `REACH_ENTRIES_MAX`.
import { targetVerdict, type TargetCheck } from "./check-values.ts";
import type { StepState } from "./check-steps.ts";
import {
  categoryOfPath,
  nameOfPath,
  type ReachCategory,
} from "./reach-categories.ts";
import type { WorkflowResolver } from "./resolver.ts";
import {
  Scope,
  type Binding,
  type Env,
  type LoopFrame,
  type Use,
} from "./scope.ts";
import { validateWorkflow } from "./validate.ts";
import type { FieldType, ValueType } from "./value-type.ts";
import { isRecord } from "./json.ts";

/** The entries one answer lists at most: a document with thousands of steps does not make an answer of thousands of rows. */
export const REACH_ENTRIES_MAX = 400;
/** How deep into the fields of an object the answer goes. */
const REACH_DEPTH_MAX = 4;
const SAMPLE_MAX_LENGTH = 60;

export type ReachEntry = {
  /** `trigger.ticket.title`: the path of the reference. */
  reference: string;
  category: ReachCategory;
  /** What the picker calls it, without the category (`title`). */
  name: string;
  /** The type in words: `text`, `whole number`, `list of text`, `one of then, else`, `object`. */
  type: string;
  /** What to insert: `{{trigger.ticket.title}}`, with `| default …` where the validator wants one (an optional field, `previous.*`). */
  insert: string;
  /** What the value was in the latest run, cut short; missing when the lane has not run or the run had no such value. */
  sample?: string;
};

export type Reach = {
  /** Pointer of the node whose reach this is. */
  at: string;
  entries: ReachEntry[];
  /** The answer lists only the first `REACH_ENTRIES_MAX` values. */
  truncated: boolean;
};

/** What `POST .../workflows/scope` answers (#927): the reach of the step, and whether the samples are those of a run. */
export type ScopeAnswer = Reach & { sampled: boolean };

/** What a run held, as the sample of a value: the trigger, the output of each step and, in `onFailure`, the failure. */
export type ReachSamples = {
  trigger?: unknown;
  steps?: Readonly<Record<string, unknown>>;
  failure?: unknown;
};

/**
 * What a field takes by type, where the validator holds it to one: `text` (no object: it has no text form), `comparable` (an operand of
 * `equals`: a text, a choice, a number or true/false) and `emptiable` (an operand of `empty`: a list or a text). Left out: every value.
 */
export const REACH_WANTS = ["text", "comparable", "emptiable"] as const;
export type ReachWants = (typeof REACH_WANTS)[number];

export type ReachOptions = {
  /** Set for an input that decides a target: only the references it takes are listed. */
  target?: TargetCheck;
  wants?: ReachWants;
  samples?: ReachSamples;
  maxBudgetUsd?: number;
};

type Place = {
  /** Pointer of the node, or of the `until` of a loop. */
  wanted: string;
  node: string;
  /** The `next` instruction of an agent step: `previous.` needs no default there. */
  previousOk: boolean;
};

/** The keys that hold a list of steps. */
const LIST_KEYS = ["steps", "then", "else", "body", "onFailure"];

/**
 * The node a pointer is in: the last index of a list of steps on its way (`/steps/1/instruction/next` is in `/steps/1`). The `until`
 * of a loop reads the scope of the body, so it is a place of its own. `undefined`: the pointer is in no step.
 */
export function placeOf(at: string): Place | undefined {
  if (!at.startsWith("/")) return undefined;
  const segments = at.slice(1).split("/");
  let last = -1;
  segments.forEach((segment, index) => {
    const previous = segments[index - 1];
    if (
      /^(0|[1-9][0-9]*)$/.test(segment) &&
      previous !== undefined &&
      LIST_KEYS.includes(previous)
    )
      last = index;
  });
  if (last < 0) return undefined;
  const node = `/${segments.slice(0, last + 1).join("/")}`;
  const rest = segments.slice(last + 1);
  return {
    wanted: rest[0] === "until" ? `${node}/until` : node,
    node,
    previousOk: rest[0] === "instruction" && rest[1] === "next",
  };
}

type Snapshot = {
  bindings: Binding[];
  loops: LoopFrame[];
  state: StepState;
};

/** The type in words, short enough for a row of the picker. */
export function shortType(type: ValueType): string {
  switch (type.kind) {
    case "string":
      return "text";
    case "integer":
      return "whole number";
    case "number":
      return "number";
    case "boolean":
      return "true/false";
    case "enum":
      return `one of ${type.values.join(", ")}`;
    case "list":
      return `list of ${shortType(type.items)}`;
    case "object":
      return "object";
    case "oneOf":
      return type.options.map(shortType).join(" or ");
    case "unknown":
      return "a value";
  }
}

/** A default that fits the type, for a reference the validator wants one for. */
function defaultOf(type: ValueType): string {
  switch (type.kind) {
    case "string":
      return '""';
    case "number":
    case "integer":
      return "0";
    case "boolean":
      return "false";
    case "enum":
      return JSON.stringify(type.values[0] ?? "");
    case "list":
      return "[]";
    case "object":
      return "{}";
    case "oneOf":
      return defaultOf(type.options[0] ?? { kind: "unknown" });
    case "unknown":
      return '""';
  }
}

/** A value of a run as a short text, or nothing when it has no short form (an object). */
export function sampleText(value: unknown): string | undefined {
  const clip = (text: string): string => {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > SAMPLE_MAX_LENGTH
      ? `${line.slice(0, SAMPLE_MAX_LENGTH - 1)}…`
      : line;
  };
  if (typeof value === "string") return value === "" ? undefined : clip(value);
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value))
    return value.length === 0
      ? "none"
      : clip(
          value
            .map((entry: unknown) =>
              typeof entry === "string" ||
              typeof entry === "number" ||
              typeof entry === "boolean"
                ? String(entry)
                : "…",
            )
            .join(", "),
        );
  return undefined;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
  let current = root;
  for (const name of path) {
    if (!isRecord(current) || !Object.hasOwn(current, name)) return undefined;
    current = current[name];
  }
  return current;
}

function sampleOf(
  samples: ReachSamples | undefined,
  path: readonly string[],
): string | undefined {
  if (samples === undefined) return undefined;
  const [root, ...rest] = path as [string, ...string[]];
  if (root === "trigger") return sampleText(valueAt(samples.trigger, rest));
  if (root === "failure") return sampleText(valueAt(samples.failure, rest));
  const [step, ...fields] = root === "previous" ? rest : [root, ...rest];
  if (step === undefined || samples.steps === undefined) return undefined;
  return sampleText(valueAt(samples.steps[step], fields));
}

/** Whether a value of this type is one the field takes, by the validator's rules (`isAssignable`, `scalarKind`, `empty`). */
export function fitsWants(type: ValueType, wants: ReachWants): boolean {
  if (type.kind === "unknown") return true;
  if (type.kind === "oneOf") {
    // A union is used as one of its options only where every option is accepted (`isAssignable`); the comparison and `empty` read it as no kind at all.
    return wants === "text"
      ? type.options.every((option) => fitsWants(option, wants))
      : false;
  }
  switch (wants) {
    case "text":
      return type.kind !== "object";
    case "comparable":
      return (
        type.kind === "string" ||
        type.kind === "enum" ||
        type.kind === "number" ||
        type.kind === "integer" ||
        type.kind === "boolean"
      );
    case "emptiable":
      return type.kind === "list" || type.kind === "string";
  }
}

type Walk = {
  entries: ReachEntry[];
  truncated: boolean;
  samples: ReachSamples | undefined;
  /** `previous.` needs a default (it exists from round two) unless the text is the `next` instruction. */
  previousNeedsDefault: boolean;
  /** The values the field takes, asked before an entry counts towards the limit. */
  takes: (path: readonly string[], type: ValueType) => boolean;
};

function addEntry(
  walk: Walk,
  path: readonly string[],
  type: ValueType,
  optional: boolean,
): void {
  if (!walk.takes(path, type)) return;
  if (walk.entries.length >= REACH_ENTRIES_MAX) {
    walk.truncated = true;
    return;
  }
  const needsDefault =
    optional || (path[0] === "previous" && walk.previousNeedsDefault);
  const reference = path.join(".");
  const sample = sampleOf(walk.samples, path);
  walk.entries.push({
    reference,
    category: categoryOfPath(path),
    name: nameOfPath(path),
    type: shortType(type),
    insert: needsDefault
      ? `{{${reference} | default ${defaultOf(type)}}}`
      : `{{${reference}}}`,
    ...(sample === undefined ? {} : { sample }),
  });
}

/** The fields of a value, depth first, each as an entry; a list is one entry (a reference has no index). */
function walkFields(
  walk: Walk,
  path: readonly string[],
  type: ValueType,
  optional: boolean,
): void {
  if (type.kind !== "object" || path.length >= REACH_DEPTH_MAX + 1) return;
  for (const [name, field] of Object.entries(type.fields)) {
    const next = [...path, name];
    const open = optional || !field.required;
    addEntry(walk, next, field.type, open);
    walkFields(walk, next, field.type, open);
  }
}

/**
 * `trigger.issue` and `trigger.repo` are what a lane written before #916 reads of a label trigger: the validator still takes them, the
 * picker offers `trigger.ticket` (the same values) instead.
 */
function withoutLegacy(binding: Binding): ValueType {
  const type = binding.type;
  if (
    binding.kind !== "trigger" ||
    type.kind !== "object" ||
    !Object.hasOwn(type.fields, "ticket")
  )
    return type;
  const fields: Record<string, FieldType> = { ...type.fields };
  delete fields.issue;
  delete fields.repo;
  return { kind: "object", fields };
}

/** The values a snapshot of the validator's scope reaches, in the order the picker lists them. */
function entriesOf(
  snapshot: Snapshot,
  place: Place,
  options: ReachOptions,
): { entries: ReachEntry[]; truncated: boolean } {
  const { target, wants } = options;
  const use: Use | undefined = (() => {
    if (target === undefined) return undefined;
    const scope = new Scope();
    for (const binding of snapshot.bindings) scope.set(binding.id, binding);
    const env: Env = { scope, loops: snapshot.loops };
    return {
      path: place.wanted,
      env,
      previousOk: place.previousOk,
      nodePath: place.node,
      branches: snapshot.state.branches,
    };
  })();
  const walk: Walk = {
    entries: [],
    truncated: false,
    samples: options.samples,
    previousNeedsDefault: !place.previousOk,
    takes: (path, type) =>
      (wants === undefined || fitsWants(type, wants)) &&
      (target === undefined ||
        use === undefined ||
        targetVerdict({ path: [...path] }, target, use) === "ok"),
  };
  for (const binding of snapshot.bindings) {
    if (binding.kind === "reserved" || binding.type.kind !== "object") continue;
    walkFields(walk, [binding.id], withoutLegacy(binding), false);
  }
  const frame = snapshot.loops[snapshot.loops.length - 1];
  if (frame !== undefined)
    for (const binding of frame.previous.values())
      if (binding.type.kind === "object")
        walkFields(walk, ["previous", binding.id], binding.type, false);
  return { entries: walk.entries, truncated: walk.truncated };
}

/**
 * What the node at `at` can reach in `document`, or `undefined` when `at` names no step of it. The document may be unsaved and may
 * have problems: the check reads the scope at the node and goes no further, and whatever is wrong elsewhere does not stop the answer.
 */
export function reachAt(
  document: unknown,
  resolver: WorkflowResolver,
  at: string,
  options: ReachOptions = {},
): Reach | undefined {
  const place = placeOf(at);
  if (place === undefined) return undefined;
  let found: Snapshot | undefined;
  validateWorkflow(document, resolver, {
    ...(options.maxBudgetUsd === undefined
      ? {}
      : { maxBudgetUsd: options.maxBudgetUsd }),
    probe: (path, env, state) => {
      if (path !== place.wanted || found !== undefined) return;
      found = { bindings: [...env.scope.values()], loops: env.loops, state };
    },
    done: () => found !== undefined,
  });
  if (found === undefined) return undefined;
  const { entries, truncated } = entriesOf(found, place, options);
  return { at: place.node, entries, truncated };
}
