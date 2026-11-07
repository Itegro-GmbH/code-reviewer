// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of a question on a ticket or a pull request (#920), as pure text: the comment that carries the question, the edit that says it
// was answered, the comment the page writes in the name of the person who answered there, and how the marker of the first is read back.
// The question is the agent's text and the answer a person's; both are defused (no mention, no link, no markup that reaches somebody) and
// bounded before they go into a comment the App writes. The marker is ours, a comment that only the App wrote counts (the provider looks at
// the author), and the run is found by its id in the database, never by what a comment says.
import type { AgentAsk } from "../db/agent-ask.ts";
import type { StepAsk } from "./ask.ts";
import { ACTION_BODY_MAX_CHARS } from "./limits.ts";
import { cleanText, defuseMentions } from "./templates.ts";

/** The label that says a run waits for a person, and the one that says an agent works on the ticket (the one that went when it began to wait comes back). */
export const LABEL_WAITING = "agent waiting";
export const LABEL_WORKING = "agent working";

/** The most mentions one question carries: a comment that pings the whole workspace is noise. */
export const MENTIONS_MAX = 10;

/**
 * The page of a run below its workspace (`/w/<slug>/workflows/<workflow>/runs/<run>`). Written here, not taken from `workspaces/paths.ts`,
 * which would make `workflow-runs` and `workspaces` import each other; a test in `ask-comment.test.ts` keeps the two in line.
 */
export function runPagePath(
  slug: string,
  run: { workflowId: string; id: string },
): string {
  return `/w/${slug}/workflows/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.id)}`;
}

type Identity = { runId: string; stepId: string; n: number };

type MarkerState = "ask" | "answered" | "cancelled" | "superseded";

/** `<!-- factory ask run=<id> step=<id> q=<n> -->`; `answered` replaces `ask` once the question has its answer, `cancelled` when the run was stopped. */
export function markerOf(state: MarkerState, identity: Identity): string {
  return `<!-- factory ${state} run=${identity.runId} step=${identity.stepId} q=${String(identity.n)} -->`;
}

const MARKER =
  /<!-- factory (ask|answered|cancelled|superseded) run=([A-Za-z0-9_-]{1,64}) step=([A-Za-z][A-Za-z0-9_-]{0,63}) q=([1-9][0-9]{0,8}) -->/;

/** The marker a comment carries, or undefined. Nothing else of the comment is read. */
export function readMarker(
  body: string,
): (Identity & { state: MarkerState }) | undefined {
  const found = MARKER.exec(body);
  if (found === null) return undefined;
  return {
    state: found[1] as MarkerState,
    runId: found[2] as string,
    stepId: found[3] as string,
    n: Number(found[4]),
  };
}

/** A text of an agent or a person as it goes into a comment: no control or direction characters, no mention, and not longer than a comment may be. */
export function safeText(text: string, max = ACTION_BODY_MAX_CHARS): string {
  const clean = defuseMentions(cleanText(text)).trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** The people to ask: logins GitHub allows, once each, at most `MENTIONS_MAX`. */
export function mentionsOf(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const login of logins)
    if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login))
      seen.add(login);
  return [...seen].slice(0, MENTIONS_MAX).map((login) => `@${login}`);
}

function questionBlock(ask: AgentAsk): string[] {
  return [
    `**${safeText(ask.question, 2000).replace(/\n+/g, " ")}**`,
    ...(ask.context === undefined ? [] : ["", safeText(ask.context, 4000)]),
    ...(ask.options === undefined || ask.options.length === 0
      ? []
      : [
          "",
          ...ask.options.map(
            (option, index) =>
              `${String(index + 1)}. ${safeText(option, 200).replace(/\n+/g, " ")}`,
          ),
        ]),
  ];
}

/**
 * The comment of a question: the marker, the question, the numbered options, how to answer (`/answer <n>` with an optional note, or the
 * page of the run) and who is asked. A question without options is answered with `/answer <text>`.
 */
export function questionComment(input: {
  identity: Identity;
  ask: AgentAsk;
  /** The page of the run, an address of this app. */
  link: string;
  mentions: readonly string[];
}): string {
  const { ask } = input;
  const how =
    ask.options === undefined || ask.options.length === 0
      ? "Reply with `/answer <your answer>`"
      : "Reply with `/answer <n>` (a note may follow)";
  return [
    markerOf("ask", input.identity),
    "The agent has a question and waits for the answer:",
    "",
    ...questionBlock(ask),
    "",
    `${how} or answer in the factory: ${input.link}`,
    ...(input.mentions.length === 0 ? [] : ["", input.mentions.join(" ")]),
  ].join("\n");
}

/** The question as it reads once it has its answer: the marker says `answered`, and the answer and who gave it follow. */
export function answeredComment(input: {
  identity: Identity;
  ask: StepAsk;
}): string {
  const { ask } = input;
  const answer = ask.answer;
  return [
    markerOf("answered", input.identity),
    "The agent had a question:",
    "",
    ...questionBlock(ask),
    "",
    `Answered by ${answer?.by === null || answer?.by === undefined ? "a member of the workspace" : `@${safeText(answer.by, 39).replace(/\s+/g, "")}`}: ${safeText(answer?.text ?? "", 4000)}`,
  ].join("\n");
}

/** The question as it reads once the run was stopped before anybody answered: nobody has to. */
export function cancelledComment(input: {
  identity: Identity;
  ask: AgentAsk;
}): string {
  return [
    markerOf("cancelled", input.identity),
    "The agent had a question, and the run was cancelled before it was answered. No answer is needed.",
    "",
    ...questionBlock(input.ask),
  ].join("\n");
}

/** A second comment for a question that another comment carries (two announcements raced): it says so and repeats nothing of the question. */
export function supersededComment(input: { identity: Identity }): string {
  return [
    markerOf("superseded", input.identity),
    "This comment repeats a question that is asked in another comment on this ticket. Please answer there.",
  ].join("\n");
}

/** What the page writes in the name of the person who answered there, so the ticket holds the whole record. */
export function answerRecordComment(input: {
  identity: Identity;
  ask: StepAsk;
}): string {
  const answer = input.ask.answer;
  return [
    `<!-- factory answer run=${input.identity.runId} step=${input.identity.stepId} q=${String(input.identity.n)} -->`,
    `Answer by ${answer?.by === null || answer?.by === undefined ? "a member of the workspace" : `@${safeText(answer.by, 39).replace(/\s+/g, "")}`}: ${safeText(answer?.text ?? "", 4000)}`,
  ].join("\n");
}
