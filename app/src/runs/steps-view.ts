// SPDX-License-Identifier: LicenseRef-Proprietary

// What the Runs page reads of the steps of an Implementer turn (#745, live view): one entry for each part of the agent's work
// (what it thought, what it said, each tool call with its input, the end of each model call), as plain text and numbers.
// Shared by the route that answers (`steps-service.ts`) and the timeline that shows them, so it imports nothing server-only.
//
// The stored payload (`implementer_turn_steps`) is a JSON document the runner API wrote after cleaning it. It is read here as
// untrusted anyway: a field of another type is left out, a kind this page does not know is skipped, and no field can carry markup,
// because the page renders every text as text. The OUTPUT of a tool is never stored, so none is here.
import type { StoredStep } from "../db/repositories/implementer-steps-repository.ts";

/** The kinds the page shows; a stored row of another kind is skipped (the cursor still moves past it). */
export const STEP_KINDS = ["reasoning", "text", "tool", "step"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** How many parts one answer holds at most, and the default. */
export const STEPS_PAGE_LIMIT = 200;

/** The tokens of one model call, as the runner counts them. */
export type StepTokensView = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export type StepView = {
  partId: string;
  /** Changes whenever the part changes; the cursor of the page is the highest one it has seen. */
  seq: number;
  /** The place of the part in the timeline: the `seq` of its first record. */
  ordinal: number;
  kind: StepKind;
  /** Epoch milliseconds of the sandbox's clock, as the runner reported them. */
  startedAt?: number;
  endedAt?: number;
  /** reasoning, text: the words. A cut text ends with the mark `[N bytes cut]`. */
  text?: string;
  /** The true size of `text` in bytes, before it was cut. */
  bytes?: number;
  /** tool: the name, the state (`running`, `completed`, `error`), the title the engine gave the call, the input as JSON text. */
  tool?: string;
  status?: string;
  title?: string;
  input?: string;
  error?: string;
  /** step: why the model call ended. */
  reason?: string;
  tokens?: StepTokensView;
  /** step: the cost of the call; stored only for a run on the workspace's own key. */
  cost?: number;
};

/** The answer of `GET /api/w/:workspace/runs/:id/steps`. */
export type StepsSnapshot = {
  /** The parts that changed after the `after` of the request, in the order the page shows them (`ordinal`). */
  steps: StepView[];
  /** The highest `seq` of this answer, or the `after` of the request when nothing changed; the next request asks after it. */
  cursor: number;
  /** More changed parts wait behind this answer: ask again at once. */
  hasMore: boolean;
};

function textField(
  payload: Record<string, unknown>,
  key: string,
  clean: (text: string) => string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? clean(value) : undefined;
}

function numberField(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function tokensOf(value: unknown): StepTokensView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const source = value as Record<string, unknown>;
  const count = (key: string): number => numberField(source, key) ?? 0;
  return {
    input: count("input"),
    output: count("output"),
    reasoning: count("reasoning"),
    cacheRead: count("cacheRead"),
    cacheWrite: count("cacheWrite"),
  };
}

const isKnownKind = (kind: string): kind is StepKind =>
  (STEP_KINDS as readonly string[]).includes(kind);

/**
 * The view of a stored part, or undefined for a kind the page does not show. `clean` is applied to every text again (the secrets
 * the app knows), as the run's other texts are; the runner API has cleaned them once when it stored them.
 */
export function toStepView(
  stored: StoredStep,
  clean: (text: string) => string = (text) => text,
): StepView | undefined {
  if (!isKnownKind(stored.kind)) return undefined;
  const payload = stored.payload;
  const view: StepView = {
    partId: stored.partId,
    seq: stored.seq,
    ordinal: stored.ordinal,
    kind: stored.kind,
  };
  const assign = <K extends keyof StepView>(
    key: K,
    value: StepView[K] | undefined,
  ) => {
    if (value !== undefined) view[key] = value;
  };
  assign("startedAt", numberField(payload, "startedAt"));
  assign("endedAt", numberField(payload, "endedAt"));
  assign("bytes", numberField(payload, "bytes"));
  assign("cost", numberField(payload, "cost"));
  assign("text", textField(payload, "text", clean));
  assign("tool", textField(payload, "tool", clean));
  assign("status", textField(payload, "status", clean));
  assign("title", textField(payload, "title", clean));
  assign("input", textField(payload, "input", clean));
  assign("error", textField(payload, "error", clean));
  assign("reason", textField(payload, "reason", clean));
  assign("tokens", tokensOf(payload["tokens"]));
  return view;
}
