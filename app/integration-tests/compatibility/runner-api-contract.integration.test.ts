// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down that the app and contracts/runner-api.v1.json describe the same API: what the app really
// answers (through the real handler) is valid against the file, what the app accepts from a runner
// is exactly what the file allows, and the lists the app keeps in TypeScript (error codes, commands)
// are the lists of the file. The runner checks the same file in runner/tests/contract.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REVIEW_COMMANDS } from "../../src/integrations/types.ts";
import type { JobModelEntry } from "../../src/models-dev/job-entry.ts";
import { LLM_PROVIDERS } from "../../src/llm/config.ts";
import {
  LLM_PROVIDER_ID_PATTERN,
  RUNNER_API_ERROR_CODES,
  RUNNER_ENV_KEY_PATTERN,
  RUNNER_API_VERSION,
  RUNNER_CHECKOUT_REASONS,
  RUNNER_ERROR_CODES,
} from "../../src/runner-api/contract.ts";
import {
  parseClaimRequest,
  parseCompleteRequest,
  parseHeartbeatRequest,
} from "../../src/runner-api/requests.ts";
import {
  createContractValidator,
  readContract,
  readExamples,
} from "../../src/test-support/runner-contract.ts";
import {
  goodResult,
  startRunnerApiHarness,
} from "../../src/test-support/runner-api-harness.ts";

const contract = createContractValidator();
// The entry of a native job is the object of its own file (#578).
const entryValidator = createContractValidator("job-model-entry.v1.json");
const NATIVE_ENTRY: JobModelEntry = {
  version: 1,
  providerId: "deepseek",
  npm: "@ai-sdk/openai-compatible",
  family: "openai-chat",
  authHeader: "Authorization",
  upstreamBaseUrl: "https://api.deepseek.com",
  modelId: "deepseek-v4-pro",
  model: {
    name: "DeepSeek V4 Pro",
    status: "active",
    tool_call: true,
    reasoning: true,
    temperature: true,
    limit: { context: 1_000_000, output: 384_000 },
    modalities: { input: ["text"], output: ["text"] },
    interleaved: { field: "reasoning_content" },
  },
};

function expectValid(definition: string, document: unknown) {
  const { valid, errors } = contract.check(definition, document);
  expect({ valid, errors }).toStrictEqual({ valid: true, errors: "" });
}

describe("the contract file", () => {
  it("is version 1 and the app speaks version 1", () => {
    expect(readContract().version).toBe(1);
    expect(RUNNER_API_VERSION).toBe(1);
  });

  it("lists the same runner error codes as the app's TypeScript list", () => {
    const listed = readContract().$defs.KnownRunnerErrorCode?.enum;

    expect([...RUNNER_ERROR_CODES].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  // #296-T10
  it("lists the same checkout reasons as the app's TypeScript list", () => {
    const listed = readContract().$defs.KnownCheckoutReason?.enum;

    expect([...RUNNER_CHECKOUT_REASONS].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  it("lists the same error codes of the API as the app's TypeScript list", () => {
    const listed = readContract().$defs.ApiErrorCode?.enum;

    expect([...RUNNER_API_ERROR_CODES].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  // #424-T07
  it("lists the providers of the app's registry as the providers it knows", () => {
    const defs = readContract().$defs;

    expect([...LLM_PROVIDERS].sort()).toStrictEqual(
      [...(defs.KnownLlmProvider?.enum ?? [])].sort(),
    );
    expect(defs.LlmProviderId?.pattern).toBe(LLM_PROVIDER_ID_PATTERN.source);
    for (const provider of LLM_PROVIDERS)
      expect(provider).toMatch(LLM_PROVIDER_ID_PATTERN);
  });

  // #424-T01: `llm.provider` of a job is a slug, so the form decides in the contract and the
  // registry of the side that reads the job decides the rest.
  it.each([
    ["openrouter", true],
    ["a_future_provider", true],
    ["ab", true],
    ["a".repeat(32), true],
    ["a".repeat(33), false],
    ["a", false],
    ["OpenRouter", false],
    ["1abc", false],
    ["open-router", false],
    ["", false],
  ])(
    "judges the provider %j of a job like the slug form: %s",
    (provider, ok) => {
      const claim = structuredClone(
        readExamples().find((e) => e.definition === "ClaimResponse")?.document,
      ) as {
        job: { input: { llm: { provider: unknown } } };
      };
      claim.job.input.llm.provider = provider;

      expect(contract.check("ClaimResponse", claim).valid).toBe(ok);
      expect(LLM_PROVIDER_ID_PATTERN.test(provider)).toBe(ok);
    },
  );

  it("allows the commands the app can queue", () => {
    const listed = readContract().$defs.Command?.enum;

    expect([...REVIEW_COMMANDS].sort()).toStrictEqual(
      [...(listed ?? [])].sort(),
    );
  });

  it("allows the same environment variables as the app's pattern", () => {
    const schema = readContract().$defs.JobEnv as unknown as {
      propertyNames: { pattern: string };
    };

    expect(schema.propertyNames.pattern).toBe(RUNNER_ENV_KEY_PATTERN.source);
  });

  it.each(readExamples())(
    "has a valid example for $definition",
    ({ definition, document }) => {
      expectValid(definition, document);
    },
  );
});

describe("what the app answers", () => {
  // CR-28-T01, #203-T13
  it("answers a claim with a document that is valid against the contract, review only", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew({ prNumber: 7 });
    h.clock.advance(1000);
    await h.enqueueNew({
      prNumber: 8,
      headSha: "b".repeat(40),
      triggerKind: "comment",
    });

    const first = await h.claim();
    const second = await h.claim();

    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expectValid("ClaimResponse", firstBody);
    expect(Object.keys(firstBody.job.input.git).sort()).toStrictEqual([
      "baseUrl",
      "botLogin",
      "provider",
      "token",
    ]);
    expect(firstBody.job.input.git.token).toBe(h.issuedJobTokens()[0]);
    expect(typeof firstBody.job.input.prUrl).toBe("string");
    expect(typeof firstBody.job.leaseExpiresAt).toBe("string");
    expect(firstBody.job.input.command).toBe("review");
    expect(firstBody.job.input).not.toHaveProperty("args");
    expect(firstBody.job.input.env).toStrictEqual({});
    expect(firstBody.job.input.llm.model).toBe("vendor/test-model");
    expectValid("ClaimResponse", await second.json());
  });

  // CR-28-T02
  it("accepts a claim response that carries fields the contract does not know", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const body = await h.claimed();

    expectValid("ClaimResponse", {
      ...body,
      somethingNew: [1, 2],
      job: { ...body.job, priority: "high" },
    });
  });

  // CR-28-T03
  it("answers heartbeat and complete with documents that are valid against the contract", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const { job } = await h.claimed();

    expectValid(
      "HeartbeatResponse",
      await (await h.heartbeat(job.id, job.leaseToken)).json(),
    );
    const first = await h.complete(job.id, job.leaseToken);
    const repeated = await h.complete(job.id, job.leaseToken);
    expectValid("CompleteResponse", await first.json());
    expectValid("CompleteResponse", await repeated.json());
  });

  // CR-28-T03
  it("answers a shutdown report with the job back in the queue, valid against the contract", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const { job } = await h.claimed();

    const response = await h.complete(job.id, job.leaseToken, {
      ok: false,
      errorCode: "runner_shutdown",
    });

    const body = await response.json();
    expectValid("CompleteResponse", body);
    expect(body.job.status).toBe("queued");
  });

  // CR-28-T03
  it("answers no job with 204 and no body", async () => {
    const h = await startRunnerApiHarness();

    const response = await h.claim();

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  // CR-28-T03
  it("gives every error the same form with a stable code and a message", async () => {
    const h = await startRunnerApiHarness();
    await h.enqueueNew();
    const { job } = await h.claimed();
    h.fake.fail({ pathIncludes: "/access_tokens", status: 503, times: 1 });
    await h.enqueueNew({ prNumber: 8, headSha: "b".repeat(40) });
    const unknown = "11111111-2222-4333-8444-555555555555";
    await h.complete(job.id, job.leaseToken);

    const answers = [
      [401, await h.claim({ token: "wrong" })],
      [400, await h.claim({ runnerId: "bad id" })],
      [400, await h.heartbeat("nope", "lease-token-value")],
      [400, await h.post("complete", job.id, "{")],
      [404, await h.heartbeat(unknown, "lease-token-value")],
      [409, await h.heartbeat(job.id, job.leaseToken)],
      [
        409,
        await h.complete(job.id, job.leaseToken, {
          ok: false,
          errorCode: "timeout",
        }),
      ],
      [
        413,
        await h.complete(job.id, job.leaseToken, {
          logTail: "x".repeat(100_000),
        }),
      ],
      [503, await h.claim()],
    ] as const;

    for (const [status, response] of answers) {
      expect(response.status).toBe(status);
      const body = await response.json();
      expectValid("ErrorResponse", body);
      expect(body.error.code).toMatch(/^RUNNER_[A-Z_]+$/);
    }
  });
});

describe("what the app accepts from a runner", () => {
  const TOKEN = "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33";
  const result = goodResult();

  const HEARTBEATS: Array<[string, unknown]> = [
    ["a lease token", { leaseToken: TOKEN }],
    ["extra fields", { leaseToken: TOKEN, extra: { a: 1 } }],
    ["no lease token", {}],
    ["a number as lease token", { leaseToken: 12345678 }],
    ["a lease token that is too short", { leaseToken: "short" }],
    ["a lease token at the shortest length", { leaseToken: "12345678" }],
    ["a lease token at the longest length", { leaseToken: "x".repeat(256) }],
    ["a lease token that is too long", { leaseToken: "x".repeat(257) }],
    ["null", null],
    ["an array", [TOKEN]],
  ];

  const COMPLETES: Array<[string, unknown]> = [
    ["a full successful result", { leaseToken: TOKEN, result }],
    [
      "a result with only the required fields",
      {
        leaseToken: TOKEN,
        result: { ok: true, durationMs: 0, errorCode: null, logTail: "" },
      },
    ],
    [
      "a failed result",
      {
        leaseToken: TOKEN,
        result: goodResult({
          ok: false,
          errorCode: "llm_auth",
          errorMessage: "refused",
        }),
      },
    ],
    [
      "a failed result with a code the app does not list",
      {
        leaseToken: TOKEN,
        result: goodResult({ ok: false, errorCode: "brand_new_failure" }),
      },
    ],
    [
      "a failed result without a code",
      { leaseToken: TOKEN, result: goodResult({ ok: false, errorCode: null }) },
    ],
    [
      "a good result with a code",
      { leaseToken: TOKEN, result: goodResult({ errorCode: "timeout" }) },
    ],
    [
      "an error code in capitals",
      {
        leaseToken: TOKEN,
        result: goodResult({ ok: false, errorCode: "TIMEOUT" }),
      },
    ],
    ["no lease token", { result }],
    ["no result", { leaseToken: TOKEN }],
    ["a result that is not an object", { leaseToken: TOKEN, result: "ok" }],
    [
      "no ok flag",
      {
        leaseToken: TOKEN,
        result: { durationMs: 1, errorCode: null, logTail: "" },
      },
    ],
    [
      "ok as text",
      {
        leaseToken: TOKEN,
        result: goodResult({ ok: "true" as unknown as boolean }),
      },
    ],
    [
      "a negative duration",
      { leaseToken: TOKEN, result: goodResult({ durationMs: -1 }) },
    ],
    [
      "a duration with decimals",
      { leaseToken: TOKEN, result: goodResult({ durationMs: 1.5 }) },
    ],
    [
      "a duration over the limit",
      { leaseToken: TOKEN, result: goodResult({ durationMs: 604_800_001 }) },
    ],
    [
      "no log tail",
      {
        leaseToken: TOKEN,
        result: { ok: true, durationMs: 1, errorCode: null },
      },
    ],
    [
      "a log tail of the longest length",
      { leaseToken: TOKEN, result: goodResult({ logTail: "x".repeat(8192) }) },
    ],
    [
      "a log tail that is too long",
      { leaseToken: TOKEN, result: goodResult({ logTail: "x".repeat(8193) }) },
    ],
    [
      "a log tail of many characters outside the basic plane that is within the limit",
      { leaseToken: TOKEN, result: goodResult({ logTail: "😀".repeat(5000) }) },
    ],
    [
      "a comment URL that is not a web address",
      {
        leaseToken: TOKEN,
        result: goodResult({ commentUrl: "ftp://example.test/x" }),
      },
    ],
    [
      "no comment URL",
      { leaseToken: TOKEN, result: goodResult({ commentUrl: null }) },
    ],
    [
      "an error message that is too long",
      {
        leaseToken: TOKEN,
        result: goodResult({
          ok: false,
          errorCode: "timeout",
          errorMessage: "x".repeat(2001),
        }),
      },
    ],
    [
      "usage without a model",
      {
        leaseToken: TOKEN,
        result: { ...result, usage: { ...result.usage, model: undefined } },
      },
    ],
    [
      "usage with a null model and cost",
      {
        leaseToken: TOKEN,
        result: {
          ...result,
          usage: { ...result.usage, model: null, costUsd: null },
        },
      },
    ],
    // #293-T08: the reason a Dynamic Review was wrapped up, in the schema and in the parser.
    ...["cost_limit", "time_limit", null].map(
      (stoppedEarly): [string, unknown] => [
        `usage that stopped early with ${String(stoppedEarly)}`,
        {
          leaseToken: TOKEN,
          result: { ...result, usage: { ...result.usage, stoppedEarly } },
        },
      ],
    ),
    ...["budget", "", 1, true].map((stoppedEarly): [string, unknown] => [
      `usage that stopped early with ${JSON.stringify(stoppedEarly)}`,
      {
        leaseToken: TOKEN,
        result: { ...result, usage: { ...result.usage, stoppedEarly } },
      },
    ]),
    // #405-T30: the findings a successful review left open, in the schema and in the parser.
    ...[
      { open: 3, bySeverity: { P0: 1, P1: 0, P2: 2, P3: 0 } },
      { open: 2, bySeverity: null },
      { open: 0, bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 } },
      { open: 0, bySeverity: null, incomplete: true },
      { open: 1, bySeverity: null, incomplete: false },
      null,
    ].map((findings): [string, unknown] => [
      `findings ${JSON.stringify(findings)}`,
      { leaseToken: TOKEN, result: { ...result, findings } },
    ]),
    ...[
      { open: -1, bySeverity: null },
      { open: 1.5, bySeverity: null },
      { open: 1 },
      { bySeverity: null },
      { open: 1, bySeverity: { P0: 1, P1: 0, P2: 0 } },
      { open: 1, bySeverity: { P0: 1, P1: 0, P2: 0, P3: 0, P4: 0 } },
      { open: 1, bySeverity: { P0: -1, P1: 0, P2: 0, P3: 0 } },
      { open: 1, bySeverity: null, extra: true },
      { open: 1, bySeverity: null, incomplete: "yes" },
      { open: 1000001, bySeverity: null },
      "none",
      [],
    ].map((findings): [string, unknown] => [
      `findings that are not valid: ${JSON.stringify(findings)}`,
      { leaseToken: TOKEN, result: { ...result, findings } },
    ]),
    [
      "usage with a negative token count",
      {
        leaseToken: TOKEN,
        result: { ...result, usage: { ...result.usage, promptTokens: -1 } },
      },
    ],
    [
      "usage that is not an object",
      { leaseToken: TOKEN, result: { ...result, usage: "none" } },
    ],
    [
      "unknown fields in the result",
      { leaseToken: TOKEN, result: { ...result, extra: 1 } },
    ],
    ...callTraceCases(result, TOKEN),
    ...implementerCases(result, TOKEN),
  ];

  it.each(HEARTBEATS)(
    "judges %s of a heartbeat like the contract",
    (_name, body) => {
      expect(parseHeartbeatRequest(body).ok).toBe(
        contract.check("HeartbeatRequest", body).valid,
      );
    },
  );

  it.each(COMPLETES)(
    "judges %s of a complete like the contract",
    (_name, body) => {
      // The app accepts the result whole exactly when the contract does. Its one leniency is the call trace
      // (#541, observability): a malformed one is left out and the rest accepted, which is not "whole".
      const parsed = parseCompleteRequest(body);
      expect(parsed.ok && parsed.dropped.length === 0).toBe(
        contract.check("CompleteRequest", body).valid,
      );
    },
  );

  it("accepts the examples of the contract", () => {
    const examples = new Map(
      readExamples().map((example) => [example.definition, example.document]),
    );

    expect(parseHeartbeatRequest(examples.get("HeartbeatRequest")).ok).toBe(
      true,
    );
    expect(parseCompleteRequest(examples.get("CompleteRequest")).ok).toBe(true);
  });

  // #273-T07: the examples of a failed result with usage are valid, and the app reads them as the
  // runner sends them.
  it("accepts the examples of a failed result that carries the usage of its calls", () => {
    const examples = readContract().$defs.RunnerResult?.examples as Record<
      string,
      unknown
    >[];

    expect(examples.length).toBeGreaterThanOrEqual(2);
    for (const result of examples) {
      expect(result.ok).toBe(false);
      expect(contract.check("RunnerResult", result).valid).toBe(true);
      const body = {
        leaseToken: "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33",
        result,
      };
      expect(contract.check("CompleteRequest", body).valid).toBe(true);
      const parsed = parseCompleteRequest(body);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.result.usage).not.toBeNull();
    }
    expect(
      new Set(
        examples.map(
          (result) => (result.usage as { costUsd: unknown }).costUsd === null,
        ),
      ),
    ).toEqual(new Set([true, false]));
  });

  // #274-T07: the result of a Diff Review with its exact cost is valid in the schema and in the app,
  // and the app reads the cost as the runner printed it.
  it("accepts the exact cost of a Diff Review unchanged", () => {
    for (const costUsd of [0.6, 0.00037035, 0, null]) {
      const result = {
        ok: true,
        durationMs: 41200,
        commentUrl: "https://github.com/octo/repo/pull/7#issuecomment-1",
        errorCode: null,
        logTail: "",
        logTruncated: false,
        usage: {
          model: "openrouter/vendor/model-name",
          promptTokens: 3000,
          completionTokens: 450,
          totalTokens: 3450,
          aiCalls: 3,
          fallbackUsed: false,
          costUsd,
        },
      };
      const body = {
        leaseToken: "6f1d2c9a-5b3e-4a77-9c0d-8e2f1a4b7c33",
        result,
      };

      expect(contract.check("RunnerResult", result).valid).toBe(true);
      expect(contract.check("CompleteRequest", body).valid).toBe(true);
      const parsed = parseCompleteRequest(body);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.result.usage?.costUsd).toBe(costUsd);
    }
  });

  // #195-T06: the claim request is judged exactly like the contract. An absent body is the
  // previous-release caller and means pr-agent only; an empty or unknown or duplicated engine list is
  // refused before any job is claimed.
  it("judges the claim request like the contract", () => {
    const cases: Array<[string, unknown]> = [
      ["no engines", {}],
      ["both engines", { engines: ["pr-agent", "opencode"] }],
      ["the dynamic engine alone", { engines: ["opencode"] }],
      ["unknown fields next to engines", { engines: ["pr-agent"], extra: 1 }],
      ["an empty list", { engines: [] }],
      ["a duplicated engine", { engines: ["pr-agent", "pr-agent"] }],
      ["an unknown engine", { engines: ["gitlab"] }],
      ["engines as text", { engines: "pr-agent" }],
      ["null", null],
      ["an array", []],
      // #279-T07
      [
        "a feature next to the engines",
        { engines: ["opencode"], features: ["dynamic_capabilities"] },
      ],
      ["no features", { features: [] }],
      ["a feature this app does not know", { features: ["a_future_feature"] }],
      ["features as text", { features: "dynamic_capabilities" }],
      ["a feature that is no name", { features: [1] }],
      ["a feature with a bad name", { features: ["Bad Name"] }],
      ["too many features", { features: Array(17).fill("some_feature") }],
      // #424-T01, #424-T02
      [
        "the provider of a previous-release runner",
        { llmProviders: ["openrouter"] },
      ],
      ["two providers", { llmProviders: ["openrouter", "a_future_provider"] }],
      ["an empty provider list", { llmProviders: [] }],
      ["providers as text", { llmProviders: "openrouter" }],
      ["an uppercase provider", { llmProviders: ["OpenRouter"] }],
      ["a too short provider", { llmProviders: ["a"] }],
      ["a too long provider", { llmProviders: ["a".repeat(33)] }],
      ["a duplicated provider", { llmProviders: ["openrouter", "openrouter"] }],
      ["a provider that is no text", { llmProviders: [1] }],
      [
        "too many providers",
        {
          llmProviders: Array.from(
            { length: 17 },
            (_, index) => `provider_${index}`,
          ),
        },
      ],
      // #322-T12
      [
        "a job id and a cap",
        {
          engines: ["pr-agent"],
          features: ["worker_credential"],
          jobId: "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10",
          maxRunning: 4,
        },
      ],
      ["the lowest cap", { maxRunning: 1 }],
      ["the highest cap", { maxRunning: 1000 }],
      ["a cap of 0", { maxRunning: 0 }],
      ["a negative cap", { maxRunning: -1 }],
      ["a cap over 1000", { maxRunning: 1001 }],
      ["a cap that is no integer", { maxRunning: 2.5 }],
      ["a cap as text", { maxRunning: "4" }],
      ["a null cap", { maxRunning: null }],
      ["a job id that is no UUID", { jobId: "abc" }],
      ["a job id with a path in it", { jobId: "../etc/passwd" }],
      [
        "a job id with a suffix",
        { jobId: "0b9f6f4e-3c1a-4d9e-8f43-2a7d5e1c9b10x" },
      ],
      ["a job id as a number", { jobId: 7 }],
      ["a null job id", { jobId: null }],
    ];

    for (const [name, body] of cases)
      expect({ name, ok: parseClaimRequest(body).ok }).toEqual({
        name,
        ok: contract.check("ClaimRequest", body).valid,
      });
    // The absent body never reaches parseClaimRequest from JSON; the API maps it to pr-agent only.
    expect(parseClaimRequest(undefined)).toEqual({ ok: true, value: {} });
  });
});

// #279-T07: a Dynamic claim is valid with and without the model capabilities, and the real answer of
// the app with them is the shape of the file.
describe("the model capabilities of a Dynamic job", () => {
  const FIXTURES = new URL("../../../fakes/fixtures/", import.meta.url);
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<
      string,
      unknown
    >;

  it.each(["dynamic-review-job.json", "dynamic-review-job-capabilities.json"])(
    "accepts the golden Dynamic job %s",
    (name) => {
      expectValid("RunnerJobInput", read(name));
    },
  );

  it("refuses a capability object that is not closed or typed", () => {
    for (const change of [
      { command: "x" },
      { maxOutputTokens: 0 },
      { inputUsdPerMtok: 0.6 },
      { inputUsdPerMtok: "1e3" },
      { toolChoiceRequired: "yes" },
    ]) {
      const job = read("dynamic-review-job-capabilities.json") as {
        dynamic: { capabilities: Record<string, unknown> };
      };
      Object.assign(job.dynamic.capabilities, change);
      expect(contract.check("RunnerJobInput", job).valid).toBe(false);
    }
  });

  it("gives the real claim answer of the app the shape of the file", async () => {
    const h = await startRunnerApiHarness({
      projects: true,
      modelCapabilities: {
        check: async () => ({
          outcome: "supported",
          capabilities: {
            tools: true,
            toolChoice: true,
            toolChoiceRequired: true,
            responseFormat: true,
            structuredOutputs: true,
            maxCompletionTokens: 8192,
            smallestCompletionTokens: 8192,
            contextLength: 200_000,
            inputUsdPerMtok: "0.02016",
            outputUsdPerMtok: "0.891",
          },
        }),
      },
    });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });
    await h.enqueueNew();

    const claim = await h.claimed({
      engines: ["opencode"],
      features: ["dynamic_capabilities"],
    });

    expect(claim.job.input.dynamic?.capabilities).toBeDefined();
    expectValid("ClaimResponse", claim);
  });
});

// #553-T02: the cost policy of a native job. The examples are valid, the policy is closed and typed, and the type the app
// builds (`CostPolicyJson`) is what the file describes.
describe("the cost policy of a native job", () => {
  const FIXTURES = new URL("../../../fakes/fixtures/", import.meta.url);
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<
      string,
      unknown
    >;
  const costOf = (job: Record<string, unknown>) =>
    (job.dynamic as { cost: Record<string, unknown> }).cost;

  it.each([
    "dynamic-review-job-cost-managed.json",
    "dynamic-review-job-cost-own.json",
  ])("accepts the golden Dynamic job %s", (name) => {
    expectValid("RunnerJobInput", read(name));
  });

  it("refuses a policy that is not closed, typed and complete", () => {
    const changes: Array<[string, (cost: Record<string, unknown>) => void]> = [
      ["an unknown key", (cost) => Object.assign(cost, { command: "x" })],
      ["no key mode", (cost) => delete cost.keyMode],
      [
        "a bad key mode",
        (cost) => Object.assign(cost, { keyMode: "operator" }),
      ],
      ["no book key", (cost) => delete cost.priceBook],
      ["no cap key", (cost) => delete cost.maxTotalTokens],
      [
        "a cap as text",
        (cost) => Object.assign(cost, { maxTotalTokens: "4000000" }),
      ],
      ["a cap of zero", (cost) => Object.assign(cost, { maxTotalTokens: 0 })],
      [
        "a fractional cap",
        (cost) => Object.assign(cost, { maxTotalTokens: 1.5 }),
      ],
      [
        "a huge cap",
        (cost) => Object.assign(cost, { maxTotalTokens: 10 ** 12 }),
      ],
    ];
    for (const [name, change] of changes) {
      const job = read("dynamic-review-job-cost-own.json");
      change(costOf(job));
      expect({
        name,
        valid: contract.check("RunnerJobInput", job).valid,
      }).toEqual({
        name,
        valid: false,
      });
    }
  });

  it("refuses a managed policy without a book, with a cap, or with a book that is not exact", () => {
    const changes: Array<[string, (cost: Record<string, unknown>) => void]> = [
      ["no book", (cost) => Object.assign(cost, { priceBook: null })],
      ["a cap", (cost) => Object.assign(cost, { maxTotalTokens: 4_000_000 })],
      [
        "an amount as a number",
        (cost) => Object.assign(cost.priceBook as object, { input: 3 }),
      ],
      [
        "a decimal amount",
        (cost) => Object.assign(cost.priceBook as object, { input: "3.5" }),
      ],
      [
        "a negative amount",
        (cost) => Object.assign(cost.priceBook as object, { output: "-1" }),
      ],
      [
        "an unknown price",
        (cost) => Object.assign(cost.priceBook as object, { cacheBlend: "1" }),
      ],
      [
        "a tier without a size",
        (cost) =>
          Object.assign(cost.priceBook as object, {
            tiers: [{ input: "1", output: "2" }],
          }),
      ],
    ];
    for (const [name, change] of changes) {
      const job = read("dynamic-review-job-cost-managed.json");
      change(costOf(job));
      expect({
        name,
        valid: contract.check("RunnerJobInput", job).valid,
      }).toEqual({
        name,
        valid: false,
      });
    }
  });

  it("accepts an own policy with the catalog's price, tiers and a level that states fewer prices", () => {
    const job = read("dynamic-review-job-cost-own.json");
    Object.assign(costOf(job), {
      priceBook: {
        input: "3000000",
        output: "15000000",
        cacheRead: null,
        contextOver200k: { input: "6000000", output: "22500000" },
        tiers: [{ contextOver: 128000, input: "4000000", output: "16000000" }],
      },
    });
    expectValid("RunnerJobInput", job);
  });

  it("names the feature a runner says it enforces the policy with, and the reason a run may stop for", () => {
    const features = readContract().$defs.KnownClaimFeature?.enum ?? [];
    expect(features).toContain("dynamic_cost_policy");
    const usage = readContract().$defs.RunnerUsage as {
      properties: { stoppedEarly: { enum: Array<string | null> } };
    };
    expect(usage.properties.stoppedEarly.enum).toContain("token_limit");
  });

  it("gives the real claim answer of the app the shape of the file", async () => {
    const h = await startRunnerApiHarness({
      projects: true,
      nativeCost: {
        refOf: () => ({ providerId: "deepseek", modelId: "deepseek-v4-pro" }),
        policyFor: async () => ({
          ok: true,
          policy: {
            keyMode: "own",
            priceBook: null,
            maxTotalTokens: 4_000_000,
          },
          confirmation: null,
        }),
        entryFor: async () => ({ ok: true, entry: NATIVE_ENTRY }),
      },
    });
    await h.projectService.activateProject(h.repositoryId);
    await h.reviewSettings.updateProjectSettings(h.repositoryId, {
      reviewKind: "dynamic",
      dynamicModel: "vendor/dynamic-model",
    });
    await h.enqueueNew();

    const claim = await h.claimed({
      engines: ["opencode"],
      features: ["dynamic_capabilities", "dynamic_cost_policy"],
    });

    expect(claim.job.input.dynamic?.cost).toEqual({
      keyMode: "own",
      priceBook: null,
      maxTotalTokens: 4_000_000,
    });
    expect(claim.job.input.dynamic?.modelEntry).toEqual(NATIVE_ENTRY);
    expectValid("ClaimResponse", claim);
    // The entry is the object of its own file, which the file of the runner API does not repeat.
    expect(
      entryValidator.check(
        "JobModelEntry",
        claim.job.input.dynamic?.modelEntry,
      ),
    ).toEqual({ valid: true, errors: "" });
  });
});

// #578-T07: the entry of a native job. The runner API says only that it is an object that goes with the cost policy; the
// entry's own file says what it is, and every golden job is held against both.
describe("the model entry of a native job", () => {
  const FIXTURES = new URL("../../../fakes/fixtures/", import.meta.url);
  const read = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as Record<
      string,
      unknown
    >;
  const dynamicOf = (job: Record<string, unknown>) =>
    job.dynamic as Record<string, unknown>;

  it.each([
    "dynamic-review-job-native-managed.json",
    "dynamic-review-job-native-own.json",
  ])("accepts the golden native job %s and its entry", (name) => {
    const job = read(name);

    expectValid("RunnerJobInput", job);
    expect(
      entryValidator.check("JobModelEntry", dynamicOf(job).modelEntry),
    ).toEqual({ valid: true, errors: "" });
  });

  it.each([
    "dynamic-review-job.json",
    "dynamic-review-job-cost-managed.json",
    "dynamic-review-job-cost-own.json",
  ])("still accepts the job without an entry %s", (name) => {
    expectValid("RunnerJobInput", read(name));
  });

  it("refuses an entry without the cost policy it goes with", () => {
    const job = read("dynamic-review-job-native-own.json");
    delete dynamicOf(job).cost;

    expect(contract.check("RunnerJobInput", job).valid).toBe(false);
  });

  it("refuses an entry that is not an object, and the entry's file refuses one with a key", () => {
    const job = read("dynamic-review-job-native-own.json");
    dynamicOf(job).modelEntry = "anthropic";
    expect(contract.check("RunnerJobInput", job).valid).toBe(false);

    const entry = structuredClone(
      dynamicOf(read("dynamic-review-job-native-own.json")).modelEntry,
    ) as Record<string, unknown>;
    entry.apiKey = "sk-live-1";
    expect(entryValidator.check("JobModelEntry", entry).valid).toBe(false);
  });
});

// #541-T06: the per-call trace of a usage. The hand-written check of the app and the schema give the same
// verdict on each of these (the app then drops a malformed trace instead of refusing the result).
function callTraceCases(
  result: { usage: object | null },
  token: string,
): [string, unknown][] {
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
  const body = (callTrace: unknown): unknown => ({
    leaseToken: token,
    result: { ...result, usage: { ...(result.usage ?? {}), callTrace } },
  });
  const many = <T>(item: T, count: number): T[] =>
    Array.from({ length: count }, () => item);
  return [
    ["a usage with a call trace", body(trace)],
    ["a usage with a null call trace", body(null)],
    [
      "a call trace of nulls",
      body({
        truncated: true,
        modelCalls: [
          {
            ...modelCall,
            promptTokens: null,
            cacheRead: null,
            cacheWrite: null,
            completionTokens: null,
            costUsd: null,
            finishReason: null,
            tools: [],
          },
        ],
        toolCalls: [{ ...toolCall, resultBytes: null }],
      }),
    ],
    [
      "an empty call trace",
      body({ truncated: false, modelCalls: [], toolCalls: [] }),
    ],
    ["a call trace that is not an object", body("trace")],
    ["a call trace with an unknown key", body({ ...trace, extra: 1 })],
    ["a call trace without a key", body({ truncated: false, modelCalls: [] })],
    [
      "a call trace with 100 model calls",
      body({ ...trace, modelCalls: many(modelCall, 100) }),
    ],
    [
      "a call trace with 101 model calls",
      body({ ...trace, modelCalls: many(modelCall, 101) }),
    ],
    [
      "a call trace with 101 tool calls",
      body({ ...trace, toolCalls: many(toolCall, 101) }),
    ],
    [
      "a model call with an extra key",
      body({ ...trace, modelCalls: [{ ...modelCall, path: "src/a.py" }] }),
    ],
    [
      "a model call with a negative count",
      body({ ...trace, modelCalls: [{ ...modelCall, promptTokens: -1 }] }),
    ],
    [
      "a model call with a fractional count",
      body({ ...trace, modelCalls: [{ ...modelCall, cacheRead: 1.5 }] }),
    ],
    [
      "a model call with a negative cost",
      body({ ...trace, modelCalls: [{ ...modelCall, costUsd: -1 }] }),
    ],
    [
      "a model call with an unknown finish reason",
      body({ ...trace, modelCalls: [{ ...modelCall, finishReason: "boom" }] }),
    ],
    [
      "a model call with an unknown tool",
      body({
        ...trace,
        modelCalls: [{ ...modelCall, tools: [{ name: "bash", count: 1 }] }],
      }),
    ],
    [
      "a model call with a tool count of zero",
      body({
        ...trace,
        modelCalls: [{ ...modelCall, tools: [{ name: "read", count: 0 }] }],
      }),
    ],
    [
      "a tool call with an unknown name",
      body({ ...trace, toolCalls: [{ ...toolCall, name: "webfetch" }] }),
    ],
    [
      "a tool call with an argument",
      body({ ...trace, toolCalls: [{ ...toolCall, arguments: {} }] }),
    ],
    [
      "a tool call with a flag that is not a boolean",
      body({ ...trace, toolCalls: [{ ...toolCall, isRepeat: "no" }] }),
    ],
  ];
}

// #754: the implementer block of a result, judged by the app and the contract alike.
function implementerCases(result: object, token: string): [string, unknown][] {
  const sha = (letter: string) => letter.repeat(40);
  const block = {
    baseCommit: sha("a"),
    headCommit: sha("b"),
    pushed: true,
    commits: [{ sha: sha("b"), subject: "Add a health endpoint" }],
    filesChanged: [{ path: "src/health.ts", status: "added" }],
    summary: "Added a health endpoint.",
    opencode: { sessionId: "ses_1", version: "1.19.0" },
  };
  const body = (implementer: unknown) => ({
    leaseToken: token,
    result: { ...result, implementer },
  });
  const withoutSummary: Record<string, unknown> = { ...block };
  delete withoutSummary.summary;
  return [
    ["an implementer block", body(block)],
    [
      "an implementer block of a turn that made no commit",
      body({
        ...block,
        headCommit: null,
        pushed: false,
        commits: [],
        filesChanged: [],
        summary: "",
        opencode: null,
      }),
    ],
    [
      "an implementer block with a short sha",
      body({ ...block, baseCommit: "abc" }),
    ],
    [
      "an implementer block with 201 commits",
      body({
        ...block,
        commits: Array.from({ length: 201 }, () => block.commits[0]),
      }),
    ],
    [
      "an implementer block with 200 commits",
      body({
        ...block,
        commits: Array.from({ length: 200 }, () => block.commits[0]),
      }),
    ],
    [
      "an implementer block with 501 files",
      body({
        ...block,
        filesChanged: Array.from({ length: 501 }, () => block.filesChanged[0]),
      }),
    ],
    [
      "an implementer summary over its limit",
      body({ ...block, summary: "s".repeat(8193) }),
    ],
    [
      "an implementer block with a field it does not have",
      body({ ...block, branch: "x" }),
    ],
    ["an implementer block without a summary", body(withoutSummary)],
    [
      "an implementer file with an unknown status",
      body({ ...block, filesChanged: [{ path: "a", status: "moved" }] }),
    ],
    ["an implementer block that is a string", body("pushed")],
  ];
}
