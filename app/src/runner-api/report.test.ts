// SPDX-License-Identifier: LicenseRef-Proprietary

// What a job's result keeps of the model of a catalog entry when it ran on the operator's key (#432): the mechanics of
// the masking, below the claim and the completion that feed it.
import { describe, expect, it } from "vitest";
import { IDENTITIES } from "../product-identity/identities.ts";
import { errorCopy } from "../runs/error-copy.ts";
import { RUNNER_ERROR_CODES, type RunnerResult } from "./contract.ts";
import { mapRunnerErrorCode, withoutManagedModel } from "./report.ts";

function resultOf(overrides: Partial<RunnerResult> = {}): RunnerResult {
  return {
    ok: true,
    durationMs: 10,
    commentUrl: null,
    errorCode: null,
    errorMessage: null,
    logTail: "",
    logTruncated: false,
    usage: null,
    ...overrides,
  };
}

const USAGE = {
  model: "openrouter/vendor/entry-model",
  promptTokens: 10,
  completionTokens: 5,
  totalTokens: 15,
  aiCalls: 1,
  fallbackUsed: false,
  costUsd: 0.01,
  stoppedEarly: null,
};

describe("the result of a job on the operator's key", () => {
  // #432-T08
  it("masks an id at any length in the log and the error, even one the generic secret rule would ignore", () => {
    const masked = withoutManagedModel(
      resultOf({
        logTail: "model ab/c answered",
        errorMessage: "ab/c is busy",
      }),
      ["ab/c"],
      true,
    );

    expect(masked.logTail).toBe("model [model] answered");
    expect(masked.errorMessage).toBe("[model] is busy");
  });

  // #432-T08, #435-T06
  it("masks the id inside a provider-prefixed spelling, and the provider with it (ADR 0005: no log line a member reads names a provider)", () => {
    const masked = withoutManagedModel(
      resultOf({ logTail: "calling openrouter/vendor/entry-model now" }),
      ["vendor/entry-model"],
      true,
    );

    expect(masked.logTail).toBe("calling [provider]/[model] now");
  });

  // #435-T06
  it("masks the provider in any letter case, inside the name of an exception, in the log and the error", () => {
    const masked = withoutManagedModel(
      resultOf({
        logTail:
          'litellm.NotFoundError: NotFoundError: OpenrouterException - {"error":{"message":"OpenRouter: model gone"}}',
        errorMessage: "OPENROUTER said no (openrouter)",
      }),
      [],
      true,
    );

    expect(masked.logTail).toBe(
      'litellm.NotFoundError: NotFoundError: [provider]Exception - {"error":{"message":"[provider]: model gone"}}',
    );
    expect(masked.errorMessage).toBe("[provider] said no ([provider])");
  });

  // #435-T06
  it("leaves the provider in the text of a job that did not run on the operator's key", () => {
    const result = resultOf({ logTail: "OpenRouter answered" });

    expect(withoutManagedModel(result, [], false).logTail).toBe(
      "OpenRouter answered",
    );
  });

  // #432-T08
  it.each([
    ["ab/c", "https://github.com/ab/cats/pull/1#issuecomment-1"],
    [
      "acme/widget-reviews",
      "https://github.com/acme/widget-reviews/pull/1#issuecomment-1",
    ],
  ])(
    "leaves the link to the comment alone when the id %s also occurs in a repository name",
    (model, link) => {
      const masked = withoutManagedModel(
        resultOf({ commentUrl: link, logTail: `model ${model} answered` }),
        [model],
        true,
      );

      expect(masked.commentUrl).toBe(link);
      expect(masked.logTail).toBe("model [model] answered");
    },
  );

  // #432-T08
  it("reports no model of the usage and keeps its tokens and cost", () => {
    const masked = withoutManagedModel(resultOf({ usage: USAGE }), [], true);

    expect(masked.usage).toEqual({ ...USAGE, model: null });
  });

  // #432-T08
  it("leaves a result alone when the job did not run on the operator's key, whatever the text says", () => {
    const result = resultOf({
      logTail: "model vendor/entry-model answered",
      errorMessage: "vendor/entry-model is busy",
      usage: USAGE,
    });

    expect(withoutManagedModel(result, ["vendor/entry-model"], false)).toBe(
      result,
    );
  });
});

describe("the code a failed job is stored with (#754)", () => {
  // #754-T07
  it("keeps every code of the runner contract, the Implementer's included, and has a sentence for each", () => {
    for (const product of Object.values(IDENTITIES)) {
      const copy = errorCopy(product);
      for (const code of RUNNER_ERROR_CODES) {
        expect(mapRunnerErrorCode(code), code).toBe(code);
        expect(Object.hasOwn(copy, code), `${product.name}: ${code}`).toBe(
          true,
        );
      }
    }
  });

  // #754-T07
  it("stores a code the build does not know as unknown", () => {
    expect(mapRunnerErrorCode("brand_new_failure")).toBe("unknown");
  });
});
