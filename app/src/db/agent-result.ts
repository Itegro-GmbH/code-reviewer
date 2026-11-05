// SPDX-License-Identifier: LicenseRef-Proprietary

// The result an agent hands in through the finish tool (#843), as far as it can be judged without its schema: an object of JSON within
// the bounds of a result. This is the part the database layer, the runner API and the schema check share, so it imports nothing: the
// check against the schema of the turn is `implementer/agent-result.ts`. Pure.

/** JSON as the app holds it; kept here so that this module needs no other. */
export type AgentJson =
  | null
  | boolean
  | number
  | string
  | AgentJson[]
  | { [key: string]: AgentJson };

/** The result of an agent: an object of JSON, bounded before the app keeps it. */
export type AgentResultValue = { [key: string]: AgentJson };

/**
 * The result schema of a turn as the database holds it: an object of the format of `contracts/result-schema.v1.json`, already judged by
 * the validator of the format (`workflows/result-schema.ts`) before it was written. The layers below the validator carry it, they do not
 * read it.
 */
export type StoredResultSchema = {
  type: "object";
  properties: { [name: string]: unknown };
  [key: string]: unknown;
};

/** The most a result takes, as compact JSON in UTF-8 bytes; the runner holds the file it reads to the same number (`MAX_RESULT_BYTES`). */
export const AGENT_RESULT_MAX_BYTES = 256 * 1024;
/** Levels of lists and objects the value may nest, with room to spare (the format allows 4). */
export const AGENT_RESULT_MAX_DEPTH = 8;
/** Values in all: list entries, fields, nested lists and objects. */
export const AGENT_RESULT_MAX_VALUES = 20_000;

export type AgentResultBound =
  "not_an_object" | "too_large" | "too_deep" | "too_many_values" | "not_json";

/** What the check of a result against its schema answers: the value and the compact JSON it is stored as, or why it is refused. */
export type AgentResultCheck =
  | { ok: true; value: AgentResultValue; text: string }
  | { ok: false; reason: AgentResultBound | "does_not_fit" };

/**
 * Counts what a value holds without recursion and stops at the first bound it breaks, so a value of two million keys or of a
 * hundred thousand levels costs what the bound costs, not what the value costs.
 */
function withinBounds(
  value: unknown,
): "too_deep" | "too_many_values" | "not_json" | null {
  let values = 0;
  const pending: Array<{ at: unknown; depth: number }> = [
    { at: value, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { at, depth } = next;
    values += 1;
    if (values > AGENT_RESULT_MAX_VALUES) return "too_many_values";
    if (at === null || typeof at === "string" || typeof at === "boolean")
      continue;
    if (typeof at === "number") {
      if (!Number.isFinite(at)) return "not_json";
      continue;
    }
    if (typeof at !== "object") return "not_json";
    if (depth + 1 > AGENT_RESULT_MAX_DEPTH) return "too_deep";
    // Children are queued one by one and the walk stops as soon as the values counted and the values waiting are over the bound:
    // an object of two million keys is not listed in full before it is refused.
    if (Array.isArray(at)) {
      for (let index = 0; index < at.length; index += 1) {
        if (values + pending.length >= AGENT_RESULT_MAX_VALUES)
          return "too_many_values";
        pending.push({ at: at[index], depth: depth + 1 });
      }
    } else {
      for (const key in at) {
        if (!Object.hasOwn(at, key)) continue;
        if (values + pending.length >= AGENT_RESULT_MAX_VALUES)
          return "too_many_values";
        pending.push({
          at: (at as Record<string, unknown>)[key],
          depth: depth + 1,
        });
      }
    }
  }
  return null;
}

/**
 * Holds a result to the bounds, whatever its schema: an object, within the levels and the number of values, and its compact JSON no
 * larger than the limit. `text` is that JSON, which is what the value is stored as. Never throws.
 */
export function boundAgentResult(
  value: unknown,
):
  | { ok: true; value: AgentResultValue; text: string }
  | { ok: false; reason: AgentResultBound } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, reason: "not_an_object" };
  const bound = withinBounds(value);
  if (bound !== null) return { ok: false, reason: bound };
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (new TextEncoder().encode(text).byteLength > AGENT_RESULT_MAX_BYTES)
    return { ok: false, reason: "too_large" };
  // Counted value by value above: nothing but JSON is in it (a function, a symbol or a bigint is `not_json`).
  return { ok: true, value: value as AgentResultValue, text };
}

