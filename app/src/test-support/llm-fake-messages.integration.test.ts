// SPDX-License-Identifier: LicenseRef-Proprietary

// #511-T28: the fake LLM (fakes/llm) speaks the Anthropic Messages API the way the Claude API does: the key in
// `x-api-key`, the version header, answers in the Messages shape with a usage of input, output and cache
// tokens, tool calls as `tool_use` blocks, errors in the error envelope. The runner's Diff and Dynamic paths
// and the Anthropic adapter rely on it, so a wrong fake fails here first.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "./test-database.ts";

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

async function messages(
  baseUrl: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { "x-api-key": "dummy-key" },
) {
  const response = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

type RuleCase = {
  id: string;
  steps: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
    answer?: Record<string, unknown>;
    status: number;
  }>;
};

// The table the Python fake answers too (runner/tests/unit/test_anthropic_strict_fake.py).
const RULE_CASES = (
  JSON.parse(
    readFileSync(
      new URL("../../../fakes/llm/anthropic-rule-cases.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: RuleCase[] }
).cases;

const REQUEST = {
  model: "claude-haiku-5-5",
  max_tokens: 1000,
  system: "you review",
  messages: [{ role: "user", content: "the diff" }],
};

describe("the fake LLM as the Anthropic Messages API", () => {
  // #511-T28
  it("answers a request with a message, a usage and the canned review, and records the request", async () => {
    const fake = await setup();

    const { status, json } = await messages(fake.baseUrl, REQUEST);

    expect(status).toBe(200);
    expect(json).toMatchObject({
      type: "message",
      role: "assistant",
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(
      (json.content as Array<{ type: string; text: string }>)[0]?.text,
    ).toContain("review:");
    expect(fake.messageRequests()).toEqual([
      { apiKey: "dummy-key", version: "2023-06-01", body: REQUEST },
    ]);
  });

  // #511-T28
  it("reports the usage a test sets, cache tokens included", async () => {
    const fake = await setup();
    fake.setMessagesUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 0,
      },
    });

    const { json } = await messages(fake.baseUrl, REQUEST);

    expect(json.usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
      cache_creation: {
        ephemeral_5m_input_tokens: 3,
        ephemeral_1h_input_tokens: 0,
      },
    });
  });

  // #511-T28
  it("answers no request without a key", async () => {
    const fake = await setup();

    const { status, json } = await messages(fake.baseUrl, REQUEST, {});

    expect(status).toBe(401);
    expect(json).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
  });

  // #511-T28
  it("answers the scripted errors in the error envelope, quoting the key when asked", async () => {
    const fake = await setup();
    fake.failWith({ status: 529, message: "Overloaded" });

    const { status, json } = await messages(fake.baseUrl, REQUEST);

    expect(status).toBe(529);
    expect(json).toEqual({
      type: "error",
      error: { type: "overloaded_error", message: "Overloaded" },
    });
  });

  // #511-T28
  it("gives a request that offers tools the scripted tool calls and then the structured answer", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { path: "a.py" } }]],
      final: { findings: [] },
    });
    const tools = [
      { name: "read", input_schema: { type: "object" } },
      { name: "StructuredOutput", input_schema: { type: "object" } },
    ];

    const first = await messages(fake.baseUrl, { ...REQUEST, tools });
    const second = await messages(fake.baseUrl, { ...REQUEST, tools });

    expect(first.json).toMatchObject({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "read", input: { path: "a.py" } }],
    });
    expect(second.json).toMatchObject({
      stop_reason: "tool_use",
      content: [
        { type: "tool_use", name: "StructuredOutput", input: { findings: [] } },
      ],
    });
  });

  // #511-T28
  it("checks a key with GET /models and does not mix it up with the other provider's key check", async () => {
    const fake = await setup();
    fake.acceptKeys(["good-key"]);

    const good = await fetch(`${fake.baseUrl}/models?limit=1`, {
      headers: { "x-api-key": "good-key", "anthropic-version": "2023-06-01" },
    });
    const bad = await fetch(`${fake.baseUrl}/models?limit=1`, {
      headers: { "x-api-key": "bad-key" },
    });
    const none = await fetch(`${fake.baseUrl}/models?limit=1`);

    expect([good.status, bad.status, none.status]).toEqual([200, 401, 401]);
    expect(fake.anthropicKeyChecks().map((check) => check.apiKey)).toEqual([
      "good-key",
      "bad-key",
      "",
    ]);
    expect(fake.keyChecks()).toEqual([]);
  });

  // #533-T14
  it.each(RULE_CASES.map((rule) => [rule.id, rule] as const))(
    "answers the status of the real API: %s",
    async (_id, rule) => {
      const fake = await setup();

      for (const step of rule.steps) {
        if (step.answer !== undefined) fake.queueMessagesAnswer(step.answer);
        const { status, json } = await messages(
          fake.baseUrl,
          step.body,
          step.headers,
        );

        expect(status, JSON.stringify(json)).toBe(step.status);
        if (status === 400)
          expect(json).toMatchObject({
            type: "error",
            error: { type: "invalid_request_error" },
          });
      }
    },
  );

  // #533-T14
  it("answers a scripted agent of a model that thinks with signed thinking blocks, and wants them back", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { path: "a.py" } }]],
      final: { findings: [] },
      thinking: true,
    });
    const tools = [
      { name: "read", input_schema: { type: "object" } },
      { name: "StructuredOutput", input_schema: { type: "object" } },
    ];
    const request = { ...REQUEST, model: "claude-sonnet-5-5", tools };

    const first = await messages(fake.baseUrl, request);
    const blocks = first.json.content as Array<{ type: string; id?: string }>;
    expect(blocks.map((block) => block.type)).toEqual(["thinking", "tool_use"]);
    const callId = blocks[1]?.id;
    const next = (assistant: unknown[]) => ({
      ...request,
      messages: [
        { role: "user", content: "the diff" },
        { role: "assistant", content: assistant },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: callId, content: "x" }],
        },
      ],
    });

    const dropped = await messages(
      fake.baseUrl,
      next([blocks[1] as unknown as Record<string, unknown>]),
    );
    const replayed = await messages(fake.baseUrl, next(blocks));

    expect(dropped.status).toBe(400);
    expect(replayed.status).toBe(200);
    expect(
      (replayed.json.content as Array<{ type: string }>).map(
        (block) => block.type,
      ),
    ).toEqual(["thinking", "tool_use"]);
  });

  // #533-T14
  it("reports the thinking tokens inside the output tokens when the script says so", async () => {
    const fake = await setup();
    fake.setMessagesUsage({
      input_tokens: 10,
      output_tokens: 90,
      output_tokens_details: { thinking_tokens: 60 },
    });

    const { json } = await messages(fake.baseUrl, REQUEST);

    expect(json.usage).toEqual({
      input_tokens: 10,
      output_tokens: 90,
      output_tokens_details: { thinking_tokens: 60 },
    });
  });

  // #755: found by the Implementer's journey in the privileged lane; its engine always streams, and the fake answered JSON.
  it("answers a request that asks for a stream with the stream of the same answer: message, blocks, stop reason with the output tokens", async () => {
    const fake = await setup();
    fake.scriptAgent({
      when: { lastUserContains: "the diff" },
      steps: [[{ name: "bash", arguments: { command: "echo one" } }]],
      finalText: "Done.",
    });
    fake.setMessagesUsage({
      input_tokens: 10,
      output_tokens: 90,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 200,
    });
    const ask = async () => {
      const response = await fetch(`${fake.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "dummy-key",
        },
        body: JSON.stringify({
          ...REQUEST,
          stream: true,
          tools: [{ name: "bash", input_schema: { type: "object" } }],
        }),
      });
      const text = await response.text();
      return {
        type: response.headers.get("content-type"),
        events: text
          .split("\n\n")
          .filter((chunk) => chunk !== "")
          .map((chunk) => ({
            name: /^event: (.*)$/m.exec(chunk)?.[1],
            data: JSON.parse(
              /^data: (.*)$/m.exec(chunk)?.[1] ?? "null",
            ) as Record<string, unknown>,
          })),
      };
    };

    const tool = await ask();
    const text = await ask();

    expect(tool.type).toBe("text/event-stream");
    expect(tool.events.map((event) => event.name)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(tool.events[0]?.data).toMatchObject({
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 200,
        },
      },
    });
    const arguments_ = tool.events
      .filter((event) => event.name === "content_block_delta")
      .map(
        (event) => (event.data.delta as { partial_json: string }).partial_json,
      )
      .join("");
    expect(JSON.parse(arguments_)).toEqual({ command: "echo one" });
    expect(tool.events.at(-2)?.data).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 90 },
    });
    expect(text.events.map((event) => event.name)).toContain("message_stop");
    expect(
      text.events.find((event) => event.name === "content_block_delta")?.data,
    ).toMatchObject({ delta: { type: "text_delta", text: "Done." } });
  });
});
