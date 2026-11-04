// SPDX-License-Identifier: LicenseRef-Proprietary

// How the timeline of the agent's work is kept on the page (#745, live view): the parts come in pages that follow a cursor, and a
// part that changed (a tool call: running, then done) comes again with a higher `seq`. Here those pages become one list in the
// order the parts began in, and the list becomes the "steps" the page shows: one for each model call of the agent. Pure.
import type { StepView } from "../steps-view.ts";

/**
 * `existing` with `incoming` merged in: a part is kept once, by its id, and a record with a higher `seq` replaces the earlier one
 * in place (it keeps its `ordinal`, so it keeps its place). A record with an equal or lower `seq` changes nothing, so an answer
 * that arrives twice or late does no harm. The result is in display order.
 */
export function mergeSteps(
  existing: readonly StepView[],
  incoming: readonly StepView[],
): StepView[] {
  if (incoming.length === 0) return [...existing];
  const byId = new Map<string, StepView>();
  for (const step of existing) byId.set(step.partId, step);
  for (const step of incoming) {
    const current = byId.get(step.partId);
    if (current === undefined || step.seq > current.seq)
      byId.set(step.partId, step);
  }
  return [...byId.values()].sort(
    (a, b) => a.ordinal - b.ordinal || a.seq - b.seq,
  );
}

/** One model call of the agent: what it thought, said and did, and how it ended (absent while it is going on). */
export type StepGroup = {
  /** 1 for the first model call. */
  number: number;
  /** The parts before the end of the call, in order. */
  items: StepView[];
  /** The record of the end of the call, with its tokens and cost. */
  end: StepView | undefined;
};

/** The parts cut into model calls: each call ends with its `step` record, and the last call may still be going on. */
export function groupSteps(steps: readonly StepView[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let items: StepView[] = [];
  for (const step of steps) {
    if (step.kind === "step") {
      groups.push({ number: groups.length + 1, items, end: step });
      items = [];
      continue;
    }
    items.push(step);
  }
  if (items.length > 0)
    groups.push({ number: groups.length + 1, items, end: undefined });
  return groups;
}

/** The milliseconds a model call took, from the first time any of its parts has to the end; undefined when the times are missing. */
export function groupDurationMs(group: StepGroup): number | undefined {
  const times: number[] = [];
  for (const part of group.end === undefined
    ? group.items
    : [...group.items, group.end]) {
    if (part.startedAt !== undefined) times.push(part.startedAt);
    if (part.endedAt !== undefined) times.push(part.endedAt);
  }
  if (times.length < 2) return undefined;
  return Math.max(...times) - Math.min(...times);
}

/** How many parts a page shows at first, and how many more each click on "earlier" adds. */
export const RENDER_PARTS = 400;

/**
 * The model calls to render: the newest ones whose parts add up to `cap` (at least one call), and how many calls are held back.
 * A long turn would otherwise put thousands of rows in the document; the newest are the ones a person follows.
 */
export function newestGroups(
  groups: readonly StepGroup[],
  cap: number,
): { shown: StepGroup[]; hidden: number } {
  let parts = 0;
  let start = groups.length;
  while (start > 0) {
    const group = groups[start - 1];
    if (group === undefined) break;
    const weight = group.items.length + (group.end === undefined ? 0 : 1);
    if (parts > 0 && parts + weight > cap) break;
    parts += weight;
    start -= 1;
  }
  return { shown: groups.slice(start), hidden: start };
}

/** A text the runner cut ends with `\n[N bytes cut]`; the body without the mark and the size of what is missing. */
export function splitCut(text: string): {
  body: string;
  cutBytes: number | null;
} {
  const found = /\n\[(\d{1,15}) bytes cut\]$/.exec(text);
  if (found === null) return { body: text, cutBytes: null };
  return { body: text.slice(0, found.index), cutBytes: Number(found[1]) };
}

/** True when a tool call of the list was kept as name and status only, which the runner does once a turn is too long. */
export function isShortened(steps: readonly StepView[]): boolean {
  return steps.some((step) => step.kind === "tool" && step.input === undefined);
}
