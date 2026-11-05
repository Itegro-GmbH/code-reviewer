// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the "Continue" form (#841). Fixed sentences; the only texts from outside on it are the instruction that waits (the
// person's own words, rendered as text) and the names of environments and models, which the first form shows the same way.
import type { DiscardReason } from "../../db/repositories/implementer-repository.ts";

export const CONTINUE_COPY = {
  title: "Continue",
  intro:
    "Give the agent the next instruction on this branch. It starts in a new sandbox: only the git repository comes back from GitHub, not the processes, containers or files outside it that the last turn left.",
  runningIntro:
    "A turn is running. Your instruction waits and starts when the running turn ends. Only one instruction can wait.",
  queuedTitle: "Waiting for the running turn to end",
  queuedNote:
    "This instruction starts as soon as the running turn ends. No other instruction can wait meanwhile.",
  queuedStarting:
    "The turn has ended. This instruction is about to start; reload the page in a moment.",
  discardedTitle: "The instruction that waited did not start",
  discardedInstruction: "It said:",
  instruction: "Next instruction",
  instructionPlaceholder:
    "Describe what the agent should do next. It remembers the earlier turns.",
  costLimit: "Cost limit (USD, optional)",
  costLimitHint:
    "As in the last turn unless you change it. Empty: the most the operator allows.",
  environment: "Environment",
  environmentSame: "As in the last turn",
  environmentSameNamed: (name: string) => `As in the last turn: ${name}`,
  environmentNone: "Standard (no setup script)",
  environmentHint:
    "The setup script of the environment runs again in the new sandbox.",
  environmentLoadFailed: "The environments could not be loaded.",
  profile: (profile: string) =>
    `Profile of the last turn, kept: ${profile}. It brings its own instructions and may push or not as before.`,
  modelHint: "The model of the last turn is preselected; you may change it.",
  history: (tokens: number) =>
    `history: about ${tokens.toLocaleString("en-US")} tokens; the first call reads all of it again`,
  historyWarning:
    "A very long history can reach the cost limit with the first call, before the agent does anything.",
  send: "Continue",
  sending: "Sending",
  sendQueued: "Queue instruction",
  startedLink: "Open the new run",
  queuedAccepted: "Queued. It starts when the running turn ends.",
  openThatTask: "Open that run",
  loading: "Loading",
  loadFailed: "The options of this session could not be loaded.",
  tryAgain: "Try again",
} as const;

const DISCARD_SENTENCES: Record<DiscardReason, string> = {
  branch_gone:
    "The branch of this session was deleted on GitHub, so it could not be continued. Start a new task.",
  repository_unavailable:
    "The repository is not available any more (it was removed, or the GitHub App lost access).",
  write_not_granted:
    "The GitHub App does not have the permission to write contents any more.",
  model_not_allowed: "The model you chose is not available any more.",
  cost_limit_exceeded:
    "The cost limit you chose is above the maximum the operator allows now.",
  environment_unavailable:
    "The size of the environment is no longer offered. Change it under Environments.",
  github_unavailable:
    "GitHub could not be reached for a day, so the instruction was dropped. Send it again.",
  start_failed:
    "The instruction could not be started for a day because of an error on our side, so it was dropped. Send it again, or tell us if it keeps failing.",
  request_invalid:
    "The job queue does not accept this instruction (what it asks for is not valid any more), so it was not started. Check the choices and send it again.",
  instruction_unreadable:
    "The stored instruction could not be read, so it was dropped. Send it again.",
};

/** The sentence for why a queued instruction did not start; an unknown word gets the general sentence. */
export function describeDiscard(reason: string): string {
  return Object.hasOwn(DISCARD_SENTENCES, reason)
    ? DISCARD_SENTENCES[reason as DiscardReason]
    : "The instruction could not be started.";
}

/** About how many tokens, rounded so that the figure does not look more exact than it is. */
export function roundTokens(tokens: number): number {
  if (tokens < 1000) return Math.max(1, Math.round(tokens / 10) * 10);
  return Math.round(tokens / 100) * 100;
}
