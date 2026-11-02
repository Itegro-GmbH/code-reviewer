# Spike #546: native OpenCode through a plain relay, four wire formats

Study: #544 (maintainer decisions of 2026-10-19). Ticket: #546. Pinned engine: OpenCode **v1.19.0**
(`runner/opencode-pin.json`, executable sha256 `135ac3f8…71fd`, checked before every run).

**Status: part 1 of 2.** Everything that can be proven without a provider key is proven here, against
the real pinned binary and fake providers. There was no real key for this spike, so what only a
real provider can show (its real usage shapes, its real errors, whether real models accept what the
engine sends) is the **live checklist in section 7**. The reusable parts are in the repository:
`fakes/wire/` (generic fakes per format, a strict upstream, a key swapping relay) and
`runner/tests/engine/test_engine_opencode_native.py` (every claim below as an engine test).

**There is no local live relay.** No script in this repository (or next to this report) talks to a
real provider: the relay of `fakes/wire/relay.py` is a test double that only ever points at the fake
upstream on loopback, and it has no TLS. The live part runs later and only through `/review` on the
playground, with the maintainer's Anthropic key, which no part of this work reads. Everything in
this report that names a real provider's behavior is therefore either read from the engine's own
requests (what the engine sends) or an **assumption** about the provider (marked as such).

## 1. How this was measured

```
OpenCode (pinned binary, closed environment of config.engine_environment, default-deny permissions)
   │  provider.<id> { npm, options.baseURL = relay, options.apiKey = DUMMY }, models.<m> = the entry
   ▼
fakes/wire/relay.py       checks the dummy under the header of the family, swaps in the real key,
   │                      relays the bytes unchanged, keeps a copy of request and answer
   ▼
fakes/wire/upstream.py    strict fake of the provider: only the real key, one path, one model
```

- A six step tool loop (`glob`, `read`, `grep`, `read`, `glob`, `grep`, then a text answer) per
  family, on a provider id and a model id that exist nowhere (`acme-chat/acme-chat-9`, …); the
  Messages loop runs `claude-fable-5-1` from the snapshot against the strict rules of
  `fakes/llm/anthropic_rules.py`.
- The turn has no `format`: the engine runs its ordinary loop and ends in text (decision 4 of #544).
- `OPENCODE_DISABLE_MODELS_FETCH=true`, `OPENCODE_PURE=true`, no `OPENCODE_MODELS_PATH` (except in
  the one fallback test), `enabled_providers` limited to the providers of the test.
- The suite starts few engines (an engine start costs about five seconds): four family loops, one
  engine that knows about a dozen providers (resolution, request bodies, the listing of
  `GET /config/providers`), one engine for the faults, two single launches (a models file, a config
  the engine refuses). About one minute locally; it was 3.7 minutes with one engine per claim.
- The shapes of the fakes follow the providers' documented formats and what the bundled AI SDKs
  parse. **They are not captured from real providers.** The assumptions are listed in section 6.

## 2. Answers

| # | Question | Answer |
|---|---|---|
| 1 | Does the pinned OpenCode resolve a model that is not in its snapshot from the per-job config entry alone, with fetch disabled and no `OPENCODE_MODELS_PATH`? | **Yes, for all four families**, for a provider the snapshot lacks (`npm` + `options.baseURL` + `models.<m>`) and for a model the snapshot lacks under a provider it has (`anthropic`, `openai`, `google`, `deepseek`: no `npm` needed). The fallback `OPENCODE_MODELS_PATH` is **not needed**; it works too, with a smallest valid file recorded below. |
| 2 | What does it send through a pure relay? | One **streaming** POST per step, to one path per family, key in one header. It never sends a non-stream call and never calls `GET /models`. Details in section 4. |
| 3 | Does its own prompt caching (`applyCaching`) arrive unchanged through a pure relay? | **Yes, byte for byte** (sha256 of every request body equal on both sides of the relay, all four families). Whether marks exist is decided by the engine from the SDK and the model id, see section 6. |

Verdict per family (everything below has an engine test):

| Family | SDK in the pin | Through a plain relay | Needs |
|---|---|---|---|
| OpenAI Chat / compatible | `@ai-sdk/openai-compatible` (`openrouter` has its own: `@openrouter/ai-sdk-provider`) | works | auth swap on `authorization` |
| OpenAI Responses | `@ai-sdk/openai` | works | auth swap on `authorization`; `npm` must be named (a new provider without it speaks Chat) |
| Anthropic Messages | `@ai-sdk/anthropic` | works | auth swap on `x-api-key`; pass `anthropic-version` and `anthropic-beta` through untouched |
| Google | `@ai-sdk/google` | works | auth swap on `x-goog-api-key`; the model and the stream are in the path |

## 3. Model resolution (question 1)

### The entry that works

```json
{
  "provider": {
    "acme-claude": {
      "npm": "@ai-sdk/anthropic",
      "options": { "baseURL": "http://127.0.0.1:<relay>/v1", "apiKey": "<dummy capability>" },
      "models": {
        "acme-claude-9": {
          "name": "Spike model",
          "limit": { "context": 200000, "output": 8192 },
          "tool_call": true,
          "reasoning": false,
          "temperature": true
        }
      }
    }
  },
  "enabled_providers": ["acme-claude"]
}
```

`GET /config/providers` shows the engine's view of it: `status: active`, the limits, `toolcall`,
`api.npm`, `cost` and, for a model with `reasoning: true`, the derived `variants`. That endpoint is
the cheap way for #548 to test an entry without a model call. The engine checks the config when the
first session is made (HTTP 400 `ConfigInvalidError` with every issue at once), not when it starts.

### Which fields are needed (tested one at a time)

| Entry | Result |
|---|---|
| `{}` (what the Dynamic config uses today) | resolves; output cap falls back to **32000**; cost 0 |
| `{ "name": … }` only, or without `limit`, `tool_call`, `temperature`, `reasoning` | resolves, same defaults |
| `limit` with only `context` **or** only `output` | **refused by the config validator** (`ConfigInvalidError`, `Missing key`, both cases tested): state both or neither |
| `tool_call: false` | the model is listed with `toolcall: false` and **the tools are still sent**: the engine does not gate on the flag, the catalog filter of #548 must |
| `cost` missing | engine cost is **0, silently**; the relay's tee still sees real tokens |
| `status: "deprecated"` or `"alpha"` | the model is **not offered**: `ProviderModelNotFoundError`, HTTP 500, no upstream call. `"beta"` and the default run |
| provider without `npm`, not in the snapshot | defaults to `@ai-sdk/openai-compatible`: Responses/Messages/Google entries silently speak Chat and fail on the key header. **Always write `npm`.** |
| provider in the snapshot (`anthropic`, `openai`, `google`, `deepseek`) | `npm` not needed; the snapshot's SDK is used |

Two surprises for #548:

- **The snapshot's `status` applies when the entry states none; an explicit status in the entry
  overrides it.** `deepseek-v4-flash` is in the pinned snapshot, flagged `deprecated` by models.dev:
  an empty entry `{}` for it is not offered, while `{"status": "active"}` brings it back (`"beta"` did
  the same when tried by hand). So the
  `status` field has to be mapped when the entry is generated, and a catalog model that models.dev
  flags `alpha`/`deprecated` needs a decision, not a silent drop: omitting the field is **not** enough
  to make the model usable.
- **The output cap is `min(limit.output, 32000)`.** `claude-sonnet-5-5` (limit 128000) is sent with
  `max_tokens: 32000`, and so is any entry that states `limit.output: 128000`. An entry without `limit`
  gets 32000. The ledger's output reservation must use the cap the engine will send, not the
  catalog's `limit.output`.

### The snapshot

The pinned binary embeds a full models.dev snapshot (`anthropic` 20 models incl. `claude-sonnet-5-5`
and `claude-fable-5-1`, `openai` 80, `google` 38, `deepseek` 2 offered plus the deprecated
`deepseek-v4-flash`, `openrouter` several hundred). `opencode models` lists only providers that have
credentials or config; a provider is listed once it has `options.apiKey`. With a snapshot model, an
**empty entry `{}`** keeps the snapshot's prices and limits (`claude-sonnet-5-5`: input 2, output 10,
limit.output 128000), so an entry for a snapshot model need not repeat them.

### Fallback: `OPENCODE_MODELS_PATH` (not needed)

Works with config `{ "provider": { "<id>": { "options": { "baseURL", "apiKey" } } } }` and this file:

```json
{
  "acme-claude": {
    "id": "acme-claude",
    "name": "Spike",
    "npm": "@ai-sdk/anthropic",
    "env": [],
    "models": {
      "acme-claude-9": {
        "id": "acme-claude-9",
        "name": "Spike model",
        "tool_call": true,
        "limit": { "context": 200000, "output": 8192 }
      }
    }
  }
}
```

`limit` is mandatory in the file (without it the engine fails with a `TypeError` on
`limit.context`), `reasoning` is optional, `api` is not needed.

### Unknown model or provider (question 7)

A turn for a model or provider the config does not name fails **before any upstream call**:
`POST /session/{id}/message` answers **HTTP 500** with `{"name": "UnknownError", "data": {"message":
"Unexpected server error. Check server logs for details.", "ref": "err_…"}}`. The cause is only in the
engine log: `ProviderModelNotFoundError: Model not found: <provider>/<model>` (with "Did you mean"
for near names). #550 can map "500 `UnknownError` and zero upstream
calls for the turn" to one stable code; the text must not be shown (it names the model).

## 4. What the engine sends (questions 2, T08, T09)

Same for every call of every family (`user-agent: opencode/1.19.0 ai-sdk/provider-utils/<v>
runtime/bun/1.3.14`):

- **Always POST, always streaming, one call per step.** No GET (`/models` is never called), no
  non-stream call, no title or compaction call **when the session has a title** (the adapter sets
  one; a session without a title makes one extra, tool-less, streamed call beside the first step).
- Headers besides the key (closed set, tested): `accept: */*`, `accept-encoding: gzip, deflate, br,
  zstd` (exactly this value, pinned by a test), `connection`, `content-length`, `content-type:
  application/json`, `host`, `user-agent`, and three that carry the session id:
  `x-opencode-session-id`, `x-session-id`, `x-session-affinity`. The provider id `openrouter` adds
  no attribution header (`HTTP-Referer`, `X-Title`) in this pin; whether OpenRouter wants them is on
  the live list.

| Family | Request line | Key header | Extra headers | Stream | Output cap | Tool choice |
|---|---|---|---|---|---|---|
| chat | `POST /v1/chat/completions` | `authorization: Bearer` | | body `stream: true`, `stream_options.include_usage: true` (for the `openrouter` provider id: `usage: {include: true}` instead, no `stream_options`) | `max_tokens` | `tool_choice: "auto"` |
| responses | `POST /v1/responses` | `authorization: Bearer` | | body `stream: true` | `max_output_tokens` | `tool_choice: "auto"` |
| messages | `POST /v1/messages` | `x-api-key` | `anthropic-version: 2023-06-01`, `anthropic-beta: thinking-binding-controls-2026-08-01,structured-outputs-2025-11-13` | body `stream: true` | `max_tokens` | `tool_choice: {"type":"auto"}` |
| google | `POST /v1beta/models/<model>:streamGenerateContent?alt=sse` | `x-goog-api-key` | | **the method name** in the path | `generationConfig.maxOutputTokens` | `toolConfig.functionCallingConfig.mode: "AUTO"` |

Other body fields, and what decides them:

- Responses adds `store: false` and `prompt_cache_key` (the session id). With `reasoning: true` in the
  entry it adds `include: ["reasoning.encrypted_content"]`.
- Messages adds `thinking: {"type":"adaptive","block_binding":{"prefix_mismatch_behavior":
  "drop_block"}}` **for a model whose id carries a Claude version** (`claude-sonnet-5-5`,
  `acme-claude-9`, `claude-x-9`), **whatever its `reasoning` flag and its provider id**; an id
  without one (`acme-claude-flat`, `foo-claude`) gets no `thinking` at all, even with `reasoning:
  true`. The decision follows the model id, not the entry.
- Google adds `generationConfig.thinkingConfig: {includeThoughts: true, thinkingLevel: "high"}`
  **whenever the entry says `reasoning: true`**, and nothing otherwise.
- Chat and Messages requests are otherwise the same for a model that says it reasons and one that
  does not. `variant` is never passed (the adapter does not name one), so the variants that
  `GET /config/providers` derives for a reasoning model are not used.

The Google model is in the path (`:streamGenerateContent` is the stream). **A real provider serves
every model the key can reach**, and a pure passthrough that does not look at the request would let
the engine (or anything that reaches its config) use any of them at the maintainer's price. #550
therefore has to **parse `body.model` and pin it to the job's model** for Chat, Responses and
Messages, and pin `models/<the job's model>` and one of the two methods in the path for Google. The
relay of `fakes/wire/relay.py` has that rule (`pinned_model`); in the engine test a turn that asks
for a different model than the job's is answered **403 by the relay, with no upstream call**, and the
engine does not retry it (`isRetryable: false`).

**The relay must not forward `accept-encoding` as it is.** The engine offers gzip, br and zstd. A
provider may compress the answer for that (a test shows it), and a tee that reads the usage then holds
compressed bytes it cannot parse. `fakes/wire/relay.py` sends `accept-encoding: identity` upstream;
#550 must do the same or decode before it parses.

## 5. Usage, and what the engine does with it (T02, T06)

Where the usage sits in the four formats is pinned by `runner/tests/unit/test_wire_formats.py`
(shapes from the providers' documentation; real ones are the live test):

| Family | Non-stream | SSE stream |
|---|---|---|
| chat | `usage.prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens` | last data chunk, `choices: []`, **only when the request asked** (`stream_options.include_usage`, or `usage.include` for OpenRouter); without it the fake states no usage |
| responses | `usage.input_tokens`, `output_tokens`, `input_tokens_details.cached_tokens`, `output_tokens_details.reasoning_tokens` | `response.completed` → `response.usage` |
| messages | `usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` | input and cache in `message_start`, cumulative `output_tokens` in `message_delta` (**unconfirmed**: a real `message_delta` may carry only `output_tokens`, or repeat the input and cache fields) |
| google | `usageMetadata.{promptTokenCount, candidatesTokenCount, cachedContentTokenCount, thoughtsTokenCount}` | **assumption, both forms in the fakes:** on the last chunk only (default), or cumulative on every chunk (variant, what Gemini documents; the Google engine loop uses it) |

OpenCode **never uses non-stream**, so the non-stream column only matters for a provider that answers
a streaming request with a plain document, and for the title call if it ever changes.

How the engine itself counts the same upstream usage (first call: prompt 1010 of which 301 cached,
completion 21 of which 6 reasoning, cache write 51 + 8 for 1 h). It is not uniform, and it is not what
the ledger may use. Each row is an engine test (`…counts_the_usage_of_each_family_in_its_own_way`):

| Family | engine `input` | `output` | `reasoning` | `cache.read` | `cache.write` |
|---|---|---|---|---|---|
| chat, responses | 709 (prompt − cached) | 15 (completion − reasoning) | 6 | 301 | 0 |
| messages | 1010 | 21 | 0 | 301 | 59 (5 min + 1 h **summed**) |
| google | 709 | 21 (thoughts are separate) | 6 | 301 | 0 |

With a priced entry (`cost: {input: 3, output: 15}`) the engine's first call costs `0.002442`
= `(709·3 + 21·15)/1e6`: its own token counts times the entry's prices, reasoning at the output
price, a cache price only if the entry states one. Without `cost` it is `0`, silently. It knows
nothing of a 1-hour cache price or a charge the provider states. That is the reason for decision 10
of #544: the ledger reads the raw provider usage from the tee and never the engine's `cost`.

## 6. Caching (question 3), retries, thinking, and what the fakes assume

### `applyCaching` through the relay

The body is identical on both sides of the relay in every call of every family. Which marks the
engine adds (the relay does not matter; every row has an engine test):

| Case | Marks |
|---|---|
| `@ai-sdk/anthropic`, any provider id, any model id (also `acme-…`) | `cache_control: {type: ephemeral}` on `system[0]` and on the last block of each of the **last two messages** (one message → only that one) |
| openai-compatible, model id containing `claude` (also under the provider id `deepseek`) | `cache_control` on the system message and the last messages (also on `tool_calls[0]`) |
| openai-compatible, any other model id (also under the provider id `deepseek`) | none |
| provider id `openrouter` (SDK `@openrouter/ai-sdk-provider`), model id containing `claude` (`anthropic/claude-…`) | `cache_control` on the content blocks of the system message and the last messages |
| provider id `openrouter`, any other model id | none |
| `@ai-sdk/openai` (Responses) | `prompt_cache_key` = the session id, every call |
| `@ai-sdk/google` | none |

So caching is decided by the SDK and the **model id**, not by the provider id. For the managed
OpenRouter models whose id contains `claude`, marks appear on the Chat family; for DeepSeek/Gemini
the provider caches implicitly and nothing is marked. A model id the engine does not recognise gets
no marks on the Chat family even if the upstream is Anthropic behind a gateway: note it in #548's
catalog notes. "Caching stays demonstrably active" (decision 9) is therefore a property to assert per
family in the live test (cache read/write tokens above 0 on the second call), not a given.

### Faults (T07), all with engine tests

- **One logical call becomes several upstream calls.** After a 429/5xx/529, a cut stream or an
  error event inside a 200 stream the engine retries by itself, as a whole new call. A persistent 429
  makes **6 upstream calls** (1 + 5 retries), then the turn is answered (HTTP 200) with an assistant
  error `{"name":"APIError","data":{"statusCode":429,"isRetryable":true,"responseBody":"<the
  upstream body>"}}`. A 4xx that is not retryable (the 403 of the model pin) is one call.
- **Waiting:** a `retry-after` of 1 second is honoured (the second call comes after 1.0 s); a 500
  without `retry-after` waits about 2 s before its first retry. How long the engine keeps retrying a
  500 that never goes away was **measured by hand once (about 70 s)**; no test pins that figure.
- A stream cut after a few events is retried as a whole new call; the cut call's usage is never seen,
  the retry's is. The Messages stream's `message_start` carries the input and cache usage before any
  content, so a stream that is cut or fails later has **already stated a part of its usage**.
- **An error inside a stream** (HTTP 200, then an `error` event; the shape is an assumption, see
  below) is retried as a new call on Chat, Responses and Messages; the status of the call is 200, so
  a proxy that only looks at the status never sees it. On Google, where the first chunk already held a
  whole function call, the engine runs the tool and records that step with `finish: "unknown"`, then
  asks again: three upstream calls and an extra, half-done step.
- The ledger therefore sees more calls than the engine has steps, and **some calls have no usage at
  all** (cut streams) or only a part of it. #550/#551 must reserve before each call, settle what is
  seen, and decide what a cut stream costs (a reservation, not zero).
- `responseBody` is the provider's error body verbatim, and an error body may quote the key it was
  sent (OpenAI does, masked). A test with an upstream that quotes the key shows the real key arrive,
  unredacted, in the engine's error message: nothing in a pure relay removes it.

### Thinking and the tool loop (question 8)

- The six step loop completes on every family, with thinking on for Messages and Google.
- Anthropic thinking blocks (`thinking` + `signature`) come back **unchanged and first** in every
  later assistant turn; Gemini thought parts and `thoughtSignature` come back with their function
  call. The native SDKs do what #533 had to do in the wire.
- The Fable 5.1 case: `claude-fable-5-1` (in the snapshot, entry `{}`) runs a six step loop against
  the strict Messages rules of `fakes/llm/anthropic_rules.py` (forced `tool_choice` refused,
  `block_binding` needs the beta header, thinking blocks must come back as issued): every call is
  `tool_choice: auto`, `thinking: adaptive` with `block_binding` and the beta header, and no 400.
  That rule set is documented but is a fake; the real API is the live checklist.
- Variants: for `reasoning: true` the engine derives `low/medium/high` (Chat, Responses, Google) and
  `low…max` (Messages, adaptive + `effort`). They apply only when a turn names a `variant`; the
  adapter does not, so the defaults above are what runs.

### The first live run (#810): what the fakes hid

The first real Implementer run on a real Anthropic key (`claude-sonnet-5-5`, this pin) made one good call and was
refused at the second by `request_not_allowed`. Cause, from the bundled `@ai-sdk/anthropic` of the pinned binary and
Anthropic's documentation: the Messages API states `"caller": {"type": "direct"}` on every `tool_use` block of a
response, the SDK keeps it from the stream and sends it back on the replayed block (`tool_use` ... `caller`), and the
closed schema of a message did not know the key. The Messages fake never stated one, so no test replayed it. The
fake now speaks the real stream (`ping`, a thinking block with `signature_delta`, `caller` on `tool_use`,
`service_tier` and `inference_geo`, the nested `cache_creation`, and a `message_delta` that repeats the input and cache
fields), and the captured body in `fakes/wire/engine_requests.json` carries the `caller` the real engine sends back.
The decision that followed: the proxy no longer walks the conversation (see `docs/dynamic-review.md`, "The body"), and a
refusal names the path that failed (never a value) in the log tail. Section 7 stays as it is: L12 now also covers the
top-level keys the engine sends for the real Claude models, which the diagnostics will name if one is missing.

### What the fakes assume (no live capture has confirmed any of it)

- A Messages `message_delta` carries only `output_tokens`.
- A Google stream states `usageMetadata` once, on the last chunk (default) or cumulatively on every
  chunk (variant).
- A Chat provider states usage in the stream only for a request that asked for it.
- An invalid key is a 401 for every family in the fake. Gemini probably answers a bad key with
  **HTTP 400 and `API_KEY_INVALID`**; the fake does not do that.
- Messages errors: 429 `rate_limit_error`, 500 `api_error`, 529 `overloaded_error` (documented);
  any other 5xx as `api_error` (assumed).
- The error event inside a 200 stream, in each family (Messages `event: error` with
  `overloaded_error`; Responses `event: error`; a data chunk with an `error` object for Chat and
  Google).
- Framing (so that a reader is not written against the tidy case): the fakes can re-chunk a stream at
  arbitrary byte boundaries, use CRLF line ends (Google's real stream does), and answer a JSON
  document without a `Content-Length`.

## 7. Live checklist (needs real keys; runs later via `/review` on the playground)

The live part never runs from this repository: there is no local live relay and no script that reads a
key. It runs through `/review` on the playground, with the maintainer's Anthropic key for Messages;
the other families need their own keys. Each item is answered with a scrubbed capture; none can be
answered by a fake. **Runnable now** means: with the Anthropic key the maintainer already has, via
`/review`.

| # | Item | Family | Key needed | Pass criterion | Runnable now |
|---|---|---|---|---|---|
| L1 | Tool loop of ≥ 5 steps, relay in front, dummy key in the engine; record the real request headers | Messages | Anthropic (maintainer's, via `/review`) | loop completes, no 4xx, headers equal the closed set of section 4 | **yes** |
| L1 | same | Chat (DeepSeek, OpenRouter) / Responses (OpenAI) / Google (Gemini) | DeepSeek, OpenRouter, OpenAI, Gemini | as above | no |
| L2 | **Request headers the provider rejects**: the extra `anthropic-beta` values, the three `x-*session*` headers, `user-agent`; OpenRouter `HTTP-Referer`/`X-Title`; Google with `alt=sse` | Messages | Anthropic | no 4xx for the engine's full header set; a recorded answer to one extra `anthropic-beta` value | **yes** |
| L2 | same | Chat / Responses / Google | DeepSeek, OpenRouter, OpenAI, Gemini | no 4xx for the full header set; OpenRouter's need for attribution headers recorded | no |
| L3 | **Real usage shapes (T10)**: one scrubbed real answer and stream, as fixtures for #551. Messages: `cache_creation` 5 min / 1 h in `message_start`, `output_tokens` (and anything else) in `message_delta`, thinking tokens, `service_tier` | Messages | Anthropic | fixture contains no key, id, account data or content; the usage places of section 5 confirmed or corrected | **yes** (including the Fable thinking loop and `cache_creation`) |
| L3 | same. Chat: usage on the last chunk, OpenRouter `usage.cost` and cached/reasoning details, DeepSeek cache fields (`prompt_cache_hit_tokens`). Responses: `response.completed.response.usage`. Google: `usageMetadata` on the last chunk or on every chunk, `thoughtsTokenCount` outside `candidatesTokenCount`, `cachedContentTokenCount` | Chat / Responses / Google | DeepSeek, OpenRouter, OpenAI, Gemini | as above | no |
| L4 | **Compression**: does a real provider answer the streaming call with `content-encoding` when the engine offered gzip/br/zstd, and does it honour `identity` when the relay asks for it | Messages | Anthropic | no `content-encoding` on a request with `accept-encoding: identity` | **yes** |
| L4 | same | other families | the four other keys | as above | no |
| L5 | **Caching is active**: cache read tokens above 0 on the second and third call of a loop; what the engine marks for a Claude model behind OpenRouter | Messages | Anthropic | `cache_read_input_tokens` > 0 from the second call; `cache_creation` split visible | **yes** |
| L5 | same: OpenAI (`prompt_cache_key`), DeepSeek and Gemini (implicit), OpenRouter with a Claude model | Responses / Chat / Google | OpenAI, DeepSeek, Gemini, OpenRouter | cache read > 0 from the second or third call | no |
| L6 | **Real errors**: a wrong key (the relay sends one on purpose) and a refused request (`max_tokens` above the model's limit); a real 429, 5xx and 529 only if they occur. Status, body, `retry-after`, what the engine surfaces, and whether a body quotes the key | Messages | Anthropic | statuses and bodies recorded; no key in any body, or the redaction shown | **yes** (the provoked ones); 429/5xx/529 observed only |
| L6 | same; Gemini's status for a bad key (assumed 400 `API_KEY_INVALID`) | Chat / Responses / Google | the four other keys | as above | no |
| L7 | **The mid-stream error event**: whether a real provider ever sends an `error` event after HTTP 200, its shape per family, and whether the usage of that call was already stated | all | Anthropic for Messages | the tee of every run is searched for it; a real capture replaces the assumed shapes of section 6 | observed only (it cannot be provoked) |
| L8 | **A real current model absent from the snapshot** through the entry alone, thinking on (the Fable thinking loop); a model whose models.dev `status` is `deprecated`/`alpha` | Messages | Anthropic | runs from the entry alone; thinking blocks return unchanged | **yes** |
| L8 | same: Gemini with `reasoning: true`, an OpenAI reasoning model, a DeepSeek/OpenRouter model | Chat / Responses / Google | the four other keys | as above | no |
| L9 | **Cut stream**: the relay drops the connection after half the events: retries, upstream call count, what the provider bills for the cut call (its usage page, not the answer) | Messages | Anthropic | call count and billed tokens recorded | **yes** |
| L9 | same | other families | the four other keys | as above | no |
| L11 | **SDKs mapped from the source only (#548)**: `@ai-sdk/mistral`, `@ai-sdk/groq`, `@ai-sdk/deepinfra`, `@ai-sdk/cerebras`, `@ai-sdk/togetherai`, `@ai-sdk/perplexity`, `@openrouter/ai-sdk-provider` (all mapped to Chat) and `@ai-sdk/xai` (Responses) are in `contracts/opencode-providers.v1.json` by the reading of the pinned OpenCode's source (`app/src/ci/opencode-providers/derive.ts`); neither the fakes nor a live run has driven them. One tool loop per SDK: path, key header and usage shape as the family says, and `interleaved` with `reasoning_details` where a model states it | Chat / Responses | one key per provider (mistral, groq, deepinfra, cerebras, togetherai, perplexity, openrouter, xai) | the call arrives on the family's path with the key in the family's header and the usage is read; a provider that differs is excluded in the file (`wire_not_supported`) | no |
| L12 | **The `anthropic-beta` values for real Claude models (#550 allow-list)**: the pinned OpenCode sends `thinking-binding-controls-2026-08-01,structured-outputs-2025-11-13` for the fake Claude ids; record the exact value list the engine sends for each real Claude model the catalog offers (Sonnet, Haiku, Opus, Fable), per model id and with thinking on and off, and whether Anthropic accepts each. Also the numeric sampling options (`temperature`, `top_p`, `top_k`) the engine sends for real model ids of the other families, which the closed request schema lets through but no capture has seen | Messages (and the others) | Anthropic (maintainer's, via `/review`) | the allow-list `ALLOWED_ANTHROPIC_BETAS` equals the recorded set, every value accepted; the body keys of `body_schema.py` equal the recorded ones | **yes** |
| L13 | **Does a real provider bill a 5xx?** The passthrough proxy books a 500/502/503/529 that arrives as a status before any body or stream byte as unbilled (the run continues) and 408/504/524 and anything after the first byte as unknown at the worst case. Provoke or observe a real 5xx/529 (Anthropic overloaded, a 5xx from the others) and compare the call with the provider's usage page | all | the five keys | no billed tokens for a status-only 5xx; a billed one makes the status unknown again (`_UNBILLED_SERVER_ERRORS` in `passthrough/proxy.py`) | observed only |
| L14 | **Usage shapes the parsers of #551 assume** (each marked `UNCONFIRMED` in `usage_normalize.py` and in `fakes/wire/formats.py`): Messages `message_delta.usage` (only `output_tokens`, or cumulative input and cache fields as well, and a `server_tool_use` with zeros), the real `service_tier` / `speed` / `inference_geo` values, `cache_creation` present on every call; Chat: OpenRouter `usage.cost`, `cost_details`, `is_byok` and `cache_write_tokens` (its lifetime), DeepSeek hit/miss tokens, the `audio_tokens` / `*_prediction_tokens` zeros of OpenAI, top-level `service_tier` of a Chat and a Responses answer (`default`?); Google: `usageMetadata` on every chunk or only the last, whether a zero `candidatesTokenCount` is left out, `thoughtsTokenCount` outside the candidates, the per-modality `*TokensDetails` arrays, `trafficType`; whether any provider adds a usage field the parsers do not know (the log line names it); how far OpenRouter's stated charge strays from the price book (`price_drift` tolerance, 1 %; a stated charge more than 10 times below the book is unknown, so the live run must show it never is for a real call); **review of PR #569 (S5, N5, N6)**: the chat providers of the catalog (xAI, Groq, Mistral, Moonshot) and the fields they add (xAI `prompt_tokens_details.text_tokens` and whether its `total_tokens` includes reasoning on top of `completion_tokens`, Groq `queue_time` / `prompt_time` / `completion_time` / `total_time` floats, any `x_groq`) with the total check on (`total_tokens` must be prompt + completion; Google `totalTokenCount` must be prompt + candidates + thoughts + tool use) and whether an unknown field of a real answer is in fact harmless (then it is added to the known fields with its documentation); whether a catalog model has a **reasoning price above its output price** (the worst case takes the dearer, the cost uses the reasoning price) and whether the `model` an answer names is the model of the job (the proxy does not compare them yet); whether Chat usage always comes in or after the finish chunk and Messages sends nothing but `ping` after `message_stop` | all | the five keys | a scrubbed real answer and stream per family replaces the fake shapes and every `UNCONFIRMED` marker is closed or corrected; no call of the live run is an unknown call because of a field that is in fact harmless | Messages **yes**; others no |
| L10 | Spend stays below the USD 5 of the ticket; keys only from the environment of the relay process, never in the report or in a fixture | all | — | a grep of the repository for the key prefixes finds nothing | applies to every run |

## 8. Consequences for the follow-up issues

**#548 (catalog and per-job entry)**

- The per-job entry is as in section 3: `npm`, `options.baseURL`, `options.apiKey`, and the model entry.
  **Always set `npm`.** State `limit.context` and `limit.output` together or leave `limit` out;
  `{}` is valid for a snapshot model. `tool_call` is informational (filter in the catalog, the
  engine does not). Cost is irrelevant to the engine (the ledger prices) and may be omitted.
- Map models.dev `status`: `deprecated`/`alpha` entries are not offered by the engine, and an empty
  entry inherits the snapshot's status, so emit `beta` (or `active`) explicitly for a model that is to
  be usable, or do not offer the model.
- Cap `limit.output` at 32000 in the reservation (the engine sends the minimum).
- **Gemini with `reasoning: true` always sends `thinkingLevel: high`**, which changes the tokens a call
  uses and therefore the reservation; the same flag on Responses adds
  `include: ["reasoning.encrypted_content"]`.
- **`variant` is never passed** by the adapter, so the variants that the engine derives for a reasoning
  model are never used; effort and thinking level are whatever the defaults above say.
- **A wrong `reasoning` flag changes the request** (Google: `thinkingConfig`; Responses: `include`).
  Anthropic's adaptive thinking is decided by the model id, not by the flag: a catalog id without a
  Claude version gets no thinking, and one with a version always gets it, whatever the catalog says.
- `GET /config/providers` on the started engine is a cheap validation of a generated entry.
- `OPENCODE_MODELS_PATH` is not needed. Keep the minimal file of section 3 as the documented fallback.

**#550 (passthrough core)**

- Allow-list per family (from section 4): Chat `POST …/chat/completions`, Responses `POST …/responses`,
  Messages `POST …/messages`, Google `POST …/models/<job model>:streamGenerateContent` (also
  `:generateContent` if a non-stream call is ever wanted). No GET is needed.
- **Pin the model**: parse `body.model` (Chat, Responses, Messages) and the `models/<m>:` part of the
  Google path, and refuse any model but the job's; a real provider serves everything the key reaches.
- **Drop every credential header except the swapped one.** Today `authorization` is passed through for
  Messages (`fakes/wire/relay.py` forwards everything but the hop-by-hop headers), so a request that
  carries a bearer token would reach Anthropic with it. The proxy builds the outgoing headers from an
  allow-list and sets the one key header of the family.
- **Reject a `?key=` query on Google** (Google accepts the key as a query parameter) and allow **only
  `alt=sse`** as a query.
- **Allow-list the `anthropic-beta` values** (today the engine sends
  `thinking-binding-controls-2026-08-01,structured-outputs-2025-11-13`); pass `anthropic-version` and
  the `x-*session*` headers; send `accept-encoding: identity` upstream.
- **Cap the body size** of a request.
- **Handle mid-stream errors**: an `error` event inside a 200 stream is a failed call that may already
  have stated usage (`message_start`); the status does not show it.
- **Redact error bodies that echo the key** before anything is stored or shown. The upstream fake has
  a fault for this (`quote_key`): its error messages quote the key of the request, and the engine test
  shows the real key arrive in the engine's error message. Use it as the fixture of the redaction test.
- Count upstream calls, not engine steps: a retry is a new call (up to 6 per logical call), and the
  ledger needs a rule for calls that end without usage or with a part of it.
- "Model unknown" is a 500 `UnknownError` on the turn with zero upstream calls; map it to a stable code.
- `openrouter` as a provider id uses `@openrouter/ai-sdk-provider` and asks for its usage with
  `usage: {include: true}` in the body; the body fields of the allow-list must allow it.

**#551 (usage parsers and fakes)** (built: `runner/src/code_reviewer_runner/dynamic_review/passthrough/usage*.py`, `pricing.py`, `price_book.py`; what is assumed is L14)

- Start from `fakes/wire/formats.py` and `fakes/wire/upstream.py`: four families, JSON and SSE,
  distinct usage per call, faults (status with a chosen `retry-after`, cut stream, error event in a
  stream, compression, a quoted key), framing variants (arbitrary byte boundaries, CRLF, no
  `Content-Length`), strict key/path/model. Replace the synthetic shapes by the live captures of
  section 7.
- The engine never needs non-stream, but the provider may still answer a streaming request with a
  document; the parser must read both.
- Chat needs `include_usage` (OpenRouter: `usage.include`): the engine sends it, so a missing last chunk
  means a cut stream, not a provider without usage.
- Google's `usageMetadata` may be on every chunk, cumulative: take the last, never add them up.
- The 1 h cache split exists only in the raw Messages usage; the engine's own count sums it.

**#552 (finalization)**: the native SDKs carry thinking blocks and signatures and send `auto`, so the
#533 class of failure does not arise on the plain-text path (proved against the strict fake, to be
confirmed live). **#553 (cost policy)**: "no usage at all" occurs for cut streams, so the rule
"a call without usage fails the run" needs a distinction between a cut stream that is retried and a
completed answer without usage.

## 9. Reproduce

```
uv --directory runner sync --locked
uv --directory runner run python scripts/fetch_opencode.py            # once, needs the internet
OPENCODE_TEST_PATH=<dir holding rg> uv --directory runner run pytest -m engine tests/engine/test_engine_opencode_native.py tests/engine/test_native_support.py
uv --directory runner run pytest tests/unit/test_wire_formats.py tests/integration/test_wire_fakes_servers.py
```
