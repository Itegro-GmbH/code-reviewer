// SPDX-License-Identifier: LicenseRef-Proprietary

// What a run's error code means, in words for a person who does not run the servers. The codes come
// from three places: the queue (`JOB_ERROR_CODES`), the claim of the runner API (`CLAIM_FAILURE_CODES`
// and `CLAIM_RELEASE_REASONS`) and the runner itself (`RUNNER_ERROR_CODES`). A test requires a text
// for every code of those lists, so a new code cannot ship without one. A code nobody knows (a newer
// runner, a changed database) gets a general sentence and is shown as it is, never as a crash.
//
// Nothing here repeats what a runner or a pull request wrote: the texts are fixed, and the code is
// shown only when it has the plain shape of a code.
//
// The texts that name the product (#740) are made from the identity the caller hands in, so the same words serve every
// product; `errorCopy(product)` is the table, `describeErrorCode(product, ...)` the sentence.
import type { ProductIdentity } from "../product-identity/identity.ts";

/**
 * Codes that no part of the system produces any more but that stored runs still carry: they keep their sentence and
 * are no part of the lists a test requires a sentence for.
 */
export const HISTORIC_ERROR_CODES = ["managed_tier_unavailable"] as const;

/**
 * Codes that are never shown to the customer, in the check run, on the run page or in any answer: the sentence says all
 * there is to say. The code of the hidden hourly brake (#499) is one: it would tell a reader that a count exists.
 */
export const UNSHOWN_ERROR_CODES = ["reviews_paused"] as const;

/** The sentence of each code of the queue, the claim and the runner, for the product the caller serves. */
export const errorCopy = (
  product: ProductIdentity,
): Readonly<Record<string, string>> => ({
  // The queue
  lease_expired:
    "The runner stopped reporting while it worked on this run, and the run ran out of retries.",
  timeout: "The run took longer than the time limit, so it was stopped.",
  project_deactivated:
    "The project was switched off before this run could start.",
  pull_request_closed:
    "The pull request was closed before this run could start.",
  pull_request_draft:
    "The pull request was turned into a draft before this run could start.",
  command_removed:
    "This command was removed from the product, so the waiting run was cancelled.",
  review_kind_changed:
    "The project's review kind was changed before this run could start, so the waiting run was cancelled.",
  no_capable_runner:
    "No runner that can run this kind of review picked up the run within the time limit, so it was cancelled. It will run again on the next push or review request.",
  dispatch_unavailable:
    "No worker picked up this run within the time limit, so it was stopped. The service that starts workers may be down or fully busy. It will run again on the next push or review request.",
  dynamic_review_disabled:
    "Dynamic Review is not switched on yet, so this run could not start. Ask whoever runs the server to turn it on, or switch the project to Diff Review on its settings page.",
  workspace_suspended:
    "Reviews are paused for this workspace, so this run did not start and no AI model was used. Ask whoever manages this workspace's plan.",
  quota_exhausted:
    "This workspace has used up what its plan allows for the current period, so this run did not start and no AI model was used. Reviews start again when the period renews or the limit is raised.",
  entitlements_invalid:
    "The plan settings of this workspace could not be read, so this run did not start and no AI model was used. Ask whoever manages this workspace's plan to check them.",
  balance_negative:
    "The balance of this workspace is below zero, so this run did not start and no AI model was used. Add credit to continue.",
  insufficient_balance:
    "The balance of this workspace is used up, so this run did not start and no AI model was used. Add credit to continue.",
  billing_rates_incomplete: `This run did not start because the billing setup is not complete, and no AI model was used. Ask whoever runs ${product.name}.`,
  billing_hold_released:
    "The credit held for this run was released before it could start, so it did not start and no AI model was used. It will run again on the next push or review request.",
  monthly_limit_reached:
    "The monthly spending limit of this workspace was reached, so this run did not start and no AI model was used. An Owner or Admin of the workspace can change the limit in the workspace settings.",
  reviews_paused:
    "Reviews are paused for this workspace for a while, so this run did not start and no AI model was used. It will run again on the next push or review request.",
  billing_limits_unreadable: `The spending limits of this workspace could not be checked, so this run did not start and no AI model was used. It will run again on the next push or review request. If this keeps happening, ask whoever runs ${product.name}.`,
  // A code of a job from before the catalog (#434): nothing ends a job with it any more (see HISTORIC_ERROR_CODES).
  managed_tier_unavailable:
    "The quality level chosen for this project was not available when this run was made, so it did not start and no AI model was used. Quality levels have since been replaced by review options, which a workspace Owner or Admin can choose in the review settings of the project.",

  managed_model_unavailable: `The review option chosen for this project is not available right now, so this run did not start and no AI model was used. A workspace Owner or Admin can choose another option in the review settings of the project. If none is available, contact whoever runs ${product.name}.`,
  llm_provider_unsupported: `The AI provider chosen in the model settings of this project cannot be used for this run, so it did not start and no AI model was used. Check the model settings of the project, or ask whoever runs ${product.name}.`,

  llm_model_unavailable:
    "The AI model chosen in the model settings of this project is not available any more, so this run did not start and no AI model was used. Choose another model in the review settings of the project.",

  provider_address_changed:
    "The address of the AI provider chosen in the model settings of this project has changed since it was chosen, so this run did not start, your AI key was not sent anywhere and no AI model was used. An Owner or Admin of the workspace can check the provider and confirm the new address in the review settings of the project.",

  // The claim of the runner API
  llm_not_configured:
    "No access to an AI model is set up on this server. Ask whoever runs it to set the LLM provider and key.",
  git_connection_disabled:
    "The GitHub connection of this repository is switched off.",
  git_connection_gone:
    "The GitHub connection of this repository no longer exists.",
  git_connection_suspended: "The GitHub App is suspended for this account.",
  git_scope_refused:
    "GitHub did not give the app the access this review needs.",
  git_app_auth_failed:
    "The server could not sign in to GitHub as the app. Check the GitHub App credentials.",
  git_access_failed:
    "The server could not get access to the repository on GitHub.",
  pr_not_found: "The pull request could not be found on GitHub.",
  job_args_invalid: "The command or arguments of this run could not be used.",
  job_env_invalid:
    "The review settings of this project could not be used for this run. Check them on the project page.",
  job_llm_options_invalid:
    "The model settings of this project, for a Dynamic Review its Dynamic model too, could not be used for this run. Check them on the project page.",
  git_access_unavailable:
    "GitHub could not be reached to prepare this run, even after several tries.",
  pull_request_unavailable:
    "The pull request could not be read from GitHub, even after several tries.",
  claim_failed:
    "The server could not prepare this run, even after several tries.",
  price_check_failed:
    "The server could not check the model for this run, even after several tries.",
  provider_pin_check_failed:
    "The server could not check the address of the model provider for this run, even after several tries.",
  launch_failed:
    "The worker for this run could not be started, even after several tries.",
  worker_exited:
    "The worker for this run stopped with an error before it reported a result, even after several tries.",

  // The runner
  invalid_job: "The runner refused the job because it was incomplete.",
  invalid_command: "The command of this run is not one the runner supports.",
  pr_agent_version_mismatch:
    "The review engine in the runner is not the version this server expects.",
  identity_patch_failed:
    "The review engine could not act as the GitHub App. This is a problem of the runner.",
  runner_error: "The runner hit an unexpected error.",
  command_failed: "The review engine reported an error.",
  review_not_published:
    "No review was posted on the pull request. Either the engine did not post one, or the earlier review on the pull request belongs to a commit this run cannot account for.",
  review_state_truncated:
    "The review was posted, but it grew past GitHub's comment size limit, so earlier findings are no longer tracked.",
  review_text_truncated:
    "The review was posted, but part of it was cut off because the comment reached GitHub's size limit.",
  git_auth: "GitHub refused the access token of this run.",
  git_forbidden: "GitHub does not allow the app to do this on the repository.",
  git_rate_limit: "GitHub is limiting requests right now. Try again later.",
  git_unavailable: "GitHub could not be reached.",
  git_unprocessable:
    "GitHub could not process the request for this pull request.",
  git_provider_init: "The review engine could not connect to the pull request.",
  llm_auth: "The AI provider refused the API key.",
  llm_quota: "The AI provider says the credit or quota is used up.",
  llm_rate_limit: "The AI provider is limiting requests right now.",
  llm_timeout: "The AI provider took too long to answer.",
  llm_unavailable: "The AI provider could not be reached or is having trouble.",
  llm_bad_request:
    "The AI provider rejected the request, for example because the pull request is too large for the model.",
  llm_context_length_exceeded:
    "The request was larger than the model's context window, so the AI provider refused it. Choose a model with a larger window, or review a smaller pull request.",
  llm_output_invalid:
    "The AI model answered in a form the review engine could not use.",
  model_unknown: "The configured model is not known to the AI provider.",
  llm_parameters_unsupported:
    "No provider can serve this model with everything the review asks for, so the AI service refused the request. Choose another model for this project.",
  runner_shutdown: "The runner was shut down while it worked on this run.",
  dynamic_engine_unavailable:
    "This run needs something no runner that answered has available yet: the Dynamic Review engine, or, for a project with a cost limit, a runner that can enforce that limit.",
  dynamic_isolation_self_check_failed:
    "The Dynamic Review engine could not prove its isolation is safe, so no runner advertises it.",
  dynamic_config_invalid:
    "The Dynamic Review settings of this project could not be used for this run. Check them on the project page.",
  checkout_incomplete:
    "The Dynamic Review could not prepare the repository checkout, so it was not started.",
  dynamic_policy_violation:
    "The Dynamic Review stopped because it would have broken a safety rule.",
  dynamic_budget_exceeded:
    "The Dynamic Review used more than its allowed budget and was stopped.",
  dynamic_accounting_failed:
    "The Dynamic Review's model usage could not be accounted for, so it was stopped.",
  // The sentence for a reader who does not know whose limit it was (a list row, a runner that did not say): true for both.
  cost_limit_reached: `The review stopped at its cost limit: it sent no further request to the AI model once the calls so far had cost that much, and posted no review. The limit is the one set for this project under Limits in the project settings, or the maximum cost per review set by ${product.name}, whichever is lower.`,
  dynamic_model_features_unsupported:
    "The configured model does not support the features Dynamic Review requires. Choose another model.",
  lease_lost:
    "When the review was ready, the job was no longer held by its runner or this could not be confirmed, so nothing was written. The next push reviews again.",
  superseded:
    "A newer push replaced this run while it was running, so it was stopped and published nothing.",
  // The Implementer (#746). One plain sentence each; none promises a pull request (the work is on a branch).
  branch_exists:
    "The branch for this task already exists on the repository, so nothing was changed. Choose another branch name.",
  base_branch_not_found:
    "The branch this task should start from could not be found on the repository, so nothing was changed.",
  clone_failed:
    "The repository could not be downloaded, so the task did not start.",
  setup_failed:
    "The repository's own set-up steps did not complete, so the task could not start.",
  agent_gave_up:
    "The agent stopped without a result it could stand behind. Read its summary, then try again with a clearer or smaller task.",
  push_rejected:
    "The repository refused the new branch, so the work was not saved there.",
  branch_violation:
    "The work left the branch it was given, so it was stopped and nothing was pushed.",
  time_limit_reached:
    "The task took longer than its time limit, so it was stopped.",
  git_write_not_granted:
    "The app is not allowed to write to this repository yet. Accept the new permission on GitHub, then start the task again.",
  implementer_engine_unavailable:
    "No worker that answered can run tasks yet, so this task did not start.",
  implementer_config_invalid:
    "The settings of this task could not be used, so it did not start.",
  unknown: "The run failed for a reason this version does not know.",
});

/**
 * Why a Dynamic Review checkout failed (`RUNNER_CHECKOUT_REASONS`), in words. The runner reports the
 * name next to the code `checkout_incomplete`; a test requires a sentence for every name.
 */
export const CHECKOUT_REASON_COPY: Readonly<Record<string, string>> = {
  invalid_request:
    "The job or its limits could not be used to prepare the repository checkout.",
  ref_moved:
    "The pull request changed while the checkout was prepared, so nothing was reviewed. The next push reviews again.",
  ref_missing:
    "The pull request or its base branch could not be found on GitHub.",
  protocol: "GitHub answered in a form the checkout could not read.",
  pack_invalid: "The repository data GitHub sent could not be verified.",
  object_missing:
    "A file the checkout needed was missing from what GitHub sent.",
  tree_invalid: "The file tree of the repository could not be read.",
  entries: "The repository has more files than a Dynamic Review can prepare.",
  path_invalid: "A file path in the repository cannot be exported safely.",
  budget_transfer:
    "The repository is larger to download than a Dynamic Review allows.",
  budget_preparation:
    "The repository is larger to prepare than a Dynamic Review allows.",
  budget_exposed:
    "The text files of the repository are more than a Dynamic Review may read.",
  diff_too_large:
    "The change of this pull request is larger than a Dynamic Review can read.",
  input_too_large:
    "The description or the earlier review state of the pull request is larger than a Dynamic Review can use.",
  cancelled: "The run was stopped while the checkout was prepared.",
  timeout: "Preparing the repository checkout took longer than the time limit.",
  transport:
    "GitHub refused the request or could not be reached while the checkout was prepared.",
  isolation: "The checkout could not be sealed safely for the review engine.",
  context:
    "The title, the description or the earlier review state of the pull request could not be read.",
};

export const unknownReasonCopy = (product: ProductIdentity): string =>
  `The checkout failed for a reason this version of ${product.name} does not know. The reason below helps whoever runs the server to look it up.`;

export const unknownErrorCopy = (product: ProductIdentity): string =>
  `The run ended with an error this version of ${product.name} does not know. The error code below helps whoever runs the server to look it up.`;

/** A code is a short word with underscores; anything else is not shown. */
const CODE_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * #689: a Diff Review that is stopped at its cost limit ends with one code whichever limit it was; the runner names the limit in
 * `usage.stoppedEarly`. The customer can change their own limit but not the maximum of the product, so the text says which.
 */
const costLimitReachedCopy = (
  product: ProductIdentity,
): Readonly<Record<string, string>> => ({
  project_cost_limit:
    "The review stopped at the cost limit set for this project: it sent no further request to the AI model once the calls so far had cost that much, and posted no review. You can change the limit under Limits in the project settings.",
  cost_limit: `The review stopped at the maximum cost per review set by ${product.name}: it sent no further request to the AI model once the calls so far had cost that much, and posted no review. This maximum is not a setting of the project.`,
});

export type ErrorDescription = {
  /** The code as stored when it has the shape of one, otherwise null (it is never shown then). */
  code: string | null;
  /** The sentence for a person. */
  text: string;
  /** Whether the code has a text of its own. */
  known: boolean;
};

/**
 * The sentences of a run of the Implementer (#758). A task is not a review of a pull request: where a sentence of the table
 * above names a review, a project, a pull request or a later push, or says "nothing was pushed" about a run that may have pushed
 * commits, the task has its own. Every other code keeps the sentence of the table. The table above is code-review.com's and is
 * pinned by its golden file; nothing here changes a line of it. A sentence is true for the list (which does not know what the
 * task pushed) and for the page, which says what was pushed next to it.
 */
export const turnErrorCopy = (
  product: ProductIdentity,
): Readonly<Record<string, string>> => ({
  ...errorCopy(product),
  // No longer reported (git is free in the workspace and each branch is judged by GitHub at the end), but runs that carry it stay
  // readable.
  branch_violation:
    "The task was stopped because its work could not be kept safely on the branch it was given. Commits pushed before that stay on the branch; nothing after that was saved.",
  cost_limit_reached: `The task stopped at its cost limit: it sent no further request to the AI model once the calls so far had cost that much. The limit is the one chosen for this task or the maximum cost per task set by ${product.name}, whichever is lower. Work committed before the stop was pushed to the branch when possible, so check the branch for what reached it.`,
  // The same code serves the Diff Review, the Dynamic Review and a task. The usage could not be settled; the work may be done.
  dynamic_accounting_failed:
    "The model usage of this task could not be accounted for, so the task was ended and its cost is not known. The work may be done and pushed: check the branch.",
  time_limit_reached:
    "The task reached its time limit and was stopped. Work committed before then was pushed to the branch when possible, so check the branch for what reached it.",
  // The runner reports this code when the task's branch did not arrive on GitHub, or when no branch did: the repository refused it
  // (the branch already exists with other history, a rule, a permission, a workflow file) or could not be reached. The page
  // lists every branch with the reason; a branch that was pushed stays.
  push_rejected:
    "GitHub did not take the work of this task: the branch was refused, or GitHub could not be reached. The branches below say which were pushed and why the others were not. A branch that was pushed stays on GitHub.",
  // The table above says "Reviews" for a workspace that is paused or has used up its plan; a task is not a review.
  workspace_suspended:
    "Tasks are paused for this workspace, so this task did not start and no AI model was used. Ask whoever manages this workspace's plan.",
  quota_exhausted:
    "This workspace has used up what its plan allows for the current period, so this task did not start and no AI model was used. Tasks start again when the period renews or the limit is raised.",
  // The code covers an agent that ended without a commit and an engine that stopped after the model was called. The runner
  // pushes what was committed in the second case, and the summary says when files the agent wrote could not be kept (the
  // Implementer cannot change the configuration of its own engine, such as opencode.json).
  agent_gave_up:
    "The agent stopped without a result it could stand behind, or its engine stopped before it could report one. Read its summary, if there is one: it also says when files the agent wrote could not be kept. Anything the agent committed was pushed to the branch when possible. Then try again with a clearer or smaller task.",
  // The table above promises a new run on the next push or review request; a task is never run again by itself.
  no_capable_runner:
    "No worker that can run tasks picked up this task within the time limit, so it was cancelled. Start it again later.",
  dispatch_unavailable:
    "No worker picked up this task within the time limit, so it was stopped. The service that starts workers may be down or fully busy. Start the task again later.",
  lease_lost:
    "The worker no longer held this task when it was ready, or this could not be confirmed, so the result was not saved. Work pushed before that stays on the branch.",
  billing_hold_released:
    "The credit held for this task was released before it could start, so it did not start and no AI model was used. Start the task again.",
  reviews_paused:
    "Work is paused for this workspace for a while, so this task did not start and no AI model was used. Start it again later.",
  billing_limits_unreadable: `The spending limits of this workspace could not be checked, so this task did not start and no AI model was used. Start it again later. If this keeps happening, ask whoever runs ${product.name}.`,
  // The model of a task is chosen when it is started, not in the settings of a project.
  llm_model_unavailable:
    "The AI model chosen for this task is not available any more, so it did not start and no AI model was used. Start a new task with another model.",
  llm_provider_unsupported: `The AI provider chosen for this task cannot be used for it, so it did not start and no AI model was used. Start a new task with another model, or ask whoever runs ${product.name}.`,
  managed_model_unavailable: `The model chosen for this task is not available right now, so it did not start and no AI model was used. Start a new task with another model. If none is available, contact whoever runs ${product.name}.`,
});

function describe(
  copy: Readonly<Record<string, string>>,
  product: ProductIdentity,
  code: string,
  stoppedEarly?: string | null,
): ErrorDescription {
  const shown = CODE_SHAPE.test(code) ? code : null;
  const unknown = unknownErrorCopy(product);
  if (shown !== null && Object.hasOwn(copy, shown)) {
    const costLimits = costLimitReachedCopy(product);
    const bound =
      shown === "cost_limit_reached" &&
      stoppedEarly !== undefined &&
      stoppedEarly !== null &&
      Object.hasOwn(costLimits, stoppedEarly)
        ? costLimits[stoppedEarly]
        : undefined;
    return {
      code: (UNSHOWN_ERROR_CODES as readonly string[]).includes(shown)
        ? null
        : shown,
      text: bound ?? copy[shown] ?? unknown,
      known: true,
    };
  }
  return { code: shown, text: unknown, known: false };
}

/** `stoppedEarly` is the limit the runner reported in the usage of the run (`cost_limit`, `project_cost_limit`), when it did. */
export function describeErrorCode(
  product: ProductIdentity,
  code: string,
  stoppedEarly?: string | null,
): ErrorDescription {
  return describe(errorCopy(product), product, code, stoppedEarly);
}

/** The sentence for the code of a run of the Implementer (#758); see `turnErrorCopy`. */
export function describeTurnErrorCode(
  product: ProductIdentity,
  code: string,
): ErrorDescription {
  return describe(turnErrorCopy(product), product, code);
}

export type ReasonDescription = {
  code: string;
  text: string;
  known: boolean;
};

/** The sentence for a checkout reason; null when the value is not shaped like a reason (it is never shown). */
export function describeCheckoutReason(
  product: ProductIdentity,
  reason: string,
): ReasonDescription | null {
  if (!CODE_SHAPE.test(reason)) return null;
  const unknown = unknownReasonCopy(product);
  if (Object.hasOwn(CHECKOUT_REASON_COPY, reason))
    return {
      code: reason,
      text: CHECKOUT_REASON_COPY[reason] ?? unknown,
      known: true,
    };
  return { code: reason, text: unknown, known: false };
}
