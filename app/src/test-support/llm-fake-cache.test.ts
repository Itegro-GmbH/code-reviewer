// SPDX-License-Identifier: LicenseRef-Proprietary

// #539-T06: the fake LLM (fakes/llm) keeps the prompt cache rules of the Claude docs, the same ones as its Python twin
// (`anthropic_cache.py`): breakpoints, the model's minimum length, lifetimes that a read renews, the look-back of 20
// positions, and the 400 for what the API refuses. The runner's Diff and Dynamic tests and the Dynamic lane rely on it,
// so a wrong fake fails here first.
import { afterEach, describe, expect, it } from "vitest";
import {
  CacheRequestRejected,
  FIVE_MINUTES,
  LOOKBACK_POSITIONS,
  ONE_HOUR,
  PromptCache,
} from "../../../fakes/llm/anthropic-cache.ts";
import { startLlmFake, type FakeLlm } from "../../../fakes/llm/server.ts";

const MARK = { type: "ephemeral" };
const MODEL = "claude-sonnet-5";

function text(label: string, size = 6000): string {
  return `${label} ${"x".repeat(size)}`;
}

function block(
  label: string,
  size = 6000,
  extra: Record<string, unknown> = {},
) {
  return { type: "text", text: text(label, size), ...extra };
}

function request(
  turns: Array<Array<Record<string, unknown>>>,
  extra: Record<string, unknown> = {},
) {
  return {
    model: MODEL,
    max_tokens: 1000,
    messages: turns.map((content, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content,
    })),
    ...extra,
  };
}

function clock() {
  const state = { now: 1000 };
  return { state, read: () => state.now };
}

describe("the prompt cache of the fake LLM", () => {
  it("writes a marked prefix once and reads it for the next request", () => {
    const cache = new PromptCache(clock().read);
    const first = cache.usage(
      request([[block("task", 6000, { cache_control: MARK })]]),
      50,
    );
    expect(first.cache_read_input_tokens).toBe(0);
    expect(first.cache_creation_input_tokens).toBeGreaterThan(1024);
    expect(first.input_tokens).toBe(0);
    expect(first.cache_creation.ephemeral_5m_input_tokens).toBe(
      first.cache_creation_input_tokens,
    );

    const second = cache.usage(
      request([
        [block("task", 6000, { cache_control: MARK })],
        [block("answer")],
        [block("next")],
      ]),
      50,
    );
    expect(second.cache_read_input_tokens).toBe(
      first.cache_creation_input_tokens,
    );
    expect(second.cache_creation_input_tokens).toBe(0);
    expect(second.input_tokens).toBeGreaterThan(0);
  });

  it("does not read a prefix that differs before the mark", () => {
    const cache = new PromptCache(clock().read);
    cache.usage(
      request([[block("task one", 6000, { cache_control: MARK })]]),
      50,
    );
    const other = cache.usage(
      request([[block("task two", 6000, { cache_control: MARK })]]),
      50,
    );
    expect(other.cache_read_input_tokens).toBe(0);
    expect(other.cache_creation_input_tokens).toBeGreaterThan(0);
  });

  it("does not cache a prompt below the minimum of the model and says no error", () => {
    const small = request([[block("task", 100, { cache_control: MARK })]]);
    const usage = new PromptCache(clock().read).usage(small, 50);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.input_tokens).toBeGreaterThan(0);

    const body = request([[block("task", 5000, { cache_control: MARK })]]);
    expect(
      new PromptCache(clock().read).usage(
        { ...body, model: "claude-sonnet-5" },
        50,
      ).cache_creation_input_tokens,
    ).toBeGreaterThan(0);
    expect(
      new PromptCache(clock().read).usage(
        { ...body, model: "claude-opus-4-6" },
        50,
      ).cache_creation_input_tokens,
    ).toBe(0);
  });

  it("lets an entry live five minutes and renews it with every read", () => {
    const time = clock();
    const cache = new PromptCache(time.read);
    const body = request([[block("task", 6000, { cache_control: MARK })]]);
    cache.usage(body, 50);
    time.state.now += FIVE_MINUTES - 1;
    expect(cache.usage(body, 50).cache_read_input_tokens).toBeGreaterThan(0);
    time.state.now += FIVE_MINUTES - 1;
    expect(cache.usage(body, 50).cache_read_input_tokens).toBeGreaterThan(0);
    time.state.now += FIVE_MINUTES + 1;
    const expired = cache.usage(body, 50);
    expect(expired.cache_read_input_tokens).toBe(0);
    expect(expired.cache_creation_input_tokens).toBeGreaterThan(0);
  });

  it("keeps a one hour entry past five minutes and reports it in its own split", () => {
    const time = clock();
    const cache = new PromptCache(time.read);
    const body = request([
      [
        block("task", 6000, {
          cache_control: { type: "ephemeral", ttl: "1h" },
        }),
      ],
    ]);
    const written = cache.usage(body, 50);
    expect(written.cache_creation.ephemeral_1h_input_tokens).toBeGreaterThan(0);
    expect(written.cache_creation.ephemeral_5m_input_tokens).toBe(0);
    time.state.now += ONE_HOUR - 1;
    expect(cache.usage(body, 50).cache_read_input_tokens).toBeGreaterThan(0);
  });

  it("looks back at most twenty positions for an entry", () => {
    const cache = new PromptCache(clock().read);
    cache.usage(request([[block("task", 6000, { cache_control: MARK })]]), 50);
    const unmarked = [block("task")];
    const turns = (count: number) =>
      Array.from({ length: count }, (_, index) => [
        block(`turn ${String(index)}`, 50),
      ]);
    const near = request([
      unmarked,
      ...turns(LOOKBACK_POSITIONS - 2),
      [block("head", 6000, { cache_control: MARK })],
    ]);
    expect(
      new PromptCache(clock().read).usage(near, 50).cache_read_input_tokens,
    ).toBe(0);
    expect(cache.usage(near, 50).cache_read_input_tokens).toBeGreaterThan(0);
    const far = request([
      unmarked,
      ...turns(LOOKBACK_POSITIONS + 2),
      [block("head", 6000, { cache_control: MARK })],
    ]);
    expect(cache.usage(far, 50).cache_read_input_tokens).toBe(0);
  });

  it("counts a run of tool results as one position", () => {
    const cache = new PromptCache(clock().read);
    cache.usage(request([[block("task", 6000, { cache_control: MARK })]]), 50);
    const calls = Array.from(
      { length: LOOKBACK_POSITIONS * 2 },
      (_, index) => ({
        type: "tool_use",
        id: `t${String(index)}`,
        name: "read",
        input: {},
      }),
    );
    const results: Array<Record<string, unknown>> = Array.from(
      { length: LOOKBACK_POSITIONS * 2 },
      (_, index) => ({
        type: "tool_result",
        tool_use_id: `t${String(index)}`,
        content: "x",
      }),
    );
    results[results.length - 1] = { ...results.at(-1), cache_control: MARK };
    const body = request([[block("task")], calls, results]);
    expect(cache.usage(body, 50).cache_read_input_tokens).toBeGreaterThan(0);
  });

  it("marks the last block for a top-level cache_control", () => {
    const cache = new PromptCache(clock().read);
    const first = cache.usage(
      request([[block("task")]], { cache_control: MARK }),
      50,
    );
    expect(first.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(first.input_tokens).toBe(0);
    const second = cache.usage(
      request([[block("task")], [block("answer")], [block("q")]], {
        cache_control: MARK,
      }),
      50,
    );
    expect(second.cache_read_input_tokens).toBe(
      first.cache_creation_input_tokens,
    );
  });

  const refused: Array<[string, () => Record<string, unknown>]> = [
    [
      "five blocks with a mark",
      () =>
        request(
          Array.from({ length: 5 }, (_, index) => [
            block(`t${String(index)}`, 6000, { cache_control: MARK }),
          ]),
        ),
    ],
    [
      "four blocks and the top-level mark",
      () =>
        request(
          [
            ...Array.from({ length: 4 }, (_, index) => [
              block(`t${String(index)}`, 6000, { cache_control: MARK }),
            ]),
            [block("x")],
          ],
          { cache_control: MARK },
        ),
    ],
    [
      "an empty text block",
      () => request([[{ type: "text", text: "", cache_control: MARK }]]),
    ],
    [
      "a thinking block",
      () =>
        request([[{ type: "thinking", thinking: "t", cache_control: MARK }]]),
    ],
    [
      "a tool result without content",
      () =>
        request([
          [block("task")],
          [{ type: "tool_use", id: "t1", name: "read", input: {} }],
          [{ type: "tool_result", tool_use_id: "t1", cache_control: MARK }],
        ]),
    ],
    [
      "a tool result with an empty string",
      () =>
        request([
          [block("task")],
          [{ type: "tool_use", id: "t1", name: "read", input: {} }],
          [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "",
              cache_control: MARK,
            },
          ],
        ]),
    ],
    [
      "a tool result with no blocks",
      () =>
        request([
          [block("task")],
          [{ type: "tool_use", id: "t1", name: "read", input: {} }],
          [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [],
              cache_control: MARK,
            },
          ],
        ]),
    ],
    [
      "an unknown ttl",
      () =>
        request([
          [
            block("a", 6000, {
              cache_control: { type: "ephemeral", ttl: "2h" },
            }),
          ],
        ]),
    ],
    [
      "one hour after five minutes",
      () =>
        request([
          [block("a", 6000, { cache_control: MARK })],
          [
            block("b", 6000, {
              cache_control: { type: "ephemeral", ttl: "1h" },
            }),
          ],
        ]),
    ],
    [
      "a mark on the message itself",
      () => ({
        model: MODEL,
        messages: [{ role: "user", content: "x", cache_control: MARK }],
      }),
    ],
  ];
  it.each(refused)("refuses %s", (_name, build) => {
    expect(() => new PromptCache(clock().read).usage(build(), 50)).toThrow(
      CacheRequestRejected,
    );
  });

  it("allows four breakpoints", () => {
    const body = request(
      Array.from({ length: 4 }, (_, index) => [
        block(`t${String(index)}`, 6000, { cache_control: MARK }),
      ]),
    );
    expect(
      new PromptCache(clock().read).usage(body, 50).cache_creation_input_tokens,
    ).toBeGreaterThan(0);
  });
});

function tool(name: string) {
  return { name, input_schema: { type: "object" } };
}

function stablePrefix(extra: Record<string, unknown> = {}) {
  return request([[block("task", 6000, { cache_control: MARK })]], {
    tools: [tool("read"), tool("grep")],
    system: [block("system", 6000, { cache_control: MARK })],
    ...extra,
  });
}

describe("what invalidates the cached prefix in the fake LLM", () => {
  const settings = {
    tool_choice: { type: "auto" },
    thinking: { type: "disabled" },
  };
  const changes: Array<[string, Record<string, unknown>]> = [
    ["tool_choice", { tool_choice: { type: "none" } }],
    ["thinking", { thinking: { type: "enabled", budget_tokens: 2048 } }],
  ];

  it.each(changes)(
    "a changed %s invalidates the messages but not the system",
    (_name, changed) => {
      // What the system breakpoint covers: the tools and the system prompt.
      const covered = new PromptCache(clock().read).usage(
        {
          ...request([[block("task")]], {
            tools: [tool("read"), tool("grep")],
            system: [block("system", 6000, { cache_control: MARK })],
          }),
          ...settings,
        },
        50,
      ).cache_creation_input_tokens;
      const cache = new PromptCache(clock().read);
      const first = cache.usage(stablePrefix(settings), 50);
      expect(first.cache_creation_input_tokens).toBeGreaterThan(covered);
      const same = cache.usage(stablePrefix(settings), 50);
      expect(same.cache_read_input_tokens).toBe(
        first.cache_creation_input_tokens,
      );
      const other = cache.usage(stablePrefix({ ...settings, ...changed }), 50);
      expect(other.cache_read_input_tokens).toBe(covered);
      expect(other.cache_creation_input_tokens).toBe(
        first.cache_creation_input_tokens - covered,
      );
    },
  );

  it("a changed tool set invalidates everything", () => {
    const cache = new PromptCache(clock().read);
    cache.usage(stablePrefix(), 50);
    const other = cache.usage(
      stablePrefix({ tools: [tool("read"), tool("grep"), tool("write")] }),
      50,
    );
    expect(other.cache_read_input_tokens).toBe(0);
    expect(other.cache_creation_input_tokens).toBeGreaterThan(0);
  });
});

describe("the fake LLM server with the prompt cache on", () => {
  let fake: FakeLlm | null = null;
  afterEach(async () => {
    await fake?.close();
    fake = null;
  });

  async function post(
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ) {
    if (fake === null) throw new Error("no fake");
    const response = await fetch(`${fake.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  }
  const anthropic = {
    "x-api-key": "dummy-key",
    "anthropic-version": "2023-06-01",
  };

  it("answers the Messages usage from the cache, and the 400 for a mark on a message", async () => {
    fake = await startLlmFake();
    fake.enablePromptCache(true);
    const body = request([[block("task", 6000, { cache_control: MARK })]]);

    const first = await post("/messages", body, anthropic);
    const second = await post("/messages", body, anthropic);
    const refused = await post(
      "/messages",
      {
        model: MODEL,
        messages: [{ role: "user", content: "x", cache_control: MARK }],
      },
      anthropic,
    );

    const usageOf = (answer: { json: Record<string, unknown> }) =>
      answer.json.usage as Record<string, number>;
    expect(usageOf(first).cache_creation_input_tokens).toBeGreaterThan(0);
    expect(usageOf(second).cache_read_input_tokens).toBe(
      usageOf(first).cache_creation_input_tokens,
    );
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });

  // #767
  it("counts a mark on a chat message object only when the provider honours it, and then caches up to the end of that message", async () => {
    fake = await startLlmFake();
    const body = {
      model: "claude-lane-coder",
      messages: [
        { role: "system", content: text("rules", 6000) },
        { role: "user", content: text("task", 6000), cache_control: MARK },
      ],
    };

    fake.enablePromptCache(true);
    const ignored = [
      await post("/chat/completions", body, {}),
      await post("/chat/completions", body, {}),
    ];
    fake.enablePromptCache(true, { messageMarks: true });
    const first = await post("/chat/completions", body, {});
    const second = await post("/chat/completions", body, {});

    const cachedOf = (answer: { json: Record<string, unknown> }) =>
      (
        (answer.json.usage as Record<string, unknown>).prompt_tokens_details as
          { cached_tokens?: number } | undefined
      )?.cached_tokens ?? 0;
    expect(ignored.map(cachedOf)).toEqual([0, 0]);
    expect(cachedOf(first)).toBe(0);
    expect(cachedOf(second)).toBeGreaterThan(0);
  });

  it("answers the chat usage with cached tokens and a discounted charge", async () => {
    fake = await startLlmFake();
    fake.enablePromptCache(true);
    const body = {
      model: "anthropic/claude-sonnet-4.5",
      cache_control: MARK,
      messages: [
        {
          role: "system",
          content: [block("rules", 6000, { cache_control: MARK })],
        },
        { role: "user", content: "the diff" },
      ],
    };
    const bearer = { authorization: "Bearer dummy-key" };

    const first = await post("/chat/completions", body, bearer);
    const second = await post("/chat/completions", body, bearer);

    const usageOf = (answer: { json: Record<string, unknown> }) =>
      answer.json.usage as {
        prompt_tokens: number;
        cost: number;
        prompt_tokens_details: {
          cached_tokens: number;
          cache_write_tokens: number;
        };
      };
    expect(
      usageOf(first).prompt_tokens_details.cache_write_tokens,
    ).toBeGreaterThan(0);
    expect(usageOf(second).prompt_tokens_details.cached_tokens).toBe(
      usageOf(first).prompt_tokens_details.cache_write_tokens,
    );
    expect(usageOf(second).cost).toBeLessThan(usageOf(first).cost);
    expect(usageOf(second).prompt_tokens).toBe(usageOf(first).prompt_tokens);
  });

  it("is off again after a reset", async () => {
    fake = await startLlmFake();
    fake.enablePromptCache(true);
    fake.reset();
    const answer = await post(
      "/messages",
      request([[block("task", 6000, { cache_control: MARK })]]),
      anthropic,
    );
    expect(answer.json.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
    });
  });
});
