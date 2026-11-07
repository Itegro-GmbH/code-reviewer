// SPDX-License-Identifier: LicenseRef-Proprietary

// The stable codes of the workflow engine (#844): what a route answers (`WORKFLOW_RUN_*`, with the HTTP status) and why a run or a step
// failed (the lower case codes stored with them). A caller branches on the code; the message is for a person.
import type { Issue } from "../workflows/issues.ts";

export const WORKFLOW_RUN_ERROR_STATUS = {
  WORKFLOW_RUN_REQUEST_INVALID: 400,
  WORKFLOW_RUN_CROSS_SITE_REQUEST: 403,
  WORKFLOW_RUN_WORKFLOW_NOT_FOUND: 404,
  WORKFLOW_RUN_NOT_FOUND: 404,
  WORKFLOW_RUN_REPOSITORY_NOT_FOUND: 404,
  WORKFLOW_RUN_TRIGGER_UNKNOWN: 404,
  WORKFLOW_RUN_TICKET_NOT_FOUND: 404,
  WORKFLOW_RUN_WORKFLOW_ARCHIVED: 409,
  /** #920: the run does not wait for an answer (never did, was answered before, or was asked to stop). */
  WORKFLOW_RUN_NOT_WAITING: 409,
  /** #920: the answer was written for another question than the one that waits (it was answered, and the step asked again). */
  WORKFLOW_RUN_QUESTION_CHANGED: 409,
  WORKFLOW_RUN_REQUEST_REUSED: 409,
  WORKFLOW_RUN_BODY_TOO_LARGE: 413,
  WORKFLOW_RUN_CONTENT_TYPE_UNSUPPORTED: 415,
  WORKFLOW_RUN_TRIGGER_NOT_MANUAL: 422,
  WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT: 422,
  WORKFLOW_RUN_REPOSITORY_OUTSIDE_PROJECT: 422,
  WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED: 422,
  WORKFLOW_RUN_INPUT_INVALID: 422,
  /** #920: the answer is empty, too long, or names an option the question does not have. */
  WORKFLOW_RUN_ANSWER_INVALID: 422,
  WORKFLOW_RUN_DOCUMENT_UNUSABLE: 500,
  WORKFLOW_RUN_GITHUB_UNAVAILABLE: 503,
} as const;

export type WorkflowRunErrorCode = keyof typeof WORKFLOW_RUN_ERROR_STATUS;

/** A value of the request a lane of a project refuses (#922), with the names that would have been accepted. */
export type WorkflowRunRequestIssue = {
  path: string;
  code: "ticket_outside_project" | "repository_outside_project";
  message: string;
  available: string[];
};

export class WorkflowRunError extends Error {
  readonly code: WorkflowRunErrorCode;
  /** On `WORKFLOW_RUN_INPUT_INVALID`: every problem of the input, as the validator of result schemas lists them. */
  readonly errors: Issue[];
  /** On `WORKFLOW_RUN_TICKET_OUTSIDE_PROJECT` and `WORKFLOW_RUN_REPOSITORY_OUTSIDE_PROJECT`: the value and the repository the project has. */
  readonly issues: WorkflowRunRequestIssue[];
  /** On `WORKFLOW_RUN_REQUEST_REUSED`: the run the request id made. */
  readonly runId?: string;
  /** On `WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED`: the step and its kind. */
  readonly step?: { id: string; kind: string };

  constructor(
    code: WorkflowRunErrorCode,
    message: string,
    details: {
      errors?: Issue[];
      issues?: WorkflowRunRequestIssue[];
      runId?: string;
      step?: { id: string; kind: string };
    } = {},
  ) {
    super(message);
    this.name = "WorkflowRunError";
    this.code = code;
    this.errors = details.errors ?? [];
    this.issues = details.issues ?? [];
    if (details.runId !== undefined) this.runId = details.runId;
    if (details.step !== undefined) this.step = details.step;
  }
}

/** Why a run failed. */
export const RUN_FAILURE_CODES = [
  /** A step failed; the step says why. */
  "step_failed",
  /** The workflow's budget does not cover another agent step. */
  "budget_exhausted",
  /** The document holds a node this engine does not run (a reserved kind, or a node that is not well formed). */
  "step_kind_not_supported",
  /** The condition of an `if` or the `until` of a `loop` could not be evaluated (a value it needs does not exist). */
  "condition_failed",
  /** The document of the pinned version cannot be read, or the steps written so far are not what it says they should be. */
  "document_unusable",
  /** A run a label started: the account that owns the workflow is no longer a member of the workspace (`WORKFLOW_OWNER_GONE_TEXT`). */
  "workflow_owner_gone",
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

/** What a person is told when `workflow_owner_gone` ends a run, or an agent step cannot start for the same reason. */
export const WORKFLOW_OWNER_GONE_TEXT =
  "The person who owns this workflow is no longer a member of the workspace; save the workflow again to take it over.";

/** Why a step failed, besides the code of the job that ended without a result (`timeout`, `no_result`, ...), which is kept as it is. */
export const STEP_FAILURE_CODES = [
  /** A reference points at a value the run does not have (and no default). */
  "template_missing_value",
  /** A reference holds something that has no text form, or the text is not well formed. */
  "template_invalid",
  /** The text a step built does not fit the bound of the place it goes to. */
  "template_too_large",
  /** The profile is gone, archived or has no such version. */
  "profile_not_found",
  /** The environment is not one of the workspace. */
  "environment_not_found",
  /** The Implementer refused the turn, or could not start it. */
  "agent_start_failed",
  /** The turn ended, but its job, its result or its session cannot be read. */
  "turn_unreadable",
  /** The turn succeeded without a result that fits the schema of the step, or ended with `no_result`. */
  "no_result",
  /** The turn's job ended without success and without a code of its own. */
  "job_failed",
  /** No connector is available for the action (the real ones come with milestone 3b). */
  "connector_unavailable",
  /** The inputs of the action are not what the connector takes, once the references are resolved. */
  "action_input_invalid",
  /** The connector refused or failed for a reason that has no code of its own. */
  "action_failed",
  /** The GitHub App of the workspace lacks a permission the action needs (or the installation is suspended); the message names the permission. */
  "github_permission_missing",
  /** GitHub has no such issue, pull request or repository, or the installation is gone. */
  "github_not_found",
  /** `ticket.setStatus` (#917): the board has no status of that name; the message lists the statuses it has. */
  "board_status_unknown",
  /** GitHub refused what was asked for its content: no commits between the branches, an archived repository, an unusable value. */
  "github_validation",
  /** GitHub's rate limit was reached; the action is not repeated. */
  "github_rate_limited",
  /** GitHub could not be reached or answered with an error of its own. */
  "github_unavailable",
  /** The connector did not answer within `ACTION_TIMEOUT_MS`; whether the action happened is not known, and it is not repeated. */
  "action_timeout",
  /** The engine was interrupted while an action ran; whether it happened is not known, and it is not repeated. */
  "action_interrupted",
  /** A member stopped the run (or the task of the step) before the turn of the step started or while it ran (#891). */
  "cancelled",
] as const;
export type StepFailureCode = (typeof STEP_FAILURE_CODES)[number];
