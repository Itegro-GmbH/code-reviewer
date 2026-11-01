// SPDX-License-Identifier: LicenseRef-Proprietary

// Pins down the agent mode of the fake LLM (fakes/llm): the answers the real, pinned OpenCode gets from the
// runner's model proxy in the Dynamic e2e lane (#253). The engine sends a chat completion that offers tools;
// the fake answers with the scripted tool calls one request at a time and, when they are used up, with the
// structured findings through the engine's `StructuredOutput` tool, exactly as the engine suite's scripted
// model does (runner/tests/engine/opencode_support.py). A request that offers no tool (the engine's title
// request) is answered with plain text. The journey relies on it, so a wrong fake fails here first.
import { describe, expect, it } from "vitest";
import { startLlmFake } from "../../../fakes/llm/server.ts";
import { cleanUpAfterTest } from "./test-database.ts";

async function setup() {
  const fake = await startLlmFake();
  cleanUpAfterTest(() => fake.close());
  return fake;
}

const TOOLS = [
  { type: "function", function: { name: "read" } },
  { type: "function", function: { name: "StructuredOutput" } },
];

type Message = Record<string, unknown>;
type Chunk = {
  choices: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        function: { name?: string; arguments: string };
        [key: string]: unknown;
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: Record<string, unknown>;
};

async function ask(
  baseUrl: string,
  messages: Message[],
  tools: unknown[] | null = TOOLS,
) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer the-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "vendor/agent-e2e",
      messages,
      ...(tools === null ? {} : { tools }),
    }),
  });
  return {
    status: response.status,
    json: (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
      usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    },
  };
}

const FINAL = { schemaVersion: 1, reviewedSha: "a".repeat(40), findings: [] };

describe("the agent mode of the fake LLM", () => {
  // #253-F04
  it("answers the requests that offer tools with the scripted calls in order, then with the structured answer", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [
        [{ name: "read", arguments: { filePath: "src/lookup.py" } }],
        [
          { name: "read", arguments: { filePath: "README.md" } },
          { name: "read", arguments: { filePath: "src/app.py" } },
        ],
      ],
      final: FINAL,
    });
    const conversation: Message[] = [{ role: "user", content: "review" }];

    const first = await ask(fake.baseUrl, conversation);
    const second = await ask(fake.baseUrl, conversation);
    const third = await ask(fake.baseUrl, conversation);
    const fourth = await ask(fake.baseUrl, conversation);

    const call = (answer: typeof first, index = 0) => {
      const found = answer.json.choices[0]?.message.tool_calls?.[index];
      return {
        name: found?.function.name,
        arguments: JSON.parse(found?.function.arguments ?? "null") as unknown,
      };
    };
    expect(first.json.choices[0]?.finish_reason).toBe("tool_calls");
    expect(call(first)).toEqual({
      name: "read",
      arguments: { filePath: "src/lookup.py" },
    });
    expect(call(second, 0).arguments).toEqual({ filePath: "README.md" });
    expect(call(second, 1).arguments).toEqual({ filePath: "src/app.py" });
    expect(call(third)).toEqual({ name: "StructuredOutput", arguments: FINAL });
    expect(call(fourth).name).toBe("StructuredOutput");
    // The ids differ, so the engine can tell the calls apart.
    const ids = [first, second, third].flatMap((answer) =>
      (answer.json.choices[0]?.message.tool_calls ?? []).map((item) => item.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  // #253-F04
  it("answers a request without tools with plain text and does not spend a step on it", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "a" } }]],
      final: FINAL,
    });

    const title = await ask(
      fake.baseUrl,
      [{ role: "user", content: "t" }],
      null,
    );
    const first = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);

    expect(title.json.choices[0]?.message.content).toBe("ok");
    expect(title.json.choices[0]?.message.tool_calls).toBeUndefined();
    expect(first.json.choices[0]?.message.tool_calls?.[0]?.function.name).toBe(
      "read",
    );
  });

  // #253-F05
  // #290: OpenRouter reports the charge of every call; a Dynamic run without it stops (fail closed).
  it("reports fixed token counts and a fixed cost, so a journey can check the usage the Runs page shows", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [], final: FINAL });

    const answer = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);

    expect(answer.json.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost: 0.0001,
    });
  });

  // #253-F05
  it("records the key, the offered tools and the tool results the engine sent back", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "src/lookup.py" } }]],
      final: FINAL,
    });
    await ask(fake.baseUrl, [{ role: "user", content: "review" }]);

    await ask(fake.baseUrl, [
      { role: "user", content: "review" },
      { role: "assistant", content: null, tool_calls: [] },
      { role: "tool", tool_call_id: "call_1", content: "def lookup(): ..." },
    ]);

    const [first, second] = fake.requests();
    expect(first?.authorization).toBe("Bearer the-key");
    expect(first?.tools).toEqual(["read", "StructuredOutput"]);
    expect(second?.toolResults).toEqual({ call_1: "def lookup(): ..." });
  });

  // #253-F05
  it("is switched off by reset and by null, and the canned reply of the PR-Agent tests is then back", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [], final: FINAL });
    fake.scriptAgent(null);

    const answer = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);

    expect(answer.json.choices[0]?.message.tool_calls).toBeUndefined();
    expect(answer.json.choices[0]?.message.content).toContain("review:");
    fake.scriptAgent({ steps: [], final: FINAL });
    fake.reset();
    const after = await ask(fake.baseUrl, [{ role: "user", content: "r" }]);
    expect(after.json.choices[0]?.message.tool_calls).toBeUndefined();
  });
});

// #766: the fake LLM plays a coding agent (the Implementer journey, #767): an end in plain text instead of
// `StructuredOutput`, answers chosen by the last user message, and the write tools of a coding agent as named calls.
describe("the fake LLM playing a coding agent", () => {
  const CODING_STEPS = [
    [
      { name: "write", arguments: { filePath: "a.txt", content: "one\n" } },
      {
        name: "edit",
        arguments: { filePath: "a.txt", oldString: "one", newString: "two" },
      },
    ],
    [{ name: "bash", arguments: { command: "git add -A && git commit -m x" } }],
  ];

  // #766-T05
  it("passes bash, write and edit with arbitrary arguments on as named tool calls, in order", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: CODING_STEPS, finalText: "Done." });
    const conversation: Message[] = [{ role: "user", content: "implement" }];

    const first = await ask(fake.baseUrl, conversation);
    const second = await ask(fake.baseUrl, conversation);

    const calls = (answer: typeof first) =>
      (answer.json.choices[0]?.message.tool_calls ?? []).map((call) => ({
        name: call.function.name,
        arguments: JSON.parse(call.function.arguments) as unknown,
      }));
    expect(calls(first)).toEqual(CODING_STEPS[0]);
    expect(calls(second)).toEqual(CODING_STEPS[1]);
    expect(first.json.choices[0]?.finish_reason).toBe("tool_calls");
  });

  // #766-T05
  it("ends with a plain assistant message when the steps are used up, for every later request", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: CODING_STEPS,
      finalText: "All changes are committed.",
    });
    const conversation: Message[] = [{ role: "user", content: "implement" }];
    await ask(fake.baseUrl, conversation);
    await ask(fake.baseUrl, conversation);

    const third = await ask(fake.baseUrl, conversation);
    const fourth = await ask(fake.baseUrl, conversation);

    for (const answer of [third, fourth]) {
      const message = answer.json.choices[0]?.message;
      expect(message?.content).toBe("All changes are committed.");
      expect(message?.tool_calls).toBeUndefined();
      expect(answer.json.choices[0]?.finish_reason).toBe("stop");
    }
  });

  // #766-T05
  it("ends with a plain assistant message in the Messages shape too", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [CODING_STEPS[1] ?? []], finalText: "Done." });
    const ask1 = async () => {
      const response = await fetch(`${fake.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": "dummy-key",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5-5",
          max_tokens: 1000,
          messages: [{ role: "user", content: "implement" }],
          tools: [
            {
              name: "bash",
              description: "d",
              input_schema: { type: "object" },
            },
          ],
        }),
      });
      return (await response.json()) as {
        stop_reason: string;
        content: Array<Record<string, unknown>>;
      };
    };

    const first = await ask1();
    const second = await ask1();

    expect(first.stop_reason).toBe("tool_use");
    expect(first.content).toMatchObject([{ type: "tool_use", name: "bash" }]);
    expect(second.stop_reason).toBe("end_turn");
    expect(second.content).toEqual([{ type: "text", text: "Done." }]);
  });

  // #766-T05
  it("chooses the script by the last user message and counts the steps of each script apart", async () => {
    const fake = await setup();
    fake.scriptAgent([
      {
        when: { lastUserContains: "commit your changes" },
        steps: [[{ name: "bash", arguments: { command: "git commit -am x" } }]],
        finalText: "Committed.",
      },
      { steps: CODING_STEPS, finalText: "Implemented." },
    ]);
    const work: Message[] = [{ role: "user", content: "implement the ticket" }];
    const wrapUp: Message[] = [
      ...work,
      { role: "assistant", content: "ok" },
      { role: "user", content: "Please commit your changes now." },
    ];

    const first = await ask(fake.baseUrl, work);
    const commit = await ask(fake.baseUrl, wrapUp);
    const second = await ask(fake.baseUrl, work);
    const committed = await ask(fake.baseUrl, [
      ...wrapUp,
      { role: "tool", tool_call_id: "call_1_0", content: "ok" },
    ]);
    const after = await ask(fake.baseUrl, wrapUp);

    const first0 = first.json.choices[0]?.message.tool_calls?.[0];
    expect(first0?.function.name).toBe("write");
    expect(
      commit.json.choices[0]?.message.tool_calls?.[0]?.function.arguments,
    ).toContain("git commit -am x");
    expect(second.json.choices[0]?.message.tool_calls?.[0]?.function.name).toBe(
      "bash",
    );
    // The tool result is not a user message: the last *user* message still says "commit your changes".
    expect(committed.json.choices[0]?.message.content).toBe("Committed.");
    expect(after.json.choices[0]?.message.content).toBe("Committed.");
    const ids = [first, commit, second].map(
      (answer) => answer.json.choices[0]?.message.tool_calls?.[0]?.id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  // #766-T05
  it("refuses a request that no script matches, so a mistaken script is seen at once", async () => {
    const fake = await setup();
    fake.scriptAgent([
      {
        when: { lastUserContains: "commit your changes" },
        steps: [],
        finalText: "Committed.",
      },
    ]);

    const answer = await ask(fake.baseUrl, [
      { role: "user", content: "implement" },
    ]);

    expect(answer.status).toBe(400);
  });

  // #766-T05
  it("leaves the Dynamic script as it was: StructuredOutput after the steps, no matcher needed", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [], final: FINAL });

    const answer = await ask(fake.baseUrl, [
      { role: "user", content: "review" },
    ]);

    const call = answer.json.choices[0]?.message.tool_calls?.[0];
    expect(call?.function.name).toBe("StructuredOutput");
    expect(JSON.parse(call?.function.arguments ?? "{}")).toEqual(FINAL);
  });

  // #767
  it("reports the chat usage a test sets, with the cost at one and four dollars per million tokens, until it is cleared", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [], finalText: "Done." });

    fake.setChatUsage({ promptTokens: 20_000, completionTokens: 100 });
    const set = await ask(fake.baseUrl, [{ role: "user", content: "go" }]);
    fake.setChatUsage(null);
    const cleared = await ask(fake.baseUrl, [{ role: "user", content: "go" }]);

    expect(set.json.usage).toMatchObject({
      prompt_tokens: 20_000,
      completion_tokens: 100,
      total_tokens: 20_100,
      cost: 0.0204,
    });
    expect(cleared.json.usage).toMatchObject({
      prompt_tokens: 100,
      completion_tokens: 50,
    });
  });

  // #767: found by the Implementer's journey in the privileged lane; the native path always streams, and the fake answered JSON.
  it("answers a request that asks for a stream with the stream of the same answer: tool call in pieces, finish, usage, [DONE]", async () => {
    const fake = await setup();
    fake.scriptAgent({
      steps: [[{ name: "read", arguments: { filePath: "a.txt" } }]],
      finalText: "All done.",
    });
    const stream = async () => {
      const response = await fetch(`${fake.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer the-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "vendor/agent-e2e",
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: "user", content: "go" }],
          tools: TOOLS,
        }),
      });
      const text = await response.text();
      return {
        type: response.headers.get("content-type"),
        text,
        events: text
          .split("\n\n")
          .filter((block) => block.startsWith("data: "))
          .map((block) => block.slice(6)),
      };
    };

    const first = await stream();
    const second = await stream();

    expect(first.type).toBe("text/event-stream");
    expect(first.events.at(-1)).toBe("[DONE]");
    const chunks = first.events
      .slice(0, -1)
      .map((event) => JSON.parse(event) as Chunk);
    const calls = chunks.flatMap(
      (chunk) => chunk.choices[0]?.delta?.tool_calls ?? [],
    );
    expect(calls[0]).toMatchObject({
      index: 0,
      type: "function",
      function: { name: "read" },
    });
    expect(
      calls
        .map(
          (call: { function: { arguments: string } }) =>
            call.function.arguments,
        )
        .join(""),
    ).toBe('{"filePath":"a.txt"}');
    expect(
      chunks.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]
        .finish_reason,
    ).toBe("tool_calls");
    expect(chunks.at(-1)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    // The closing text comes as content, with `stop`.
    const closing = second.events
      .slice(0, -1)
      .map((event) => JSON.parse(event) as Chunk);
    expect(
      closing.map((chunk) => chunk.choices[0]?.delta?.content).join(""),
    ).toBe("All done.");
    expect(
      closing.find((chunk) => chunk.choices[0]?.finish_reason)?.choices[0]
        .finish_reason,
    ).toBe("stop");
  });

  // #767
  it("keeps the usage it stated with the request in its log", async () => {
    const fake = await setup();
    fake.scriptAgent({ steps: [], finalText: "Done." });
    fake.setChatUsage({ promptTokens: 700, completionTokens: 30 });

    await ask(fake.baseUrl, [{ role: "user", content: "go" }]);

    expect(fake.requests()[0]?.usage).toMatchObject({
      prompt_tokens: 700,
      completion_tokens: 30,
    });
  });
});
