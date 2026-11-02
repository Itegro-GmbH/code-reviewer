# SPDX-License-Identifier: LicenseRef-Proprietary

"""The closed schema of a request body per wire family (#550, B1 of the security review).

The engine is hostile: it is driven by an untrusted model that reads untrusted repository content.
A body that names the job's model and a small output cap is not yet a body the job may send: the
provider would also serve server-side tools (web search, code execution, MCP servers), fetch the
URL in an image part, bill several choices for one request or route to another model. So the body
is walked against a closed schema of what protects money, the key and the way out, and anything
else is `request_not_allowed`. The base of every case here is a body the real pinned OpenCode sent
(`fakes/wire/engine_requests.json`, captured by the engine test); each case changes one thing.

**The conversation is opaque** (a deliberate decision of the owner, #810): what is inside
`messages`, `input`, `contents`, `system` and `systemInstruction` is the engine's and the
provider's business.
The first closed walk refused a healthy second call of a real Sonnet run because the SDK replays the
`caller` of a `tool_use` block. The closed items below (top-level keys, tools, the model pin, the
output cap, `stream`, the numbers) each have a test, and the mutation checks of the PR break them.
"""

import copy
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.dynamic_review.passthrough.admission import (
    Admission,
    PassthroughTarget,
    RefusalCode,
    Refused,
)
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of

CAPTURED: dict[str, dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[3] / "fakes" / "wire" / "engine_requests.json").read_text()
)
KEY = {
    WireFamily.OPENAI_CHAT: "chat",
    WireFamily.OPENAI_RESPONSES: "responses",
    WireFamily.ANTHROPIC_MESSAGES: "messages",
    WireFamily.GOOGLE: "google",
}
ALLOWANCE = 8192
CAPABILITY = "c" * 43
FAMILIES = list(WireFamily)
Mutation = Callable[[dict[str, Any]], None]


def model_of(family: WireFamily) -> str:
    return "acme-google-9" if family is WireFamily.GOOGLE else CAPTURED[KEY[family]]["model"]


def captured(family: WireFamily) -> dict[str, Any]:
    return copy.deepcopy(CAPTURED[KEY[family]])


def admit(family: WireFamily, document: dict[str, Any]) -> Any:
    target = PassthroughTarget(family=family, model=model_of(family), output_allowance=ALLOWANCE)
    admission = Admission(target, CAPABILITY)
    body = json.dumps(document).encode()
    head = admission.head(
        "POST",
        spec_of(family).engine_target(model_of(family)),
        [
            (spec_of(family).key_header, spec_of(family).key_value(CAPABILITY)),
            ("content-type", "application/json"),
            ("content-length", str(len(body))),
        ],
        8 * 1024 * 1024,
    )
    return admission.body(head, body)


def refused(family: WireFamily, document: dict[str, Any]) -> Refused:
    with pytest.raises(Refused) as raised:
        admit(family, document)
    return raised.value


def cap_path(family: WireFamily) -> tuple[str, ...]:
    return {
        WireFamily.OPENAI_CHAT: ("max_tokens",),
        WireFamily.OPENAI_RESPONSES: ("max_output_tokens",),
        WireFamily.ANTHROPIC_MESSAGES: ("max_tokens",),
        WireFamily.GOOGLE: ("generationConfig", "maxOutputTokens"),
    }[family]


def set_at(document: dict[str, Any], path: tuple[str, ...], value: Any) -> None:
    node = document
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value


# -- what the real engine sends passes, byte for byte --


# #550-B1-S01
@pytest.mark.parametrize("family", FAMILIES)
def test_the_body_the_real_engine_sends_passes_and_is_forwarded_byte_for_byte(
    family: WireFamily,
) -> None:
    document = captured(family)
    body = json.dumps(document).encode()
    admitted = admit(family, document)
    assert admitted.body == body
    assert admitted.output_cap == ALLOWANCE


# #550-B1-S02
@pytest.mark.parametrize("family", FAMILIES)
def test_the_sampling_and_stream_options_of_the_engine_are_numbers_and_flags_only(
    family: WireFamily,
) -> None:
    document = captured(family)
    if family is WireFamily.GOOGLE:
        document["generationConfig"].update({"temperature": 1.0, "topP": 0.95, "topK": 64})
        document["generationConfig"]["thinkingConfig"] = {
            "includeThoughts": True,
            "thinkingLevel": "high",
        }
    else:
        document.update({"temperature": 0.55, "top_p": 0.9})
    assert admit(family, document).body


# -- B1: nothing but the keys the engine sends --


TOP_LEVEL_FORBIDDEN: dict[str, Any] = {
    "service_tier": "flex",
    "background": True,
    "previous_response_id": "resp_1",
    "cachedContent": "cachedContents/1",
    "provider": {"order": ["other"]},
    "models": ["other-model"],
    "route": "fallback",
    "plugins": [{"id": "web"}],
    "transforms": ["middle-out"],
    "web_search_options": {},
    "mcp_servers": [{"type": "url", "url": "https://evil.example/mcp", "name": "x"}],
    "container": {"id": "c1"},
    "metadata": {"user_id": "u"},
    "user": "someone",
    "stop": ["x"],
    "response_format": {"type": "json_object"},
    "logprobs": True,
    "safetySettings": [],
    "unknown_future_field": 1,
    # Messages options that change what is paid or where data goes (#810).
    "context_management": {"edits": [{"type": "clear_tool_uses_20250919"}]},
    "speed": "fast",
    "inference_geo": "us",
    "output_config": {"effort": "max"},
    "cache_control": {"type": "ephemeral", "ttl": "1h"},
    "fallbacks": ["other-model"],
    "stop_sequences": ["x"],
}


# #550-B1-S03
@pytest.mark.parametrize("name", TOP_LEVEL_FORBIDDEN)
@pytest.mark.parametrize("family", FAMILIES)
def test_a_top_level_key_the_engine_does_not_send_is_refused(family: WireFamily, name: str) -> None:
    document = captured(family)
    document[name] = TOP_LEVEL_FORBIDDEN[name]
    error = refused(family, document)
    assert (error.status, error.code) == (403, RefusalCode.REQUEST_NOT_ALLOWED)


# #550-B1-S04
@pytest.mark.parametrize("family", FAMILIES)
def test_a_key_that_differs_from_a_known_one_only_in_case_is_refused(family: WireFamily) -> None:
    for known in list(captured(family)):
        for spelling in (known.upper(), known.capitalize(), known.swapcase()):
            if spelling == known:
                continue
            document = captured(family)
            document[spelling] = document[known]
            assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED
            # Neither does the other spelling stand in for the real one.
            document = captured(family)
            document[spelling] = document.pop(known)
            if known == "model" and family is not WireFamily.GOOGLE:
                assert refused(family, document).code in (
                    RefusalCode.REQUEST_NOT_ALLOWED,
                    RefusalCode.MODEL_NOT_ALLOWED,
                )
            else:
                assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-B1-S05
def test_the_model_of_a_google_body_is_not_a_key_of_the_body() -> None:
    document = captured(WireFamily.GOOGLE)
    document["model"] = "models/other"
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# -- B1: function tools only --

SERVER_TOOLS: dict[WireFamily, list[dict[str, Any]]] = {
    WireFamily.OPENAI_CHAT: [
        {"type": "web_search"},
        {"type": "openrouter:web_search"},
        {"type": "openrouter:datetime"},
        {"type": "mcp", "server_url": "https://evil.example/mcp"},
        {"type": "code_interpreter"},
        {"function": {"name": "x", "parameters": {}}},
        {"type": "function"},
        {"type": "function", "function": {"name": "x", "parameters": {}}, "extra": 1},
    ],
    WireFamily.OPENAI_RESPONSES: [
        {"type": "web_search_preview"},
        {"type": "web_search"},
        {"type": "file_search", "vector_store_ids": ["v"]},
        {"type": "mcp", "server_label": "x", "server_url": "https://evil.example/mcp"},
        {"type": "code_interpreter", "container": {"type": "auto"}},
        {"type": "computer_use_preview", "display_width": 1, "display_height": 1},
        {"type": "image_generation"},
        {"name": "x", "parameters": {}},
    ],
    WireFamily.ANTHROPIC_MESSAGES: [
        {"type": "web_search_20250305", "name": "web_search"},
        {"type": "web_fetch_20250910", "name": "web_fetch"},
        {"type": "code_execution_20250522", "name": "code_execution"},
        {"type": "computer_20250124", "name": "computer"},
        {"type": "bash_20250124", "name": "bash"},
        {"type": "text_editor_20250124", "name": "str_replace_editor"},
        {"type": "mcp", "name": "x"},
        {"name": "x"},
    ],
    WireFamily.GOOGLE: [
        {"googleSearch": {}},
        {"googleSearchRetrieval": {}},
        {"urlContext": {}},
        {"codeExecution": {}},
        {"computerUse": {}},
        {"functionDeclarations": [{"name": "x"}], "googleSearch": {}},
        {"functionDeclarations": [{"name": "x", "extra": 1}]},
    ],
}


def _with_extra_tool(family: WireFamily, tool: dict[str, Any]) -> dict[str, Any]:
    document = captured(family)
    document["tools"].append(tool)
    return document


# #550-B1-S06
@pytest.mark.parametrize(
    ("family", "tool"),
    [(family, tool) for family, tools in SERVER_TOOLS.items() for tool in tools],
    ids=lambda value: json.dumps(value)[:50] if isinstance(value, dict) else value.value,
)
def test_a_tool_that_is_not_a_plain_function_tool_is_refused(
    family: WireFamily, tool: dict[str, Any]
) -> None:
    assert refused(family, _with_extra_tool(family, tool)).code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-B1-S07
def test_a_messages_tool_may_name_itself_custom() -> None:
    document = captured(WireFamily.ANTHROPIC_MESSAGES)
    document["tools"][0]["type"] = "custom"
    assert admit(WireFamily.ANTHROPIC_MESSAGES, document).body


# #550-B1-S08
@pytest.mark.parametrize("family", FAMILIES)
def test_tools_that_are_not_a_list_of_objects_are_refused(family: WireFamily) -> None:
    bad_tools: list[Any] = ["web_search", {"type": "function"}, [1], [[]], [None]]
    for bad in bad_tools:
        document = captured(family)
        document["tools"] = bad
        assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# -- B1: content parts --

URL = "https://evil.example/leak.png"
HOLDER = {
    WireFamily.OPENAI_CHAT: "messages",
    WireFamily.OPENAI_RESPONSES: "input",
    WireFamily.ANTHROPIC_MESSAGES: "messages",
    WireFamily.GOOGLE: "contents",
}


def _chat_part(part: dict[str, Any]) -> Mutation:
    return lambda document: document["messages"][1].__setitem__("content", [part])


def _responses_part(part: dict[str, Any]) -> Mutation:
    return lambda document: document["input"][1].__setitem__("content", [part])


def _messages_part(part: dict[str, Any]) -> Mutation:
    return lambda document: document["messages"][0].__setitem__("content", [part])


def _google_part(part: dict[str, Any]) -> Mutation:
    return lambda document: document["contents"][0].__setitem__("parts", [part])


PARTS: dict[WireFamily, list[Mutation]] = {
    WireFamily.OPENAI_CHAT: [
        _chat_part({"type": "image_url", "image_url": {"url": URL}}),
        _chat_part({"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}),
        _chat_part({"type": "input_audio", "input_audio": {"data": "AAAA", "format": "wav"}}),
        _chat_part({"type": "file", "file": {"file_id": "f1"}}),
        _chat_part({"type": "text", "text": "hi", "image_url": URL}),
        _chat_part({"type": "refusal", "refusal": "no"}),
    ],
    WireFamily.OPENAI_RESPONSES: [
        _responses_part({"type": "input_image", "image_url": URL}),
        _responses_part({"type": "input_image", "image_url": "data:image/png;base64,AAAA"}),
        _responses_part({"type": "input_file", "file_url": URL}),
        _responses_part({"type": "input_file", "file_id": "f1"}),
        _responses_part({"type": "input_text", "text": "hi", "file_url": URL}),
    ],
    WireFamily.ANTHROPIC_MESSAGES: [
        _messages_part({"type": "image", "source": {"type": "url", "url": URL}}),
        _messages_part(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
            }
        ),
        _messages_part({"type": "document", "source": {"type": "url", "url": URL}}),
        _messages_part({"type": "document", "source": {"type": "file", "file_id": "f1"}}),
        _messages_part({"type": "server_tool_use", "id": "s", "name": "web_search", "input": {}}),
        _messages_part({"type": "web_search_tool_result", "tool_use_id": "s", "content": []}),
        _messages_part({"type": "mcp_tool_use", "id": "m", "name": "x", "server_name": "y"}),
        _messages_part({"type": "text", "text": "hi", "citations": [{"url": URL}]}),
    ],
    WireFamily.GOOGLE: [
        _google_part({"fileData": {"fileUri": URL, "mimeType": "image/png"}}),
        _google_part({"fileData": {"fileUri": "gs://bucket/object"}}),
        _google_part({"inlineData": {"mimeType": "image/png", "data": "AAAA"}}),
        _google_part({"executableCode": {"language": "PYTHON", "code": "1"}}),
        _google_part({"codeExecutionResult": {"outcome": "OUTCOME_OK", "output": ""}}),
        _google_part({"text": "hi", "fileData": {"fileUri": URL}}),
        _google_part({"videoMetadata": {}}),
    ],
}


# #810-S09 (was #550-B1-S09: every one of these was refused; the conversation is opaque now)
@pytest.mark.parametrize(
    ("family", "index"),
    [(family, index) for family, parts in PARTS.items() for index in range(len(parts))],
)
def test_a_content_part_of_any_kind_inside_the_conversation_is_the_providers_business(
    family: WireFamily, index: int
) -> None:
    document = captured(family)
    PARTS[family][index](document)
    assert admit(family, document).body


# #550-B1-S10
@pytest.mark.parametrize("family", FAMILIES)
def test_no_url_reaches_the_provider_in_a_part_even_inside_the_tool_exchange(
    family: WireFamily,
) -> None:
    """A URL as text is text; a URL in a field the provider would fetch is refused."""
    document = captured(family)
    text = "see https://example.com/doc for details"
    if family is WireFamily.OPENAI_CHAT:
        document["messages"][1]["content"] = text
    elif family is WireFamily.OPENAI_RESPONSES:
        document["input"][1]["content"] = [{"type": "input_text", "text": text}]
    elif family is WireFamily.ANTHROPIC_MESSAGES:
        document["messages"][0]["content"] = [{"type": "text", "text": text}]
    else:
        document["contents"][0]["parts"] = [{"text": text}]
    assert admit(family, document).body


# #810-S11 (was #550-B1-S11)
@pytest.mark.parametrize("family", FAMILIES)
def test_a_message_with_a_role_or_key_the_engine_does_not_use_is_the_providers_business(
    family: WireFamily,
) -> None:
    holder = HOLDER[family]
    mutations: list[Callable[[dict[str, Any]], object]] = [
        lambda message: message.__setitem__("role", "root"),
        lambda message: message.__setitem__("attachments", [URL]),
        lambda message: message.pop("role"),
    ]
    for mutate in mutations:
        document = captured(family)
        mutate(next(message for message in document[holder] if "role" in message))
        assert admit(family, document).body


# #550-B1-S12
@pytest.mark.parametrize("family", FAMILIES)
def test_the_conversation_must_be_a_list_of_objects(family: WireFamily) -> None:
    holder = HOLDER[family]
    for bad in ("hello", {"role": "user"}, [1], ["hello"], None):
        document = captured(family)
        document[holder] = bad
        assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# -- B1: one choice, nothing stored, no routing --


# #550-B1-S13
@pytest.mark.parametrize("value", [2, 0, -1, 1.5, True, "1", None])
def test_n_is_absent_or_exactly_one(value: Any) -> None:
    document = captured(WireFamily.OPENAI_CHAT)
    document["n"] = value
    assert refused(WireFamily.OPENAI_CHAT, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    document["n"] = 1
    assert admit(WireFamily.OPENAI_CHAT, document).body


# #550-B1-S14
@pytest.mark.parametrize("value", [2, 8, 0, 1.5, True, "1", None])
def test_candidate_count_is_absent_or_exactly_one(value: Any) -> None:
    document = captured(WireFamily.GOOGLE)
    document["generationConfig"]["candidateCount"] = value
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    document["generationConfig"]["candidateCount"] = 1
    assert admit(WireFamily.GOOGLE, document).body


# #550-B1-S15
@pytest.mark.parametrize("value", [True, "false", 1, None, {"a": 1}])
def test_store_is_absent_or_false(value: Any) -> None:
    for family in (WireFamily.OPENAI_RESPONSES, WireFamily.OPENAI_CHAT):
        document = captured(family)
        document["store"] = value
        assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    document = captured(WireFamily.OPENAI_RESPONSES)
    document["store"] = False
    assert admit(WireFamily.OPENAI_RESPONSES, document).body


# #550-B1-S16
@pytest.mark.parametrize("family", [WireFamily.OPENAI_CHAT, WireFamily.OPENAI_RESPONSES])
def test_a_stream_flag_is_a_boolean(family: WireFamily) -> None:
    for bad in ("true", 1, None, [True]):
        document = captured(family)
        document["stream"] = bad
        assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# -- B1: the output cap, every spelling --

ALIASES: dict[WireFamily, list[tuple[str, ...]]] = {
    WireFamily.OPENAI_CHAT: [("max_output_tokens",), ("max_completion_tokens",)],
    WireFamily.OPENAI_RESPONSES: [("max_tokens",), ("max_completion_tokens",)],
    WireFamily.ANTHROPIC_MESSAGES: [("max_output_tokens",), ("max_completion_tokens",)],
    WireFamily.GOOGLE: [("max_output_tokens",), ("maxOutputTokens",), ("max_tokens",)],
}


# #550-B1-S17
@pytest.mark.parametrize(
    ("family", "alias"),
    [(family, alias) for family, aliases in ALIASES.items() for alias in aliases],
)
def test_a_second_spelling_of_the_output_cap_is_refused_whatever_its_value(
    family: WireFamily, alias: tuple[str, ...]
) -> None:
    for value in (1, ALLOWANCE, 10**9):
        document = captured(family)
        set_at(document, alias, value)
        assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-B1-S18
def test_the_snake_case_spelling_of_the_google_generation_config_is_refused() -> None:
    document = captured(WireFamily.GOOGLE)
    document["generation_config"] = {"max_output_tokens": 10**9}
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    document = captured(WireFamily.GOOGLE)
    document["generation_config"] = {"max_output_tokens": 5}
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    document = captured(WireFamily.GOOGLE)
    document["generationConfig"]["max_output_tokens"] = 10**9
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-B1-S19
def test_both_chat_spellings_of_the_cap_are_refused_even_when_both_are_small() -> None:
    document = captured(WireFamily.OPENAI_CHAT)
    document["max_completion_tokens"] = 10
    assert refused(WireFamily.OPENAI_CHAT, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    del document["max_tokens"]
    assert admit(WireFamily.OPENAI_CHAT, document).output_cap == 10


# #550-B1-S20
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("value", [0, -5, ALLOWANCE + 1, 10**9, 1.5, "100", True, None, [1]])
def test_the_one_output_cap_is_a_count_within_the_allowance(family: WireFamily, value: Any) -> None:
    document = captured(family)
    set_at(document, cap_path(family), value)
    assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-B1-S21
@pytest.mark.parametrize("family", FAMILIES)
def test_a_body_without_an_output_cap_is_refused(family: WireFamily) -> None:
    document = captured(family)
    path = cap_path(family)
    node = document
    for key in path[:-1]:
        node = node[key]
    del node[path[-1]]
    assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# -- B1: the pieces that stay opaque are objects --


# #810-S22 (was #550-B1-S22 and S23: a tool call of another kind, an input item the engine does
# not send)
def test_what_the_engine_replays_of_a_tool_exchange_is_not_walked() -> None:
    document = captured(WireFamily.OPENAI_CHAT)
    assistant = next(m for m in document["messages"] if m.get("tool_calls"))
    assistant["tool_calls"][0]["type"] = "custom"
    assert admit(WireFamily.OPENAI_CHAT, document).body
    for item in (
        {"type": "web_search_call", "id": "w", "status": "completed"},
        {"type": "mcp_call", "id": "m"},
        {"type": "item_reference", "id": "x"},
        {"type": "function_call_output", "call_id": "c", "output": "x", "extra": URL},
    ):
        document = captured(WireFamily.OPENAI_RESPONSES)
        document["input"].append(item)
        assert admit(WireFamily.OPENAI_RESPONSES, document).body


# #550-B1-S24
def test_a_messages_thinking_setting_is_only_the_engines() -> None:
    document = captured(WireFamily.ANTHROPIC_MESSAGES)
    document["thinking"] = {"type": "enabled", "budget_tokens": 10**9}
    assert refused(WireFamily.ANTHROPIC_MESSAGES, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    document["thinking"] = {"type": "adaptive", "mcp": 1}
    assert refused(WireFamily.ANTHROPIC_MESSAGES, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-B1-S25
def test_a_google_function_call_mode_is_the_engines() -> None:
    document = captured(WireFamily.GOOGLE)
    document["toolConfig"]["functionCallingConfig"]["mode"] = "VALIDATED"
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    document = captured(WireFamily.GOOGLE)
    document["toolConfig"]["retrievalConfig"] = {"latLng": {}}
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# -- round 2 of the security review ----


# #550-R2-S2
@pytest.mark.parametrize(
    "family", [WireFamily.OPENAI_CHAT, WireFamily.OPENAI_RESPONSES, WireFamily.ANTHROPIC_MESSAGES]
)
def test_a_body_that_does_not_stream_is_refused_because_the_engine_always_does(
    family: WireFamily,
) -> None:
    for change in ("absent", False):
        document = captured(family)
        if change == "absent":
            del document["stream"]
        else:
            document["stream"] = False
        assert refused(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# #810-R2-S4 (was #550-R2-S4): a one-hour cache write inside the conversation or the system prompt
# is no longer refused by the schema; the price book prices the write the provider states
# (`test_passthrough_usage_settlement.py`). A tool is not the conversation and stays closed.
def test_a_cache_control_ttl_is_the_providers_business_in_the_conversation_but_not_on_a_tool() -> (
    None
):
    document = captured(WireFamily.ANTHROPIC_MESSAGES)
    document["system"][0]["cache_control"]["ttl"] = "1h"
    document["messages"][0]["content"][0]["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    assert admit(WireFamily.ANTHROPIC_MESSAGES, document).body
    document["tools"][0]["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    assert refused(WireFamily.ANTHROPIC_MESSAGES, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# #550-R2-N1
@pytest.mark.parametrize("family", FAMILIES)
@pytest.mark.parametrize("value", [10**400, -(10**400), 10**30, 1e999, -1e999])
def test_a_number_too_large_for_a_float_is_a_refusal_not_a_crash(
    family: WireFamily, value: Any
) -> None:
    document = captured(family)
    if family is WireFamily.GOOGLE:
        document["generationConfig"]["temperature"] = value
    else:
        document["temperature"] = value
    raw = json.dumps(document).replace("Infinity", "1e999").encode()
    target = PassthroughTarget(family=family, model=model_of(family), output_allowance=ALLOWANCE)
    admission = Admission(target, CAPABILITY)
    head = admission.head(
        "POST",
        spec_of(family).engine_target(model_of(family)),
        [
            (spec_of(family).key_header, spec_of(family).key_value(CAPABILITY)),
            ("content-type", "application/json"),
            ("content-length", str(len(raw))),
        ],
        8 * 1024 * 1024,
    )
    with pytest.raises(Refused) as raised:
        admission.body(head, raw)
    assert (raised.value.status, raised.value.code) == (403, RefusalCode.REQUEST_NOT_ALLOWED)
    assert raised.value.error.value == "dynamic_policy_violation"


# #550-R2-N2
@pytest.mark.parametrize("budget", [ALLOWANCE + 1, 10**9, -1, 1.5, True, "1000"])
def test_a_google_thinking_budget_above_the_allowance_is_refused(budget: Any) -> None:
    document = captured(WireFamily.GOOGLE)
    document["generationConfig"]["thinkingConfig"] = {"thinkingBudget": budget}
    assert refused(WireFamily.GOOGLE, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    for fine in (0, 1, ALLOWANCE):
        document["generationConfig"]["thinkingConfig"] = {"thinkingBudget": fine}
        assert admit(WireFamily.GOOGLE, document).body
