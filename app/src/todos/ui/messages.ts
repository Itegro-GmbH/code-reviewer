// SPDX-License-Identifier: LicenseRef-Proprietary

// The words of the ToDos page, of the answer panel and of the ToDos tab of a project (#925), from the prototype of the factory. English.
import type { ProductIdentity } from "../../product-identity/identity.ts";
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  REQUEST_NOT_UNDERSTOOD,
  ROLE_NOT_ALLOWED,
} from "../../copy/messages.ts";
import { describeTransportFailure } from "../../ui/transport-messages.ts";
import { describeStartFailure } from "../../workflow-pages/messages.ts";

/** The most characters of a note to a review (`REVIEW_COMMENT_MAX_CHARS` of the route; that file is server code and is not imported here). */
export const REVIEW_NOTE_MAX = 4000;
/** The most characters of an answer (docs/workflows.md). */
export const ANSWER_MAX = 4000;

export const TODO_COPY = {
  open: (count: number) => `Open · ${String(count)}`,
  done: (count: number) => `Done · ${String(count)}`,
  hint: "Answer here or in the ticket. Whoever answers first continues the run.",
  projectHint:
    "Questions and reviews of this project. Answer here or in the ticket.",
  emptyTitle: "Nothing waits for you",
  emptyDescription:
    "A question of an agent or a review that is asked of you shows up here as soon as a lane is working on an issue.",
  projectEmptyTitle: "Nothing waits for you in this project",
  projectEmptyDescription:
    "When an agent asks a question or asks for a review, it shows up here and in your ToDos.",
  toProjects: "Open the projects",
  doneEmpty: "Answered ToDos are listed here.",
  loading: "Loading the ToDos",
  loadFailed: "The ToDos could not be loaded.",
  loadFailedHint: "This page tries again by itself.",
  refreshFailed:
    "Updating failed. This page shows the last data it got; it keeps trying.",
  noProject: "This repository is not a project yet, so it has no ToDos.",
  filterLabel: "Project",
  filterAll: "All projects",
  listLabel: "Open ToDos",
  kindQuestion: "Question",
  kindReview: "Review",
  pillQuestion: "Answer",
  pillReview: "Review",
  since: "since",
  unknownLane: "archived lane",
  doneAnswered: "Answered",
  doneMerged: "Pull request merged",
  doneClosed: "Pull request closed",
  doneBy: "by",
  viaPage: "on this page",
  viaComment: "in a comment",
} as const;

export const PANEL_COPY = {
  close: "Close",
  agent: "The agent",
  lane: "Lane",
  spent: "Spent",
  ticket: "Ticket",
  questionHeading: "Question of the agent",
  optionsLegend: (hasLogin: boolean) =>
    hasLogin
      ? "Your answer, posted as a comment in your name"
      : "Your answer, posted as a comment on the ticket",
  noteLabel: "Note for the agent (optional)",
  noteLabelOnly: "Your answer",
  notePlaceholder: "Hints for the agent…",
  clearChoice: "Clear choice",
  answer: "Answer",
  sending: "Sending the answer",
  sent: "The answer went to the agent as a new turn; the run goes on. It is posted on the ticket in your name.",
  footnote: (hasLogin: boolean) =>
    `Answering here writes your answer on the ticket as a comment (“${hasLogin ? "Answer by @login" : "Answer by a member of the workspace"}: …”); answering in GitHub with /answer works the same. The run then starts a new turn in the same session.`,
  gone: "This ToDo is not open any more: it was answered, or the run went on. The list has been updated.",
  needChoice: "Choose an option or write an answer.",
  tooLong: `The option and the note together may be at most ${String(ANSWER_MAX)} characters.`,
  /** The role does not allow answering and reviewing (the sentence of the run page). */
  notAllowed: ROLE_NOT_ALLOWED,
} as const;

/** The text a person typed, kept when the ToDo went away. */
export const KEPT_COPY = {
  heading: "Your text",
  copy: "Copy",
  copied: "Copied",
} as const;

export const REVIEW_COPY = {
  repository: "Repository",
  pullRequest: "Pull request",
  openPullRequest: "Open the pull request on GitHub",
  checks: "Checks",
  checksUnknown: "not known",
  askedOfYou: "Asked of you",
  askedOfMembers:
    "Asked of the project members: any member may answer, the first review counts.",
  noteLabel: "Note for the review (optional)",
  notePlaceholder: "Note for the review…",
  approve: "Approve",
  requestChanges: "Request changes",
  sending: "Sending the review",
  footnote: (hasLogin: boolean) =>
    `Approve and Request changes are posted on the pull request by the GitHub App ${hasLogin ? "in your name" : "as a member of the workspace"}. Asking for changes does not start the agent again: the request stands on the pull request for whoever works on it next.`,
  submitted: (decision: "approve" | "request_changes") =>
    decision === "approve"
      ? "Approved on GitHub. Merge the pull request when you are ready."
      : "Changes requested on GitHub.",
  alreadyThere: "This review was posted before; nothing was posted again.",
  commented:
    "GitHub does not let an App review a pull request it opened itself, so your decision was written as a comment on the pull request instead.",
  openComment: "Open the comment on GitHub",
  gone: "This ToDo is not open any more. The list has been updated.",
} as const;

const REVIEW_FAILURE_TEXT: Record<string, string> = {
  TODOS_REVIEW_NOT_REQUESTED:
    "A review of this pull request is not asked of you (any more), or it is not open. The list has been updated.",
  TODOS_GITHUB_UNAVAILABLE:
    "The repository has no GitHub connection that can review. Check the GitHub App of the workspace.",
  TODOS_REVIEW_FAILED:
    "GitHub could not be asked or refused. Nothing was changed; try again in a moment.",
  TODOS_REQUEST_INVALID:
    "The review cannot be used: the note may be at most 4000 characters.",
  TODOS_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  TODOS_BODY_TOO_LARGE: "The note is too large.",
  TODOS_CONTENT_TYPE_UNSUPPORTED: REQUEST_NOT_UNDERSTOOD,
  TODOS_PROJECT_NOT_FOUND: "This project does not exist any more.",
  not_found: "This workspace is not available to you.",
};

const GENERIC =
  "Something went wrong. Reload the page and try again, or answer on the ticket.";

/** The sentence for a failed read or review: the route's code, or a transport code. */
export function describeTodosFailure(
  product: ProductIdentity,
  failure: { code: string; status: number | null },
): string {
  if (Object.hasOwn(REVIEW_FAILURE_TEXT, failure.code))
    return REVIEW_FAILURE_TEXT[failure.code] ?? GENERIC;
  return (
    describeTransportFailure(product, failure.code, failure.status) ?? GENERIC
  );
}

/** The sentence for a failed answer: the codes of the answer route (`WORKFLOW_RUN_*`) are the run page's. */
export function describeAnswerFailure(
  product: ProductIdentity,
  failure: { code: string; status: number | null },
): string {
  return describeStartFailure(product, failure);
}

/** Answers that mean the question is not the one that waits any more: the list is read again. */
export const STALE_ANSWER_CODES: readonly string[] = [
  "WORKFLOW_RUN_NOT_WAITING",
  "WORKFLOW_RUN_QUESTION_CHANGED",
  "WORKFLOW_RUN_NOT_FOUND",
];
