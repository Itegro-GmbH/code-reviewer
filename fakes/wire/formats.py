# SPDX-License-Identifier: LicenseRef-Proprietary

"""What a provider of each wire family answers (#546): the generic fakes' shapes.

Four families cover every provider that authenticates with a static key (#544): OpenAI Chat and the
many OpenAI-compatible providers, OpenAI Responses, Anthropic Messages and Google's Generative
Language API. Each family has one JSON answer and one stream of server-sent events, both built from
the same `Turn` (a tool call or a text, optionally with a thought) and a `Usage` that differs from
call to call, so a test can tell which call a number came from.

The shapes follow the providers' documented formats and what the pinned OpenCode's bundled AI SDKs
parse. They are NOT captured from a real provider: that is the live test of #546 and the fixtures of
#551. Where the usage sits is the part the passthrough proxy depends on:

| Family | Answer | Stream |
|---|---|---|
| chat | `usage` | the last data chunk, with `choices: []` (needs `stream_options.include_usage`) |
| responses | `usage` | `response.completed` |
| messages | `usage` | input and cache in `message_start`, cumulative output in `message_delta` |
| google | `usageMetadata` | on the last chunk, or (variant) cumulative on every chunk |

Assumptions that no live capture has confirmed yet (each is marked where it is built, and is an item
of the live checklist in docs/spike/544-passthrough.md):

- a Messages `message_delta` carries only `output_tokens` (a real one may repeat the input and cache
  fields);
- a Google stream states `usageMetadata` once, on the last chunk (the variant states it on every
  chunk, cumulatively, which is what the Gemini API documents for streaming);
- the error envelopes and the in-stream error events of every family.

Usage faults (#551): `answer` and `stream` take a `usage_fault` that leaves the usage out
(`missing`), adds a field that could carry a price and that the parsers do not know
(`unknown_field`) or damages one count (`bad_value`), for every family, so that the parsers and the
ledger are tested against the answers they must refuse. Two more are about the events of a stream
and leave a whole document as it is: `duplicate` states the usage a second time with less output (a
replay of an older count), and `out_of_order` puts the usage where the family never has it (Chat:
before the chunk that finishes; Messages: a `message_delta` before the `message_start`; Google: the
chunk that finishes first, the partial one after it). A Responses stream has one event with the
usage, so it has no `out_of_order`.

Variants of the framing, so that a parser is not written against the tidy case: the events can be
re-chunked at arbitrary byte boundaries (`upstream.py`), a stream can use CRLF line ends (Google's
real stream does), and a stream can fail in the middle with an error event after HTTP 200.
"""

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Final, Literal

Family = Literal["chat", "responses", "messages", "google"]
# What a test can do to the usage of an answer (#551): leave it out, add a field nobody can price,
# or put something into a count that is no count. Every family has all three.
UsageFault = Literal["missing", "unknown_field", "bad_value", "duplicate", "out_of_order"]
# The faults about the events of a stream: a document states its usage once, in one place.
ORDER_FAULTS: Final[tuple[UsageFault, ...]] = ("duplicate", "out_of_order")
FAMILIES: Final[tuple[Family, ...]] = ("chat", "responses", "messages", "google")

# The header that carries the key. The swap table of the proxy has these three entries.
AUTH_HEADER: Final[dict[Family, str]] = {
    "chat": "authorization",
    "responses": "authorization",
    "messages": "x-api-key",
    "google": "x-goog-api-key",
}


def auth_value(family: Family, key: str) -> str:
    """The value of the auth header for a key: a bearer token, or the bare key."""
    return f"Bearer {key}" if AUTH_HEADER[family] == "authorization" else key


@dataclass(frozen=True)
class Turn:
    """What the scripted model does in one call: ask for one tool, or say something."""

    tool: str | None = None
    args: Mapping[str, Any] = field(default_factory=lambda: {})
    text: str = ""
    thinking: str = ""
    # Why the answer ended, in the family's own word (chat: `length`, `content_filter`; messages:
    # `max_tokens`): the default is the end of a tool call or of a text.
    finish: str | None = None
    # Further tool calls of the same assistant message (parallel tool use). Anthropic Messages
    # states them as further `tool_use` blocks; the other families ignore them (#810).
    also: tuple[tuple[str, Mapping[str, Any]], ...] = ()


@dataclass(frozen=True)
class Usage:
    input: int
    output: int
    cache_read: int
    cache_write_5m: int
    cache_write_1h: int
    reasoning: int


def usage_for(call: int) -> Usage:
    """A usage that is different for every call number, with every field non-zero."""
    return Usage(
        input=1000 + 10 * call,
        output=20 + call,
        cache_read=300 + call,
        cache_write_5m=50 + call,
        cache_write_1h=7 + call,
        reasoning=5 + call,
    )


def _faulted(
    family: Family, usage: dict[str, Any], fault: UsageFault | None
) -> dict[str, Any] | None:
    """The usage with the fault applied; None when it is to be left out."""
    if fault is None or fault in ORDER_FAULTS:
        return usage
    if fault == "missing":
        return None
    faulty = json.loads(json.dumps(usage))
    if fault == "unknown_field":
        if family == "chat":
            faulty["prompt_tokens_details"]["audio_tokens"] = 11
        elif family == "responses":
            faulty["input_tokens_details"]["audio_tokens"] = 11
        elif family == "messages":
            faulty["server_tool_use"] = {"web_search_requests": 2}
        else:
            faulty["toolUsePromptTokenCount"] = 9
        return faulty
    if family == "chat":
        faulty["prompt_tokens"] = -1
    elif family == "responses":
        faulty["input_tokens"] = 1.5
    elif family == "messages":
        faulty["output_tokens"] = -3
    else:
        faulty["promptTokenCount"] = True
    return faulty


def _replayed(usage: dict[str, Any], output_key: str) -> dict[str, Any]:
    """An older statement of `usage`: one token less output (and total), as a replay would be."""
    older = json.loads(json.dumps(usage))
    older[output_key] -= 1
    for total in ("total_tokens", "totalTokenCount"):
        if total in older:
            older[total] -= 1
    return older


def _with_usage(document: dict[str, Any], key: str, usage: dict[str, Any] | None) -> dict[str, Any]:
    """`document` with its usage under `key`, or without the key when the usage is left out."""
    if usage is None:
        return document
    return {**document, key: usage}


def request_path(family: Family, model: str, *, streaming: bool = True) -> str:
    """The path of the chat call. Google puts the model and the choice of stream in the path."""
    if family == "chat":
        return "/v1/chat/completions"
    if family == "responses":
        return "/v1/responses"
    if family == "messages":
        return "/v1/messages"
    method = "streamGenerateContent" if streaming else "generateContent"
    return f"/v1beta/models/{model}:{method}"


def request_tool_names(family: Family, body: Mapping[str, Any]) -> list[str]:
    """The names of the tools a request offers, in its order."""
    tools: list[Any] = body.get("tools") or []
    if family == "chat":
        return [tool["function"]["name"] for tool in tools]
    if family in ("responses", "messages"):
        return [tool["name"] for tool in tools]
    return [declared["name"] for tool in tools for declared in tool.get("functionDeclarations", [])]


def is_stream(family: Family, path: str, body: Mapping[str, Any] | None) -> bool:
    """Whether the request asks for a stream: a field of the body, or for Google the method."""
    if family == "google":
        return path.endswith(":streamGenerateContent")
    return bool(body and body.get("stream"))


# The Messages API names its errors by status (documented): 429 rate limit, 500 api error and 529
# overloaded. Any other 5xx is an assumption (`api_error`).
_MESSAGES_ERROR: Final[dict[int, str]] = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
    500: "api_error",
    529: "overloaded_error",
}


def error_body(family: Family, status: int, detail: str = "") -> dict[str, Any]:
    """The error envelope of a provider for a status (the text is made up).

    `detail` is appended to the message: a provider that quotes the key it was given does it there.
    """
    message = f"fake upstream {status}" + (f" {detail}" if detail else "")
    if family == "messages":
        kind = _MESSAGES_ERROR.get(status, "api_error")
        return {"type": "error", "error": {"type": kind, "message": message}}
    if family == "google":
        return {"error": {"code": status, "message": message, "status": "RESOURCE_EXHAUSTED"}}
    return {"error": {"message": message, "type": "fake", "code": str(status)}}


def error_event(family: Family, message: str = "overloaded") -> bytes:
    """An error that arrives inside a stream whose HTTP status was already 200 (an assumption).

    Anthropic documents `event: error` with an `overloaded_error`; OpenAI's Responses stream has an
    `error` event; Chat-compatible gateways (OpenRouter) and Google send a data chunk that holds an
    `error` object. None of these shapes is captured live yet.
    """
    if family == "messages":
        data: Any = {"type": "error", "error": {"type": "overloaded_error", "message": message}}
        return _sse([("error", data)])[0]
    if family == "responses":
        data = {"type": "error", "code": "server_error", "message": message, "sequence_number": 99}
        return _sse([("error", data)])[0]
    if family == "google":
        data = {"error": {"code": 503, "message": message, "status": "UNAVAILABLE"}}
        return _sse([(None, data)])[0]
    data = {"error": {"message": message, "type": "fake", "code": "server_error"}}
    return _sse([(None, data)])[0]


def parse_sse(chunks: list[bytes]) -> list[tuple[str | None, Any]]:
    """The events of a stream as (event name, JSON data); a data line that is no JSON stays text."""
    parsed: list[tuple[str | None, Any]] = []
    for chunk in chunks:
        name: str | None = None
        data = ""
        for line in chunk.decode("utf-8").splitlines():
            if line.startswith("event: "):
                name = line.removeprefix("event: ")
            elif line.startswith("data: "):
                data = line.removeprefix("data: ")
        try:
            parsed.append((name, json.loads(data)))
        except ValueError:
            parsed.append((name, data))
    return parsed


def _sse(events: list[tuple[str | None, Any]]) -> list[bytes]:
    """Each event as one `event:`/`data:` block ended by a blank line."""
    chunks: list[bytes] = []
    for name, data in events:
        payload = data if isinstance(data, str) else json.dumps(data)
        head = f"event: {name}\n" if name else ""
        chunks.append(f"{head}data: {payload}\n\n".encode())
    return chunks


# -- OpenAI Chat ---------------------------------------------------------------------------------


def _chat_usage(call: int, fault: UsageFault | None = None) -> dict[str, Any] | None:
    usage = usage_for(call)
    return _faulted(
        "chat",
        {
            "prompt_tokens": usage.input,
            "completion_tokens": usage.output,
            "total_tokens": usage.input + usage.output,
            "prompt_tokens_details": {"cached_tokens": usage.cache_read},
            "completion_tokens_details": {"reasoning_tokens": usage.reasoning},
        },
        fault,
    )


def _chat_answer(
    turn: Turn, call: int, model: str, fault: UsageFault | None = None
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": turn.text or None}
    if turn.thinking:
        message["reasoning_content"] = turn.thinking
    if turn.tool:
        message["tool_calls"] = [
            {
                "id": f"call_{call}",
                "type": "function",
                "function": {"name": turn.tool, "arguments": json.dumps(dict(turn.args))},
            }
        ]
    document: dict[str, Any] = {
        "id": f"chatcmpl-{call}",
        "object": "chat.completion",
        "created": 1,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": turn.finish or ("tool_calls" if turn.tool else "stop"),
            }
        ],
    }
    return _with_usage(document, "usage", _chat_usage(call, fault))


def _chat_stream(
    turn: Turn, call: int, model: str, include_usage: bool, fault: UsageFault | None = None
) -> list[bytes]:
    def chunk(delta: dict[str, Any], finish: str | None = None) -> dict[str, Any]:
        return {
            "id": f"chatcmpl-{call}",
            "object": "chat.completion.chunk",
            "created": 1,
            "model": model,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        }

    events: list[tuple[str | None, Any]] = [(None, chunk({"role": "assistant"}))]
    if turn.thinking:
        events.append((None, chunk({"reasoning_content": turn.thinking})))
    if turn.tool:
        arguments = json.dumps(dict(turn.args))
        half = len(arguments) // 2
        opening = {
            "index": 0,
            "id": f"call_{call}",
            "type": "function",
            "function": {"name": turn.tool, "arguments": arguments[:half]},
        }
        events.append((None, chunk({"tool_calls": [opening]})))
        rest = {"index": 0, "function": {"arguments": arguments[half:]}}
        events.append((None, chunk({"tool_calls": [rest]})))
        events.append((None, chunk({}, turn.finish or "tool_calls")))
    else:
        if turn.text:
            middle = max(1, len(turn.text) // 2)
            events.append((None, chunk({"content": turn.text[:middle]})))
            events.append((None, chunk({"content": turn.text[middle:]})))
        events.append((None, chunk({}, turn.finish or "stop")))
    closing_usage = _chat_usage(call, fault)
    if include_usage and closing_usage is not None:
        # Only a request with `stream_options.include_usage` gets this chunk; without it a Chat
        # provider states no usage in the stream at all.
        closing = chunk({})
        closing["choices"] = []
        closing["usage"] = closing_usage
        if fault == "out_of_order":
            events.insert(len(events) - 1, (None, closing))  # before the chunk that finishes
        else:
            events.append((None, closing))
        if fault == "duplicate":
            events.append(
                (None, {**closing, "usage": _replayed(closing_usage, "completion_tokens")})
            )
    events.append((None, "[DONE]"))
    return _sse(events)


# -- OpenAI Responses ----------------------------------------------------------------------------


def _responses_usage(call: int, fault: UsageFault | None = None) -> dict[str, Any] | None:
    usage = usage_for(call)
    return _faulted(
        "responses",
        {
            "input_tokens": usage.input,
            "input_tokens_details": {"cached_tokens": usage.cache_read},
            "output_tokens": usage.output,
            "output_tokens_details": {"reasoning_tokens": usage.reasoning},
            "total_tokens": usage.input + usage.output,
        },
        fault,
    )


def _responses_item(turn: Turn, call: int, status: str) -> dict[str, Any]:
    if turn.tool:
        return {
            "type": "function_call",
            "id": f"fc_{call}",
            "call_id": f"call_{call}",
            "name": turn.tool,
            "arguments": json.dumps(dict(turn.args)),
            "status": status,
        }
    return {
        "type": "message",
        "id": f"msg_{call}",
        "role": "assistant",
        "status": status,
        "content": [{"type": "output_text", "text": turn.text, "annotations": []}],
    }


def _responses_answer(
    turn: Turn, call: int, model: str, fault: UsageFault | None = None
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "id": f"resp_{call}",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "model": model,
        "output": [_responses_item(turn, call, "completed")],
        "incomplete_details": None,
    }
    return _with_usage(document, "usage", _responses_usage(call, fault))


def _responses_stream(
    turn: Turn, call: int, model: str, fault: UsageFault | None = None
) -> list[bytes]:
    if fault == "out_of_order":
        raise ValueError("a Responses stream states its usage once: it has no order to break")
    base = {"id": f"resp_{call}", "created_at": 1, "model": model}
    opening = _responses_item(turn, call, "in_progress")
    if turn.tool:
        opening["arguments"] = ""
    else:
        opening["content"] = []
    events: list[tuple[str | None, Any]] = [
        (
            "response.created",
            {"type": "response.created", "response": {**base, "status": "in_progress"}},
        ),
        (
            "response.output_item.added",
            {"type": "response.output_item.added", "output_index": 0, "item": opening},
        ),
    ]
    if turn.tool:
        events.append(
            (
                "response.function_call_arguments.delta",
                {
                    "type": "response.function_call_arguments.delta",
                    "item_id": f"fc_{call}",
                    "output_index": 0,
                    "delta": json.dumps(dict(turn.args)),
                },
            )
        )
    else:
        part: dict[str, Any] = {"type": "output_text", "text": "", "annotations": []}
        events.append(
            (
                "response.content_part.added",
                {
                    "type": "response.content_part.added",
                    "item_id": f"msg_{call}",
                    "output_index": 0,
                    "content_index": 0,
                    "part": part,
                },
            )
        )
        events.append(
            (
                "response.output_text.delta",
                {
                    "type": "response.output_text.delta",
                    "item_id": f"msg_{call}",
                    "output_index": 0,
                    "content_index": 0,
                    "delta": turn.text,
                },
            )
        )
    events.append(
        (
            "response.output_item.done",
            {
                "type": "response.output_item.done",
                "output_index": 0,
                "item": _responses_item(turn, call, "completed"),
            },
        )
    )
    completed = _with_usage(
        {**base, "status": "completed", "incomplete_details": None},
        "usage",
        _responses_usage(call, fault),
    )
    events.append(("response.completed", {"type": "response.completed", "response": completed}))
    if fault == "duplicate" and "usage" in completed:
        older = {**completed, "usage": _replayed(completed["usage"], "output_tokens")}
        events.append(("response.completed", {"type": "response.completed", "response": older}))
    return _sse(events)


# -- Anthropic Messages --------------------------------------------------------------------------


def _messages_usage(call: int, fault: UsageFault | None = None) -> dict[str, Any] | None:
    usage = usage_for(call)
    return _faulted(
        "messages",
        {
            "input_tokens": usage.input,
            "output_tokens": usage.output,
            "cache_creation_input_tokens": usage.cache_write_5m + usage.cache_write_1h,
            "cache_read_input_tokens": usage.cache_read,
            "cache_creation": {
                "ephemeral_5m_input_tokens": usage.cache_write_5m,
                "ephemeral_1h_input_tokens": usage.cache_write_1h,
            },
            "service_tier": "standard",
            "inference_geo": "not_available",
        },
        fault,
    )


def _messages_content(turn: Turn, call: int) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    if turn.thinking:
        content.append({"type": "thinking", "thinking": turn.thinking, "signature": f"sig-{call}"})
    if turn.tool:
        # The real API states who called the tool on every `tool_use` block: a call the model made
        # itself is `{"type": "direct"}` (programmatic tool calling docs), and the pinned engine's
        # SDK sends the field back with the block on the next request (the regression of #810).
        for number, (name, args) in enumerate([(turn.tool, turn.args), *turn.also]):
            content.append(
                {
                    "type": "tool_use",
                    "id": f"toolu_{call}" if number == 0 else f"toolu_{call}_{number}",
                    "name": name,
                    "input": dict(args),
                    "caller": {"type": "direct"},
                }
            )
    else:
        content.append({"type": "text", "text": turn.text})
    return content


def _messages_answer(
    turn: Turn, call: int, model: str, fault: UsageFault | None = None
) -> dict[str, Any]:
    document: dict[str, Any] = {
        "id": f"msg_{call}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": _messages_content(turn, call),
        "stop_reason": turn.finish or ("tool_use" if turn.tool else "end_turn"),
        "stop_sequence": None,
    }
    return _with_usage(document, "usage", _messages_usage(call, fault))


def _messages_stream(
    turn: Turn, call: int, model: str, fault: UsageFault | None = None
) -> list[bytes]:
    usage = _messages_usage(call, fault)
    message: dict[str, Any] = {
        "id": f"msg_{call}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": [],
        "stop_reason": None,
        "stop_sequence": None,
    }
    if usage is not None:
        message["usage"] = {**usage, "output_tokens": 1}
    events: list[tuple[str | None, Any]] = [
        ("message_start", {"type": "message_start", "message": message})
    ]
    for index, block in enumerate(_messages_content(turn, call)):
        if index == 0:
            # The first thing after `message_start` the real API sends.
            events.append(("ping", {"type": "ping"}))
        opening: dict[str, Any]
        deltas: list[dict[str, Any]]
        if block["type"] == "thinking":
            opening = {"type": "thinking", "thinking": "", "signature": ""}
            deltas = [
                {"type": "thinking_delta", "thinking": block["thinking"]},
                {"type": "signature_delta", "signature": block["signature"]},
            ]
        elif block["type"] == "tool_use":
            opening = {
                "type": "tool_use",
                "id": block["id"],
                "name": block["name"],
                "input": {},
                "caller": block["caller"],
            }
            deltas = [{"type": "input_json_delta", "partial_json": json.dumps(block["input"])}]
        else:
            opening = {"type": "text", "text": ""}
            deltas = [{"type": "text_delta", "text": block["text"]}]
        events.append(
            (
                "content_block_start",
                {"type": "content_block_start", "index": index, "content_block": opening},
            )
        )
        for delta in deltas:
            events.append(
                (
                    "content_block_delta",
                    {"type": "content_block_delta", "index": index, "delta": delta},
                )
            )
        events.append(("content_block_stop", {"type": "content_block_stop", "index": index}))
    # What Anthropic documents for streaming: the usage of a `message_delta` is cumulative and
    # repeats the input and cache fields of `message_start` next to the real `output_tokens`. (A
    # parser must still not rely on either form, so `fakes/wire/upstream.py` keeps its variants.)
    delta: dict[str, Any] = {
        "type": "message_delta",
        "delta": {
            "stop_reason": turn.finish or ("tool_use" if turn.tool else "end_turn"),
            "stop_sequence": None,
        },
    }
    if usage is not None:
        delta["usage"] = {
            "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0},
            **{key: value for key, value in usage.items() if key != "service_tier"},
        }
    if fault == "out_of_order":
        events.insert(0, ("message_delta", delta))
    else:
        events.append(("message_delta", delta))
        if fault == "duplicate" and usage is not None:
            again = {
                **delta,
                "usage": _replayed({"output_tokens": usage["output_tokens"]}, "output_tokens"),
            }
            events.append(("message_delta", again))
    events.append(("message_stop", {"type": "message_stop"}))
    return _sse(events)


# -- Google Generative Language ------------------------------------------------------------------


def _google_usage(call: int, fault: UsageFault | None = None) -> dict[str, Any] | None:
    usage = usage_for(call)
    return _faulted(
        "google",
        {
            "promptTokenCount": usage.input,
            "candidatesTokenCount": usage.output,
            "totalTokenCount": usage.input + usage.output + usage.reasoning,
            "cachedContentTokenCount": usage.cache_read,
            "thoughtsTokenCount": usage.reasoning,
        },
        fault,
    )


def _google_answer(
    turn: Turn, call: int, model: str, fault: UsageFault | None = None
) -> dict[str, Any]:
    parts: list[dict[str, Any]] = []
    if turn.thinking:
        parts.append({"text": turn.thinking, "thought": True})
    if turn.tool:
        part: dict[str, Any] = {"functionCall": {"name": turn.tool, "args": dict(turn.args)}}
        if turn.thinking:
            part["thoughtSignature"] = f"tsig-{turn.tool}"
        parts.append(part)
    else:
        parts.append({"text": turn.text})
    document: dict[str, Any] = {
        "candidates": [
            {
                "content": {"role": "model", "parts": parts},
                "finishReason": "STOP",
                "index": 0,
            }
        ],
        "modelVersion": model,
        "responseId": f"r{call}",
    }
    return _with_usage(document, "usageMetadata", _google_usage(call, fault))


def _google_stream(
    turn: Turn, call: int, model: str, cumulative: bool, fault: UsageFault | None = None
) -> list[bytes]:
    """Two chunks: the content, then the finish. Where the usage sits is an ASSUMPTION either way.

    By default `usageMetadata` is on the last chunk only. With `cumulative` every chunk carries it
    and the numbers grow (the first chunk has a partial candidate count), which is how the Gemini
    API documents streaming; a parser has to take the last one and must not add them up. Neither
    form is captured from a real stream yet.
    """
    first = _google_answer(turn, call, model, fault)
    del first["candidates"][0]["finishReason"]
    # A stream out of order needs a partial usage on the chunk that comes after the finish.
    cumulative = cumulative or fault == "out_of_order"
    if cumulative and "usageMetadata" in first:
        first["usageMetadata"] = {
            **first["usageMetadata"],
            "candidatesTokenCount": 1,
            "totalTokenCount": usage_for(call).input + 1 + usage_for(call).reasoning,
        }
    else:
        first.pop("usageMetadata", None)
    last = _google_answer(Turn(text=""), call, model, fault)
    if fault == "out_of_order":
        return _sse([(None, last), (None, first)])
    chunks: list[tuple[str | None, Any]] = [(None, first), (None, last)]
    if fault == "duplicate" and "usageMetadata" in last:
        older = _replayed(last["usageMetadata"], "candidatesTokenCount")
        chunks.append((None, {"usageMetadata": older}))
    return _sse(chunks)


def answer(
    family: Family, turn: Turn, call: int, model: str, *, usage_fault: UsageFault | None = None
) -> dict[str, Any]:
    """The whole answer of a non-streaming call."""
    if family == "chat":
        return _chat_answer(turn, call, model, usage_fault)
    if family == "responses":
        return _responses_answer(turn, call, model, usage_fault)
    if family == "messages":
        return _messages_answer(turn, call, model, usage_fault)
    return _google_answer(turn, call, model, usage_fault)


def stream(
    family: Family,
    turn: Turn,
    call: int,
    model: str,
    *,
    include_usage: bool = True,
    cumulative_usage: bool = False,
    crlf: bool = False,
    usage_fault: UsageFault | None = None,
) -> list[bytes]:
    """The events of a streaming call, each a complete `event:`/`data:` block with a blank line.

    `include_usage` only matters for Chat (the closing usage chunk exists only when the request
    asked for it), `cumulative_usage` only for Google, `crlf` and `usage_fault` for every family
    (`out_of_order` for every family but Responses, which raises `ValueError` for it).
    """
    if family == "chat":
        return _with_line_ends(_chat_stream(turn, call, model, include_usage, usage_fault), crlf)
    if family == "responses":
        return _with_line_ends(_responses_stream(turn, call, model, usage_fault), crlf)
    if family == "messages":
        return _with_line_ends(_messages_stream(turn, call, model, usage_fault), crlf)
    return _with_line_ends(_google_stream(turn, call, model, cumulative_usage, usage_fault), crlf)


def _with_line_ends(chunks: list[bytes], crlf: bool) -> list[bytes]:
    return [chunk.replace(b"\n", b"\r\n") for chunk in chunks] if crlf else chunks
