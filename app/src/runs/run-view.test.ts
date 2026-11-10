// SPDX-License-Identifier: LicenseRef-Proprietary

import { describe, expect, it } from "vitest";
import type { JsonValue } from "../integrations/types.ts";
import type { Job } from "../jobs/job-types.ts";
import {
  cleanLog,
  MAX_LOG_CHARS,
  readStoredCallTrace,
  readStoredResult,
  readStoredUsage,
  safeGithubUrl,
  toCustomerRunDetailView,
  toRunDetailView,
  toRunRowView,
} from "./run-view.ts";
import { CHECKOUT_REASON_COPY, unknownErrorCopy } from "./error-copy.ts";
import { getProductIdentity } from "../product-identity/current.ts";

const PRODUCT = getProductIdentity();
const UNKNOWN_ERROR_COPY = unknownErrorCopy(PRODUCT);

const NOW = new Date("2026-10-10T12:10:00.000Z");

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
    workspaceId: "workspace-1",
    repositoryId: "repo-1",
    prNumber: 7,
    prUrl: "https://github.com/acme/widgets/pull/7",
    headSha: "a".repeat(40),
    reviewKind: "diff",
    command: "review",
    args: "",
    triggerKind: "webhook",
    actorLogin: "octocat",
    deliveryId: "delivery-1",
    status: "succeeded",
    runAfter: "2026-10-10T12:00:00.000Z",
    attempts: 0,
    runnerId: "runner-secret-name",
    claimedAt: "2026-10-10T12:00:10.000Z",
    heartbeatAt: "2026-10-10T12:00:40.000Z",
    leaseExpiresAt: "2026-10-10T12:02:40.000Z",
    result: null,
    errorCode: null,
    supersededBy: null,
    cancelRequestedAt: null,
    requiredLabels: null,
    createdAt: "2026-10-10T12:00:00.000Z",
    updatedAt: "2026-10-10T12:01:00.000Z",
    finishedAt: "2026-10-10T12:01:00.000Z",
    ...overrides,
  };
}

describe("the links of a run", () => {
  // CR-35-T14
  it("accepts an https address on github.com and nothing else", () => {
    expect(
      safeGithubUrl("https://github.com/acme/widgets/pull/7#issuecomment-1"),
    ).toBe("https://github.com/acme/widgets/pull/7#issuecomment-1");

    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://github.com/acme/widgets/pull/7",
      "https://evil.example/acme/widgets/pull/7",
      "https://github.com.evil.example/acme",
      "https://github.com.evil.com/acme/widgets/pull/7",
      "https://evilgithub.com/acme/widgets/pull/7",
      "https://notgithub.com/acme",
      "https://gist.github.com/acme",
      "https://www.github.com/acme",
      "https://evil.example/https://github.com/",
      "https://user:pw@github.com/acme",
      "https://github.com:8443/acme",
      "//github.com/acme",
      "github.com/acme",
      "",
      "x".repeat(3000),
      null,
      undefined,
      42,
    ]) {
      expect(safeGithubUrl(bad)).toBeNull();
    }
  });
});

describe("the log of a run", () => {
  // CR-35-T13
  it("removes terminal escapes and control characters but keeps text and line breaks", () => {
    const raw =
      "\u001b[31mred\u001b[0m line\r\nnext\tcolumn\u0007\u0000\n" +
      "\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007 <b>html</b> ‮evil";

    expect(cleanLog(raw)).toBe("red line\nnext\tcolumn\nlink <b>html</b> evil");
  });

  it("reads only the comment link, the log, the truncation flag and the reason of a stored result", () => {
    expect(
      readStoredResult({
        ok: true,
        commentUrl: "https://github.com/a/b/pull/1#c",
        logTail: "line",
        logTruncated: true,
        usage: { costUsd: 0.1 },
      }),
    ).toEqual({
      commentUrl: "https://github.com/a/b/pull/1#c",
      logTail: "line",
      logTruncated: true,
      errorReason: null,
    });
    for (const odd of [null, "text", 7, [], { logTail: 5, commentUrl: {} }]) {
      expect(readStoredResult(odd)).toEqual({
        commentUrl: null,
        logTail: "",
        logTruncated: false,
        errorReason: null,
      });
    }
  });
});

describe("the provider in the log of a run", () => {
  // A row stored before the result was masked on its way in keeps the provider's name in the log.
  const OLD_LOG =
    'litellm.NotFoundError: OpenrouterException - {"error":{"message":"OpenRouter: gone"}}\ncalling openrouter/some-model';

  // #435-T06
  it("is masked on the read path for a run on the operator's key, whatever was stored", () => {
    const stored = job({
      status: "failed",
      errorCode: "llm_error",
      result: { ok: false, commentUrl: null, logTail: OLD_LOG },
    });

    const detail = toRunDetailView(
      PRODUCT,
      stored,
      "acme/widgets",
      NOW,
      (text) => text,
      true,
    );

    expect(detail.log.text).toBe(
      'litellm.NotFoundError: [provider]Exception - {"error":{"message":"[provider]: gone"}}\ncalling [provider]/some-model',
    );
  });

  // #435-T06
  it("is left as the runner wrote it for a run on the workspace's own key", () => {
    const stored = job({
      status: "failed",
      errorCode: "llm_error",
      result: { ok: false, commentUrl: null, logTail: OLD_LOG },
    });

    const detail = toRunDetailView(PRODUCT, stored, "acme/widgets", NOW);

    expect(detail.log.text).toBe(OLD_LOG);
  });
});

describe("the problem of a Diff Review that stopped at its cost limit", () => {
  const failed = (stoppedEarly?: string) =>
    job({
      status: "failed",
      errorCode: "cost_limit_reached",
      result: {
        ok: false,
        commentUrl: null,
        logTail: "",
        usage: {
          model: "vendor/model",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          aiCalls: 2,
          fallbackUsed: false,
          costUsd: 0.16,
          ...(stoppedEarly === undefined ? {} : { stoppedEarly }),
        },
      },
    });

  // #689-T26
  it("names whose limit it was on the detail page, from the limit the runner reported", () => {
    expect(
      toRunDetailView(PRODUCT, failed("cost_limit"), "acme/widgets", NOW)
        .problem,
    ).toContain("maximum cost per review set by code-review.com");
    expect(
      toRunDetailView(
        PRODUCT,
        failed("project_cost_limit"),
        "acme/widgets",
        NOW,
      ).problem,
    ).toContain("Limits in the project settings");
  });

  // #689-T26
  it("is true for both limits where the runner did not say which, and in a list row", () => {
    const neutral = toRunDetailView(
      PRODUCT,
      failed(),
      "acme/widgets",
      NOW,
    ).problem;
    expect(neutral).toContain("code-review.com");
    expect(neutral).toContain("project");
    expect(
      toRunRowView(PRODUCT, failed("cost_limit"), "acme/widgets", NOW).problem,
    ).toBe(neutral);
  });
});

describe("the usage of a run", () => {
  const usage = {
    model: "vendor/dynamic-model",
    promptTokens: 12000,
    completionTokens: 900,
    totalTokens: 12900,
    aiCalls: 7,
    fallbackUsed: false,
    costUsd: 0.04,
  };

  // #201-T22
  it("reads the model, the summed tokens, the model calls and the cost of a stored result, and nothing else of it", () => {
    expect(readStoredUsage({ ok: true, usage })).toEqual({
      model: "vendor/dynamic-model",
      totalTokens: 12900,
      aiCalls: 7,
      costUsd: 0.04,
      stoppedEarly: null,
    });
  });

  // #856-T73
  it("reads that a turn ran through a subscription with its estimate at API prices, and no cost", () => {
    const subscription = {
      ...usage,
      costUsd: null,
      costBasis: "subscription",
      estimatedCostUsd: 0.42,
    };

    expect(readStoredUsage({ ok: true, usage: subscription })).toEqual({
      model: "vendor/dynamic-model",
      totalTokens: 12900,
      aiCalls: 7,
      costUsd: null,
      stoppedEarly: null,
      costBasis: "subscription",
      estimatedCostUsd: 0.42,
    });
  });

  // #856-T73
  it.each([null, -1, "0.4"])(
    "reads a subscription turn without a usable estimate as one without an estimate (%s)",
    (estimatedCostUsd) => {
      expect(
        readStoredUsage({
          ok: true,
          usage: {
            ...usage,
            costUsd: null,
            costBasis: "subscription",
            estimatedCostUsd,
          },
        }),
      ).toMatchObject({ costBasis: "subscription", estimatedCostUsd: null });
    },
  );

  // #856-T73
  it("does not read a billed cost as a subscription: a cost beside the basis is a cost, and the basis and estimate are left out", () => {
    expect(
      readStoredUsage({
        ok: true,
        usage: { ...usage, costBasis: "subscription", estimatedCostUsd: 0.42 },
      }),
    ).toEqual({
      model: "vendor/dynamic-model",
      totalTokens: 12900,
      aiCalls: 7,
      costUsd: 0.04,
      stoppedEarly: null,
    });
  });

  // #856-T73
  it("does not take a basis it does not know, nor the estimate that goes with it", () => {
    expect(
      readStoredUsage({
        ok: true,
        usage: { ...usage, costBasis: "metered", estimatedCostUsd: 3 },
      }),
    ).toEqual({
      model: "vendor/dynamic-model",
      totalTokens: 12900,
      aiCalls: 7,
      costUsd: 0.04,
      stoppedEarly: null,
    });
  });

  // #293-T08
  it.each(["cost_limit", "project_cost_limit", "time_limit"])(
    "reads that a run stopped early (%s), and takes any other value as a complete run",
    (stoppedEarly) => {
      expect(
        readStoredUsage({ ok: true, usage: { ...usage, stoppedEarly } }),
      ).toMatchObject({ stoppedEarly });
      expect(
        readStoredUsage({ ok: true, usage: { ...usage, stoppedEarly: "x" } }),
      ).toMatchObject({ stoppedEarly: null });
      expect(
        readStoredUsage({ ok: true, usage: { ...usage, stoppedEarly: 1 } }),
      ).toMatchObject({ stoppedEarly: null });
    },
  );

  // #201-T23
  it("keeps a cost the runner could not know as unknown instead of zero", () => {
    expect(
      readStoredUsage({ ok: true, usage: { ...usage, costUsd: null } }),
    ).toMatchObject({ costUsd: null });
  });

  // #201-T24
  it.each([
    ["no result", null],
    ["a result without usage", { ok: true }],
    ["usage null", { ok: true, usage: null }],
    ["usage of the wrong type", { ok: true, usage: "12900 tokens" }],
    [
      "tokens that are not a number",
      { ok: true, usage: { ...usage, totalTokens: "many" } },
    ],
    ["negative tokens", { ok: true, usage: { ...usage, totalTokens: -1 } }],
    [
      "a fractional call count",
      { ok: true, usage: { ...usage, aiCalls: 1.5 } },
    ],
    [
      "a cost that is not finite",
      { ok: true, usage: { ...usage, costUsd: Infinity } },
    ],
  ])("shows no usage for %s", (_name, stored) => {
    expect(readStoredUsage(stored)).toBeNull();
  });

  // #201-T25
  it("takes a model without a name as unknown and cleans one that has control characters", () => {
    expect(
      readStoredUsage({ ok: true, usage: { ...usage, model: null } }),
    ).toMatchObject({ model: null });
    expect(
      readStoredUsage({
        ok: true,
        usage: { ...usage, model: "vendor/\u001b[31mmodel\u0000" },
      }),
    ).toMatchObject({ model: "vendor/model" });
  });

  // #201-T32
  it("cuts a long model name on a whole character, never inside a surrogate pair", () => {
    const name = `${"a".repeat(199)}\u{1F600}${"b".repeat(5)}`;

    const model = readStoredUsage({
      ok: true,
      usage: { ...usage, model: name },
    })?.model;

    expect(model).toBe(`${"a".repeat(199)}\u{1F600}`);
    expect(model?.isWellFormed()).toBe(true);
  });

  // #201-T33
  it("keeps the model name within its limit after the redaction, on a whole character", () => {
    const stored = job({
      reviewKind: "dynamic",
      result: {
        ok: true,
        commentUrl: null,
        logTail: "",
        usage: { ...usage, model: `${"a".repeat(190)}SECRET` },
      },
    });

    const { model } = toRunDetailView(
      PRODUCT,
      stored,
      "acme/widgets",
      NOW,
      (text) => text.replace("SECRET", "\u{1F600}".repeat(30)),
    ).usage ?? { model: null };

    expect(Array.from(model ?? "").length).toBeLessThanOrEqual(200);
    expect(model?.isWellFormed()).toBe(true);
  });

  // #201-T26
  it("is in the detail of a run, redacted, and not in the row of the list", () => {
    const stored = job({
      reviewKind: "dynamic",
      result: { ok: true, commentUrl: null, logTail: "", usage },
    });

    const detail = toRunDetailView(
      PRODUCT,
      stored,
      "acme/widgets",
      NOW,
      (text) => text.replace("dynamic-model", "[redacted]"),
    );

    expect(detail.usage).toEqual({
      model: "vendor/[redacted]",
      totalTokens: 12900,
      aiCalls: 7,
      costUsd: 0.04,
      stoppedEarly: null,
    });
    expect(
      toRunRowView(PRODUCT, stored, "acme/widgets", NOW),
    ).not.toHaveProperty("usage");
  });
});

describe("the row of a run", () => {
  it("carries what the list shows and nothing of the lease", () => {
    const view = toRunRowView(PRODUCT, job(), "acme/widgets", NOW);

    expect(view).toEqual({
      id: "6b1f0a52-5f43-4a53-9d0e-8d4a0f1c2e11",
      repositoryId: "repo-1",
      project: "acme/widgets",
      prNumber: 7,
      prUrl: "https://github.com/acme/widgets/pull/7",
      command: "review",
      reviewKind: "diff",
      triggerKind: "webhook",
      trigger: "Automatic",
      status: "succeeded",
      createdAt: "2026-10-10T12:00:00.000Z",
      startedAt: "2026-10-10T12:00:10.000Z",
      finishedAt: "2026-10-10T12:01:00.000Z",
      durationMs: 50_000,
      problem: null,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain("runner-secret-name");
    expect(text).not.toContain("delivery-1");
  });

  // #200
  it("carries the review kind the run was queued for, in the list and in the detail", () => {
    const dynamic = job({ reviewKind: "dynamic" });

    expect(toRunRowView(PRODUCT, dynamic, "p", NOW).reviewKind).toBe("dynamic");
    expect(toRunDetailView(PRODUCT, dynamic, "p", NOW).reviewKind).toBe(
      "dynamic",
    );
  });

  // CR-35-T04
  it("names who started a run started by comment or by hand", () => {
    expect(
      toRunRowView(
        PRODUCT,
        job({ triggerKind: "comment", actorLogin: "alice" }),
        "p",
        NOW,
      ).trigger,
    ).toBe("Comment by alice");
    expect(
      toRunRowView(
        PRODUCT,
        job({ triggerKind: "manual", actorLogin: "bob" }),
        "p",
        NOW,
      ).trigger,
    ).toBe("Started by bob");
  });

  it("counts a running run up to the time of the answer and shows none for a waiting one", () => {
    expect(
      toRunRowView(
        PRODUCT,
        job({ status: "running", finishedAt: null }),
        "p",
        NOW,
      ).durationMs,
    ).toBe(590_000);
    expect(
      toRunRowView(
        PRODUCT,
        job({ status: "queued", claimedAt: null, finishedAt: null }),
        "p",
        NOW,
      ).durationMs,
    ).toBeNull();
  });

  it("explains why a failed or cancelled run did not succeed", () => {
    expect(
      toRunRowView(
        PRODUCT,
        job({ status: "failed", errorCode: "timeout" }),
        "p",
        NOW,
      ).problem,
    ).toBe("The run took longer than the time limit, so it was stopped.");
    expect(
      toRunRowView(
        PRODUCT,
        job({ status: "cancelled", errorCode: "project_deactivated" }),
        "p",
        NOW,
      ).problem,
    ).toContain("switched off");
    expect(
      toRunRowView(
        PRODUCT,
        job({ status: "failed", errorCode: null }),
        "p",
        NOW,
      ).problem,
    ).toBe("The run failed without saying why.");
    expect(
      toRunRowView(PRODUCT, job({ status: "succeeded" }), "p", NOW).problem,
    ).toBeNull();
  });

  it("links the pull request only when it is a github.com address, like the comment link", () => {
    for (const bad of [
      "javascript:alert(1)",
      "https://evil.example/acme/widgets/pull/7",
      "https://evilgithub.com/acme/widgets/pull/7",
      "http://github.com/acme/widgets/pull/7",
    ])
      expect(
        toRunRowView(PRODUCT, job({ prUrl: bad }), "p", NOW).prUrl,
      ).toBeNull();
    expect(
      toRunRowView(
        PRODUCT,
        job({ prUrl: "https://github.com/acme/widgets/pull/7" }),
        "p",
        NOW,
      ).prUrl,
    ).toBe("https://github.com/acme/widgets/pull/7");
  });
});

describe("the detail of a run", () => {
  const succeeded = job({
    result: {
      ok: true,
      commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
      logTail: "reviewed 3 files",
      logTruncated: false,
      usage: {
        model: "m",
        promptTokens: 11,
        completionTokens: 22,
        totalTokens: 33,
        aiCalls: 2,
        fallbackUsed: true,
        costUsd: 0.01,
      },
      errorMessage: null,
    },
  });

  // CR-35-T04
  it("holds pull request, command, trigger, times, comment link and log", () => {
    const view = toRunDetailView(PRODUCT, succeeded, "acme/widgets", NOW);

    expect(view).toMatchObject({
      prNumber: 7,
      command: "review",
      trigger: "Automatic",
      startedAt: "2026-10-10T12:00:10.000Z",
      finishedAt: "2026-10-10T12:01:00.000Z",
      durationMs: 50_000,
      commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
      commentMissing: false,
      log: { text: "reviewed 3 files", truncated: false },
      headSha: "a".repeat(40),
    });
  });

  // CR-35-T15
  it("does not carry the runner, the lease, the delivery or the rest of the stored result", () => {
    const text = JSON.stringify(
      toRunDetailView(PRODUCT, succeeded, "acme/widgets", NOW),
    );

    for (const secret of [
      "runner-secret-name",
      "delivery-1",
      "leaseExpiresAt",
      "heartbeat",
      // The usage is shown (#201), but only the four fields of `RunUsageView`: the rest of it stays.
      "promptTokens",
      "completionTokens",
      "fallbackUsed",
      "errorMessage",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  // CR-35-T14
  it("gives a run without a usable comment link no link", () => {
    for (const commentUrl of [
      "javascript:alert(1)",
      "https://evil.example/c",
      null,
    ]) {
      const view = toRunDetailView(
        PRODUCT,
        job({ result: { ok: true, commentUrl, logTail: "" } }),
        "p",
        NOW,
      );
      expect(view.commentUrl).toBeNull();
    }
  });

  it("says a succeeded run has no comment link, but not a failed one", () => {
    expect(
      toRunDetailView(
        PRODUCT,
        job({ result: { ok: true, commentUrl: null } }),
        "p",
        NOW,
      ).commentMissing,
    ).toBe(true);
    expect(
      toRunDetailView(
        PRODUCT,
        job({ status: "failed", errorCode: "timeout", result: null }),
        "p",
        NOW,
      ).commentMissing,
    ).toBe(false);
  });

  // CR-35-T10
  it("marks a shortened log and an empty one", () => {
    expect(
      toRunDetailView(
        PRODUCT,
        job({ result: { ok: true, logTail: "tail", logTruncated: true } }),
        "p",
        NOW,
      ).log,
    ).toEqual({ text: "tail", truncated: true });
    expect(
      toRunDetailView(PRODUCT, job({ result: null }), "p", NOW).log,
    ).toEqual({
      text: "",
      truncated: false,
    });
  });

  it("keeps the end of a log that is longer than the limit and says it was shortened", () => {
    const long = `${"a".repeat(MAX_LOG_CHARS)}END`;

    const { log } = toRunDetailView(
      PRODUCT,
      job({ result: { ok: true, logTail: long } }),
      "p",
      NOW,
    );

    expect(log.text).toHaveLength(MAX_LOG_CHARS);
    expect(log.text.endsWith("END")).toBe(true);
    expect(log.truncated).toBe(true);
  });

  it("hands the log to the redaction before it leaves", () => {
    const { log } = toRunDetailView(
      PRODUCT,
      job({ result: { ok: true, logTail: "key sk-live-123 used" } }),
      "p",
      NOW,
      (text) => text.replace("sk-live-123", "[redacted]"),
    );

    expect(log.text).toBe("key [redacted] used");
  });

  // #296-T11
  it("reads the checkout reason of a failed run from its stored result and explains it", () => {
    const view = toRunDetailView(
      PRODUCT,
      job({
        status: "failed",
        errorCode: "checkout_incomplete",
        result: {
          ok: false,
          errorCode: "checkout_incomplete",
          errorReason: "budget_preparation",
          logTail: "checkout_incomplete [budget_preparation]: not prepared",
        },
      }),
      "p",
      NOW,
    );

    expect(view.errorReason).toStrictEqual({
      code: "budget_preparation",
      text: CHECKOUT_REASON_COPY.budget_preparation,
      known: true,
    });
    expect(view.log.text).toContain("budget_preparation");
  });

  // #296-T11
  it("shows no reason for a run that has none, for a good run, or for a stored value that is no stable name", () => {
    expect(
      toRunDetailView(
        PRODUCT,
        job({ status: "failed", errorCode: "timeout", result: null }),
        "p",
        NOW,
      ).errorReason,
    ).toBeNull();
    expect(
      toRunDetailView(PRODUCT, succeeded, "p", NOW).errorReason,
    ).toBeNull();
    expect(
      toRunDetailView(
        PRODUCT,
        job({
          status: "failed",
          errorCode: "checkout_incomplete",
          result: { ok: false, errorReason: "<b>oops</b>", logTail: "" },
        }),
        "p",
        NOW,
      ).errorReason,
    ).toBeNull();
  });

  // CR-35-T09
  it("shows an unknown error code with the general sentence", () => {
    const view = toRunDetailView(
      PRODUCT,
      job({ status: "failed", errorCode: "brand_new_problem" }),
      "p",
      NOW,
    );

    expect(view.errorCode).toBe("brand_new_problem");
    expect(view.errorCodeKnown).toBe(false);
    expect(view.problem).toBe(UNKNOWN_ERROR_COPY);
  });

  // #499-T13
  it("carries no error code and no window for a run the hidden brake refused", () => {
    const refused = job({ status: "failed", errorCode: "reviews_paused" });
    const detail = toRunDetailView(PRODUCT, refused, "p", NOW);
    const row = toRunRowView(PRODUCT, refused, "p", NOW);

    expect(detail.errorCode).toBeNull();
    expect(detail.errorCodeKnown).toBe(true);
    expect(detail.problem).toMatch(/^Reviews are paused for this workspace/);
    expect(JSON.stringify([detail, row])).not.toMatch(/hourly|reviews_paused/i);
  });

  // CR-53-T01
  it.each([
    [
      "review_state_truncated",
      "The review was posted, but it grew past GitHub's comment size limit, so earlier findings are no longer tracked.",
    ],
    [
      "review_text_truncated",
      "The review was posted, but part of it was cut off because the comment reached GitHub's size limit.",
    ],
  ])(
    "explains %s in words and keeps the link to the review that was posted",
    (errorCode, sentence) => {
      const commentUrl =
        "https://github.com/acme/widgets/pull/7#issuecomment-9";
      const view = toRunDetailView(
        PRODUCT,
        job({
          status: "failed",
          errorCode,
          result: { ok: false, errorCode, commentUrl, logTail: "" },
        }),
        "p",
        NOW,
      );

      expect(view.status).toBe("failed");
      expect(view.problem).toBe(sentence);
      expect(view.errorCode).toBe(errorCode);
      expect(view.errorCodeKnown).toBe(true);
      expect(view.commentUrl).toBe(commentUrl);
      expect(view.commentMissing).toBe(false);
    },
  );

  // CR-53-T03
  it("shows no comment link for other failed runs, even if the stored result has one", () => {
    const view = toRunDetailView(
      PRODUCT,
      job({
        status: "failed",
        errorCode: "llm_auth",
        result: {
          ok: false,
          errorCode: "llm_auth",
          commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-9",
          logTail: "",
        },
      }),
      "p",
      NOW,
    );

    expect(view.commentUrl).toBeNull();
  });

  // CR-53-T03
  it("gives a truncated review whose link is not usable no link and no claim that it is missing", () => {
    const view = toRunDetailView(
      PRODUCT,
      job({
        status: "failed",
        errorCode: "review_state_truncated",
        result: { ok: false, commentUrl: null, logTail: "" },
      }),
      "p",
      NOW,
    );

    expect(view.commentUrl).toBeNull();
    expect(view.commentMissing).toBe(false);
  });

  it("keeps a question and a replaced run's successor", () => {
    const view = toRunDetailView(
      PRODUCT,
      job({
        command: "ask",
        args: "What does it do?\u001b[0m",
        status: "superseded",
        supersededBy: "next-job",
        claimedAt: null,
        finishedAt: null,
      }),
      "p",
      NOW,
    );

    expect(view.args).toBe("What does it do?");
    expect(view.supersededBy).toBe("next-job");
  });
});

// #541-T09, #541-T10
describe("the call trace of a run", () => {
  const modelCall = {
    index: 0,
    tMs: 1200,
    promptTokens: 14600,
    cacheRead: 0,
    cacheWrite: 14600,
    completionTokens: 492,
    costUsd: 0.0342,
    finishReason: "tool_calls",
    final: false,
    tools: [{ name: "read", count: 2 }],
  };
  const trace = {
    truncated: false,
    modelCalls: [modelCall, { ...modelCall, index: 1, costUsd: 0.01 }],
    toolCalls: [{ index: 0, name: "read", resultBytes: 812, isRepeat: false }],
  };
  const usage = {
    model: "vendor/dynamic-model",
    totalTokens: 12900,
    aiCalls: 2,
    costUsd: 0.04,
    stoppedEarly: null,
  };
  const stored = (callTrace: unknown): JsonValue =>
    ({
      ok: true,
      commentUrl: null,
      logTail: "",
      usage: { ...usage, callTrace },
    }) as JsonValue;

  it("is read from the stored result as it is", () => {
    expect(readStoredCallTrace(stored(trace))).toStrictEqual(trace);
  });

  it.each([
    ["no result", null],
    ["a result without usage", { ok: true }],
    ["a usage without a trace", { ok: true, usage }],
    ["a trace that is null", stored(null)],
    ["a trace that is a string", stored("trace")],
    ["a trace with an unknown key", stored({ ...trace, extra: 1 })],
    [
      "a trace with an entry of the wrong shape",
      stored({ ...trace, toolCalls: [{ index: 0, name: "read" }] }),
    ],
    [
      "a trace with a path in a call",
      stored({
        ...trace,
        toolCalls: [{ ...trace.toolCalls[0], path: "src/a.py" }],
      }),
    ],
    ["a result of the wrong type", "result"],
  ])("is no trace for %s", (_name, result) => {
    expect(readStoredCallTrace(result as never)).toBeNull();
  });

  it("is in the detail of a run and not in the row of the list", () => {
    const run = job({ reviewKind: "dynamic", result: stored(trace) });

    expect(toRunDetailView(PRODUCT, run, "p", NOW).callTrace).toStrictEqual(
      trace,
    );
    expect(toRunRowView(PRODUCT, run, "p", NOW)).not.toHaveProperty(
      "callTrace",
    );
  });

  it("is null in the detail of a run without one", () => {
    const run = job({ reviewKind: "dynamic", result: { ok: true } });

    expect(toRunDetailView(PRODUCT, run, "p", NOW).callTrace).toBeNull();
  });

  it("shows no cost per call for a run on the operator's key", () => {
    const run = job({ reviewKind: "dynamic", result: stored(trace) });

    const detail = toRunDetailView(
      PRODUCT,
      run,
      "p",
      NOW,
      (text) => text,
      true,
    );

    expect(detail.callTrace?.modelCalls.map((call) => call.costUsd)).toEqual([
      null,
      null,
    ]);
    expect(detail.callTrace?.modelCalls[0]?.promptTokens).toBe(14600);
    expect(detail.costHidden).toBe(true);
  });

  // #541-T10: whether a provider reports cache writes (and how many) says which provider it is.
  it("shows no cache counts per call for a run on the operator's key, and the tokens and the normalised ending stay", () => {
    const run = job({
      reviewKind: "dynamic",
      result: stored({
        ...trace,
        modelCalls: [{ ...modelCall, cacheRead: 123_457, cacheWrite: 765_431 }],
      }),
    });

    const own = toRunDetailView(PRODUCT, run, "p", NOW);
    const managed = toRunDetailView(
      PRODUCT,
      run,
      "p",
      NOW,
      (text) => text,
      true,
    );

    expect(own.callTrace?.modelCalls[0]).toMatchObject({
      cacheRead: 123_457,
      cacheWrite: 765_431,
    });
    expect(managed.callTrace?.modelCalls[0]).toMatchObject({
      cacheRead: null,
      cacheWrite: null,
      promptTokens: 14600,
      completionTokens: 492,
      finishReason: "tool_calls",
    });
    expect(JSON.stringify(managed)).not.toMatch(/123457|765431/);
  });

  // #541-T10: the ending is the protocol's normalised label, never a word a provider chose.
  it("reads no ending that is not a normalised label, also for a run on the operator's key", () => {
    const run = job({
      reviewKind: "dynamic",
      result: stored({
        ...trace,
        modelCalls: [{ ...modelCall, finishReason: "end_turn" }],
      }),
    });

    const managed = toRunDetailView(
      PRODUCT,
      run,
      "p",
      NOW,
      (text) => text,
      true,
    );

    expect(managed.callTrace).toBeNull();
    expect(JSON.stringify(managed)).not.toContain("end_turn");
  });
});

describe("the detail of a run for a member (#657)", () => {
  const OLD_COMMENT =
    "## Review\u001b[31m\n\ncalling openrouter/some-model with sk-secret-1234";
  const redact = (text: string) => text.replace(/sk-secret-\d+/, "[redacted]");

  // #657-T02
  it("is the detail of the admin without the log and the call trace", () => {
    const stored = job({ result: { ok: true, logTail: "log text" } });

    const member = toCustomerRunDetailView(
      PRODUCT,
      stored,
      "acme/widgets",
      NOW,
    );

    expect(member).not.toHaveProperty("log");
    expect(member).not.toHaveProperty("callTrace");
    expect(member.id).toBe(stored.id);
    expect(member.durationMs).toBe(50_000);
  });

  // #657-T04
  it("carries the review text cleaned like a log and redacted, and null for none", () => {
    const stored = job();

    expect(
      toCustomerRunDetailView(
        PRODUCT,
        stored,
        "p",
        NOW,
        redact,
        false,
        OLD_COMMENT,
      ).reviewText,
    ).toBe("## Review\n\ncalling openrouter/some-model with [redacted]");
    for (const none of [null, "", "  \n "])
      expect(
        toCustomerRunDetailView(PRODUCT, stored, "p", NOW, redact, false, none)
          .reviewText,
      ).toBeNull();
  });

  // #657-T04
  it("never names the provider in the review text of a run on the operator's key", () => {
    const view = toCustomerRunDetailView(
      PRODUCT,
      job(),
      "p",
      NOW,
      redact,
      true,
      "calling openrouter/some-model",
    );

    expect(view.reviewText).toBe("calling [provider]/some-model");
  });
});
