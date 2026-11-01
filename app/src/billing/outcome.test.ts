// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import { JOB_ERROR_CODES } from "../jobs/job-types.ts";
import {
  CLAIM_FAILURE_CODES,
  CLAIM_RELEASE_REASONS,
} from "../runner-api/claim.ts";
import {
  RUNNER_CHECKOUT_REASONS,
  RUNNER_ERROR_CODES,
} from "../runner-api/contract.ts";
import {
  LAUNCH_FAILED_CODE,
  WORKER_EXITED_CODE,
} from "../runner-api/release.ts";
import { readContract } from "../test-support/runner-contract.ts";
import {
  NO_RESULT_ERROR_REASONS,
  SETTLED_REASONS,
} from "../usage/usage-records.ts";
import {
  AI_COST_FAILURE_CLASS,
  AI_COST_FAILURE_CODES,
  CHECKOUT_REASON_CLASSES,
  ERROR_CODE_CLASSES,
  OURS_ON_MANAGED_KEY,
  OUTCOME_CLASSES,
  RESULT_REASON_CLASSES,
  SETTLED_REASON_CLASSES,
  classifyOutcome,
  type OutcomeClass,
  type RunEnd,
} from "./outcome.ts";

const failed = (
  errorCode: string | null,
  rest: Partial<RunEnd> = {},
): RunEnd => ({ status: "failed", errorCode, keyMode: "managed", ...rest });

describe("every terminal code has an outcome class", () => {
  // #494-T08
  it("classes the job end codes of the queue", () => {
    for (const code of JOB_ERROR_CODES)
      expect(OUTCOME_CLASSES, code).toContain(ERROR_CODE_CLASSES[code]);
  });

  // #494-T08
  it("classes the reasons a Dispatcher gives a job back, in the app and in the contract", () => {
    const listed = readContract().$defs.KnownReleaseReason?.enum ?? [];

    expect([LAUNCH_FAILED_CODE, WORKER_EXITED_CODE].sort()).toStrictEqual(
      [...listed].sort(),
    );
    for (const code of listed)
      expect(OUTCOME_CLASSES, String(code)).toContain(
        ERROR_CODE_CLASSES[code as keyof typeof ERROR_CODE_CLASSES],
      );
  });

  // #494-T08
  it("classes every error code of the runner contract", () => {
    const listed = readContract().$defs.KnownRunnerErrorCode?.enum ?? [];

    expect([...RUNNER_ERROR_CODES].sort()).toStrictEqual([...listed].sort());
    for (const code of listed)
      expect(OUTCOME_CLASSES, String(code)).toContain(
        ERROR_CODE_CLASSES[code as keyof typeof ERROR_CODE_CLASSES],
      );
  });

  // #494-T08
  it("classes every checkout reason of the runner contract", () => {
    const listed = readContract().$defs.KnownCheckoutReason?.enum ?? [];

    expect([...RUNNER_CHECKOUT_REASONS].sort()).toStrictEqual(
      [...listed].sort(),
    );
    for (const reason of listed)
      expect(OUTCOME_CLASSES, String(reason)).toContain(
        CHECKOUT_REASON_CLASSES[reason as keyof typeof CHECKOUT_REASON_CLASSES],
      );
  });

  // #494-T08
  it("classes every reason the loop of a runner gives for a run it had to end", () => {
    for (const reason of NO_RESULT_ERROR_REASONS)
      expect(OUTCOME_CLASSES, reason).toContain(
        RESULT_REASON_CLASSES[reason as keyof typeof RESULT_REASON_CLASSES],
      );
  });

  // #494-T08
  it("classes every settled reason of a usage record", () => {
    for (const reason of SETTLED_REASONS)
      expect(OUTCOME_CLASSES, reason).toContain(SETTLED_REASON_CLASSES[reason]);
  });

  // #494-T08
  it("keeps no entry in a table for a code that no list names", () => {
    const known = new Set<string>([
      ...JOB_ERROR_CODES,
      ...RUNNER_ERROR_CODES,
      ...CLAIM_FAILURE_CODES,
      ...CLAIM_RELEASE_REASONS,
      LAUNCH_FAILED_CODE,
      WORKER_EXITED_CODE,
    ]);
    for (const code of Object.keys(ERROR_CODE_CLASSES))
      expect(known.has(code), code).toBe(true);
    const reasons = new Set<string>(RUNNER_CHECKOUT_REASONS);
    for (const reason of Object.keys(CHECKOUT_REASON_CLASSES))
      expect(reasons.has(reason), reason).toBe(true);
    for (const code of OURS_ON_MANAGED_KEY)
      expect(Object.keys(ERROR_CODE_CLASSES), code).toContain(code);
  });
});

describe("the class of a run's end", () => {
  // The maintainer decided 2026-10-19 (#489, #523): free only when the failure is clearly our fault.
  // #523-T12
  // #498-T10
  it.each([
    ["launch_failed", "free"],
    ["worker_exited", "free"],
    ["lease_expired", "free"],
    ["lease_lost", "free"],
    ["runner_shutdown", "free"],
    ["dispatch_unavailable", "free"],
    ["dynamic_engine_unavailable", "free"],
    ["dynamic_isolation_self_check_failed", "free"],
    ["dynamic_accounting_failed", "free"],
    // #498 (the review of #525): raised for missing job options, missing model prices or an invalid operator environment,
    // before any model call: the operator's side. This test moved from `charged` with the spec.
    ["dynamic_config_invalid", "free"],
    // #498: a claim the balance or the unready billing refused. Nothing ran, so nothing is charged whatever the class.
    ["insufficient_balance", "free"],
    ["balance_negative", "free"],
    ["billing_rates_incomplete", "free"],
    ["billing_hold_released", "free"],
    ["monthly_limit_reached", "free"],
    ["reviews_paused", "free"],
    ["billing_limits_unreadable", "free"],
    ["runner_error", "free"],
    ["invalid_job", "free"],
    ["git_unavailable", "free"],
    ["llm_unavailable", "free"],
    // The maintainer's decision 1: "a timeout caused by us bills nothing". The queue's `timeout` and the runner's both
    // land in `jobs.error_code`; a 20-minute stall is never the size of the pull request (the review of #520, B1).
    ["timeout", "free"],
    ["llm_timeout", "free"],
  ] as Array<[string, OutcomeClass]>)(
    "bills nothing for %s, an error on our side",
    (code, expected) => {
      expect(classifyOutcome(failed(code))).toBe(expected);
    },
  );

  // #523-T01
  // #523-T02
  it.each([
    "review_not_published",
    "llm_output_invalid",
    "unknown",
    // The Git access can be the customer's revoked installation or our own App token: not clearly ours, so charged.
    "git_auth",
    "git_forbidden",
  ])("bills AI and minutes for %s, not clearly our fault", (code) => {
    expect(classifyOutcome(failed(code))).toBe("charged");
  });

  // #494-T01
  it.each([
    "dynamic_budget_exceeded",
    "dynamic_policy_violation",
    "checkout_incomplete",
    "pr_not_found",
    "git_unprocessable",
    "llm_context_length_exceeded",
    "review_text_truncated",
    "command_failed",
    "superseded",
  ])("bills AI and minutes for %s", (code) => {
    expect(classifyOutcome(failed(code))).toBe("charged");
  });

  // #494-T01
  it("bills a delivered result", () => {
    expect(
      classifyOutcome({ status: "succeeded", errorCode: null, keyMode: "own" }),
    ).toBe("charged");
  });

  // #523-T06
  it.each([
    "project_deactivated",
    "pull_request_closed",
    "pull_request_draft",
    "review_kind_changed",
    "command_removed",
  ])(
    "bills a job cancelled with %s in full (nothing when it never ran)",
    (code) => {
      expect(
        classifyOutcome({
          status: "cancelled",
          errorCode: code,
          keyMode: "own",
        }),
      ).toBe("charged");
    },
  );

  // #523-T12
  it("bills nothing for a job cancelled because no runner could take it: our side", () => {
    expect(
      classifyOutcome({
        status: "cancelled",
        errorCode: "no_capable_runner",
        keyMode: "own",
      }),
    ).toBe("free");
  });

  // #523-T07
  it.each(["workspace_suspended", "quota_exhausted"])(
    "bills a job refused at claim with %s in full: it never ran, so it costs nothing",
    (code) => {
      expect(classifyOutcome(failed(code))).toBe("charged");
    },
  );

  // #523-T12
  it.each(["entitlements_invalid", "dynamic_review_disabled"])(
    "bills nothing for a job refused at claim with %s, our configuration",
    (code) => {
      expect(classifyOutcome(failed(code))).toBe("free");
    },
  );

  // #523-T08
  it.each([
    "llm_auth",
    "llm_quota",
    "model_unknown",
    "llm_rate_limit",
    "llm_unavailable",
    "llm_timeout",
  ])(
    "makes %s ours on the managed key and the customer's on their own",
    (code) => {
      expect(classifyOutcome(failed(code, { keyMode: "managed" }))).toBe(
        "free",
      );
      expect(classifyOutcome(failed(code, { keyMode: "own" }))).toBe("charged");
    },
  );

  // #494-T07
  it("bills a superseded run that began: the table gives it AI and minutes", () => {
    expect(
      classifyOutcome({
        status: "superseded",
        errorCode: null,
        settledReason: "superseded",
        keyMode: "managed",
      }),
    ).toBe("charged");
    expect(
      classifyOutcome({
        status: "superseded",
        errorCode: null,
        settledReason: "superseded",
        keyMode: "own",
      }),
    ).toBe("charged");
  });

  // #523-T10
  it("bills a queued job superseded before it ran in full, which is nothing: no run began", () => {
    for (const keyMode of ["managed", "own"] as const)
      expect(
        classifyOutcome({
          status: "superseded",
          errorCode: null,
          keyMode,
        }),
      ).toBe("charged");
    expect(
      classifyOutcome({
        status: "superseded",
        errorCode: null,
        settledReason: null,
        keyMode: "managed",
      }),
    ).toBe("charged");
  });

  // #523-T05
  it("bills a run settled without a result in full, unless the failure is ours", () => {
    expect(
      classifyOutcome({
        status: "failed",
        errorCode: "llm_rate_limit",
        settledReason: "no_result",
        keyMode: "managed",
      }),
    ).toBe("free");
    expect(
      classifyOutcome(failed("command_failed", { settledReason: "no_result" })),
    ).toBe("charged");
  });

  // #494-T04
  it("keeps a timeout free whatever else is known: the cheapest class wins", () => {
    expect(
      classifyOutcome(
        failed("timeout", {
          errorReason: "no_result_from_process",
          settledReason: "no_result",
        }),
      ),
    ).toBe("free");
  });

  // #523-T05
  it("takes the reason of the loop into account: a process that left no usable result", () => {
    expect(
      classifyOutcome(
        failed("command_failed", { errorReason: "no_result_from_process" }),
      ),
    ).toBe("charged");
    expect(
      classifyOutcome(
        failed("runner_error", { errorReason: "unreadable_usage" }),
      ),
    ).toBe("free");
  });

  // #494-T06
  it.each([
    ["invalid_request", "free"],
    ["transport", "free"],
    ["isolation", "free"],
    // A checkout that was stopped (a cancelled or superseded run) is billed like the run.
    ["cancelled", "charged"],
    ["ref_missing", "charged"],
    ["diff_too_large", "charged"],
    ["path_invalid", "charged"],
  ] as Array<[string, OutcomeClass]>)(
    "refines a checkout that failed by its reason %s",
    (reason, expected) => {
      expect(
        classifyOutcome(failed("checkout_incomplete", { errorReason: reason })),
      ).toBe(expected);
    },
  );

  // #523-T03
  it("charges a code it does not know in full, and never throws", () => {
    expect(classifyOutcome(failed("a_code_of_a_newer_runner"))).toBe("charged");
    expect(classifyOutcome(failed(null))).toBe("charged");
  });

  // #523-T04
  it("charges a checkout reason it does not know in full, like a code", () => {
    expect(
      classifyOutcome(
        failed("checkout_incomplete", { errorReason: "a_new_reason" }),
      ),
    ).toBe("charged");
    // No reason at all leaves the class of the code.
    expect(classifyOutcome(failed("checkout_incomplete"))).toBe("charged");
  });

  // #494-T08
  it("applies a checkout reason only to a checkout failure", () => {
    expect(
      classifyOutcome(failed("command_failed", { errorReason: "transport" })),
    ).toBe("charged");
  });
});

describe("a job refused or handed back at claim (#553)", () => {
  // #577-L5
  it("has a class for every code of the claim, and a claim that refused a job bills nothing", () => {
    for (const code of [...CLAIM_FAILURE_CODES, ...CLAIM_RELEASE_REASONS])
      expect(Object.keys(ERROR_CODE_CLASSES), code).toContain(code);
    // Nothing ran: the model was not asked and no VM was kept. The codes that name the customer's side of the line
    // (a closed pull request, a missing one, the Dynamic settings) keep the class they were given in #523.
    for (const code of [
      "managed_model_unavailable",
      "llm_not_configured",
      "llm_provider_unsupported",
      // #588-T32
      "provider_address_changed",
      "job_llm_options_invalid",
      "job_args_invalid",
      "job_env_invalid",
      "git_connection_disabled",
      "git_connection_gone",
      "git_connection_suspended",
      "git_scope_refused",
      "git_app_auth_failed",
      "git_access_failed",
      "git_access_unavailable",
      "pull_request_unavailable",
      "claim_failed",
      "price_check_failed",
      // #588-T32
      "provider_pin_check_failed",
    ])
      expect(classifyOutcome(failed(code)), code).toBe("free");
  });

  // #577-L5
  it("is free on the own key too: it is the claim's refusal, not the model's", () => {
    expect(
      classifyOutcome(failed("managed_model_unavailable", { keyMode: "own" })),
    ).toBe("free");
  });
});

describe("the cost policy of a native job (#553)", () => {
  // #553-T08
  it("charges the minutes only for an own-key Dynamic run that delivered a review at its token cap or without a price", () => {
    for (const end of [
      { status: "succeeded", errorCode: null },
      failed("dynamic_budget_exceeded"),
    ] satisfies Array<Pick<RunEnd, "status" | "errorCode">>)
      expect(
        classifyOutcome({ ...end, keyMode: "own", aiCostKnown: false }),
      ).toBe("minutes_only");
  });

  // #553-T03
  it("treats a managed run that could not account for its cost as our fault, whatever else is known", () => {
    for (const aiCostKnown of [true, false, undefined])
      expect(
        classifyOutcome(
          failed("dynamic_accounting_failed", {
            keyMode: "managed",
            ...(aiCostKnown === undefined ? {} : { aiCostKnown }),
          }),
        ),
      ).toBe("free");
  });
});

describe("a run whose AI cost is unknown", () => {
  // #523-T11
  it("is charged the minutes only: the AI part cannot be priced", () => {
    expect(
      classifyOutcome({
        status: "succeeded",
        errorCode: null,
        keyMode: "managed",
        aiCostKnown: false,
      }),
    ).toBe("minutes_only");
    expect(
      classifyOutcome(failed("command_failed", { aiCostKnown: false })),
    ).toBe("minutes_only");
    expect(classifyOutcome(failed("a_new_code", { aiCostKnown: false }))).toBe(
      "minutes_only",
    );
  });

  // #523-T11
  it("stays free when the failure is ours, and charged when the cost is known or not stated", () => {
    expect(classifyOutcome(failed("timeout", { aiCostKnown: false }))).toBe(
      "free",
    );
    expect(classifyOutcome(failed("llm_auth", { aiCostKnown: false }))).toBe(
      "free",
    );
    expect(
      classifyOutcome(failed("command_failed", { aiCostKnown: true })),
    ).toBe("charged");
    expect(classifyOutcome(failed("command_failed"))).toBe("charged");
  });

  // #523-T14
  it("is the only way to the minutes only: no table entry gives that class", () => {
    const tables = [
      ERROR_CODE_CLASSES,
      CHECKOUT_REASON_CLASSES,
      RESULT_REASON_CLASSES,
      SETTLED_REASON_CLASSES,
    ];
    for (const table of tables)
      for (const [name, outcome] of Object.entries(table))
        expect(outcome, name).not.toBe("minutes_only");
  });
});

describe("the failures that incurred AI cost", () => {
  // They stay charged (AI and minutes), by the decision of 2026-10-19 (#489). This test pins who is in the group, so a
  // member does not join or leave unnoticed.
  // #523-T13
  it("names the group, in one place", () => {
    expect([...AI_COST_FAILURE_CODES].sort()).toStrictEqual([
      // #754: the Implementer's failures after the agent ran: it gave up, the repository refused its branch, the work left the
      // branch or could not be committed or verified, the turn ran out of time. The model was used in each; the cost limit of a
      // turn is `cost_limit_reached` below.
      "agent_gave_up",
      "branch_violation",
      "command_failed",
      // #666: a Diff Review stopped at the cost limit of its project.
      "cost_limit_reached",
      "dynamic_budget_exceeded",
      "dynamic_policy_violation",
      "llm_bad_request",
      "llm_context_length_exceeded",
      "push_rejected",
      "time_limit_reached",
    ]);
  });

  // #754-T09
  it("charges the failures of a turn after the agent ran, and nothing that ended before it", () => {
    for (const code of [
      "agent_gave_up",
      "push_rejected",
      "branch_violation",
      "time_limit_reached",
      "cost_limit_reached",
    ] as const)
      expect(AI_COST_FAILURE_CODES, code).toContain(code);
    for (const code of [
      "branch_exists",
      "base_branch_not_found",
      "clone_failed",
      "setup_failed",
      "git_write_not_granted",
      "implementer_engine_unavailable",
      "implementer_config_invalid",
    ] as const) {
      expect(AI_COST_FAILURE_CODES, code).not.toContain(code);
      expect(ERROR_CODE_CLASSES[code], code).toBe("free");
    }
  });

  // #523-T13
  it("gives every member the class of the group, on both keys", () => {
    for (const code of AI_COST_FAILURE_CODES) {
      expect(ERROR_CODE_CLASSES[code], code).toBe(AI_COST_FAILURE_CLASS);
      for (const keyMode of ["managed", "own"] as const)
        expect(classifyOutcome(failed(code, { keyMode })), code).toBe(
          AI_COST_FAILURE_CLASS,
        );
    }
  });
});
