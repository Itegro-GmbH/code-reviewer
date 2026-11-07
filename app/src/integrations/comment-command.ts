// SPDX-License-Identifier: LicenseRef-Proprietary

// Reads a comment on a pull request as a command. The text of a comment is untrusted input: only the
// command word is taken from it; any text after the command is dropped, because PR-Agent would read
// it as options (`/review --setting=value`). Nothing here knows which git platform the comment came
// from.
//
// Since #920 a comment `/answer ...` is read too, as the answer to the question a workflow run waits for (`parseAnswerCommand`).
//
// Since #203 only `/review` is a command. A comment that starts with `/ask`, `/improve` or
// `/describe` is an ordinary comment: it returns null, exactly like a comment with no command, and
// no command-not-allowed answer, job, credential or model call follows.
import type { ReviewCommand } from "./types.ts";

export type ParsedCommentCommand = {
  command: ReviewCommand;
  /** Always an empty string: `/review` takes no text. */
  args: string;
};

// A command counts only if the comment starts with it (whitespace before it is allowed), in any case.
// The word must end there: `/reviewer` and `/review-all` are not `/review`.
const COMMAND_PATTERN = /^\s*\/(review)(?=\s|$)/i;

/**
 * What a comment `/answer ...` says (#920): the answer to the question a workflow run waits for. `choice` is the option of a number that
 * starts the text (`/answer 2`), `text` the note that follows it (`/answer 2 and log it`); `raw` is everything after the command, which is
 * the answer where the question has no such option (`/answer 3 retries`). The text is untrusted: only the command word is read as a command.
 */
export type ParsedAnswer = { choice?: number; text?: string; raw: string };

const ANSWER_PATTERN = /^\s*\/answer(?=\s|$)([\s\S]*)$/i;
const ANSWER_CHOICE = /^([1-9][0-9]{0,2})(?:\s+([\s\S]+))?$/;

/** The answer a comment gives, or `null` when it is no `/answer` or says nothing after it. */
export function parseAnswerCommand(body: string): ParsedAnswer | null {
  const match = ANSWER_PATTERN.exec(body);
  if (match === null) return null;
  const raw = (match[1] as string).trim();
  if (raw === "") return null;
  const numbered = ANSWER_CHOICE.exec(raw);
  if (numbered === null) return { raw };
  const note = numbered[2]?.trim();
  return {
    choice: Number(numbered[1]),
    ...(note === undefined || note === "" ? {} : { text: note }),
    raw,
  };
}

/**
 * The command a comment asks for, or `null` when the comment is no command: it does not start with
 * one, or the word is an unknown or removed one. Only `/review` counts, and it takes no text.
 */
export function parseCommentCommand(body: string): ParsedCommentCommand | null {
  const match = COMMAND_PATTERN.exec(body);
  if (match === null) return null;
  const command = (match[1] as string).toLowerCase() as ReviewCommand;
  return { command, args: "" };
}
