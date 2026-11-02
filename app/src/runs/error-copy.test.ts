// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import {
  CLAIM_FAILURE_CODES,
  CLAIM_RELEASE_REASONS,
} from "../runner-api/claim.ts";
import {
  RUNNER_CHECKOUT_REASONS,
  RUNNER_ERROR_CODES,
} from "../runner-api/contract.ts";
import { JOB_ERROR_CODES } from "../jobs/job-types.ts";
import {
  CHECKOUT_REASON_COPY,
  describeCheckoutReason,
  describeErrorCode,
  describeTurnErrorCode,
  errorCopy,
  HISTORIC_ERROR_CODES,
  unknownErrorCopy,
  unknownReasonCopy,
} from "./error-copy.ts";
import { getProductIdentity } from "../product-identity/current.ts";

const PRODUCT = getProductIdentity();
const ERROR_COPY = errorCopy(PRODUCT);
const UNKNOWN_ERROR_COPY = unknownErrorCopy(PRODUCT);
const UNKNOWN_REASON_COPY = unknownReasonCopy(PRODUCT);

const ALL_CODES = [
  ...new Set<string>([
    ...JOB_ERROR_CODES,
    ...CLAIM_FAILURE_CODES,
    ...CLAIM_RELEASE_REASONS,
    ...RUNNER_ERROR_CODES,
    ...HISTORIC_ERROR_CODES,
  ]),
];

describe("the sentences for error codes", () => {
  // CR-35-T08
  it("has a sentence for every code the queue, the claim and the runner can store", () => {
    const missing = ALL_CODES.filter(
      (code) => !Object.hasOwn(ERROR_COPY, code),
    );

    expect(missing).toEqual([]);
  });

  // CR-35-T08
  it("explains each code in a full sentence that is not the code itself", () => {
    for (const code of ALL_CODES) {
      const { text, known } = describeErrorCode(PRODUCT, code);
      expect(known).toBe(true);
      expect(text).toMatch(/^[A-Z].*\.$/);
      expect(text).not.toContain(code);
      expect(text).not.toBe(UNKNOWN_ERROR_COPY);
    }
  });

  // #689-T26
  it("words the cost limit by whose limit it was, and says neither more than it knows", () => {
    const project = describeErrorCode(
      PRODUCT,
      "cost_limit_reached",
      "project_cost_limit",
    );
    const operator = describeErrorCode(
      PRODUCT,
      "cost_limit_reached",
      "cost_limit",
    );
    const unknown = describeErrorCode(PRODUCT, "cost_limit_reached");

    // The customer's own limit: they can change it, and are told where.
    expect(project.text).toContain("cost limit set for this project");
    expect(project.text).toContain("Limits in the project settings");
    // The operator's maximum: the customer cannot raise it, and is not sent to a field that would not help.
    expect(operator.text).toContain(
      "maximum cost per review set by code-review.com",
    );
    expect(operator.text).not.toMatch(/project settings|Limits/);
    expect(operator.text).not.toMatch(/instance/i);
    // A runner that does not say which limit bound (or a list row): true for both.
    expect(unknown.text).toContain("project");
    expect(unknown.text).toContain("code-review.com");
    expect(unknown.text).not.toMatch(/instance/i);
    expect(unknown.text).toBe(ERROR_COPY["cost_limit_reached"]);
    for (const described of [project, operator, unknown]) {
      expect(described.code).toBe("cost_limit_reached");
      expect(described.known).toBe(true);
    }
    // Another code is not changed by a stop reason.
    expect(describeErrorCode(PRODUCT, "timeout", "cost_limit").text).toBe(
      ERROR_COPY["timeout"],
    );
  });

  // #499-T13
  it("gives the code of the hidden brake a sentence and shows no code, no number and no window", () => {
    const described = describeErrorCode(PRODUCT, "reviews_paused");

    expect(described.known).toBe(true);
    expect(described.code).toBeNull();
    expect(described.text).toMatch(/^Reviews are paused for this workspace/);
    expect(described.text).not.toMatch(
      /\d|hour|brake|limit|window|reviews_paused/i,
    );
  });

  // #434-X1: the code no part of the system produces any more, kept for the runs that ended with it.
  it("keeps the sentence of the removed tier code for old runs, points at the review options that replaced the levels, and the claim cannot end a job with it", () => {
    const code = "managed_tier_unavailable";
    const { text, known } = describeErrorCode(PRODUCT, code);

    expect(HISTORIC_ERROR_CODES).toEqual([code]);
    expect(CLAIM_FAILURE_CODES).not.toContain(code);
    expect(known).toBe(true);
    expect(text).toMatch(/quality level/);
    expect(text).toMatch(/replaced/);
    expect(text).toMatch(/Owner or Admin/);
    expect(text).toMatch(/review settings/);
    expect(text).not.toMatch(/\bmodel\b(?! was used)/);
  });

  // #432-T19
  it("tells a person about an unavailable model choice without naming a model, and where to change it", () => {
    expect(CLAIM_FAILURE_CODES).toContain("managed_model_unavailable");
    const { text, known } = describeErrorCode(
      PRODUCT,
      "managed_model_unavailable",
    );

    expect(known).toBe(true);
    expect(text).toMatch(/Owner or Admin/);
    expect(text).toMatch(/review settings/);
    expect(text).toMatch(/whoever runs code-review.com/);
    expect(text).toMatch(/no AI model was used/);
    expect(text).not.toMatch(/\bmodel\b(?! was used)/);
  });

  // #432-T19
  it("tells a person that the runner cannot use the provider chosen for the project, naming no provider", () => {
    expect(CLAIM_FAILURE_CODES).toContain("llm_provider_unsupported");
    const { text, known } = describeErrorCode(
      PRODUCT,
      "llm_provider_unsupported",
    );

    expect(known).toBe(true);
    expect(text).toMatch(/no AI model was used/);
    expect(text).toMatch(/model settings/);
    expect(text).not.toMatch(/openrouter/i);
  });

  // #588-T31
  it("tells a person that the address of the provider changed, that the key was not sent and who can confirm it", () => {
    expect(CLAIM_FAILURE_CODES).toContain("provider_address_changed");
    const { text, known } = describeErrorCode(
      PRODUCT,
      "provider_address_changed",
    );

    expect(known).toBe(true);
    expect(text).toMatch(/Owner or Admin/);
    expect(text).toMatch(/confirm/);
    expect(text).toMatch(/review settings of the project/);
    expect(text).toMatch(/key was not sent/);
    expect(text).toMatch(/no AI model was used/);
    expect(text).not.toMatch(/https?:/);
  });

  // #200: the codes a Dynamic project's run can end with are read by people on the Runs pages.
  it("tells a person what to do about a Dynamic Review that is not enabled, and about a model the engine cannot use", () => {
    expect(describeErrorCode(PRODUCT, "dynamic_review_disabled").text).toMatch(
      /server/i,
    );
    expect(describeErrorCode(PRODUCT, "dynamic_review_disabled").text).toMatch(
      /Diff Review/,
    );
    expect(describeErrorCode(PRODUCT, "no_capable_runner").text).toMatch(
      /runner/,
    );
    expect(
      describeErrorCode(PRODUCT, "dynamic_model_features_unsupported").text,
    ).toMatch(/Choose another model/);
    expect(describeErrorCode(PRODUCT, "dynamic_config_invalid").text).toMatch(
      /project page/,
    );
  });

  // #432-T22
  it("tells the user of a Dynamic Review that the Dynamic model counts as a model setting, without naming a model", () => {
    const { text } = describeErrorCode(PRODUCT, "job_llm_options_invalid");

    expect(text).toMatch(/Dynamic model/);
    expect(text).toMatch(/project page/);
  });

  // #277-T12
  it("explains a refusal for the plan of the workspace in one sentence, without a number or a figure", () => {
    for (const code of [
      "workspace_suspended",
      "quota_exhausted",
      "entitlements_invalid",
    ]) {
      const { text, known } = describeErrorCode(PRODUCT, code);

      expect(known).toBe(true);
      expect(text).toMatch(/^[A-Z][^.]*\.(?: [A-Z][^.]*\.)*$/);
      expect(text).not.toMatch(/\d/);
      expect(text).not.toMatch(/[$€£%]/);
      expect(text).toMatch(/did not start/);
      expect(text).toMatch(/no AI model was used/);
    }
  });

  // #290-T06
  it("tells a person that the request was larger than the model's context window", () => {
    const { text, known } = describeErrorCode(
      PRODUCT,
      "llm_context_length_exceeded",
    );

    expect(known).toBe(true);
    expect(text).toMatch(/context window/);
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toContain("llm_context_length_exceeded");
  });

  // #477-T04
  it("tells a person that no provider can serve this model with the request's parameters, and what to do", () => {
    const { text, known } = describeErrorCode(
      PRODUCT,
      "llm_parameters_unsupported",
    );

    expect(known).toBe(true);
    expect(text).toMatch(/no provider/i);
    expect(text).toMatch(/another model/);
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).not.toContain("llm_parameters_unsupported");
  });

  // #260: the code is also reported when the app could not be asked, not only when the job was lost.
  it("says for lease_lost that the job may have been lost or that this could not be confirmed, and that nothing was written", () => {
    const { text } = describeErrorCode(PRODUCT, "lease_lost");

    expect(text).toMatch(/no longer held/);
    expect(text).toMatch(/could not be confirmed/);
    expect(text).toMatch(/nothing was written/);
  });

  // #201-T20
  it("does not say the engine ran when review_not_published can come from the preparation", () => {
    const { text } = describeErrorCode(PRODUCT, "review_not_published");

    // The Dynamic preparation raises this code before any engine starts, when the earlier review
    // on the pull request cannot be used as the starting point.
    expect(text).not.toMatch(/engine finished/i);
    expect(text).toMatch(/earlier review/i);
    expect(text).toMatch(/no review was posted/i);
  });

  it("has no sentence for a code that does not exist", () => {
    const extra = Object.keys(ERROR_COPY).filter(
      (code) => !ALL_CODES.includes(code),
    );

    expect(extra).toEqual([]);
  });

  // CR-35-T09
  it("gives an unknown code a general sentence and shows the code besides it", () => {
    expect(describeErrorCode(PRODUCT, "flux_capacitor_overload")).toEqual({
      code: "flux_capacitor_overload",
      text: UNKNOWN_ERROR_COPY,
      known: false,
    });
  });

  // CR-35-T09
  it("never shows something that is not shaped like a code", () => {
    for (const odd of [
      "<script>alert(1)</script>",
      "Has Spaces",
      "",
      "x".repeat(65),
      "toString",
    ]) {
      const described = describeErrorCode(PRODUCT, odd);
      expect(described.known).toBe(false);
      expect(described.text).toBe(UNKNOWN_ERROR_COPY);
    }
    expect(describeErrorCode(PRODUCT, "<script>").code).toBeNull();
    expect(describeErrorCode(PRODUCT, "").code).toBeNull();
  });

  // #296-T11
  it("has a full sentence for every reason the checkout can fail with", () => {
    for (const reason of RUNNER_CHECKOUT_REASONS) {
      expect(Object.hasOwn(CHECKOUT_REASON_COPY, reason)).toBe(true);
      const description = describeCheckoutReason(PRODUCT, reason);
      expect(description).toStrictEqual({
        code: reason,
        text: CHECKOUT_REASON_COPY[reason],
        known: true,
      });
      expect(description?.text).toMatch(/^[A-Z].*\.$/);
      expect(description?.text).not.toContain(reason);
    }
  });

  // #296-T11
  it("shows a reason it does not know with the general sentence, and one that is not shaped like a code not at all", () => {
    expect(describeCheckoutReason(PRODUCT, "brand_new_reason")).toStrictEqual({
      code: "brand_new_reason",
      text: UNKNOWN_REASON_COPY,
      known: false,
    });
    expect(
      describeCheckoutReason(PRODUCT, "<script>alert(1)</script>"),
    ).toBeNull();
    expect(describeCheckoutReason(PRODUCT, "")).toBeNull();
  });
});

// The sentences of a run of the Implementer (#758): the table above is the table of code-review.com and does not change by a
// line (its golden stays); a task has its own sentences where those do not fit it.
describe("the sentences for the codes of a task", () => {
  /** The codes a turn can end with: its own, the runner's general ones, the queue's and the claim's. */
  const TURN_CODES = [
    "branch_exists",
    "base_branch_not_found",
    "clone_failed",
    "setup_failed",
    "agent_gave_up",
    "push_rejected",
    "branch_violation",
    "cost_limit_reached",
    "time_limit_reached",
    "dynamic_policy_violation",
    "dynamic_budget_exceeded",
    "llm_context_length_exceeded",
    "git_write_not_granted",
    "implementer_engine_unavailable",
    "implementer_config_invalid",
    "sandbox_unproven",
    "sandbox_size_unsupported",
    "dynamic_accounting_failed",
    "timeout",
    "lease_expired",
    "lease_lost",
    "runner_shutdown",
    "runner_error",
    "invalid_job",
    "no_capable_runner",
    "dispatch_unavailable",
    "launch_failed",
    "worker_exited",
    "claim_failed",
    "git_connection_disabled",
    "git_connection_gone",
    "git_connection_suspended",
    "git_access_failed",
    "git_access_unavailable",
    "llm_model_unavailable",
    "llm_provider_unsupported",
    "managed_model_unavailable",
    "workspace_suspended",
    "quota_exhausted",
    "entitlements_invalid",
    "balance_negative",
    "insufficient_balance",
    "billing_rates_incomplete",
    "billing_hold_released",
    "monthly_limit_reached",
    "reviews_paused",
    "billing_limits_unreadable",
    "unknown",
  ];

  // #758-T10
  it("has a full sentence for every code that can end a task, known and not the general one", () => {
    for (const code of TURN_CODES) {
      const { text, known } = describeTurnErrorCode(PRODUCT, code);
      expect(known, code).toBe(true);
      expect(text, code).toMatch(/^[A-Z].*\.$/);
      expect(text, code).not.toContain(code);
      expect(text, code).not.toBe(UNKNOWN_ERROR_COPY);
    }
    expect(TURN_CODES.filter((code) => !ALL_CODES.includes(code))).toEqual([]);
  });

  // #758-T10
  it("promises no pull request, no review and no run on the next push", () => {
    for (const code of TURN_CODES) {
      const { text } = describeTurnErrorCode(PRODUCT, code);
      // "Reviews" included: a task is not a review (review of #792).
      expect(text.replaceAll(PRODUCT.name, ""), code).not.toMatch(
        /pull request|next push|\breviews?\b/i,
      );
    }
  });

  // #758-T10
  it("gives an unknown code the general sentence and shows the code, as for any run", () => {
    expect(describeTurnErrorCode(PRODUCT, "flux_capacitor_overload")).toEqual({
      code: "flux_capacitor_overload",
      text: UNKNOWN_ERROR_COPY,
      known: false,
    });
    expect(describeTurnErrorCode(PRODUCT, "<script>").code).toBeNull();
  });

  // #758-T10
  it("hides the code that is never shown, also for a task", () => {
    expect(describeTurnErrorCode(PRODUCT, "reviews_paused")).toMatchObject({
      code: null,
      known: true,
    });
  });

  // #758-T03: from the review of #788, one assertion per sentence that did not fit a turn.
  it("does not say 'nothing was pushed' for a branch violation, which also covers a repository that could not be committed or verified", () => {
    const { text } = describeTurnErrorCode(PRODUCT, "branch_violation");

    expect(text).not.toMatch(/nothing was pushed/i);
    expect(text).toMatch(/branch/);
    expect(text).toMatch(/pushed before/);
  });

  it("words the cost limit of a task as the limit of one task, posts no review and leaves pushed work standing", () => {
    const { text } = describeTurnErrorCode(PRODUCT, "cost_limit_reached");

    expect(text).toMatch(/cost limit/);
    expect(text).toMatch(/task/);
    expect(text).not.toMatch(/Limits in the project settings|this project/);
    expect(text).not.toMatch(/posted no review/);
    expect(text).toContain(PRODUCT.name);
    expect(text).toMatch(/pushed/);
    // The same sentence whichever limit bound: a turn has one limit per task.
    expect(describeTurnErrorCode(PRODUCT, "cost_limit_reached").text).toBe(
      text,
    );
  });

  it("words an accounting failure of a task without the Dynamic Review and without saying the work is lost", () => {
    const { text } = describeTurnErrorCode(
      PRODUCT,
      "dynamic_accounting_failed",
    );

    expect(text).not.toMatch(/Dynamic Review/);
    expect(text).toMatch(/pushed/);
    expect(text).toMatch(/accounted/);
  });

  // #810: the first live run of a task ended with this code and the person read about a Dynamic Review.
  it("words the safety rule, the budget and the context window of a task without the Dynamic Review, a review or a pull request, and says pushed work stays", () => {
    for (const code of [
      "dynamic_policy_violation",
      "dynamic_budget_exceeded",
      "llm_context_length_exceeded",
    ]) {
      const { text } = describeTurnErrorCode(PRODUCT, code);
      expect(text.replaceAll(PRODUCT.name, ""), code).not.toMatch(
        /Dynamic Review|review|pull request/i,
      );
      expect(text, code).toMatch(/task/);
    }
    const rule = describeTurnErrorCode(
      PRODUCT,
      "dynamic_policy_violation",
    ).text;
    expect(rule).toMatch(/safety rule/);
    expect(rule).toMatch(/pushed/);
    expect(rule).toContain(PRODUCT.name);
    expect(
      describeTurnErrorCode(PRODUCT, "dynamic_budget_exceeded").text,
    ).toMatch(/pushed/);
  });

  // #810: code-review.com keeps its golden sentences for the same codes.
  it("leaves the sentences of code-review.com for these codes as they were", () => {
    expect(describeErrorCode(PRODUCT, "dynamic_policy_violation").text).toBe(
      "The Dynamic Review stopped because it would have broken a safety rule.",
    );
    expect(describeErrorCode(PRODUCT, "dynamic_budget_exceeded").text).toBe(
      "The Dynamic Review used more than its allowed budget and was stopped.",
    );
  });

  it("says for the time limit of a task whether pushed work stays", () => {
    const { text } = describeTurnErrorCode(PRODUCT, "time_limit_reached");

    expect(text).toMatch(/time limit/);
    expect(text).toMatch(/pushed/);
  });

  // #765: the copy of the issue comment, for the final push that could not reach the repository too.
  it("says for a rejected push that GitHub refused it, did not answer or answered with an error, that it took too long, or that the workspace could not be read, and that pushed branches stay", () => {
    const { text } = describeTurnErrorCode(PRODUCT, "push_rejected");

    expect(text).toBe(
      "The work of this task did not arrive on GitHub. Either GitHub refused the branch, did not answer or answered with an error, the push took too long, or the workspace of the agent could not be read, in which case nothing was pushed. The branches below, if there are any, say which were pushed and why the others were not. A branch that was pushed stays on GitHub.",
    );
    expect(text).toContain("workspace of the agent could not be read");
    expect(text).not.toMatch(/new branch/);
  });

  // #765: the runner commits what is left and pushes it at the cost limit, as at the time limit.
  it("says for the cost limit that committed work was pushed when possible, not that only earlier pushes stay", () => {
    const { text } = describeTurnErrorCode(PRODUCT, "cost_limit_reached");

    expect(text).toMatch(/committed before the stop was pushed/);
    expect(text).not.toMatch(/pushed before the stop stays/);
  });

  // #758-T03 (review of #792, 3): the list row shows the sentence without the page's lists.
  it("points at no list in the sentences of the pushed work: they are shown in the list row as well", () => {
    for (const code of [
      "branch_violation",
      "time_limit_reached",
      "dynamic_accounting_failed",
      "cost_limit_reached",
      "lease_lost",
    ]) {
      expect(describeTurnErrorCode(PRODUCT, code).text, code).not.toMatch(
        /\b(below|above|listed)\b/i,
      );
    }
  });

  // #758-T10 (review of #792, 2)
  it("words the pause and the used-up plan for a task", () => {
    expect(describeTurnErrorCode(PRODUCT, "workspace_suspended").text).toMatch(
      /^Tasks are paused for this workspace/,
    );
    const quota = describeTurnErrorCode(PRODUCT, "quota_exhausted").text;
    expect(quota).toMatch(/Tasks start again when the period renews/);
    expect(quota).not.toMatch(/Reviews/);
  });

  // #758-T10 (review of #792, 6)
  it("says for agent_gave_up that the engine may have stopped, and that a summary may not exist", () => {
    const { text } = describeTurnErrorCode(PRODUCT, "agent_gave_up");

    expect(text).toMatch(/engine/);
    expect(text).toMatch(/summary, if there is one|if there is a summary/);
    // #765: files the agent wrote that were not kept are named in the summary; its commits were pushed.
    expect(text).toMatch(/files the agent wrote could not be kept/);
    expect(text).toMatch(/committed was pushed/);
    expect(ERROR_COPY["agent_gave_up"]).toContain("Read its summary, then");
  });

  // #758-T09
  it("changes no sentence of the table of the other kinds", () => {
    for (const code of [
      "branch_violation",
      "cost_limit_reached",
      "dynamic_accounting_failed",
      "time_limit_reached",
      "push_rejected",
      "no_capable_runner",
      "workspace_suspended",
      "quota_exhausted",
      "agent_gave_up",
    ]) {
      expect(describeErrorCode(PRODUCT, code).text).toBe(ERROR_COPY[code]);
    }
    expect(ERROR_COPY["cost_limit_reached"]).toContain("posted no review");
    expect(ERROR_COPY["branch_violation"]).toContain("nothing was pushed");
  });
});
