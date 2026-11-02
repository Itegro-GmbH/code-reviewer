# SPDX-License-Identifier: LicenseRef-Proprietary

"""The generic wire fakes' answer builders (#546): four provider formats, one place for the usage.

`fakes/wire/formats.py` writes what a provider of each family answers (OpenAI Chat, OpenAI
Responses, Anthropic Messages, Google Generative Language), as one JSON document and as the stream
of server-sent events, with a distinct usage per call. These tests pin where the usage sits in each
shape, because the passthrough proxy and its usage parsers (#550, #551) are built against exactly
that. The shapes follow the providers' documented formats; a real answer is still the live test of
#546 (see docs/spike/544-passthrough.md, "Open").
"""

import json
import sys
from pathlib import Path
from typing import Any, cast

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import (
    AUTH_HEADER,
    FAMILIES,
    Family,
    Turn,
    answer,
    error_body,
    error_event,
    parse_sse,
    request_path,
    request_tool_names,
    stream,
    usage_for,
)

MODEL = "acme-model-9"
READ = Turn(tool="read", args={"filePath": "src/app.py"})
FINAL = Turn(text="all done")


def events(family: Family, turn: Turn, call: int = 3) -> list[tuple[str | None, Any]]:
    return parse_sse(stream(family, turn, call, MODEL))


# #546-T10
def test_every_family_has_its_own_auth_header() -> None:
    assert AUTH_HEADER == {
        "chat": "authorization",
        "responses": "authorization",
        "messages": "x-api-key",
        "google": "x-goog-api-key",
    }
    assert FAMILIES == ("chat", "responses", "messages", "google")


# #546-T10
def test_each_call_reports_a_different_usage() -> None:
    first, second = usage_for(1), usage_for(2)

    assert first != second
    assert first.input > first.cache_read > 0


# #546-T02
def test_a_chat_answer_carries_its_usage_in_the_usage_object() -> None:
    usage = usage_for(3)

    document = answer("chat", READ, 3, MODEL)

    assert document["usage"] == {
        "prompt_tokens": usage.input,
        "completion_tokens": usage.output,
        "total_tokens": usage.input + usage.output,
        "prompt_tokens_details": {"cached_tokens": usage.cache_read},
        "completion_tokens_details": {"reasoning_tokens": usage.reasoning},
    }
    call = document["choices"][0]["message"]["tool_calls"][0]["function"]
    assert call["name"] == "read"
    assert json.loads(call["arguments"]) == {"filePath": "src/app.py"}


# #546-T02
def test_a_chat_stream_reports_usage_in_a_last_chunk_without_choices() -> None:
    usage = usage_for(3)

    chunks = [data for _, data in events("chat", FINAL)]

    assert chunks[-1] == "[DONE]"
    last = chunks[-2]
    assert last["choices"] == []
    assert last["usage"]["prompt_tokens"] == usage.input
    assert all("usage" not in chunk for chunk in chunks[:-2])
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks[:-2])
    assert text == "all done"


# #546-T02
def test_a_responses_answer_and_stream_report_usage_with_input_and_output_tokens() -> None:
    usage = usage_for(3)
    expected = {
        "input_tokens": usage.input,
        "input_tokens_details": {"cached_tokens": usage.cache_read},
        "output_tokens": usage.output,
        "output_tokens_details": {"reasoning_tokens": usage.reasoning},
        "total_tokens": usage.input + usage.output,
    }

    document = answer("responses", READ, 3, MODEL)
    sequence = events("responses", READ)

    assert document["usage"] == expected
    assert document["output"][0]["type"] == "function_call"
    names = [name for name, _ in sequence]
    assert names[0] == "response.created"
    assert names[-1] == "response.completed"
    assert sequence[-1][1]["response"]["usage"] == expected


# #546-T02
# The shape Anthropic documents for streaming: `message_delta` is cumulative and repeats the input
# and cache fields next to the real `output_tokens`; `ping` follows the first block's start.
def test_a_messages_stream_splits_the_usage_over_message_start_and_message_delta() -> None:
    usage = usage_for(3)

    sequence = events("messages", FINAL)

    names = [name for name, _ in sequence]
    assert names[0] == "message_start" and names[-1] == "message_stop"
    start = sequence[0][1]["message"]["usage"]
    assert start["input_tokens"] == usage.input
    assert start["cache_read_input_tokens"] == usage.cache_read
    assert start["cache_creation"] == {
        "ephemeral_5m_input_tokens": usage.cache_write_5m,
        "ephemeral_1h_input_tokens": usage.cache_write_1h,
    }
    assert start["cache_creation_input_tokens"] == usage.cache_write_5m + usage.cache_write_1h
    delta = next(data for name, data in sequence if name == "message_delta")
    assert delta["usage"]["output_tokens"] == usage.output
    assert delta["usage"]["input_tokens"] == usage.input
    assert delta["usage"]["cache_read_input_tokens"] == usage.cache_read
    assert delta["usage"]["cache_creation"] == start["cache_creation"]
    assert delta["usage"]["server_tool_use"] == {"web_search_requests": 0, "web_fetch_requests": 0}
    assert delta["delta"]["stop_reason"] == "end_turn"
    assert "ping" in names


# #546-T02
def test_a_messages_answer_has_the_whole_usage_and_the_tool_use_block() -> None:
    usage = usage_for(3)

    document = answer("messages", READ, 3, MODEL)

    assert document["usage"]["output_tokens"] == usage.output
    assert document["usage"]["cache_creation"]["ephemeral_1h_input_tokens"] == usage.cache_write_1h
    assert document["stop_reason"] == "tool_use"
    assert [block["caller"] for block in document["content"] if block["type"] == "tool_use"] == [
        {"type": "direct"}
    ]
    block = document["content"][0]
    assert (block["type"], block["name"], block["input"]) == (
        "tool_use",
        "read",
        {"filePath": "src/app.py"},
    )


# #546-T02
# ASSUMPTION (unconfirmed live): the default Google stream states the usage once, on the last chunk.
def test_a_google_stream_states_the_usage_only_in_the_last_chunk() -> None:
    usage = usage_for(3)

    chunks = [data for _, data in events("google", READ)]

    assert len(chunks) == 2
    assert "usageMetadata" not in chunks[0]
    assert chunks[1]["usageMetadata"] == {
        "promptTokenCount": usage.input,
        "candidatesTokenCount": usage.output,
        "totalTokenCount": usage.input + usage.output + usage.reasoning,
        "cachedContentTokenCount": usage.cache_read,
        "thoughtsTokenCount": usage.reasoning,
    }
    assert chunks[1]["candidates"][0]["finishReason"] == "STOP"
    part = chunks[0]["candidates"][0]["content"]["parts"][0]
    assert part == {"functionCall": {"name": "read", "args": {"filePath": "src/app.py"}}}


# #546-T01
def test_a_thinking_turn_puts_the_thought_before_the_tool_call_where_the_family_has_one() -> None:
    turn = Turn(tool="read", args={}, thinking="let me look")

    messages = answer("messages", turn, 4, MODEL)["content"]
    google = answer("google", turn, 4, MODEL)["candidates"][0]["content"]["parts"]

    assert [block["type"] for block in messages] == ["thinking", "tool_use"]
    assert messages[0]["signature"] == "sig-4"
    assert google[0] == {"text": "let me look", "thought": True}
    assert google[1]["thoughtSignature"] == "tsig-read"


# #546-T09
@pytest.mark.parametrize(
    ("family", "streaming", "expected"),
    [
        ("chat", True, "/v1/chat/completions"),
        ("responses", True, "/v1/responses"),
        ("messages", True, "/v1/messages"),
        ("google", True, f"/v1beta/models/{MODEL}:streamGenerateContent"),
        ("google", False, f"/v1beta/models/{MODEL}:generateContent"),
    ],
)
def test_the_path_of_a_family_names_the_model_only_for_google(
    family: Family, streaming: bool, expected: str
) -> None:
    assert request_path(family, MODEL, streaming=streaming) == expected


# #546-T09
def test_the_tools_a_request_offers_are_found_in_every_family() -> None:
    names = ["read", "grep"]
    bodies: dict[Family, dict[str, Any]] = {
        "chat": {"tools": [{"type": "function", "function": {"name": n}} for n in names]},
        "responses": {"tools": [{"type": "function", "name": n} for n in names]},
        "messages": {"tools": [{"name": n, "input_schema": {}} for n in names]},
        "google": {"tools": [{"functionDeclarations": [{"name": n} for n in names]}]},
    }

    for family, body in bodies.items():
        assert request_tool_names(family, body) == names
        assert request_tool_names(family, {}) == []


# #546-T07
def test_an_error_body_has_the_envelope_of_its_provider() -> None:
    assert error_body("chat", 429)["error"]["message"]
    assert error_body("responses", 500)["error"]["message"]
    assert error_body("google", 429)["error"]["status"] == "RESOURCE_EXHAUSTED"


# #546-T07
@pytest.mark.parametrize(
    ("status", "kind"),
    [
        (429, "rate_limit_error"),
        (500, "api_error"),
        (529, "overloaded_error"),
        (401, "authentication_error"),
        (404, "not_found_error"),
    ],
)
def test_a_messages_error_names_its_type_after_the_status(status: int, kind: str) -> None:
    assert error_body("messages", status)["error"]["type"] == kind


# #546-T07
def test_an_error_body_can_quote_a_detail_such_as_the_key_the_request_carried() -> None:
    for family in FAMILIES:
        assert "sk-quoted" in error_body(family, 401, "(key: sk-quoted)")["error"]["message"]


# #546-T02
def test_a_chat_stream_has_no_usage_chunk_unless_the_request_asked_for_the_usage() -> None:
    plain = parse_sse(stream("chat", READ, 3, MODEL, include_usage=False))

    assert all("usage" not in data for _, data in plain[:-1])
    assert plain[-1] == (None, "[DONE]")
    assert all(data.get("choices") for _, data in plain[:-1])
    asked = parse_sse(stream("chat", READ, 3, MODEL, include_usage=True))
    assert len(asked) == len(plain) + 1


# #546-T02
# ASSUMPTION (unconfirmed live): Gemini repeats `usageMetadata` on every chunk, cumulatively.
def test_a_google_stream_can_state_the_usage_cumulatively_on_every_chunk() -> None:
    usage = usage_for(3)

    chunks = [
        data for _, data in parse_sse(stream("google", READ, 3, MODEL, cumulative_usage=True))
    ]

    assert len(chunks) == 2
    first, last = chunks[0]["usageMetadata"], chunks[1]["usageMetadata"]
    assert first["promptTokenCount"] == last["promptTokenCount"] == usage.input
    assert first["candidatesTokenCount"] < last["candidatesTokenCount"] == usage.output
    assert last == answer("google", FINAL, 3, MODEL)["usageMetadata"]


# #546-T02
@pytest.mark.parametrize("family", FAMILIES)
def test_a_stream_can_use_crlf_line_ends_and_still_parses_the_same(family: Family) -> None:
    plain = stream(family, READ, 3, MODEL)
    crlf = stream(family, READ, 3, MODEL, crlf=True)

    assert all(chunk.endswith(b"\r\n\r\n") and b"\r\n" in chunk for chunk in crlf)
    assert all(b"\r\n" not in chunk for chunk in plain)
    assert parse_sse(crlf) == parse_sse(plain)


# #546-T07
# ASSUMPTION (unconfirmed live): the shapes of the error that arrives inside a 200 stream.
@pytest.mark.parametrize(
    ("family", "name"),
    [("messages", "error"), ("responses", "error"), ("chat", None), ("google", None)],
)
def test_an_error_event_is_one_complete_event_that_holds_an_error(
    family: Family, name: str | None
) -> None:
    ((event, data),) = parse_sse([error_event(family, "boom")])

    assert event == name
    assert "boom" in json.dumps(data)
    assert "error" in data or data["type"] == "error"


# -- the usage faults of the generic fakes (#551) ------------------------------------------------


def keys_anywhere(value: Any) -> set[str]:
    """Every object key at any depth of a JSON value."""
    found: set[str] = set()
    if isinstance(value, dict):
        for key, inner in value.items():  # pyright: ignore[reportUnknownVariableType]
            found.add(str(key))  # pyright: ignore[reportUnknownArgumentType]
            found |= keys_anywhere(inner)
    elif isinstance(value, list):
        for inner in value:  # pyright: ignore[reportUnknownVariableType]
            found |= keys_anywhere(inner)
    return found


def usage_of_events(family: Family, call: int, **options: Any) -> list[Any]:
    """The usage objects a stream states, in order: `usage`, `usageMetadata`, never the text."""
    found: list[Any] = []
    for _, data in parse_sse(stream(family, READ, call, MODEL, **options)):
        if not isinstance(data, dict):
            continue
        fields = cast("dict[str, Any]", data)
        holders: list[object] = [fields, fields.get("message"), fields.get("response")]
        for holder in holders:
            if isinstance(holder, dict):
                for key in ("usage", "usageMetadata"):
                    if key in holder:
                        found.append(cast("dict[str, Any]", holder)[key])
    return found


# #551-F01
@pytest.mark.parametrize("family", FAMILIES)
def test_no_fault_is_the_default_and_changes_nothing(family: Family) -> None:
    assert answer(family, READ, 3, MODEL, usage_fault=None) == answer(family, READ, 3, MODEL)
    assert stream(family, READ, 3, MODEL, usage_fault=None) == stream(family, READ, 3, MODEL)


# #551-F01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_missing_usage_is_left_out_of_the_answer_and_of_the_stream(family: Family) -> None:
    document = answer(family, READ, 3, MODEL, usage_fault="missing")
    assert not {"usage", "usageMetadata"} & set(document)
    assert usage_of_events(family, 3, usage_fault="missing") == []
    # The rest of the answer is untouched: it is a complete answer that states no usage.
    clean = answer(family, READ, 3, MODEL)
    assert {k: v for k, v in clean.items() if k not in ("usage", "usageMetadata")} == document
    # Chat states its usage in a chunk of its own; the others in an event they send anyway.
    left_out = 1 if family == "chat" else 0
    assert len(stream(family, READ, 3, MODEL, usage_fault="missing")) == (
        len(stream(family, READ, 3, MODEL)) - left_out
    )


# #551-F01
@pytest.mark.parametrize("family", FAMILIES)
def test_an_unknown_usage_field_adds_one_field_that_holds_something(family: Family) -> None:
    clean = usage_for(3)
    assert clean.input > 0
    faulty = answer(family, READ, 3, MODEL, usage_fault="unknown_field")
    plain = answer(family, READ, 3, MODEL)
    key = "usageMetadata" if family == "google" else "usage"
    added = keys_anywhere(faulty[key]) - keys_anywhere(plain[key])
    assert len(added) >= 1
    # The same one is in the stream.
    in_stream = usage_of_events(family, 3, usage_fault="unknown_field")
    assert any(keys_anywhere(item) >= added for item in in_stream)


# #551-F01
@pytest.mark.parametrize("family", FAMILIES)
def test_a_bad_value_changes_one_count_of_the_usage_into_something_that_is_no_count(
    family: Family,
) -> None:
    key = "usageMetadata" if family == "google" else "usage"
    faulty = answer(family, READ, 3, MODEL, usage_fault="bad_value")[key]
    plain = answer(family, READ, 3, MODEL)[key]
    assert faulty != plain
    assert keys_anywhere(faulty) == keys_anywhere(plain)
    assert usage_of_events(family, 3, usage_fault="bad_value") != usage_of_events(family, 3)


# -- the faults of the order of the usage (#551, review of PR #569) ------------------------------

ORDERED_FAMILIES = ("chat", "messages", "google")


def output_of(family: Family, usage: Any) -> int:
    key = {
        "chat": "completion_tokens",
        "responses": "output_tokens",
        "messages": "output_tokens",
        "google": "candidatesTokenCount",
    }[family]
    return cast("int", usage[key])


# #551-R569-F03
@pytest.mark.parametrize("family", FAMILIES)
def test_a_duplicate_usage_is_stated_a_second_time_with_a_lower_count_in_a_stream(
    family: Family,
) -> None:
    healthy = usage_of_events(family, 3)
    replayed = usage_of_events(family, 3, usage_fault="duplicate")
    assert len(replayed) == len(healthy) + 1
    assert replayed[: len(healthy)] == healthy
    # A replay of an older count: the same usage with less output.
    assert output_of(family, replayed[-1]) == output_of(family, healthy[-1]) - 1


# #551-R569-F03
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("fault", ["duplicate", "out_of_order"])
def test_a_fault_of_the_order_of_the_usage_leaves_a_whole_document_as_it_is(
    family: Family, fault: str
) -> None:
    if (family, fault) == ("responses", "out_of_order"):
        pytest.skip("a Responses stream states its usage once, in its last event")
    assert answer(family, READ, 3, MODEL, usage_fault=fault) == answer(family, READ, 3, MODEL)  # type: ignore[arg-type]


# #551-R569-F03
def test_a_chat_usage_out_of_order_comes_before_the_chunk_that_finishes() -> None:
    parsed = events("chat", READ)
    out_of_order = parse_sse(stream("chat", READ, 3, MODEL, usage_fault="out_of_order"))
    assert sorted(map(json.dumps, out_of_order)) == sorted(map(json.dumps, parsed))
    where_usage = next(i for i, (_, d) in enumerate(out_of_order) if d != "[DONE]" and "usage" in d)
    where_finish = next(
        i
        for i, (_, d) in enumerate(out_of_order)
        if d != "[DONE]" and any(c.get("finish_reason") for c in d["choices"])
    )
    assert where_usage < where_finish


# #551-R569-F03
def test_a_messages_delta_out_of_order_comes_before_the_message_start() -> None:
    names = [
        name
        for name, _ in parse_sse(stream("messages", READ, 3, MODEL, usage_fault="out_of_order"))
    ]
    assert names.index("message_delta") < names.index("message_start")
    assert sorted(map(str, names)) == sorted(str(name) for name, _ in events("messages", READ))


# #551-R569-F03
def test_a_google_stream_out_of_order_ends_with_the_chunk_that_states_less() -> None:
    healthy = usage_of_events("google", 3, cumulative_usage=True)
    swapped = usage_of_events("google", 3, cumulative_usage=True, usage_fault="out_of_order")
    assert swapped == healthy[::-1]
    assert output_of("google", swapped[-1]) < output_of("google", swapped[0])


# #551-R569-F03
def test_a_responses_stream_has_no_order_of_the_usage_to_break() -> None:
    with pytest.raises(ValueError):
        stream("responses", READ, 3, MODEL, usage_fault="out_of_order")
