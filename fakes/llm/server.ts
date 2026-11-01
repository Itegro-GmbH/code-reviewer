// SPDX-License-Identifier: LicenseRef-Proprietary

// A fake OpenAI-compatible LLM endpoint (OpenRouter shaped, loopback only) for the tests that run
// the real PR-Agent: it is reached through LiteLLM's real OpenRouter code path, which sends
// `POST <api base>/chat/completions` with the key in the `Authorization` header. The fake records
// every request (headers and body, so a test can read the prompt and the key that arrived) and
// answers from scripts:
//
// - a canned reply; `/review` is the only tool (#203), so every prompt gets the review reply;
// - an error for every request (429, 401, ...), optionally quoting the received key in the message
//   like a provider that says "Incorrect API key provided";
// - an agent script (`scriptAgent`, the Dynamic e2e lane, #253): the answers the real, pinned OpenCode gets
//   from the runner's model proxy. A request that offers tools gets the next scripted tool calls and, when they
//   are used up, the structured findings through the engine's `StructuredOutput` tool; a request without tools
//   (the engine's title request) gets plain text. The engine suite has its own Python twin of this
//   (`ScriptedModel` in runner/tests/engine/opencode_support.py). The same script plays a coding agent (#766): its
//   steps are calls of `write`, `edit` and `bash` with any arguments, it can end with a plain assistant message
//   (`finalText`) instead of `StructuredOutput`, and a list of scripts answers by the last user message (`when`);
// - `GET <api base>/key`, the cheap call that tells whether a key is accepted (the app's "test key"
//   button): 200 for an accepted key, 401 for any other once `acceptKeys` names the accepted ones. The
//   keys that arrived are recorded apart (`keyChecks`), so a test can see which key a check carried;
// - `GET <api base>/models/{author}/{slug}/endpoints`, the public model metadata behind the app's check of a
//   Dynamic model (#269): the endpoints of the models a test registered with `setModel` (the request
//   parameters each lists), 404 for any other model. The requests are recorded apart (`modelRequests`);
// - the Anthropic Messages API (#511), at the same address (`<api base>` is `.../api/v1`, the path the
//   Anthropic adapter and the runner derive from it): `GET <api base>/models`, the free call behind the key test
//   (the key arrives in `x-api-key`; `acceptKeys` and `failWith` apply to it as well, and every check is recorded
//   in `anthropicKeyChecks`), and `POST <api base>/messages`, answered in the Messages shape with a usage of
//   input, output and cache tokens (a canned review, or the scripted agent as `tool_use` blocks). The requests
//   (headers and parsed body) are recorded in `messageRequests`, so a test can see exactly which parameters
//   reached the provider;
//
// The replies are canned (`canned.ts`). They satisfy the output contract of the review tool and
// say nothing about review quality. The engine suite of the runner has its own Python twin of this
// fake (runner/tests/engine/fake_llm.py). Dummy values only; state is in memory.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { keepConnectionsOpen } from "../keep-alive.ts";
import { CacheRequestRejected, PromptCache } from "./anthropic-cache.ts";
import { StrictMessagesApi } from "./anthropic-rules.ts";
import { defaultReplies, type PromptKind } from "./canned.ts";

export type FakeLlmRequest = {
  path: string;
  /** The whole `Authorization` header, for example `Bearer <key>`. */
  authorization: string;
  model: string;
  /** Which PR-Agent tool the prompt belongs to. */
  kind: PromptKind;
  /** The system and the user messages joined: what the model was asked. */
  prompt: string;
  /** The names of the tools the request offered (an agent: the engine's tools), in order. */
  tools: string[];
  /** The result of every tool call the request carries, by the id of the call. */
  toolResults: Record<string, string>;
  /** The `provider` object of the body (OpenRouter's routing options, #270); null when absent. */
  provider: Record<string, unknown> | null;
  /** Where the request put `cache_control`: on message objects, on content parts, on tools, and at the top level. */
  cacheMarks: { messages: number; parts: number; tools: number; top: boolean };
  /** The `usage` the chat answer stated (cache tokens included), once it was sent; absent for a request that got an error. */
  usage?: Record<string, unknown>;
};

/** One request's tool calls of the agent script. */
export type AgentToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * What the agent answers: `steps[i]` for the i-th request that offers tools, then the end for every later one:
 * `final` through `StructuredOutput` (a Dynamic Review), or `finalText` as a plain assistant message (a coding agent
 * that is done, #766).
 */
export type AgentScript = {
  steps: AgentToolCall[][];
  /**
   * Which requests this script answers, when `scriptAgent` is given several: the first script whose text is part of
   * the last user message (the text of the last message with the role `user` that carries text; a tool result is not
   * one). A script without `when` answers any request. Each script counts its own steps.
   */
  when?: { lastUserContains: string };
  /**
   * Indexes of `steps` before which the answer waits: the request that would get step `i` is held until the test calls
   * `release()` (`heldCount()` says one is waiting). A journey that has to see something happen while the agent waits (a push
   * of what it committed) waits on that, not on a pause of its own (#767). The chat route only.
   */
  holdBefore?: number[];
  /**
   * The Messages API only (#533): every answer that asks for tools opens with a signed `thinking` block, as a model
   * that always thinks does, and the next request has to give it back (the fake answers a 400 when it does not).
   */
  thinking?: boolean;
} & (
  | {
      /** The structured answer (Dynamic findings, schema version 1) given through `StructuredOutput`. */
      final: Record<string, unknown>;
      finalText?: undefined;
    }
  | {
      /** The last answer: a plain assistant message with this text and no tool call. */
      finalText: string;
      final?: undefined;
    }
);

/** One endpoint (provider) of a model in the metadata answer. */
export type FakeModelEndpoint = {
  supported_parameters: string[];
  max_completion_tokens?: number | null;
  /** #279: what the claim of a Dynamic job reads next to the parameters. Left out, the endpoint states none. */
  context_length?: number | null;
  /** US dollars per token as OpenRouter writes them (`"0.0000005"`). */
  pricing?: { prompt?: string; completion?: string };
  supports_tool_choice?: { required?: boolean };
};

export type FakeLlmError = { status: number; message: string };

/** One request to the Anthropic Messages API as the fake saw it. */
export type FakeMessagesRequest = {
  /** The `x-api-key` header, empty when absent. */
  apiKey: string;
  /** The `anthropic-version` header, empty when absent. */
  version: string;
  /** The parsed body; an unreadable body is an empty object. */
  body: Record<string, unknown>;
};

/** The usage the fake reports for a Messages answer (Anthropic's names). */
export type FakeMessagesUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;
    ephemeral_1h_input_tokens: number;
  };
  /** The thinking tokens, a part of `output_tokens` (not an addition to it). */
  output_tokens_details?: { thinking_tokens: number };
};

export type FakeLlm = {
  /** What a job gets as `llm.baseUrl`: `http://127.0.0.1:<port>/api/v1`. */
  baseUrl: string;
  /** Every request received, in order. */
  requests(): FakeLlmRequest[];
  /** Replaces the reply for one kind of prompt. */
  setReply(kind: PromptKind, text: string): void;
  /** Answers every request with this error, whatever it asks for; null is normal again. */
  failWith(error: FakeLlmError | null): void;
  /** Error messages quote the key that arrived, like a provider that says "Incorrect API key". */
  quoteKeyInErrors(on: boolean): void;
  /** The only keys `GET /key` accepts; null (the default) accepts every key. */
  acceptKeys(keys: string[] | null): void;
  /** The whole `Authorization` header of every `GET /key` received, in order. */
  keyChecks(): string[];
  /**
   * Answers like the model of a Dynamic Review or a coding agent (see `AgentScript`); several scripts answer by the
   * last user message, and a request that none of them matches is refused with a 400; null is the canned reply
   * again.
   */
  scriptAgent(script: AgentScript | AgentScript[] | null): void;
  /** The `x-api-key` and `anthropic-version` of every `GET /models` received, in order (the Anthropic key test). */
  anthropicKeyChecks(): Array<{ apiKey: string; version: string }>;
  /** Every `POST /messages` received, in order. */
  messageRequests(): FakeMessagesRequest[];
  /** The usage the next Messages answers report (default: 100 input tokens, 50 output tokens, no cache). */
  setMessagesUsage(usage: FakeMessagesUsage): void;
  /**
   * The token counts the next chat answers report (default: 100 input tokens, 50 output tokens), with the `usage.cost`
   * OpenRouter would state for them at one dollar per million input tokens and four per million output tokens; null is the
   * default again. The prompt cache (`enablePromptCache`) still wins while it is on. For a journey that has to reach a cost
   * limit within a few calls (#767).
   */
  setChatUsage(
    usage: { promptTokens: number; completionTokens: number } | null,
  ): void;
  /**
   * While on, every answer reports the usage its request earns from a prompt cache that keeps the rules of the
   * Claude docs (`anthropic-cache.ts`, #539): cache tokens in the Messages shape, or `cached_tokens` and
   * `cache_write_tokens` with a discounted `usage.cost` in the chat shape, and a request the API would refuse (more
   * than four breakpoints, a mark on a message object) answered with its 400. Off by default and by `reset()`.
   * `messageMarks`: a mark on a message object of a chat request counts, as a gateway that honours it caches up to the end of
   * that message (it is where the engine puts the mark for an OpenAI-compatible provider, #767); by default it is left out.
   */
  enablePromptCache(on: boolean, options?: { messageMarks?: boolean }): void;
  /**
   * The next `POST /messages` that is accepted answers with this message verbatim (thinking blocks and all), in
   * the order queued, once each; the request is checked as always (#533).
   */
  queueMessagesAnswer(answer: Record<string, unknown>): void;
  /** Registers a model for the metadata endpoint; its endpoints list what the test says they support. */
  setModel(id: string, endpoints: FakeModelEndpoint[]): void;
  /** Every metadata request received (path and `Authorization` header, empty when none), in order. */
  modelRequests(): Array<{ path: string; authorization: string }>;
  /**
   * While on, a request to the chat completions route is recorded when it arrives and answered only when the hold is
   * lifted (`hold(false)`, `reset()`); a client that hangs up meanwhile gets nothing. For a journey that needs a
   * review that is in progress, so it can end the process that runs it.
   */
  hold(on: boolean): void;
  /** How many requests wait for `release()`: those held by `hold(true)` and those held by a script's `holdBefore`. */
  heldCount(): number;
  /** Answers every request that is held; a `holdBefore` that was released does not hold again. */
  release(): void;
  /**
   * Whether the chat answers state their charge in `usage.cost`, as OpenRouter does (default). A provider that does not
   * (DeepSeek, OpenAI) leaves the price of the run to the book of the catalog (#767).
   */
  statesCharge(on: boolean): void;
  /** Normal replies, no error, no recorded requests, no hold. */
  reset(): void;
  close(): Promise<void>;
};

type ChatMessage = {
  role?: unknown;
  content?: unknown;
  tool_call_id?: unknown;
};

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return (tools as Array<{ function?: { name?: unknown } }>).flatMap((tool) =>
    typeof tool.function?.name === "string" ? [tool.function.name] : [],
  );
}

function providerOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toolResultsOf(messages: ChatMessage[]): Record<string, string> {
  const results: Record<string, string> = {};
  for (const message of messages)
    if (message.role === "tool" && typeof message.tool_call_id === "string")
      results[message.tool_call_id] =
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
  return results;
}

function textOf(messages: ChatMessage[], role: string): string {
  return messages
    .filter((message) => message.role === role)
    .map((message) => {
      const { content } = message;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return (content as Array<{ text?: unknown }>)
        .map((piece) => (typeof piece.text === "string" ? piece.text : ""))
        .join("\n");
    })
    .join("\n");
}

/**
 * The text of the last user message that carries text, in the chat shape and in the Messages shape alike (a tool
 * result is a message of its own in the first and a block of a user message in the second; neither is a question).
 */
function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const message of [...(messages as ChatMessage[])].reverse()) {
    if (message.role !== "user") continue;
    const { content } = message;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type?: unknown; text?: unknown }>)
              .map((piece) =>
                typeof piece.text === "string" ? piece.text : "",
              )
              .join("\n")
          : "";
    if (text !== "") return text;
  }
  return "";
}

/** The kind of prompt a request holds. `/review` is the only tool (#203). */
export function classify(system: string): PromptKind {
  void system;
  return "review";
}

/** The usage of a chat answer, fixed unless the prompt cache gave it. */
type ChatUsage = Record<string, unknown>;

const FIXED_CHAT_USAGE: ChatUsage = {
  prompt_tokens: 100,
  completion_tokens: 50,
  total_tokens: 150,
  cost: 0.0001,
};

function completion(model: string, content: string, usage?: ChatUsage) {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: usage ?? { ...FIXED_CHAT_USAGE },
  };
}

type ChatCompletion = ReturnType<typeof completion>;

/**
 * A chat completion as the server-sent events a client that asked for `stream: true` reads (OpenAI's chunks): the role, the
 * text or the tool calls (the arguments in two pieces, as a real stream cuts them), the finish, and with
 * `stream_options.include_usage` a last chunk with the usage and no choice, then `[DONE]`. The native path of the runner
 * (the Implementer's, #767) always streams, so a fake that only answers JSON leaves its engine without an answer.
 */
export function chatEvents(
  document: ChatCompletion,
  includeUsage: boolean,
): string {
  const [choice] = document.choices;
  const message = (choice?.message ?? {}) as {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) => ({
    id: document.id,
    object: "chat.completion.chunk",
    created: document.created,
    model: document.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events: unknown[] = [chunk({ role: "assistant" })];
  for (const [index, call] of (message.tool_calls ?? []).entries()) {
    const half = Math.floor(call.function.arguments.length / 2);
    events.push(
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: call.type,
            function: {
              name: call.function.name,
              arguments: call.function.arguments.slice(0, half),
            },
          },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index,
            function: { arguments: call.function.arguments.slice(half) },
          },
        ],
      }),
    );
  }
  if (typeof message.content === "string" && message.content !== "")
    events.push(chunk({ content: message.content }));
  events.push(chunk({}, choice?.finish_reason ?? "stop"));
  if (includeUsage)
    events.push({ ...chunk({}), choices: [], usage: document.usage });
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

/**
 * A completion that asks for tool calls, with the fixed token counts a journey can check and the
 * `usage.cost` OpenRouter reports with every answer (a Dynamic run without it stops, #290).
 */
function toolCompletion(
  model: string,
  id: string,
  calls: AgentToolCall[],
  usage?: ChatUsage,
) {
  return {
    id: "chatcmpl-fake-agent",
    object: "chat.completion",
    created: 1_700_000_000,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call, position) => ({
            id: `${id}_${String(position)}`,
            type: "function",
            function: {
              name: call.name,
              arguments: JSON.stringify(call.arguments),
            },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: usage ?? {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      cost: 0.0001,
    },
  };
}

function cacheMarksOf(
  body: Record<string, unknown>,
): FakeLlmRequest["cacheMarks"] {
  const marked = (value: unknown) =>
    typeof value === "object" && value !== null && "cache_control" in value;
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<Record<string, unknown>>)
    : [];
  return {
    messages: messages.filter(marked).length,
    parts: messages
      .flatMap((message) =>
        Array.isArray(message.content) ? (message.content as unknown[]) : [],
      )
      .filter(marked).length,
    tools: (Array.isArray(body.tools) ? (body.tools as unknown[]) : []).filter(
      marked,
    ).length,
    top: "cache_control" in body,
  };
}

/** A chat request as the cache sees it: the same blocks, a mark on a part or at the top level kept, one on a message object left out (unless the provider honours it). */
function chatAsMessages(
  body: Record<string, unknown>,
  honourMessageMarks = false,
): Record<string, unknown> {
  const messages = (Array.isArray(body.messages) ? body.messages : []).map(
    (raw: Record<string, unknown>) => {
      const content = raw.content;
      const parts: unknown[] =
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : Array.isArray(content)
            ? [...(content as unknown[])]
            : [];
      const { role, content: _content, cache_control: control, ...extra } = raw;
      if (Object.keys(extra).length > 0)
        parts.push({ type: "text", text: JSON.stringify(extra) });
      // A gateway that honours the mark on the message object (the engine puts it there for an OpenAI-compatible provider)
      // caches up to the end of that message: the mark moves to its last part.
      const last = parts.at(-1);
      if (honourMessageMarks && control !== undefined && last !== undefined)
        parts[parts.length - 1] = {
          ...(last as Record<string, unknown>),
          cache_control: control,
        };
      return { role: typeof role === "string" ? role : "user", content: parts };
    },
  );
  const shaped: Record<string, unknown> = { model: body.model, messages };
  if ("cache_control" in body) shaped.cache_control = body.cache_control;
  return shaped;
}

/** USD per million tokens of an input and an output for the charge of a chat answer from the cache. */
const CACHE_PRICES = { input: 3, output: 15 };

const DEFAULT_MESSAGES_USAGE: FakeMessagesUsage = {
  input_tokens: 100,
  output_tokens: 50,
};

/** An Anthropic Messages answer with text. */
function messagesText(model: string, text: string, usage: FakeMessagesUsage) {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage,
  };
}

/** An Anthropic Messages answer that asks for tool calls. */
function messagesToolUse(
  model: string,
  id: string,
  calls: AgentToolCall[],
  usage: FakeMessagesUsage,
  thinking = false,
) {
  return {
    id: "msg_fake_agent",
    type: "message",
    role: "assistant",
    model,
    content: [
      // A model that always thinks opens with a signed block (summaries are off: the text is empty).
      ...(thinking
        ? [{ type: "thinking", thinking: "", signature: `sig_${id}` }]
        : []),
      ...calls.map((call, position) => ({
        type: "tool_use",
        id: `${id}_${String(position)}`,
        name: call.name,
        input: call.arguments,
      })),
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage,
  };
}

const NO_SCRIPT_MATCHES =
  "The fake LLM has no agent script for the last user message";

/** The error shape of the Messages API. */
function messagesError(status: number, message: string) {
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 429
            ? "rate_limit_error"
            : status === 529
              ? "overloaded_error"
              : status >= 500
                ? "api_error"
                : "invalid_request_error";
  return { type: "error", error: { type, message } };
}

function anthropicToolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return (tools as Array<{ name?: unknown }>).flatMap((tool) =>
    typeof tool.name === "string" ? [tool.name] : [],
  );
}

function anthropicPrompt(body: Record<string, unknown>): string {
  const parts: string[] = [];
  const system = body.system;
  if (typeof system === "string") parts.push(system);
  if (Array.isArray(system))
    for (const block of system as Array<{ text?: unknown }>)
      if (typeof block.text === "string") parts.push(block.text);
  if (Array.isArray(body.messages))
    for (const message of body.messages as Array<{ content?: unknown }>) {
      if (typeof message.content === "string") parts.push(message.content);
      else if (Array.isArray(message.content))
        for (const block of message.content as Array<{ text?: unknown }>)
          if (typeof block.text === "string") parts.push(block.text);
    }
  return parts.join("\n");
}

export async function startLlmFake(
  options: { host?: string; port?: number } = {},
): Promise<FakeLlm> {
  const host = options.host ?? "127.0.0.1";
  let log: FakeLlmRequest[] = [];
  let replies = defaultReplies();
  let error: FakeLlmError | null = null;
  let quoteKey = false;
  let accepted: string[] | null = null;
  let keyChecks: string[] = [];
  let agent: AgentScript[] | null = null;
  // How many requests that offered tools each script answered, and how many all of them together (the call ids).
  let agentUsed: number[] = [];
  let agentRequests = 0;
  let models = new Map<string, FakeModelEndpoint[]>();
  let modelLog: Array<{ path: string; authorization: string }> = [];
  let anthropicChecks: Array<{ apiKey: string; version: string }> = [];
  let messageLog: FakeMessagesRequest[] = [];
  let messagesUsage: FakeMessagesUsage = DEFAULT_MESSAGES_USAGE;
  let promptCache: PromptCache | null = null;
  let messageMarks = false;
  let chatUsageOverride: ChatUsage | null = null;
  // What the Claude API refuses with a 400, and the thinking blocks it issued (#533).
  let strictApi = new StrictMessagesApi();
  let queuedAnswers: Array<Record<string, unknown>> = [];
  let holding = false;
  let held: Array<() => void> = [];
  // The answers a script's `holdBefore` keeps back, and the holds that were released (a step is held once).
  let scriptHeld: Array<{ key: string; run: () => void }> = [];
  let passedHolds = new Set<string>();
  let statesCharge = true;
  const release = () => {
    const waiting = held;
    held = [];
    for (const answer of waiting) answer();
    const kept = scriptHeld;
    scriptHeld = [];
    for (const { key, run } of kept) {
      passedHolds.add(key);
      run();
    }
  };
  /** The key of the hold the next answer of the script that the last user message selects runs into, or null. */
  function holdAhead(lastUser: string): string | null {
    const position = (agent ?? []).findIndex(
      (script) =>
        script.when === undefined ||
        lastUser.includes(script.when.lastUserContains),
    );
    const script = agent?.[position];
    if (script?.holdBefore === undefined) return null;
    const next = agentUsed[position] ?? 0;
    const key = `${String(position)}:${String(next)}`;
    return script.holdBefore.includes(next) && !passedHolds.has(key)
      ? key
      : null;
  }

  /**
   * The next scripted answer to a request that offers tools: the next step of the script the last user message
   * selects, then its end. Null when no script matches.
   */
  function nextAgentAnswer(lastUser: string): {
    id: number;
    thinking: boolean;
    calls: AgentToolCall[] | null;
    text: string;
  } | null {
    const position = (agent ?? []).findIndex(
      (script) =>
        script.when === undefined ||
        lastUser.includes(script.when.lastUserContains),
    );
    const script = agent?.[position];
    if (script === undefined) return null;
    const used = agentUsed[position] ?? 0;
    agentUsed[position] = used + 1;
    const id = agentRequests;
    agentRequests += 1;
    const thinking = script.thinking === true;
    const step = script.steps[used];
    if (step !== undefined) return { id, thinking, calls: step, text: "" };
    if (script.finalText !== undefined)
      return { id, thinking, calls: null, text: script.finalText };
    return {
      id,
      thinking,
      calls: [{ name: "StructuredOutput", arguments: script.final }],
      text: "",
    };
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const send = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      const path = (request.url ?? "").split("?")[0] ?? "";
      if (request.method === "GET" && path.endsWith("/models")) {
        // The Anthropic key test: the free list of models, the key in `x-api-key`.
        const apiKey = String(request.headers["x-api-key"] ?? "");
        const version = String(request.headers["anthropic-version"] ?? "");
        anthropicChecks.push({ apiKey, version });
        if (error !== null)
          return send(
            error.status,
            messagesError(
              error.status,
              quoteKey ? `${error.message}: ${apiKey}` : error.message,
            ),
          );
        if (apiKey === "" || (accepted !== null && !accepted.includes(apiKey)))
          return send(
            401,
            messagesError(
              401,
              quoteKey && apiKey !== ""
                ? `invalid x-api-key: ${apiKey}`
                : "invalid x-api-key",
            ),
          );
        return send(200, {
          data: [],
          first_id: null,
          last_id: null,
          has_more: false,
        });
      }
      if (request.method === "POST" && path.endsWith("/messages")) {
        let parsed: Record<string, unknown> = {};
        try {
          const value: unknown = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          );
          if (
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)
          )
            parsed = value as Record<string, unknown>;
        } catch {
          // an unreadable body is answered like an empty one
        }
        const apiKey = String(request.headers["x-api-key"] ?? "");
        messageLog.push({
          apiKey,
          version: String(request.headers["anthropic-version"] ?? ""),
          body: parsed,
        });
        const model = typeof parsed.model === "string" ? parsed.model : "";
        const answerMessages = () => {
          if (response.destroyed) return;
          if (apiKey === "")
            return send(
              401,
              messagesError(401, "x-api-key header is required"),
            );
          if (error !== null)
            return send(
              error.status,
              messagesError(
                error.status,
                quoteKey ? `${error.message}: ${apiKey}` : error.message,
              ),
            );
          // What the Claude API refuses with a 400 (#533): a forced tool choice or `thinking: disabled` where the
          // model's flags say no, thinking blocks that do not come back as issued, a changed conversation.
          const refusal = strictApi.check(
            Object.fromEntries(
              Object.entries(request.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(",") : String(value ?? ""),
              ]),
            ),
            parsed,
          );
          if (refusal !== null) return send(refusal.status, refusal.body);
          const accept = (answer: Record<string, unknown>) => {
            strictApi.record(parsed, answer);
            return send(200, answer);
          };
          let usage: FakeMessagesUsage = messagesUsage;
          if (promptCache !== null) {
            try {
              usage = promptCache.usage(parsed, messagesUsage.output_tokens);
            } catch (failure) {
              if (failure instanceof CacheRequestRejected)
                return send(400, messagesError(400, failure.message));
              throw failure;
            }
          }
          const queued = queuedAnswers.shift();
          if (queued !== undefined) return accept(queued);
          const tools = anthropicToolNames(parsed.tools);
          if (agent !== null && tools.length > 0) {
            const answer = nextAgentAnswer(lastUserText(parsed.messages));
            if (answer === null)
              return send(400, messagesError(400, NO_SCRIPT_MATCHES));
            return accept(
              answer.calls === null
                ? messagesText(model, answer.text, usage)
                : messagesToolUse(
                    model,
                    `toolu_${String(answer.id)}`,
                    answer.calls,
                    usage,
                    answer.thinking,
                  ),
            );
          }
          if (agent !== null) return accept(messagesText(model, "ok", usage));
          log.push({
            path: request.url ?? "",
            authorization: `x-api-key ${apiKey}`,
            model,
            kind: "review",
            prompt: anthropicPrompt(parsed),
            tools,
            toolResults: {},
            provider: null,
            cacheMarks: { messages: 0, parts: 0, tools: 0, top: false },
          });
          return accept(messagesText(model, replies.review, usage));
        };
        if (holding) held.push(answerMessages);
        else answerMessages();
        return;
      }
      if (request.method === "GET" && path.endsWith("/key")) {
        const authorization = request.headers.authorization ?? "";
        const key = authorization.split(" ").at(-1) ?? "";
        keyChecks.push(authorization);
        if (error !== null)
          return send(error.status, {
            error: {
              message: quoteKey ? `${error.message}: ${key}` : error.message,
              code: error.status,
            },
          });
        if (accepted !== null && !accepted.includes(key))
          return send(401, {
            error: {
              message: quoteKey
                ? `Incorrect API key provided: ${key}`
                : "No auth credentials found",
              code: 401,
            },
          });
        return send(200, { data: { label: "fake-key", limit: null } });
      }
      const metadata = /\/models\/([^/]+)\/([^/]+)\/endpoints$/.exec(
        (request.url ?? "").split("?")[0] ?? "",
      );
      if (request.method === "GET" && metadata !== null) {
        modelLog.push({
          path: request.url ?? "",
          authorization: request.headers.authorization ?? "",
        });
        const id = `${decodeURIComponent(metadata[1] ?? "")}/${decodeURIComponent(metadata[2] ?? "")}`;
        const endpoints = models.get(id);
        if (endpoints === undefined)
          return send(404, { error: { message: "Not Found", code: 404 } });
        return send(200, {
          data: {
            id,
            name: id,
            endpoints: endpoints.map((endpoint) => ({
              name: "fake-provider",
              ...endpoint,
            })),
          },
        });
      }
      if (
        request.method !== "POST" ||
        !(request.url ?? "").split("?")[0]?.endsWith("/chat/completions")
      )
        return send(404, { error: { message: "Not Found", code: 404 } });

      let body: { model?: unknown; messages?: unknown } = {};
      try {
        body = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as typeof body;
      } catch {
        // an unreadable body is answered like an empty one
      }
      const messages = Array.isArray(body.messages)
        ? (body.messages as ChatMessage[])
        : [];
      const model = typeof body.model === "string" ? body.model : "";
      const authorization = request.headers.authorization ?? "";
      const system = textOf(messages, "system");
      const kind = classify(system);
      const entry: FakeLlmRequest = {
        path: request.url ?? "",
        authorization,
        model,
        kind,
        prompt: `${system}\n${textOf(messages, "user")}`,
        tools: toolNames((body as { tools?: unknown }).tools),
        toolResults: toolResultsOf(messages),
        provider: providerOf((body as { provider?: unknown }).provider),
        cacheMarks: cacheMarksOf(body as Record<string, unknown>),
      };
      log.push(entry);

      const streaming = (body as { stream?: unknown }).stream === true;
      const includeUsage =
        (body as { stream_options?: { include_usage?: unknown } })
          .stream_options?.include_usage === true;
      // An answer to a request that asked for a stream is the stream of the same answer.
      const sendChat = (status: number, document: unknown) => {
        if (status === 200) {
          const body = document as { usage?: Record<string, unknown> };
          // A provider that states no charge leaves it out of the usage of every answer.
          if (!statesCharge && body.usage !== undefined) {
            const { cost: _charge, ...rest } = body.usage;
            body.usage = rest;
          }
          entry.usage = body.usage;
        }
        if (!streaming || status !== 200) return send(status, document);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end(chatEvents(document as ChatCompletion, includeUsage));
      };
      const respond = () => {
        // The client hung up while the request was held: nobody to answer.
        if (response.destroyed) return;
        let chatUsage: ChatUsage | undefined = chatUsageOverride ?? undefined;
        if (promptCache !== null && error === null) {
          try {
            const counted = promptCache.usage(
              chatAsMessages(body as Record<string, unknown>, messageMarks),
              50,
              { minimum: 1024 },
            );
            const fresh = counted.input_tokens;
            const read = counted.cache_read_input_tokens;
            const written = counted.cache_creation_input_tokens;
            chatUsage = {
              prompt_tokens: fresh + read + written,
              completion_tokens: 50,
              total_tokens: fresh + read + written + 50,
              prompt_tokens_details: {
                cached_tokens: read,
                cache_write_tokens: written,
              },
              cost:
                ((fresh + 0.1 * read + 1.25 * written) * CACHE_PRICES.input +
                  50 * CACHE_PRICES.output) /
                1_000_000,
            };
          } catch (failure) {
            if (failure instanceof CacheRequestRejected)
              return send(400, {
                error: { message: failure.message, code: 400 },
              });
            throw failure;
          }
        }
        if (error !== null) {
          const message = quoteKey
            ? `Incorrect API key provided: ${authorization.split(" ").at(-1) ?? ""}`
            : error.message;
          return send(error.status, {
            error: { message, code: error.status },
          });
        }
        if (agent !== null) {
          if (toolNames((body as { tools?: unknown }).tools).length === 0)
            return sendChat(200, completion(model, "ok", chatUsage));
          const holdKey = holdAhead(lastUserText(messages));
          if (holdKey !== null) {
            scriptHeld.push({ key: holdKey, run: respond });
            return;
          }
          const answer = nextAgentAnswer(lastUserText(messages));
          if (answer === null)
            return send(400, {
              error: { message: NO_SCRIPT_MATCHES, code: 400 },
            });
          if (answer.calls === null)
            return sendChat(200, completion(model, answer.text, chatUsage));
          return sendChat(
            200,
            toolCompletion(
              model,
              `call_${String(answer.id)}`,
              answer.calls,
              chatUsage,
            ),
          );
        }
        sendChat(200, completion(model, replies[kind], chatUsage));
      };
      if (holding) held.push(respond);
      else respond();
    });
  });

  keepConnectionsOpen(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://${host}:${String(address.port)}/api/v1`,
    requests: () => [...log],
    setReply(kind, text) {
      replies[kind] = text;
    },
    failWith(next) {
      error = next;
    },
    quoteKeyInErrors(on) {
      quoteKey = on;
    },
    acceptKeys(keys) {
      accepted = keys;
    },
    keyChecks: () => [...keyChecks],
    setModel(id, endpoints) {
      models.set(id, endpoints);
    },
    modelRequests: () => [...modelLog],
    anthropicKeyChecks: () => [...anthropicChecks],
    messageRequests: () => [...messageLog],
    setMessagesUsage(usage) {
      messagesUsage = usage;
    },
    setChatUsage(usage) {
      chatUsageOverride =
        usage === null
          ? null
          : {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.promptTokens + usage.completionTokens,
              cost:
                (usage.promptTokens * 1 + usage.completionTokens * 4) /
                1_000_000,
            };
    },
    queueMessagesAnswer(answer) {
      queuedAnswers.push(answer);
    },
    scriptAgent(script) {
      agent =
        script === null ? null : Array.isArray(script) ? script : [script];
      agentUsed = [];
      agentRequests = 0;
    },
    hold(on) {
      holding = on;
      if (!on) release();
    },
    heldCount: () => held.length + scriptHeld.length,
    release,
    statesCharge(on) {
      statesCharge = on;
    },
    enablePromptCache(on, options) {
      promptCache = on ? new PromptCache() : null;
      messageMarks = on && options?.messageMarks === true;
    },
    reset() {
      holding = false;
      promptCache = null;
      chatUsageOverride = null;
      release();
      scriptHeld = [];
      passedHolds = new Set();
      statesCharge = true;
      agent = null;
      agentUsed = [];
      agentRequests = 0;
      log = [];
      replies = defaultReplies();
      error = null;
      quoteKey = false;
      accepted = null;
      keyChecks = [];
      models = new Map();
      modelLog = [];
      anthropicChecks = [];
      messageLog = [];
      messagesUsage = DEFAULT_MESSAGES_USAGE;
      strictApi = new StrictMessagesApi();
      queuedAnswers = [];
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((failure) => (failure ? reject(failure) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
