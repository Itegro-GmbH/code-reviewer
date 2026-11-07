// SPDX-License-Identifier: LicenseRef-Proprietary

// The question an agent ends a turn with instead of a result (#920), as far as the app judges it: a closed object of a question, an
// optional short list of options and an optional context, each text bounded. The runner holds the file the finish tool wrote to the same
// bounds (`ASK_*` in `finish_tool.py`); the app holds it again, since it is the agent's text. This is the part the database layer, the
// runner API and the workflow engine share, so it imports nothing. Pure.

export type AgentAsk = {
  question: string;
  /** Left out when there are none. */
  options?: string[];
  /** Left out when there is none. */
  context?: string;
};

export const ASK_QUESTION_MAX_CHARS = 2000;
export const ASK_OPTIONS_MAX = 10;
export const ASK_OPTION_MAX_CHARS = 200;
export const ASK_CONTEXT_MAX_CHARS = 4000;

const KEYS: ReadonlySet<string> = new Set(["question", "options", "context"]);

function text(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= max
    ? value
    : undefined;
}

/**
 * The question when `value` is one within the bounds, else undefined. A copy: unknown keys, an empty list and an empty context are not
 * kept (the runner writes none of them; another writer's are the agent's noise, not a reason to refuse the report).
 */
export function boundAgentAsk(value: unknown): AgentAsk | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const given = value as Record<string, unknown>;
  if (Object.keys(given).some((key) => !KEYS.has(key))) return undefined;
  const question = text(given.question, ASK_QUESTION_MAX_CHARS);
  if (question === undefined) return undefined;
  let options: string[] | undefined;
  if (given.options !== undefined) {
    if (!Array.isArray(given.options) || given.options.length > ASK_OPTIONS_MAX)
      return undefined;
    const kept = given.options.map((option: unknown) =>
      text(option, ASK_OPTION_MAX_CHARS),
    );
    if (kept.some((option) => option === undefined)) return undefined;
    options = kept as string[];
  }
  let context: string | undefined;
  if (given.context !== undefined) {
    context = text(given.context, ASK_CONTEXT_MAX_CHARS);
    if (context === undefined) return undefined;
  }
  return {
    question,
    ...(options === undefined || options.length === 0 ? {} : { options }),
    ...(context === undefined ? {} : { context }),
  };
}
