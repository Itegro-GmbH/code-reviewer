// SPDX-License-Identifier: LicenseRef-Proprietary

// The question an agent step ended its turn with, as the engine keeps it with the step (#920): `workflow_step_runs.ask`, JSON text. The
// question is the agent's text (bounded by `boundAgentAsk`), the answer is a person's. Pure; what is read from the column is read
// defensively, since a row written by another version is still a row.
import { boundAgentAsk, type AgentAsk } from "../db/agent-ask.ts";
import { ASK_ANSWER_MAX_CHARS } from "./limits.ts";
import { cleanText } from "./templates.ts";

/**
 * `open`: the step waits. `answered`: somebody answered and the turn that goes on has not been started yet. `resumed`: that turn was started
 * (the answer stays for the page and the record).
 */
export type AskState = "open" | "answered" | "resumed";

export type AskAnswer = {
  /** The answer as the agent reads it: the option chosen, with the note that followed, or the free text. */
  text: string;
  /** The option chosen, from 1; absent for a free text. */
  choice?: number;
  /** The login of the person on the provider, or the name of the account; null when unknown. */
  by: string | null;
  /** Where the answer came from: a comment on the ticket or the pull request, or the page of the run. */
  via: "comment" | "ui";
  at: string;
};

/**
 * How often the engine looked again at a question whose comment is not posted (#920). `ended` says it stopped: `no_place` (the run has no
 * ticket and no pull request, so the question is shown on the page of the run only) or `gave_up` (the post kept failing; the page says so).
 */
export type AskAnnounce = {
  attempts: number;
  ended?: "no_place" | "gave_up";
};

export type StepAsk = AgentAsk & {
  /** Which question of the step this is, from 1: a step may ask again after an answer. */
  n: number;
  state: AskState;
  /** When the step began to wait for this question (the engine's clock, ISO 8601); an answer written before it is none to it. Absent in a row from before. */
  askedAt?: string;
  announce?: AskAnnounce;
  answer?: AskAnswer;
};

const STATES: readonly AskState[] = ["open", "answered", "resumed"];

export function serializeAsk(ask: StepAsk): string {
  return JSON.stringify(ask);
}

/** The question stored with a step, or undefined for a step that never asked or a column that cannot be read. */
export function parseStepAsk(text: string | null): StepAsk | undefined {
  if (text === null) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const { n, state, answer, askedAt, announce, ...rest } = value as Record<
    string,
    unknown
  >;
  const asked = boundAgentAsk(rest);
  if (
    asked === undefined ||
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    typeof state !== "string" ||
    !STATES.some((known) => known === state)
  )
    return undefined;
  const given = parseAnswer(answer);
  const looked = parseAnnounce(announce);
  if (state !== "open" && given === undefined) return undefined;
  return {
    ...asked,
    n,
    state: state as AskState,
    ...(typeof askedAt === "string" && !Number.isNaN(Date.parse(askedAt))
      ? { askedAt }
      : {}),
    ...(looked === undefined ? {} : { announce: looked }),
    ...(given === undefined ? {} : { answer: given }),
  };
}

function parseAnnounce(value: unknown): AskAnnounce | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { attempts, ended } = value as Record<string, unknown>;
  if (typeof attempts !== "number" || !Number.isSafeInteger(attempts))
    return undefined;
  return {
    attempts,
    ...(ended === "no_place" || ended === "gave_up" ? { ended } : {}),
  };
}

function parseAnswer(value: unknown): AskAnswer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { text, choice, by, via, at } = value as Record<string, unknown>;
  if (
    typeof text !== "string" ||
    text === "" ||
    text.length > ASK_ANSWER_MAX_CHARS ||
    (by !== null && typeof by !== "string") ||
    (via !== "comment" && via !== "ui") ||
    typeof at !== "string"
  )
    return undefined;
  return {
    text,
    ...(typeof choice === "number" && Number.isSafeInteger(choice)
      ? { choice }
      : {}),
    by,
    via,
    at,
  };
}

/** What a person handed in: an option by its number (from 1), a text, or an option with a note. */
export type AnswerInput = {
  choice?: number | undefined;
  text?: string | undefined;
};

export type ResolvedAnswer =
  | { ok: true; text: string; choice?: number }
  | { ok: false; code: "answer_empty" | "answer_too_long" | "option_unknown" };

/**
 * The answer in the words the agent reads. A choice is an option of the question (its number, from 1) and the text, if any, is a note to
 * it; without a choice the text is the answer, and a question that has options takes a free text too (a person may say none of them).
 * The text is cleaned (no control or direction characters) first and judged as it will be stored: an answer that is empty or too long
 * then is refused here, before the question is touched (a stored answer that `parseStepAsk` would not read back would strand the step).
 */
export function resolveAnswer(
  ask: Pick<AgentAsk, "options">,
  input: AnswerInput,
): ResolvedAnswer {
  const note = cleanText(input.text ?? "").trim();
  if (input.choice === undefined) {
    if (note === "") return { ok: false, code: "answer_empty" };
    return note.length > ASK_ANSWER_MAX_CHARS
      ? { ok: false, code: "answer_too_long" }
      : { ok: true, text: note };
  }
  const option = ask.options?.[input.choice - 1];
  if (
    !Number.isSafeInteger(input.choice) ||
    input.choice < 1 ||
    option === undefined
  )
    return { ok: false, code: "option_unknown" };
  const text = note === "" ? option : `${option}\n\n${note}`;
  return text.length > ASK_ANSWER_MAX_CHARS
    ? { ok: false, code: "answer_too_long" }
    : { ok: true, text, choice: input.choice };
}

/** The instruction of the turn that goes on: the person's answer, with the question it belongs to. */
export function answerInstruction(ask: StepAsk, answer: AskAnswer): string {
  return [
    `You asked: ${ask.question}`,
    "",
    `The answer${answer.by === null ? "" : ` of ${answer.by}`}:`,
    answer.text,
    "",
    "Go on with the task from here.",
  ].join("\n");
}
