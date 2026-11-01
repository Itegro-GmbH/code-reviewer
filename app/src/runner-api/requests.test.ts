// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the checks on what a runner sends: the job id in the path, the runner id header and the
// bodies of heartbeat and complete. A refusal names fields and reasons, never the values.
import { describe, expect, it } from "vitest";
import {
  callerLlmProviders,
  parseClaimRequest,
  parseCompleteRequest,
  parseHeartbeatRequest,
  parseJobId,
  parseReleaseRequest,
  parseRunnerId,
  parseWorkerLlmProviders,
  parseWorkerResultRequest,
} from "./requests.ts";

const TOKEN = "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33";
const GOOD_RESULT = {
  ok: true,
  durationMs: 41250,
  commentUrl: "https://github.com/acme/widgets/pull/7#issuecomment-1001",
  errorCode: null,
  logTail: "review published",
  logTruncated: false,
  usage: {
    model: "vendor/model-name",
    promptTokens: 12000,
    completionTokens: 900,
    totalTokens: 12900,
    aiCalls: 2,
    fallbackUsed: false,
    costUsd: 0.04,
  },
};

function fieldsOf(result: ReturnType<typeof parseCompleteRequest>) {
  if (result.ok) throw new Error("expected a refusal");
  return result.fields;
}

describe("the job id in the path", () => {
  it("accepts a UUID", () => {
    expect(parseJobId("0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10")).toBe(true);
  });

  it.each([
    "",
    "abc",
    "0b9f6f4e",
    "../etc/passwd",
    "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b1g",
    " 0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10",
  ])("refuses %j", (id) => {
    expect(parseJobId(id)).toBe(false);
  });
});

describe("the runner id header", () => {
  it("passes a plain id through", () => {
    expect(parseRunnerId("runner-1.local:2")).toStrictEqual({
      ok: true,
      value: "runner-1.local:2",
    });
  });

  it("uses a fixed name for a request without the header", () => {
    expect(parseRunnerId(null)).toStrictEqual({ ok: true, value: "unknown" });
  });

  it.each([
    "",
    "   ",
    "a".repeat(65),
    "runner one",
    "runner\nid",
    "run;ner",
    "ünicode",
  ])("refuses %j, so nothing odd reaches the logs or the table", (id) => {
    expect(parseRunnerId(id).ok).toBe(false);
  });
});

describe("the heartbeat body", () => {
  it("accepts a lease token and ignores fields it does not know", () => {
    expect(
      parseHeartbeatRequest({ leaseToken: TOKEN, extra: 1 }),
    ).toStrictEqual({ ok: true, value: { leaseToken: TOKEN } });
  });

  it.each([
    ["not an object", "text"],
    ["null", null],
    ["an array", []],
    ["no token", {}],
    ["a token that is not text", { leaseToken: 5 }],
    ["a token that is too short", { leaseToken: "short" }],
    ["a token that is too long", { leaseToken: "x".repeat(257) }],
  ])("refuses %s", (_name, body) => {
    expect(parseHeartbeatRequest(body).ok).toBe(false);
  });
});

describe("the complete body", () => {
  it("accepts a successful result and fills in what was left out", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ok: true, durationMs: 5, errorCode: null, logTail: "" },
    });

    expect(parsed).toStrictEqual({
      ok: true,
      value: {
        leaseToken: TOKEN,
        result: {
          ok: true,
          durationMs: 5,
          commentUrl: null,
          errorCode: null,
          errorMessage: null,
          logTail: "",
          logTruncated: false,
          usage: null,
        },
      },
      dropped: [],
    });
  });

  it("keeps every field of a full result and drops fields it does not know", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, somethingNew: "x" },
    });

    expect(parsed.ok && parsed.value.result).toStrictEqual({
      ...GOOD_RESULT,
      errorMessage: null,
      usage: { ...GOOD_RESULT.usage, stoppedEarly: null },
    });
  });

  it("accepts a failed result with an error code and a message", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: {
        ok: false,
        durationMs: 10,
        errorCode: "llm_auth",
        errorMessage: "The key was refused.",
        logTail: "401",
      },
    });

    expect(parsed.ok && parsed.value.result.errorMessage).toBe(
      "The key was refused.",
    );
  });

  // #296-T10
  it("keeps the stable reason of a failure and leaves the field out when there is none", () => {
    const failed = {
      ok: false,
      durationMs: 10,
      errorCode: "checkout_incomplete",
      errorReason: "budget_preparation",
      logTail: "checkout_incomplete [budget_preparation]",
    };
    const parsed = parseCompleteRequest({ leaseToken: TOKEN, result: failed });

    expect(parsed.ok && parsed.value.result.errorReason).toBe(
      "budget_preparation",
    );
    const plain = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...failed, errorReason: undefined },
    });
    expect(plain.ok && "errorReason" in plain.value.result).toBe(false);
  });

  // #296-T10
  it.each(["Budget Prep", "", "../etc", 5, ["a"]])(
    "refuses a reason that is not a stable name (%j)",
    (errorReason) => {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ok: false,
          durationMs: 1,
          errorCode: "checkout_incomplete",
          errorReason,
          logTail: "",
        },
      });

      expect(fieldsOf(parsed)).toStrictEqual([
        { field: "result.errorReason", code: "invalid" },
      ]);
    },
  );

  // #296-T10
  it("refuses a reason that is longer than a stable name", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: {
        ok: false,
        durationMs: 1,
        errorCode: "checkout_incomplete",
        errorReason: "x".repeat(65),
        logTail: "",
      },
    });

    expect(fieldsOf(parsed)).toStrictEqual([
      { field: "result.errorReason", code: "too_long" },
    ]);
  });

  it("refuses a failed result without an error code and a good one with one", () => {
    const failed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, ok: false },
    });
    const good = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, errorCode: "timeout" },
    });

    expect(fieldsOf(failed)).toContainEqual({
      field: "result.errorCode",
      code: "invalid",
    });
    expect(fieldsOf(good)).toContainEqual({
      field: "result.errorCode",
      code: "invalid",
    });
  });

  it.each([
    ["a code in capitals", "TIMEOUT"],
    ["a code with a space", "time out"],
    ["a code that starts with a digit", "1abc"],
    ["a code that is too long", "a".repeat(65)],
  ])("refuses %s as an error code", (_name, code) => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, ok: false, errorCode: code },
    });

    expect(fieldsOf(parsed)).toContainEqual({
      field: "result.errorCode",
      code: "invalid",
    });
  });

  // #267-T07
  it("keeps the exact small cost of a Dynamic Review as the runner wrote it", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: {
        ...GOOD_RESULT,
        usage: { ...GOOD_RESULT.usage, costUsd: 5.79e-5 },
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.result.usage?.costUsd).toBe(5.79e-5);
    expect(parsed.value.result.usage?.costUsd).toBe(
      JSON.parse('{"costUsd":5.79e-05}').costUsd,
    );
  });

  // #293-T08
  it("keeps the reason a Dynamic Review stopped early, and null when it did not", () => {
    for (const stoppedEarly of [
      "cost_limit",
      "time_limit",
      // #553-R07
      "token_limit",
    ] as const) {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ...GOOD_RESULT,
          usage: { ...GOOD_RESULT.usage, stoppedEarly },
        },
      });

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.result.usage?.stoppedEarly).toBe(stoppedEarly);
    }
    const complete = parseCompleteRequest({
      leaseToken: TOKEN,
      result: GOOD_RESULT,
    });
    expect(complete.ok).toBe(true);
    if (!complete.ok) return;
    expect(complete.value.result.usage?.stoppedEarly).toBeNull();
  });

  // #293-T08
  it("refuses a reason for stopping early that the contract does not name", () => {
    for (const stoppedEarly of ["budget", "", 1, true, ["cost_limit"]]) {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ...GOOD_RESULT,
          usage: { ...GOOD_RESULT.usage, stoppedEarly },
        },
      });

      expect(fieldsOf(parsed)).toContainEqual({
        field: "result.usage.stoppedEarly",
        code: "invalid",
      });
    }
  });

  // #540-N4
  it("keeps by how much a Dynamic Review passed its cost limit, and nothing when it did not", () => {
    const over = parseCompleteRequest({
      leaseToken: TOKEN,
      result: {
        ...GOOD_RESULT,
        usage: { ...GOOD_RESULT.usage, limitExceededBy: 0.0123 },
      },
    });
    expect(over.ok).toBe(true);
    if (!over.ok) return;
    expect(over.value.result.usage?.limitExceededBy).toBe(0.0123);

    const within = parseCompleteRequest({
      leaseToken: TOKEN,
      result: GOOD_RESULT,
    });
    expect(within.ok).toBe(true);
    if (!within.ok) return;
    expect(within.value.result.usage).not.toHaveProperty("limitExceededBy");
  });

  // #540-N4
  it("refuses an excess over the cost limit that is not a finite number above zero", () => {
    for (const limitExceededBy of [
      0,
      -0.01,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "0.01",
      true,
      null,
    ]) {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ...GOOD_RESULT,
          usage: { ...GOOD_RESULT.usage, limitExceededBy },
        },
      });

      expect(fieldsOf(parsed)).toContainEqual({
        field: "result.usage.limitExceededBy",
        code: "invalid",
      });
    }
  });

  // #541-T07
  describe("the per-call trace of a Dynamic Review", () => {
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
    const toolCall = {
      index: 0,
      name: "read",
      resultBytes: 812,
      isRepeat: false,
    };
    const trace = {
      truncated: false,
      modelCalls: [modelCall],
      toolCalls: [toolCall],
    };
    const withTrace = (callTrace: unknown) =>
      parseCompleteRequest({
        leaseToken: TOKEN,
        result: { ...GOOD_RESULT, usage: { ...GOOD_RESULT.usage, callTrace } },
      });

    it("keeps a valid trace exactly as it was sent", () => {
      const parsed = withTrace(trace);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.result.usage?.callTrace).toStrictEqual(trace);
    });

    it("keeps the nulls of a call the provider reported nothing for", () => {
      const nulls = {
        ...modelCall,
        promptTokens: null,
        cacheRead: null,
        cacheWrite: null,
        completionTokens: null,
        costUsd: null,
        finishReason: null,
        tools: [],
      };
      const parsed = withTrace({
        truncated: true,
        modelCalls: [nulls],
        toolCalls: [{ ...toolCall, resultBytes: null }],
      });

      expect(parsed.ok).toBe(true);
    });

    it("leaves a usage without a trace as it was, with no trace key at all", () => {
      const absent = parseCompleteRequest({
        leaseToken: TOKEN,
        result: GOOD_RESULT,
      });

      expect(absent.ok).toBe(true);
      if (!absent.ok) return;
      expect(absent.value.result.usage).not.toHaveProperty("callTrace");
    });

    it.each([
      ["not an object", "trace"],
      ["null (it is left out, not null)", null],
      ["an unknown key", { ...trace, extra: 1 }],
      ["a missing key", { truncated: false, modelCalls: [] }],
      ["truncated not a boolean", { ...trace, truncated: "yes" }],
      [
        "101 model calls",
        { ...trace, modelCalls: Array.from({ length: 101 }, () => modelCall) },
      ],
      [
        "101 tool calls",
        { ...trace, toolCalls: Array.from({ length: 101 }, () => toolCall) },
      ],
      [
        "a call with an extra key",
        { ...trace, modelCalls: [{ ...modelCall, path: "src/a.py" }] },
      ],
      [
        "a call without a key",
        { ...trace, modelCalls: [{ ...modelCall, tools: undefined }] },
      ],
      [
        "a negative count",
        { ...trace, modelCalls: [{ ...modelCall, promptTokens: -1 }] },
      ],
      [
        "a fractional count",
        { ...trace, modelCalls: [{ ...modelCall, cacheRead: 1.5 }] },
      ],
      [
        "a negative cost",
        { ...trace, modelCalls: [{ ...modelCall, costUsd: -0.1 }] },
      ],
      [
        "an infinite cost",
        {
          ...trace,
          modelCalls: [{ ...modelCall, costUsd: Number.POSITIVE_INFINITY }],
        },
      ],
      [
        "an unknown finish reason",
        { ...trace, modelCalls: [{ ...modelCall, finishReason: "boom" }] },
      ],
      [
        "final not a boolean",
        { ...trace, modelCalls: [{ ...modelCall, final: 1 }] },
      ],
      [
        "an unknown tool",
        {
          ...trace,
          modelCalls: [{ ...modelCall, tools: [{ name: "bash", count: 1 }] }],
        },
      ],
      [
        "a tool count of zero",
        {
          ...trace,
          modelCalls: [{ ...modelCall, tools: [{ name: "read", count: 0 }] }],
        },
      ],
      [
        "an unknown tool call name",
        { ...trace, toolCalls: [{ ...toolCall, name: "webfetch" }] },
      ],
      [
        "a tool call with an argument",
        { ...trace, toolCalls: [{ ...toolCall, arguments: {} }] },
      ],
      [
        "isRepeat not a boolean",
        { ...trace, toolCalls: [{ ...toolCall, isRepeat: "no" }] },
      ],
      [
        "a negative result size",
        { ...trace, toolCalls: [{ ...toolCall, resultBytes: -1 }] },
      ],
    ])("drops %s and keeps the usage", (_name, callTrace) => {
      const parsed = withTrace(callTrace);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.result.usage).toMatchObject(GOOD_RESULT.usage);
      expect(parsed.value.result.usage).not.toHaveProperty("callTrace");
      expect(parsed.dropped).toEqual(["result.usage.callTrace"]);
    });

    // #541-T07: the trace is observability. A malformed one costs the trace, never the usage or the verdict.
    it("still refuses a usage whose own fields are invalid, trace or none", () => {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ...GOOD_RESULT,
          usage: { ...GOOD_RESULT.usage, promptTokens: -1, callTrace: trace },
        },
      });

      expect(fieldsOf(parsed)).toContainEqual({
        field: "result.usage.promptTokens",
        code: "invalid",
      });
    });

    it("says nothing was dropped for a valid trace and for none", () => {
      const valid = withTrace(trace);
      const absent = parseCompleteRequest({
        leaseToken: TOKEN,
        result: GOOD_RESULT,
      });

      expect(valid.ok && valid.dropped).toEqual([]);
      expect(absent.ok && absent.dropped).toEqual([]);
    });

    it("never repeats a value of the trace in the note of what was dropped", () => {
      const parsed = withTrace({ ...trace, extra: "SECRET-VALUE" });

      expect(JSON.stringify(parsed)).not.toContain("SECRET-VALUE");
    });

    it("drops the trace of the Worker's result the same way", () => {
      const parsed = parseWorkerResultRequest({
        result: {
          ...GOOD_RESULT,
          usage: { ...GOOD_RESULT.usage, callTrace: { ...trace, extra: 1 } },
        },
      });

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.result.usage).not.toHaveProperty("callTrace");
      expect(parsed.dropped).toEqual(["result.usage.callTrace"]);
    });
  });

  // #267-T07
  it("refuses a cost that is not a finite number of at least zero", () => {
    for (const costUsd of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      -0.01,
      "0.01",
      true,
    ]) {
      const parsed = parseCompleteRequest({
        leaseToken: TOKEN,
        result: {
          ...GOOD_RESULT,
          usage: { ...GOOD_RESULT.usage, costUsd },
        },
      });

      expect(fieldsOf(parsed)).toContainEqual({
        field: "result.usage.costUsd",
        code: "invalid",
      });
    }
  });

  it("names every field that is missing or wrong, once each, without echoing values", () => {
    const parsed = parseCompleteRequest({
      leaseToken: "short",
      result: {
        ok: "yes",
        durationMs: -1,
        errorCode: null,
        logTail: 5,
        usage: { model: 5 },
      },
    });

    const fields = fieldsOf(parsed);
    expect(fields).toContainEqual({ field: "leaseToken", code: "invalid" });
    expect(fields).toContainEqual({ field: "result.ok", code: "invalid" });
    expect(fields).toContainEqual({
      field: "result.durationMs",
      code: "invalid",
    });
    expect(fields).toContainEqual({ field: "result.logTail", code: "invalid" });
    expect(fields).toContainEqual({
      field: "result.usage.model",
      code: "invalid",
    });
    expect(fields).toContainEqual({
      field: "result.usage.promptTokens",
      code: "required",
    });
    expect(JSON.stringify(fields)).not.toContain("yes");
  });

  it("marks text over its limit as too long", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, logTail: "x".repeat(8193) },
    });

    expect(fieldsOf(parsed)).toContainEqual({
      field: "result.logTail",
      code: "too_long",
    });
  });

  it.each([
    ["no result", { leaseToken: TOKEN }],
    ["a result that is not an object", { leaseToken: TOKEN, result: "ok" }],
    ["no lease token", { result: GOOD_RESULT }],
  ])("refuses %s", (_name, body) => {
    expect(parseCompleteRequest(body).ok).toBe(false);
  });

  it("refuses a comment URL that is not a web address", () => {
    const parsed = parseCompleteRequest({
      leaseToken: TOKEN,
      result: { ...GOOD_RESULT, commentUrl: "javascript:alert(1)" },
    });

    expect(fieldsOf(parsed)).toContainEqual({
      field: "result.commentUrl",
      code: "invalid",
    });
  });
});

describe("the features of a claim (#279)", () => {
  // #279-T07
  it("keeps the features it knows and ignores the ones it does not", () => {
    expect(
      parseClaimRequest({
        engines: ["opencode"],
        features: ["a_future_feature", "dynamic_capabilities"],
      }),
    ).toEqual({
      ok: true,
      value: { engines: ["opencode"], features: ["dynamic_capabilities"] },
    });
  });

  // #279-T07: an old runner's claim has no features and reads the same as before.
  it("reads a claim without features exactly as before", () => {
    expect(parseClaimRequest({ engines: ["pr-agent"] })).toEqual({
      ok: true,
      value: { engines: ["pr-agent"] },
    });
    expect(parseClaimRequest({})).toEqual({ ok: true, value: {} });
  });

  it("refuses features that are not a list of plain names", () => {
    for (const features of ["dynamic_capabilities", [1], ["Bad Name"], {}]) {
      expect(parseClaimRequest({ features })).toEqual({
        ok: false,
        fields: [{ field: "features", code: "invalid" }],
      });
    }
  });
});

describe("the Dispatcher's fields of a claim (#322)", () => {
  const JOB = "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10";

  // #322-T12
  it("keeps a job id and a pool cap", () => {
    expect(
      parseClaimRequest({
        engines: ["pr-agent"],
        features: ["worker_credential"],
        jobId: JOB,
        maxRunning: 4,
      }),
    ).toEqual({
      ok: true,
      value: {
        engines: ["pr-agent"],
        features: ["worker_credential"],
        jobId: JOB,
        maxRunning: 4,
      },
    });
  });

  // #322-T12
  it("accepts the ends of the range of the cap", () => {
    for (const maxRunning of [1, 1000])
      expect(parseClaimRequest({ maxRunning })).toEqual({
        ok: true,
        value: { maxRunning },
      });
  });

  // #322-T12
  it.each([0, -1, 1001, 1.5, "4", null, true, [], {}, Number.NaN])(
    "refuses the pool cap %j",
    (maxRunning) => {
      expect(parseClaimRequest({ maxRunning })).toEqual({
        ok: false,
        fields: [{ field: "maxRunning", code: "invalid" }],
      });
    },
  );

  // #322-T12
  it.each(["", "abc", "../x", 7, null, JOB + "0", ` ${JOB}`, {}])(
    "refuses the job id %j",
    (jobId) => {
      expect(parseClaimRequest({ jobId })).toEqual({
        ok: false,
        fields: [{ field: "jobId", code: "invalid" }],
      });
    },
  );

  // #322-T12
  it("names every refused field, never its value", () => {
    const refused = parseClaimRequest({ jobId: "nope", maxRunning: 0 });

    expect(refused).toEqual({
      ok: false,
      fields: [
        { field: "jobId", code: "invalid" },
        { field: "maxRunning", code: "invalid" },
      ],
    });
    expect(JSON.stringify(refused)).not.toContain("nope");
  });

  // #322-T10: a claim of an old runner reads the same as before.
  it("adds nothing to a claim that names neither", () => {
    expect(parseClaimRequest({ engines: ["pr-agent"] })).toEqual({
      ok: true,
      value: { engines: ["pr-agent"] },
    });
  });
});

describe("the release body (#322)", () => {
  const CREDENTIAL = `crj_${"A".repeat(43)}`;

  // #322-T07
  it("reads a credential, a reason and a delay", () => {
    expect(
      parseReleaseRequest({
        credential: CREDENTIAL,
        reason: "launch_failed",
        retryAfterSeconds: 30,
      }),
    ).toEqual({
      ok: true,
      value: {
        credential: CREDENTIAL,
        reason: "launch_failed",
        retryAfterSeconds: 30,
      },
    });
  });

  // #322-T07
  it("does not need a delay, and ignores unknown fields", () => {
    expect(
      parseReleaseRequest({ credential: CREDENTIAL, reason: "x", more: 1 }),
    ).toEqual({ ok: true, value: { credential: CREDENTIAL, reason: "x" } });
  });

  // #322-T09
  it("refuses a body that is not an object, or lacks a credential or a reason", () => {
    expect(parseReleaseRequest("x")).toEqual({
      ok: false,
      fields: [{ field: "body", code: "invalid" }],
    });
    expect(parseReleaseRequest({})).toEqual({
      ok: false,
      fields: [
        { field: "credential", code: "required" },
        { field: "reason", code: "required" },
      ],
    });
  });

  // #322-T09
  it.each([
    ["not a credential", "lease-token-1234567"],
    ["too short", `crj_${"A".repeat(42)}`],
    ["a wrong character", `crj_${"A".repeat(42)}!`],
    ["with a suffix", `${CREDENTIAL}A`],
    ["a number", 5],
  ])("refuses a credential that is %s", (_name, credential) => {
    expect(parseReleaseRequest({ credential, reason: "x" })).toEqual({
      ok: false,
      fields: [{ field: "credential", code: "invalid" }],
    });
  });

  // #322-T07
  it.each(["", "Launch", "1abc", "has space", "a".repeat(65), 5])(
    "refuses the reason %j",
    (reason) => {
      const refused = parseReleaseRequest({ credential: CREDENTIAL, reason });
      expect(refused.ok).toBe(false);
      expect(JSON.stringify(refused)).not.toContain(CREDENTIAL);
    },
  );

  // #322-T07
  it.each([0, -1, 86401, 1.5, "30", null])(
    "refuses the delay %j",
    (retryAfterSeconds) => {
      expect(
        parseReleaseRequest({
          credential: CREDENTIAL,
          reason: "x",
          retryAfterSeconds,
        }),
      ).toEqual({
        ok: false,
        fields: [{ field: "retryAfterSeconds", code: "invalid" }],
      });
    },
  );
});

describe("the LLM providers a caller advertises (#424)", () => {
  // #424-T02
  it("reads a claim without the list exactly as before, and the absent list means OpenRouter", () => {
    expect(parseClaimRequest({ engines: ["pr-agent"] })).toEqual({
      ok: true,
      value: { engines: ["pr-agent"] },
    });
    expect(callerLlmProviders(undefined)).toEqual(["openrouter"]);
  });

  // #424-T02
  it("keeps the list a runner advertises, also a provider this app has no adapter for", () => {
    expect(
      parseClaimRequest({ llmProviders: ["openrouter", "a_future_provider"] }),
    ).toEqual({
      ok: true,
      value: { llmProviders: ["openrouter", "a_future_provider"] },
    });
    expect(callerLlmProviders(["a_future_provider"])).toEqual([
      "a_future_provider",
    ]);
  });

  // #424-T01
  it("refuses a list that is not a list of provider slugs, a duplicate, an empty or a long list", () => {
    for (const llmProviders of [
      "openrouter",
      [],
      [1],
      ["OpenRouter"],
      ["a"],
      ["a".repeat(33)],
      ["openrouter", "openrouter"],
      Array.from({ length: 17 }, (_, index) => `provider_${index}`),
      {},
      null,
    ]) {
      expect(parseClaimRequest({ llmProviders })).toEqual({
        ok: false,
        fields: [{ field: "llmProviders", code: "invalid" }],
      });
    }
  });

  // #424-T08
  it("reads the providers of the Worker's details call like the features: a comma separated list", () => {
    expect(parseWorkerLlmProviders(null)).toBeUndefined();
    expect(parseWorkerLlmProviders("openrouter")).toEqual(["openrouter"]);
    expect(parseWorkerLlmProviders("openrouter, a_future_provider ")).toEqual([
      "openrouter",
      "a_future_provider",
    ]);
  });

  // #424-T08: a malformed parameter is ignored like an unknown feature, it never fails the call.
  it("ignores names of the details call that are no slugs, and a list with none left is absent", () => {
    expect(parseWorkerLlmProviders("OpenRouter,openrouter,openrouter")).toEqual(
      ["openrouter"],
    );
    expect(parseWorkerLlmProviders("")).toBeUndefined();
    expect(parseWorkerLlmProviders("Bad Name,,a")).toBeUndefined();
  });
});

// #754: the result block of a turn of the Implementer (`result.implementer`, contracts/runner-api.v1.json `ImplementerResult`).
// The parser reads the block like the contract does; whether the job is a turn is decided with the job (`implementer-report.test.ts`).
describe("the implementer block of a result (#754)", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  const block = () => ({
    baseCommit: SHA_A,
    headCommit: SHA_B,
    pushed: true,
    commits: [{ sha: SHA_B, subject: "Add a health endpoint" }],
    filesChanged: [{ path: "src/health.ts", status: "added" }],
    summary: "Added a health endpoint.",
    opencode: { sessionId: "ses_1", version: "1.19.0" },
  });
  const bodyWith = (implementer: unknown) => ({
    leaseToken: TOKEN,
    result: { ...GOOD_RESULT, implementer },
  });

  // #754-T03
  it("keeps a valid block as it was sent, in a complete and in a Worker result", () => {
    const complete = parseCompleteRequest(bodyWith(block()));
    const worker = parseWorkerResultRequest({
      result: { ...GOOD_RESULT, implementer: block() },
    });

    expect(complete.ok && complete.value.result.implementer).toEqual(block());
    expect(worker.ok && worker.value.result.implementer).toEqual(block());
  });

  // #754-T03
  it("leaves the field out of a result that has none, and accepts a turn that made no commit", () => {
    const none = parseCompleteRequest({
      leaseToken: TOKEN,
      result: GOOD_RESULT,
    });
    const empty = parseCompleteRequest(
      bodyWith({
        ...block(),
        headCommit: null,
        pushed: false,
        commits: [],
        filesChanged: [],
        summary: "",
        opencode: null,
      }),
    );

    expect(none.ok && "implementer" in none.value.result).toBe(false);
    expect(empty.ok).toBe(true);
  });

  // #754-T03
  it.each<[string, (value: ReturnType<typeof block>) => unknown, string]>([
    [
      "a base commit that is not 40 hex digits",
      (b) => ({ ...b, baseCommit: "abc" }),
      "result.implementer.baseCommit",
    ],
    [
      "an upper case sha",
      (b) => ({ ...b, headCommit: "A".repeat(40) }),
      "result.implementer.headCommit",
    ],
    [
      "a head commit that is a number",
      (b) => ({ ...b, headCommit: 5 }),
      "result.implementer.headCommit",
    ],
    [
      "a pushed flag that is not a boolean",
      (b) => ({ ...b, pushed: "yes" }),
      "result.implementer.pushed",
    ],
    [
      "201 commits",
      (b) => ({
        ...b,
        commits: Array.from({ length: 201 }, () => b.commits[0]),
      }),
      "result.implementer.commits",
    ],
    [
      "a commit with a bad sha",
      (b) => ({ ...b, commits: [{ sha: "x", subject: "s" }] }),
      "result.implementer.commits[0].sha",
    ],
    [
      "a subject over 500 characters",
      (b) => ({ ...b, commits: [{ sha: SHA_B, subject: "s".repeat(501) }] }),
      "result.implementer.commits[0].subject",
    ],
    [
      "a commit with an unknown field",
      (b) => ({ ...b, commits: [{ sha: SHA_B, subject: "s", author: "x" }] }),
      "result.implementer.commits[0].author",
    ],
    [
      "501 files",
      (b) => ({
        ...b,
        filesChanged: Array.from({ length: 501 }, () => b.filesChanged[0]),
      }),
      "result.implementer.filesChanged",
    ],
    [
      "an empty path",
      (b) => ({ ...b, filesChanged: [{ path: "", status: "added" }] }),
      "result.implementer.filesChanged[0].path",
    ],
    [
      "a path over 4096 characters",
      (b) => ({
        ...b,
        filesChanged: [{ path: "p".repeat(4097), status: "added" }],
      }),
      "result.implementer.filesChanged[0].path",
    ],
    [
      "a file status the contract does not name",
      (b) => ({ ...b, filesChanged: [{ path: "a", status: "moved" }] }),
      "result.implementer.filesChanged[0].status",
    ],
    [
      "a summary over 8192 characters",
      (b) => ({ ...b, summary: "s".repeat(8193) }),
      "result.implementer.summary",
    ],
    [
      "a summary that is not text",
      (b) => ({ ...b, summary: null }),
      "result.implementer.summary",
    ],
    [
      "an OpenCode session without a version",
      (b) => ({ ...b, opencode: { sessionId: "ses_1" } }),
      "result.implementer.opencode.version",
    ],
    [
      "an OpenCode session id over 200 characters",
      (b) => ({ ...b, opencode: { sessionId: "s".repeat(201), version: "1" } }),
      "result.implementer.opencode.sessionId",
    ],
    [
      "a field the block does not have",
      (b) => ({ ...b, branch: "x" }),
      "result.implementer.branch",
    ],
    [
      "a missing summary",
      (b) =>
        Object.fromEntries(
          Object.entries(b).filter(([key]) => key !== "summary"),
        ),
      "result.implementer.summary",
    ],
    ["a block that is not an object", () => "pushed", "result.implementer"],
  ])(
    "refuses %s, naming the field and not its value",
    (_name, change, field) => {
      const parsed = parseCompleteRequest(bodyWith(change(block())));

      expect(fieldsOf(parsed).map((entry) => entry.field)).toContain(field);
    },
  );

  // #754-T03
  it("counts a text by characters, like the contract", () => {
    const parsed = parseCompleteRequest(
      bodyWith({ ...block(), summary: "😀".repeat(8192) }),
    );

    expect(parsed.ok).toBe(true);
  });

  // #754: a control character is no text: Postgres refuses a NUL in a text column, so the report would never be processed.
  it("strips control characters from the text and the free-form ids, and keeps tabs and line breaks", () => {
    const parsed = parseCompleteRequest(
      bodyWith({
        ...block(),
        summary: "Added\u0000 a\u001b health\tendpoint.\nDone\u007f.",
        commits: [{ sha: SHA_B, subject: "Add\u0000 it" }],
        filesChanged: [{ path: "src/\u0000health.ts", status: "added" }],
        opencode: { sessionId: "ses\u0000_1", version: "1.\u000019.0" },
      }),
    );

    expect(parsed.ok && parsed.value.result.implementer).toMatchObject({
      summary: "Added a health\tendpoint.\nDone.",
      commits: [{ subject: "Add it" }],
      filesChanged: [{ path: "src/health.ts" }],
      opencode: { sessionId: "ses_1", version: "1.19.0" },
    });
  });

  // #754: what is left of an id or a path after the strip has to be something.
  it.each([
    [
      "an OpenCode session id of NUL only",
      { opencode: { sessionId: "\u0000", version: "1" } },
      "result.implementer.opencode.sessionId",
    ],
    [
      "a version of NUL only",
      { opencode: { sessionId: "s", version: "\u0000\u0000" } },
      "result.implementer.opencode.version",
    ],
    [
      "a path of NUL only",
      { filesChanged: [{ path: "\u0000", status: "added" }] },
      "result.implementer.filesChanged[0].path",
    ],
  ])("refuses %s", (_name, change, field) => {
    expect(
      fieldsOf(parseCompleteRequest(bodyWith({ ...block(), ...change }))).map(
        (entry) => entry.field,
      ),
    ).toContain(field);
  });

  // #754: the invariants the contract states in words: `pushed` never without a head, and the head is the last commit.
  it.each([
    [
      "pushed without a head commit",
      { headCommit: null, pushed: true, commits: [], filesChanged: [] },
      "result.implementer.pushed",
    ],
    [
      "a head commit that is not the last commit listed",
      { headCommit: SHA_A },
      "result.implementer.headCommit",
    ],
    [
      "commits listed and no head commit",
      { headCommit: null, pushed: false },
      "result.implementer.headCommit",
    ],
  ])("refuses %s", (_name, change, field) => {
    expect(
      fieldsOf(parseCompleteRequest(bodyWith({ ...block(), ...change }))).map(
        (entry) => entry.field,
      ),
    ).toContain(field);
  });

  // #754
  it("accepts a head commit with no commits listed, and a head that was committed and not pushed", () => {
    expect(parseCompleteRequest(bodyWith({ ...block(), commits: [] })).ok).toBe(
      true,
    );
    expect(
      parseCompleteRequest(bodyWith({ ...block(), pushed: false })).ok,
    ).toBe(true);
  });

  // #754: the contract has no null for the block (only absent); the parser follows it.
  it("refuses a block that is null", () => {
    expect(
      fieldsOf(parseCompleteRequest(bodyWith(null))).map(
        (entry) => entry.field,
      ),
    ).toContain("result.implementer");
  });
});
