// SPDX-License-Identifier: LicenseRef-Proprietary

// A text with references as the lane builder shows it (#927): plain stretches and chips. The stored text is never rewritten: a chip keeps
// the exact `{{…}}` it was written with, so joining the parts gives back what was typed, and removing or inserting a reference touches
// only that reference. Pure; the reading of a reference is the validator's own (`scanTemplate`).
import {
  REACH_CATEGORY_LABEL,
  categoryOfPath,
  nameOfPath,
  type ReachCategory,
} from "../../workflows/reach-categories.ts";
import { scanTemplate } from "../../workflows/template.ts";

export type Chip = {
  /** The `{{…}}` as it is written in the text. */
  source: string;
  /** Where it starts in the text. */
  start: number;
  end: number;
  path: string[];
  category: ReachCategory;
  /** What the chip says, `Ticket · title`. */
  label: string;
  /** The reference with its default, for a tooltip: `trigger.ticket.title`, or `previous.check.verdict | default ""`. */
  title: string;
  hasDefault: boolean;
};

export type Part = { text: string; start: number } | { chip: Chip };

/** The text cut into its plain stretches and its chips, in order. */
export function partsOf(text: string): Part[] {
  const parts: Part[] = [];
  let at = 0;
  for (const span of scanTemplate(text)) {
    if ("text" in span) {
      parts.push({ text: span.text, start: at });
      at += span.text.length;
      continue;
    }
    const category = categoryOfPath(span.ref.path);
    parts.push({
      chip: {
        source: span.source,
        start: at,
        end: at + span.source.length,
        path: span.ref.path,
        category,
        label: `${REACH_CATEGORY_LABEL[category]} · ${nameOfPath(span.ref.path)}`,
        title: span.ref.raw,
        hasDefault: span.ref.default !== undefined,
      },
    });
    at += span.source.length;
  }
  return parts;
}

export function chipsOf(text: string): Chip[] {
  return partsOf(text).flatMap((part) => ("chip" in part ? [part.chip] : []));
}

/** The text the parts stand for: what is stored. */
export function textOfParts(parts: readonly Part[]): string {
  return parts
    .map((part) => ("chip" in part ? part.chip.source : part.text))
    .join("");
}

/** The text without one chip. */
export function withoutChip(
  text: string,
  chip: Pick<Chip, "start" | "end">,
): string {
  return text.slice(0, chip.start) + text.slice(chip.end);
}

export type Selection = { start: number; end: number };

/**
 * Where a reference may go for a cursor or selection: the same, moved where the text around it stays what it was. Never inside a
 * reference (the start moves to its start, the end to its end, a cursor to the nearer edge), and never right after a `\` or a `{`,
 * which would turn the reference into text (`\{{` is the escape, `{{{` no reference): the position moves before them.
 */
export function insertSpan(text: string, selection: Selection): Selection {
  const clamp = (at: number): number => Math.max(0, Math.min(at, text.length));
  let start = clamp(selection.start);
  let end = Math.max(start, clamp(selection.end));
  const collapsed = start === end;
  for (const chip of chipsOf(text)) {
    const inside = (at: number): boolean => at > chip.start && at < chip.end;
    if (collapsed && inside(start)) {
      start = start - chip.start < chip.end - start ? chip.start : chip.end;
      end = start;
      break;
    }
    if (!collapsed) {
      if (inside(start)) start = chip.start;
      if (inside(end)) end = chip.end;
    }
  }
  while (start > 0 && (text[start - 1] === "\\" || text[start - 1] === "{"))
    start -= 1;
  return { start, end: collapsed ? start : Math.max(start, end) };
}

/**
 * The text with `insert` (a `{{…}}`) where the cursor is, and the cursor after it. A selection is replaced. The reference is never put
 * inside another one or where it would not stay one (`insertSpan`). In a field that takes one value (`replaceAll`), the reference is the
 * whole text.
 */
export function withReference(
  text: string,
  selection: Selection,
  insert: string,
  replaceAll = false,
): { text: string; caret: number } {
  if (replaceAll) return { text: insert, caret: insert.length };
  const { start, end } = insertSpan(text, selection);
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    caret: start + insert.length,
  };
}
