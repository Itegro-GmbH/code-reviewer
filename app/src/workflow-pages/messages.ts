// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the workflow pages (#873). The engine and its routes answer with stable codes; this is where a code becomes a sentence (the
// UI translates codes, never the other way round). Nothing a response carried (a message, a value an agent returned) is put into a
// sentence: the sentences are fixed, and a code this file does not know gets the generic one, never the raw code.
// `messages.test.ts` fails for a code without a sentence of its own.
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  INVALID_VALUES,
  NOT_AVAILABLE_TO_YOU,
  REQUEST_NOT_UNDERSTOOD,
} from "../copy/messages.ts";
import type { ProductIdentity } from "../product-identity/identity.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
  UNEXPECTED_RESPONSE_COPY,
} from "../ui/transport-messages.ts";
import { RUNS_LISTED_MAX } from "../workflow-runs/limits.ts";
import {
  RUN_FAILURE_CODES,
  WORKFLOW_OWNER_GONE_TEXT,
  STEP_FAILURE_CODES,
  type WorkflowRunErrorCode,
} from "../workflow-runs/errors.ts";

export const RUN_STATUS_COPY = {
  running: {
    label: "Running",
    description: "The workflow is running. This page updates by itself.",
  },
  succeeded: {
    label: "Succeeded",
    description: "Every step finished.",
  },
  failed: {
    label: "Failed",
    description: "A step failed or the budget ran out. The steps say why.",
  },
} as const;

export const STEP_STATUS_COPY = {
  pending: { label: "Waiting" },
  running: { label: "Running" },
  succeeded: { label: "Succeeded" },
  failed: { label: "Failed" },
} as const;

export const STEP_KIND_COPY = {
  agent: "Agent",
  action: "Action",
} as const;

export const TRIGGER_COPY = {
  manual: "Started by hand",
  "github.issueLabeled": "A label on an issue",
} as const;

/** Why a run failed, in a sentence. */
const RUN_FAILURE_TEXT: Record<(typeof RUN_FAILURE_CODES)[number], string> = {
  step_failed: "A step failed. The step below says why.",
  budget_exhausted:
    "The budget of the run is used up, so the next agent step could not start.",
  step_kind_not_supported:
    "The workflow has a step that this version of the engine does not run yet.",
  document_unusable: "The saved version of the workflow cannot be read.",
  workflow_owner_gone: WORKFLOW_OWNER_GONE_TEXT,
};

/**
 * Why a step failed, in a sentence. Besides the codes of the engine, a step keeps the code of the job that ended without a result,
 * so the common ones of those have a sentence too.
 */
const STEP_FAILURE_TEXT: Record<
  (typeof STEP_FAILURE_CODES)[number] | JobFailureCode,
  string
> = {
  template_missing_value:
    "The step refers to a value that the run does not have.",
  template_invalid: "The step refers to a value that cannot be put into text.",
  template_too_large: "The text of the step is too long.",
  profile_not_found:
    "The profile of the step no longer exists, is archived, or has no such version.",
  environment_not_found: "The environment of the step does not exist.",
  agent_start_failed: "The agent could not be started.",
  turn_unreadable: "The result of the agent could not be read.",
  no_result:
    "The agent ended without a result that fits what the step asks for.",
  job_failed: "The agent's task ended without success.",
  connector_unavailable: "This action is not available on this server.",
  action_input_invalid: "The values of the action are not what it takes.",
  action_failed: "The action failed.",
  github_permission_missing:
    "The GitHub App of this workspace lacks a permission this action needs, or its installation is suspended. The owner of the GitHub installation has to grant the permission and accept the change; then run the workflow again.",
  github_not_found:
    "GitHub has no such issue, pull request or repository, or the GitHub installation of this workspace no longer exists.",
  github_validation:
    "GitHub refused what the action asked for: for example there are no commits between the branches, the repository is archived, or a value is not accepted.",
  github_rate_limited:
    "GitHub's rate limit was reached. The action was not repeated; wait a while and run the workflow again.",
  github_unavailable: "GitHub could not be reached or did not answer in time.",
  action_timeout:
    "The action did not answer in time. It is not repeated, because it may have happened.",
  action_interrupted:
    "The run was interrupted while the action ran. It is not repeated, because it may have happened.",
  timeout: "The agent ran out of time.",
  cost_limit_reached: "The agent reached its cost limit.",
  no_runner_available:
    "No runner of this workspace with the labels of the environment took the task in time.",
};
type JobFailureCode = "timeout" | "cost_limit_reached" | "no_runner_available";

export const FAILURE_UNKNOWN_TEXT = "It failed for a reason not listed here.";

function has<T extends object>(table: T, key: string): key is keyof T & string {
  return Object.hasOwn(table, key);
}

/** The sentence for why a run failed; never the code. */
export function describeRunFailure(code: string | null): string | null {
  if (code === null) return null;
  return has(RUN_FAILURE_TEXT, code)
    ? RUN_FAILURE_TEXT[code]
    : FAILURE_UNKNOWN_TEXT;
}

/** The permissions the actions need, as the settings page of the GitHub App words them. Only these are ever named. */
const GITHUB_PERMISSIONS = [
  "Pull requests: Read and write",
  "Issues: Read and write",
] as const;

/** What the connector says about an action that cannot be repeated and ended without an answer (`MAY_HAVE_HAPPENED` of the engine). */
const MAY_HAVE_HAPPENED_MARK = "may have happened";
export const MAY_HAVE_HAPPENED_TEXT =
  "The action may have happened: check GitHub before starting again.";

/** The permission a `github_permission_missing` message names, when it is one of the known ones. */
export function missingPermissionOf(message: string | null): string | null {
  if (message === null) return null;
  return (
    GITHUB_PERMISSIONS.find((name) => message.includes(`"${name}"`)) ?? null
  );
}

/**
 * The sentence for why a step failed; never the code. The message the step stored is used for two things only, and only by matching
 * known strings: which permission is missing, and whether an action that creates something may have happened.
 */
export function describeStepFailure(
  code: string | null,
  message: string | null = null,
): string | null {
  if (code === null) return null;
  if (!has(STEP_FAILURE_TEXT, code)) return FAILURE_UNKNOWN_TEXT;
  const base = STEP_FAILURE_TEXT[code];
  if (code === "github_permission_missing") {
    const permission = missingPermissionOf(message);
    if (permission !== null)
      return `The GitHub App of this workspace lacks the permission "${permission}", or its installation is suspended. The owner of the GitHub installation has to grant the permission and accept the change; then run the workflow again.`;
  }
  const mayHaveHappened =
    code === "github_unavailable" &&
    message !== null &&
    message.includes(MAY_HAVE_HAPPENED_MARK);
  return mayHaveHappened ? `${base} ${MAY_HAVE_HAPPENED_TEXT}` : base;
}

/** Where the cost charged to a step comes from, and what that means for the figure. */
export const COST_BASIS_COPY = {
  reported: {
    label: "reported",
    explanation: "The runner reported this cost.",
  },
  estimated: {
    label: "estimated",
    explanation:
      "The runner reported no cost, so it is estimated from the tokens used at the catalog price of the model.",
  },
  limit: {
    label: "booked as the limit",
    explanation:
      "The cost could not be determined, so the step is charged the whole limit it ran under. The real cost is probably lower, but the run never spends more than its budget.",
  },
} as const;

/** A step that no runner took: not a cost basis, the step never ran. */
export const COST_NOT_RUN_COPY = {
  label: "not run",
  explanation: "No runner took this step, so it never ran and cost nothing.",
} as const;

export const COST_COPY = {
  budget: "Budget",
  of: "of",
  spentOfBudget: "spent of the budget",
  stepCost: "Cost",
  basisHeading: "Where the costs come from",
} as const;

export const PAGE_COPY = {
  workflowsTitle: "Workflows",
  workflowsDescription:
    "The workflows of this workspace. Open one to start it and see its runs.",
  workflowsEmpty:
    "This workspace has no workflows yet. Workflows are written through the API.",
  workflowVersion: "Version",
  workflowUpdated: "Last saved",
  runsHeading: "Runs",
  runsEmpty: "This workflow has not been run yet.",
  runsShowing: `The newest ${String(RUNS_LISTED_MAX)} runs are shown.`,
  columnStatus: "Status",
  columnStarted: "Started",
  columnTrigger: "Trigger",
  columnBudget: "Spent of budget",
  columnVersion: "Version",
  of: "of",
  breadcrumbRoot: "Workflows",
  allRuns: "All runs of this workflow",
  runTitle: "Run",
  runStartedAt: "Started",
  runFinishedAt: "Finished",
  runTrigger: "Trigger",
  runActor: "Label put on by",
  runWorkflowVersion: "Workflow version",
  runRepository: "Repository",
  runBaseBranch: "Base branch",
  runWhy: "Why it failed",
  stepsHeading: "Steps",
  stepsNone: "No step has started yet.",
  stepAgentRun: "Open the agent's run (live view)",
  stepFinished: "Took",
  stepNotStarted: "Not started",
  stepResultJson: "Show everything the step returned (JSON)",
  stepBranch: "Branch",
  stepLink: "Open on GitHub",
  stepNumber: "Number",
  stepExisting: "This already existed, so nothing new was created.",
  stepCreated: "This was created by the step.",
  profile: "Profile",
  openRun: "Open the run",
} as const;

export const START_COPY = {
  heading: "Start a run",
  intro:
    "Fill in what the workflow asks for. Starting runs agents, which cost money from the budget of the workflow.",
  start: "Start",
  starting: "Starting",
  notManual: "This workflow is not started by hand.",
  started: "The run has started.",
  openRun: "Open the run",
  openThatRun: "Open the run that this request already made",
  required: "Fill in this field.",
  notInteger: "Enter a whole number.",
  notNumber: "Enter a number.",
  notJson: "Enter valid JSON.",
  invalidValue: "This value does not fit what the workflow asks for.",
  choose: "Choose",
  fieldRepo: "Repository",
  repoHint: "owner/name, one of the repositories of this workspace.",
} as const;

const START_FAILURE_TEXT: Record<WorkflowRunErrorCode, string> = {
  WORKFLOW_RUN_REQUEST_INVALID: REQUEST_NOT_UNDERSTOOD,
  WORKFLOW_RUN_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  WORKFLOW_RUN_WORKFLOW_NOT_FOUND: "This workflow no longer exists.",
  WORKFLOW_RUN_NOT_FOUND: "This run no longer exists.",
  WORKFLOW_RUN_REPOSITORY_NOT_FOUND:
    "That repository is not one of this workspace's repositories.",
  WORKFLOW_RUN_WORKFLOW_ARCHIVED:
    "This workflow is archived and cannot be started.",
  WORKFLOW_RUN_REQUEST_REUSED:
    "This request already made another run. Reload the page and fill the form in again.",
  WORKFLOW_RUN_BODY_TOO_LARGE: "The input is too large.",
  WORKFLOW_RUN_CONTENT_TYPE_UNSUPPORTED: REQUEST_NOT_UNDERSTOOD,
  WORKFLOW_RUN_TRIGGER_NOT_MANUAL: "This workflow is not started by hand.",
  WORKFLOW_RUN_STEP_KIND_NOT_SUPPORTED:
    "The workflow has a step that the engine does not run yet, so it cannot be started.",
  WORKFLOW_RUN_INPUT_INVALID: INVALID_VALUES,
  WORKFLOW_RUN_DOCUMENT_UNUSABLE: "The saved workflow cannot be read.",
  WORKFLOW_RUN_GITHUB_UNAVAILABLE:
    "GitHub could not be asked right now. Try again in a moment.",
};

/** The sentence for a failed start or read: the route's code, or a transport code, or a status the page cannot read. */
export function describeStartFailure(
  product: ProductIdentity,
  failure: { code: string; status: number | null },
): string {
  if (Object.hasOwn(START_FAILURE_TEXT, failure.code))
    return START_FAILURE_TEXT[failure.code as WorkflowRunErrorCode];
  if (failure.code === "not_found") return NOT_AVAILABLE_TO_YOU;
  return (
    describeTransportFailure(product, failure.code, failure.status) ??
    GENERIC_FAILURE
  );
}

export const RUN_POLL_FAILED_TEXT =
  "Updating failed. This page shows the last data it got; it keeps trying.";
const STOPPED_SUFFIX = " This page no longer updates; reload it to try again.";

/** The sentence for a failed poll; `stopped` says polling ended (a permanent failure). */
export function describeRunPollFailure(
  product: ProductIdentity,
  code: string | null,
  stopped: boolean,
): string {
  if (!stopped || code === null) return RUN_POLL_FAILED_TEXT;
  const sentence =
    code === "WORKFLOW_RUN_NOT_FOUND" ||
    code === "WORKFLOW_RUN_WORKFLOW_NOT_FOUND"
      ? "This run no longer exists."
      : code === "not_found"
        ? NOT_AVAILABLE_TO_YOU
        : (describeTransportFailure(product, code) ?? UNEXPECTED_RESPONSE_COPY);
  return `${sentence}${STOPPED_SUFFIX}`;
}
