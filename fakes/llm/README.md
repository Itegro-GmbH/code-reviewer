# fakes/llm

The fake LLM: an OpenRouter-shaped `chat/completions` endpoint and the Anthropic Messages API at one loopback address
(`server.ts`, `startLlmFake`). `fakes/README.md` lists everything it does; this page is about the agent mode, in which
it plays the model of an agent that the real, pinned OpenCode talks to. State is in memory; dummy values only.

## The agent script

`scriptAgent(script)` switches the fake to an agent mode: a request that offers tools gets the next scripted tool
calls, a request that offers none (the engine's title request) gets the plain text `ok` and spends no step. The calls
are named after the tools of the engine, with any arguments: `read`, `write`, `edit`, `bash`, `StructuredOutput`, and
whatever else a test names. The fake does not check them against the tools the request offered.

```ts
llm.scriptAgent({
  steps: [
    [
      {
        name: "write",
        arguments: { filePath: "src/a.ts", content: "export const a = 1;\n" },
      },
    ],
    [
      {
        name: "bash",
        arguments: { command: "git add -A && git commit -m 'Add a'" },
      },
    ],
  ],
  finalText: "I added src/a.ts and committed it.",
});
```

| Field       | Meaning                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steps`     | `steps[i]` (one or more calls, answered in one message) for the i-th request that offers tools.                                                    |
| `final`     | After the steps, for every later request: the structured answer through the `StructuredOutput` tool (a Dynamic Review; schema version 1).          |
| `finalText` | The same place, for a coding agent that is done: a plain assistant message with this text and no tool call. Give `final` or `finalText`, not both. |
| `when`      | `{ lastUserContains: "..." }`: which requests the script answers, see below.                                                                       |
| `thinking`  | The Messages API only (#533): every answer that asks for tools opens with a signed `thinking` block.                                               |

A script with `final` behaves exactly as before (#253): the Dynamic e2e lane and its tests are unchanged.

### Answering a message differently

`scriptAgent([...])` takes several scripts. A request is answered by the first script whose `when.lastUserContains` is
part of the last user message (the text of the last `user` message that carries text; a tool result is not one, so the
text stays the same while the agent works through its steps); a script without `when` answers any request. Every
script counts its own steps, so one script can play the work and another the reply to "commit your changes":

```ts
llm.scriptAgent([
  {
    when: { lastUserContains: "commit your changes" },
    steps: [
      [
        {
          name: "bash",
          arguments: { command: "git add -A && git commit -m 'Done'" },
        },
      ],
    ],
    finalText: "Committed.",
  },
  {
    steps: [
      [{ name: "write", arguments: { filePath: "a.txt", content: "one\n" } }],
    ],
    finalText: "Implemented.",
  },
]);
```

A request that offers tools and that no script matches is refused with a 400 (`The fake LLM has no agent script for the
last user message`), so a mistaken script shows at once instead of answering something else. `scriptAgent(null)` and
`reset()` switch the agent mode off.

### Usage

A chat answer reports 100 input and 50 output tokens. `setChatUsage({ promptTokens, completionTokens })` makes the next ones
report other counts (with the `usage.cost` for them at one and four dollars per million tokens; `null` is the default again).
The Implementer's journey for the cost limit (#767) switches it once the first commit is pushed, so that the limit is reached
within a few calls.

Tests: `app/src/test-support/llm-fake-agent.integration.test.ts`.
