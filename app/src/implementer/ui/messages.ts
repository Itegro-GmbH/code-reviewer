// SPDX-License-Identifier: LicenseRef-Proprietary

// The copy of the Implementer page (#756). The routes answer with stable codes; this is where a code becomes a sentence (the UI
// translates codes, never the other way round). Nothing a response carried (a message, a name, a raw answer of GitHub) is ever put
// into a sentence: the sentences are fixed, and the one number an answer carries (the operator's maximum) is formatted here. A
// code this file does not know gets the generic sentence. `messages.test.ts` fails for a code without a sentence of its own.
import {
  CROSS_SITE_REQUEST_RELOAD_PAGE,
  INVALID_VALUES,
  REQUEST_NOT_UNDERSTOOD,
} from "../../copy/messages.ts";
import type { ProductIdentity } from "../../product-identity/identity.ts";
import {
  describeTransportFailure,
  GENERIC_FAILURE,
} from "../../ui/transport-messages.ts";
import type { BranchNameIssue } from "../branch-name.ts";
import {
  IMPLEMENTER_ERROR_CODES,
  MODEL_REFUSAL_REASONS,
  type ImplementerErrorCode,
  type ImplementerIssue,
  type ModelRefusalReason,
  type UnwritableReason,
} from "../errors.ts";

/** The words of the labels, hints and empty states of the form. */
export const FORM_COPY = {
  repository: "Repository",
  repositoryPlaceholder: "Choose a repository",
  baseBranch: "Base branch",
  baseBranchPlaceholder: "Choose a base branch",
  defaultMark: "default",
  branchesTruncated:
    "The repository has more branches than are listed here. To start from one that is not listed, type the name of the branch below.",
  otherBase: "Another base branch",
  otherBaseHint:
    "Leave empty to use the branch chosen above. The name must be a branch that exists on GitHub.",
  newBranch: "New branch name",
  newBranchHint:
    "The branch the agent pushes to. It must not exist yet. You can change the suggested name.",
  task: "Task",
  taskPlaceholder: "Describe what the agent should do in this repository.",
  provider: "Provider",
  providerPlaceholder: "Choose a provider",
  model: "Model",
  modelPlaceholder: "Choose a model",
  costLimit: "Cost limit (USD, optional)",
  costLimitHint:
    "The task stops when it reaches this amount. Leave empty for the maximum.",
  start: "Start task",
  starting: "Sending the task",
  tryAgain: "Try again",
  started: "The task was started.",
  openRun: "Open the run",
  openThatTask: "Open that task",
  loading: "Loading",
  noRepositoryBefore: "No repository is linked yet. Link one under",
  noRepositoryLink: "Connections",
  noRepositoryAfter: "first.",
  noModelBefore: "No model is available yet. Check",
  noModelLink: "LLM access",
  noModelAfter: "in the settings.",
  deprecatedNote: "deprecated",
  alphaNote: "alpha",
} as const;

const UNWRITABLE_NOTES: Record<UnwritableReason, string> = {
  write_not_granted: "approve the new GitHub permission",
  connection_gone: "the GitHub App was removed",
  connection_suspended: "the GitHub App is suspended",
  app_auth_failed: "GitHub rejected the GitHub App",
  scope_refused: "GitHub refuses the GitHub App access",
  repository_not_accessible: "the GitHub App cannot reach it",
};

/** The short note beside a repository that is listed but cannot be chosen: the reason, in a few words. */
export function describeUnwritableNote(reason: UnwritableReason): string {
  return UNWRITABLE_NOTES[reason];
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const BRANCH_COPY: Record<BranchNameIssue, string> = {
  empty: "Enter a name for the new branch.",
  too_long: "A branch name can have at most 200 characters.",
  component_too_long:
    "A part of the branch name between slashes is too long. Shorten it.",
  forbidden_character:
    "A branch name cannot contain spaces, control characters or any of ~ ^ : ? * [ and the backslash.",
  double_dot: "A branch name cannot contain two dots in a row.",
  reflog_syntax: "A branch name cannot contain the characters @{.",
  leading_dash: "A branch name cannot start with a dash.",
  slash_placement:
    "A branch name cannot start or end with a slash, or contain two slashes in a row.",
  component_leading_dot:
    "No part of a branch name between slashes can start with a dot.",
  lock_suffix: "A branch name cannot end with .lock.",
  component_lock_suffix:
    "No part of a branch name between slashes can end with .lock.",
  trailing_dot: "A branch name cannot end with a dot.",
  reserved_name: "HEAD and @ cannot be used as a branch name.",
  same_as_base: "The new branch needs another name than the base branch.",
};

/** The sentence for the rule of git (or of this product) a new branch name breaks. */
export function describeBranchIssue(rule: BranchNameIssue): string {
  return BRANCH_COPY[rule];
}

const MODEL_REFUSAL_COPY: Record<ModelRefusalReason, string> = {
  wrong_key_mode:
    "This model does not fit how this workspace pays for AI. Reload the page and choose a model again.",
  key_mode_unreadable:
    "How this workspace pays for AI could not be read, so no model can be offered. Reload the page and try again.",
  entry_unknown:
    "This model does not exist any more. Reload the page and choose another.",
  entry_not_released: "This model is not offered any more. Choose another.",
  entry_kind_mismatch:
    "This model is not set up to work on tasks. Choose another.",
  entry_not_allowed: "Your plan does not include this model. Choose another.",
  entry_unavailable:
    "This model cannot be used right now, because its price or its details are missing. Choose another.",
  provider_unsupported:
    "Tasks cannot run on this provider. Choose another provider.",
  no_key:
    "No key is saved for this provider. Add one in the settings under LLM access, or choose another provider.",
  model_not_in_catalog:
    "The catalog does not list this model any more. Choose another.",
};

/** The reasons that have a sentence; `messages.test.ts` compares them with the reasons of the routes. */
export const MODEL_REFUSAL_COPY_REASONS = Object.keys(
  MODEL_REFUSAL_COPY,
) as ModelRefusalReason[];

const MODEL_REFUSED_GENERIC =
  "This model cannot be used for a task. Choose another model.";

function hasReason(reason: unknown): reason is ModelRefusalReason {
  return (
    typeof reason === "string" &&
    (MODEL_REFUSAL_REASONS as readonly string[]).includes(reason)
  );
}

/** The sentence for why a model was refused. */
export function describeModelRefusal(reason: ModelRefusalReason): string {
  return MODEL_REFUSAL_COPY[reason];
}

type IssueField = ImplementerIssue["field"];
type PlainCode = "required" | "invalid" | "too_long";

const FIELD_COPY: Record<
  Exclude<IssueField, "branch">,
  Record<PlainCode, string>
> = {
  repositoryId: {
    required: "Choose a repository.",
    invalid:
      "This repository cannot be used. Reload the page and choose another.",
    too_long:
      "This repository cannot be used. Reload the page and choose another.",
  },
  baseBranch: {
    required: "Choose a base branch.",
    invalid: "This base branch cannot be used. Choose another.",
    too_long: "This base branch cannot be used. Choose another.",
  },
  instruction: {
    required: "Describe the task for the agent.",
    invalid:
      "The task contains characters that cannot be sent. Remove control characters and try again.",
    too_long: "The task can have at most 20,000 characters. Shorten it.",
  },
  model: {
    required: "Choose a model.",
    invalid: "This model choice cannot be used. Choose the model again.",
    too_long: "This model choice cannot be used. Choose the model again.",
  },
  costLimitCents: {
    required: "Enter an amount, for example 2.50, or leave the field empty.",
    invalid: "Enter an amount in dollars, for example 2.50.",
    too_long: "Enter an amount in dollars, for example 2.50.",
  },
  clientRequestId: {
    required: "The request could not be sent. Reload the page and try again.",
    invalid: "The request could not be sent. Reload the page and try again.",
    too_long: "The request could not be sent. Reload the page and try again.",
  },
};

function isBranchIssue(code: string): code is BranchNameIssue {
  return Object.hasOwn(BRANCH_COPY, code);
}

/** The sentence for one issue of a refused body: the field and the code it was refused with. */
export function describeFieldIssue(field: IssueField, code: string): string {
  if (field === "branch") {
    if (code === "required") return BRANCH_COPY.empty;
    if (isBranchIssue(code)) return BRANCH_COPY[code];
    return "This branch name cannot be used. Choose a new branch name.";
  }
  const copy = FIELD_COPY[field];
  return code === "required" || code === "too_long" ? copy[code] : copy.invalid;
}

/** An answer that was not a success, as much of it as a sentence may use. */
export type ImplementerFailure = {
  code: string;
  status?: number | null;
  /** On `IMPLEMENTER_MODEL_NOT_ALLOWED`: why. */
  reason?: unknown;
  /** On `EXCEEDS_OPERATOR_MAXIMUM`: the operator's maximum in whole US cents. */
  maximumCents?: unknown;
};

const writeNotGranted = (product: ProductIdentity) =>
  `The GitHub App has no permission to write to your repositories yet, so no task can start. Ask an owner of the GitHub account or organisation to open the installation of ${product.name} on GitHub and approve the new permission (contents: read and write). Then reload this page.`;

/** The sentence for why no task can start in a repository, for the reason that is true. */
export function describeUnwritable(
  product: ProductIdentity,
  reason: UnwritableReason,
): string {
  switch (reason) {
    case "write_not_granted":
      return writeNotGranted(product);
    case "connection_gone":
      return `The ${product.name} GitHub App was removed from this GitHub account or organisation, so no task can start. Install it again under Connections, then reload this page.`;
    case "connection_suspended":
      return `The ${product.name} GitHub App is suspended on GitHub, so no task can start. An owner of the GitHub account or organisation has to unsuspend it in the installation settings on GitHub. Then reload this page.`;
    case "app_auth_failed":
      return `GitHub rejected the sign-in of the ${product.name} GitHub App, so no task can start. Try again in a moment. If it stays, the operator has to check the credentials of the GitHub App.`;
    case "scope_refused":
      return `GitHub refuses the ${product.name} GitHub App access to this installation, so no task can start. Check the permissions and the repository access of the installation on GitHub, then reload this page.`;
    case "repository_not_accessible":
      return `The ${product.name} GitHub App cannot reach this repository on GitHub, so no task can start. Check that the installation still includes it, then reload this page.`;
  }
}

const failureCopy = (
  product: ProductIdentity,
  failure: ImplementerFailure,
): Record<ImplementerErrorCode, string> => ({
  IMPLEMENTER_REQUEST_INVALID: INVALID_VALUES,
  IMPLEMENTER_CROSS_SITE_REQUEST: CROSS_SITE_REQUEST_RELOAD_PAGE,
  IMPLEMENTER_BODY_TOO_LARGE:
    "The task is too large to send. Shorten it and try again.",
  IMPLEMENTER_CONTENT_TYPE_UNSUPPORTED: REQUEST_NOT_UNDERSTOOD,
  IMPLEMENTER_REPOSITORY_NOT_FOUND:
    "This repository is not available in this workspace any more. Reload the page and choose another.",
  IMPLEMENTER_APP_NOT_INSTALLED: `${product.name} can no longer reach this repository on GitHub. Check that the GitHub App is still installed for it, then reload the page.`,
  IMPLEMENTER_WRITE_NOT_GRANTED: writeNotGranted(product),
  IMPLEMENTER_BASE_BRANCH_NOT_FOUND:
    "The base branch does not exist on GitHub any more. Choose another base branch.",
  IMPLEMENTER_BRANCH_EXISTS:
    "A branch or an earlier task of this repository already uses this branch name. A new branch name is needed: change the name and send the task again.",
  IMPLEMENTER_BRANCH_CONFLICT:
    "This name clashes with a branch of the repository: a branch name cannot be a folder of another (foo and foo/bar). A new branch name is needed.",
  IMPLEMENTER_REQUEST_REUSED:
    "A task with this form was already started, and what you sent now is not that task. Open the task that was started, or reload the page to send a new one.",
  IMPLEMENTER_MODEL_NOT_ALLOWED: hasReason(failure.reason)
    ? MODEL_REFUSAL_COPY[failure.reason]
    : MODEL_REFUSED_GENERIC,
  EXCEEDS_OPERATOR_MAXIMUM:
    typeof failure.maximumCents === "number" &&
    Number.isFinite(failure.maximumCents)
      ? `The cost limit is above the maximum of ${money(failure.maximumCents)} per task. Enter that amount or less.`
      : "The cost limit is above the maximum for a task. Enter a smaller amount.",
  IMPLEMENTER_GITHUB_UNAVAILABLE:
    "GitHub could not be reached or answered with an error. Nothing was started. Try again in a moment.",
});

function hasCopy(code: string): code is ImplementerErrorCode {
  return (IMPLEMENTER_ERROR_CODES as readonly string[]).includes(code);
}

/** The sentence for the code an answer carried (or a transport code). */
export function describeImplementerFailure(
  product: ProductIdentity,
  failure: ImplementerFailure,
): string {
  if (hasCopy(failure.code)) return failureCopy(product, failure)[failure.code];
  return (
    describeTransportFailure(product, failure.code, failure.status) ??
    GENERIC_FAILURE
  );
}
