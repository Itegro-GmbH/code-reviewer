# SPDX-License-Identifier: LicenseRef-Proprietary

"""The conversation is opaque, what pays or leaks stays closed, and a refusal names its path (#810).

The first live run of the Implementer on a real Anthropic key made one good model call and was
refused at the second: the SDK of the pinned engine replays the `caller` of a `tool_use` block
(`{"type": "direct"}`, which the real API states on every one), and the closed walk of the message
did not know the key. The owner decided: the proxy guards money, the key and the way out, and
leaves the conversation alone. These tests are that decision, each closed item once more, the
diagnostics (the path of what failed, never a value) and the readers that must survive any shape.
"""

import copy
import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from passthrough_support import MODEL, rig, streamed

from code_reviewer_runner.dynamic_review.passthrough.admission import (
    Admission,
    PassthroughTarget,
    RefusalCode,
    Refused,
)
from code_reviewer_runner.dynamic_review.passthrough.body_schema import NotAllowed, check_body
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.dynamic_review.passthrough.last_user import last_user_text
from code_reviewer_runner.result import ErrorCode

CAPTURED: dict[str, dict[str, Any]] = json.loads(
    (Path(__file__).resolve().parents[3] / "fakes" / "wire" / "engine_requests.json").read_text()
)
MESSAGES = WireFamily.ANTHROPIC_MESSAGES
ALLOWANCE = 8192
CAPABILITY = "c" * 43
HOLDER = {
    WireFamily.OPENAI_CHAT: "messages",
    WireFamily.OPENAI_RESPONSES: "input",
    WireFamily.ANTHROPIC_MESSAGES: "messages",
    WireFamily.GOOGLE: "contents",
}
KEY = {
    WireFamily.OPENAI_CHAT: "chat",
    WireFamily.OPENAI_RESPONSES: "responses",
    WireFamily.ANTHROPIC_MESSAGES: "messages",
    WireFamily.GOOGLE: "google",
}
SECRET = "THE-VALUE-OF-A-KEY-MUST-NEVER-BE-LOGGED-0123456789"


def captured(family: WireFamily) -> dict[str, Any]:
    return copy.deepcopy(CAPTURED[KEY[family]])


def model_of(family: WireFamily) -> str:
    return "acme-google-9" if family is WireFamily.GOOGLE else CAPTURED[KEY[family]]["model"]


def admission(family: WireFamily) -> Admission:
    target = PassthroughTarget(family=family, model=model_of(family), output_allowance=ALLOWANCE)
    return Admission(target, CAPABILITY)


def head_of(family: WireFamily, body: bytes, *extra: tuple[str, str]) -> Any:
    spec = spec_of(family)
    return admission(family).head(
        "POST",
        spec.engine_target(model_of(family)),
        [
            (spec.key_header, spec.key_value(CAPABILITY)),
            ("content-type", "application/json"),
            ("content-length", str(len(body))),
            *extra,
        ],
        8 * 1024 * 1024,
    )


def refusal_of(family: WireFamily, document: dict[str, Any]) -> Refused:
    body = json.dumps(document).encode()
    with pytest.raises(Refused) as raised:
        admission(family).body(head_of(family, body), body)
    return raised.value


def admitted(family: WireFamily, document: dict[str, Any]) -> bytes:
    body = json.dumps(document).encode()
    return admission(family).body(head_of(family, body), body).body


# -- the regression: what the real SDK replays after a real answer --


def _assistant_turn_as_the_engine_replays_it() -> list[dict[str, Any]]:
    """Blocks the real Messages API states and the SDK of the pinned engine sends back."""
    return [
        {"role": "user", "content": [{"type": "text", "text": "Review src."}]},
        {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "Let me look.", "signature": "EqQBCkYI" * 20},
                {"type": "redacted_thinking", "data": "EmwKAhgB" * 20},
                {
                    "type": "text",
                    "text": "I will read the file.",
                    "citations": [
                        {
                            "type": "char_location",
                            "cited_text": "x",
                            "document_index": 0,
                            "document_title": None,
                            "start_char_index": 0,
                            "end_char_index": 1,
                        }
                    ],
                },
                {
                    "type": "tool_use",
                    "id": "toolu_01A",
                    "name": "read",
                    "input": {"filePath": "/work/a.py"},
                    "caller": {"type": "direct"},
                },
                {
                    "type": "tool_use",
                    "id": "toolu_01B",
                    "name": "grep",
                    "input": {"pattern": "def "},
                    "caller": {"type": "direct"},
                    "cache_control": {"type": "ephemeral"},
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "toolu_01A", "content": "1: x"},
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_01B",
                    "content": [
                        {"type": "text", "text": "boom"},
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": "iVBORw0KGgo=",
                            },
                        },
                    ],
                    "is_error": True,
                    "cache_control": {"type": "ephemeral"},
                },
            ],
        },
    ]


# #810-T01
def test_the_replay_of_a_real_assistant_turn_is_admitted_byte_for_byte() -> None:
    """The exact request the live job's second call sent in shape: `caller` on a `tool_use`, a
    thinking block with its signature, parallel tool calls, an `is_error` result and an image."""
    document = captured(MESSAGES)
    document["messages"] = _assistant_turn_as_the_engine_replays_it()
    assert admitted(MESSAGES, document) == json.dumps(document).encode()


# #810-T02
def test_the_body_the_real_engine_replays_carries_the_caller_and_is_admitted() -> None:
    """The base capture is what the pinned OpenCode sent against the real-shaped fake stream."""
    document = captured(MESSAGES)
    callers = [
        block["caller"]
        for message in document["messages"]
        for block in message["content"]
        if block.get("type") == "tool_use"
    ]
    assert callers
    assert all(caller == {"type": "direct"} for caller in callers)
    assert admitted(MESSAGES, document)


# #810-T03
@pytest.mark.parametrize("family", list(WireFamily))
def test_nothing_inside_the_conversation_is_walked_whatever_it_holds(family: WireFamily) -> None:
    holder = HOLDER[family]
    shapes: list[dict[str, Any]] = [
        {"anything": {"at": ["all", 1, None, True, 1.5]}},
        {"role": "assistant", "content": {"not": "a list"}, "caller": {"type": "direct"}},
        {"role": 5, "content": None, "cache_control": {"type": "ephemeral", "ttl": "1h"}},
        {"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}},
        {},
    ]
    for shape in shapes:
        document = captured(family)
        document[holder].append(shape)
        assert admitted(family, document)


# #810-T04
def test_the_system_prompt_and_an_instruction_are_opaque_too() -> None:
    document = captured(MESSAGES)
    document["system"] = [
        {"type": "text", "text": "x", "citations": [], "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "y", "cache_control": {"type": "ephemeral", "ttl": "1h"}},
    ]
    assert admitted(MESSAGES, document)
    document["system"] = "plain text"
    assert admitted(MESSAGES, document)
    document["system"] = [1]
    assert refusal_of(MESSAGES, document).where == "system (invalid value)"
    google = captured(WireFamily.GOOGLE)
    google["systemInstruction"] = {"role": "system", "parts": [{"text": "x"}], "other": 1}
    assert admitted(WireFamily.GOOGLE, google)


# #810-T05
@pytest.mark.parametrize("family", list(WireFamily))
def test_the_conversation_still_has_to_be_an_array_of_objects(family: WireFamily) -> None:
    holder = HOLDER[family]
    bad_conversations: list[Any] = ["hello", {"role": "user"}, [1], ["hello"], [[]], None]
    for bad in bad_conversations:
        document = captured(family)
        document[holder] = bad
        assert refusal_of(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED


# -- what stays closed, each item once more (the mutation checks of the PR break these) --


CLOSED_TOP_LEVEL: dict[str, Any] = {
    "mcp_servers": [{"type": "url", "url": "https://evil.example/mcp", "name": "x"}],
    "container": {"id": "c1"},
    "service_tier": "priority",
    "context_management": {"edits": [{"type": "clear_tool_uses_20250919"}]},
    "speed": "fast",
    "inference_geo": "us",
    "an_unknown_key": 1,
}


# #810-T06
@pytest.mark.parametrize("name", list(CLOSED_TOP_LEVEL))
@pytest.mark.parametrize("family", list(WireFamily))
def test_a_top_level_key_that_changes_what_is_paid_or_where_data_goes_is_refused_by_name(
    family: WireFamily, name: str
) -> None:
    document = captured(family)
    document[name] = CLOSED_TOP_LEVEL[name]
    error = refusal_of(family, document)
    assert (error.status, error.code) == (403, RefusalCode.REQUEST_NOT_ALLOWED)
    assert error.where == f"{name} (unknown key)"


SERVER_TOOLS: list[tuple[WireFamily, dict[str, Any]]] = [
    (MESSAGES, {"type": "web_search_20250305", "name": "web_search"}),
    (MESSAGES, {"type": "code_execution_20250522", "name": "code_execution"}),
    (MESSAGES, {"type": "computer_20250124", "name": "computer"}),
    (MESSAGES, {"type": "mcp", "name": "x"}),
    (WireFamily.OPENAI_CHAT, {"type": "web_search"}),
    (WireFamily.OPENAI_CHAT, {"type": "openrouter:web_search"}),
    (WireFamily.OPENAI_RESPONSES, {"type": "web_search_preview"}),
    (WireFamily.OPENAI_RESPONSES, {"type": "code_interpreter", "container": {"type": "auto"}}),
    (WireFamily.GOOGLE, {"googleSearch": {}}),
    (WireFamily.GOOGLE, {"codeExecution": {}}),
]


# #810-T07
@pytest.mark.parametrize(("family", "tool"), SERVER_TOOLS, ids=lambda v: str(v)[:40])
def test_a_tool_that_is_not_a_function_tool_is_refused_whatever_the_conversation_is(
    family: WireFamily, tool: dict[str, Any]
) -> None:
    document = captured(family)
    document["tools"].append(tool)
    # An opaque conversation must not be a way to smuggle a server tool: the tools are walked.
    error = refusal_of(family, document)
    assert error.code is RefusalCode.REQUEST_NOT_ALLOWED
    assert error.where is not None and error.where.startswith(
        f"tools[{len(document['tools']) - 1}]"
    )


# #810-T08
@pytest.mark.parametrize("family", list(WireFamily))
def test_the_model_is_pinned_and_the_output_cap_and_stream_stay_closed(
    family: WireFamily,
) -> None:
    if family is not WireFamily.GOOGLE:
        document = captured(family)
        document["model"] = "another-model"
        assert refusal_of(family, document).code is RefusalCode.MODEL_NOT_ALLOWED
    cap = {
        WireFamily.OPENAI_CHAT: ("max_tokens",),
        WireFamily.OPENAI_RESPONSES: ("max_output_tokens",),
        WireFamily.ANTHROPIC_MESSAGES: ("max_tokens",),
        WireFamily.GOOGLE: ("generationConfig", "maxOutputTokens"),
    }[family]
    document = captured(family)
    node = document
    for key in cap[:-1]:
        node = node[key]
    node[cap[-1]] = ALLOWANCE + 1
    assert refusal_of(family, document).code is RefusalCode.REQUEST_NOT_ALLOWED
    node[cap[-1]] = ALLOWANCE
    assert admitted(family, document)
    if family is not WireFamily.GOOGLE:
        document["stream"] = False
        assert refusal_of(family, document).where == "stream (invalid value)"


# #810-T09
@pytest.mark.parametrize("header", ["anthropic-beta", "anthropic-version"])
def test_the_anthropic_header_allow_lists_stay_closed_and_name_the_header(header: str) -> None:
    body = json.dumps(captured(MESSAGES)).encode()
    value = "an-unlisted-beta-2099-01-01" if header == "anthropic-beta" else "2099-01-01"
    with pytest.raises(Refused) as raised:
        head_of(MESSAGES, body, (header, value))
    assert raised.value.code is RefusalCode.REQUEST_NOT_ALLOWED
    assert raised.value.where == f"header {header}"
    ok = "thinking-binding-controls-2026-08-01,structured-outputs-2025-11-13"
    assert head_of(MESSAGES, body, ("anthropic-beta", ok), ("anthropic-version", "2023-06-01"))


# -- the diagnostics: a path, never a value --


# #810-T10
def test_a_refusal_inside_a_closed_object_names_the_path_and_never_a_value() -> None:
    document = captured(MESSAGES)
    document["tools"][0]["input_schema_extra"] = SECRET
    assert refusal_of(MESSAGES, document).where == "tools[0].input_schema_extra (unknown key)"
    document = captured(MESSAGES)
    document["thinking"]["type"] = SECRET
    assert refusal_of(MESSAGES, document).where == "thinking.type (invalid value)"
    document = captured(MESSAGES)
    document["tool_choice"] = {"type": "tool", "extra": SECRET}
    assert refusal_of(MESSAGES, document).where == "tool_choice.extra (unknown key)"
    for value in (SECRET, 10**9, [SECRET], {"k": SECRET}):
        document = captured(MESSAGES)
        document["max_tokens"] = value
        where = refusal_of(MESSAGES, document).where
        assert where == "max_tokens (invalid value)"
    document = captured(MESSAGES)
    del document["max_tokens"]
    assert refusal_of(MESSAGES, document).where == "max_tokens (output cap)"
    document = captured(MESSAGES)
    del document["stream"]
    assert refusal_of(MESSAGES, document).where == "stream (missing key)"


# #810-T11
@pytest.mark.parametrize(
    "name",
    ["Ключ", "a b", "key\nwith newline", "x" * 41, "", "ke$y", "api-key: " + SECRET, "\x00"],
)
def test_a_key_name_the_engine_chose_is_logged_only_when_short_and_plain(name: str) -> None:
    document = captured(MESSAGES)
    document[name] = 1
    where = refusal_of(MESSAGES, document).where
    assert where == "<key> (unknown key)"
    document = captured(MESSAGES)
    document["tools"][0][name] = 1
    assert refusal_of(MESSAGES, document).where == "tools[0].<key> (unknown key)"


# #810-T12
def test_a_short_plain_key_name_is_logged_as_it_is_and_the_path_is_bounded() -> None:
    document = captured(MESSAGES)
    document["my-key_1.x"] = 1
    assert refusal_of(MESSAGES, document).where == "my-key_1.x (unknown key)"
    path = NotAllowed("invalid value")
    for index in range(200):
        path.within(f"[{index}]")
    assert len(path.path) <= 120 + len(" (invalid value)")


# #810-T13
def test_a_body_that_is_not_json_or_too_deep_is_refused_with_a_fixed_place() -> None:
    admission_ = admission(MESSAGES)
    for body in (b"not json", b"[1]", b"[" * 100_000 + b"]" * 100_000, b'{"a": NaN}'):
        head = head_of(MESSAGES, body)
        with pytest.raises(Refused) as raised:
            admission_.body(head, body)
        assert raised.value.where is not None and raised.value.where.startswith("body")


# #810-T14
def test_the_run_records_the_path_and_the_engine_is_told_only_the_fixed_sentence() -> None:
    family = MESSAGES
    r = rig(family, streamed(family))
    document = json.loads(r.body())
    document["service_tier"] = "priority"
    sink = r.post(json.dumps(document).encode())
    assert sink.status == 403
    told = sink.everything()
    assert b"service_tier" not in told
    assert b"the request is not one this job may make" in told
    assert r.upstream.requests == []
    failure = r.ledger.failure
    assert failure is not None
    assert failure.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
    assert failure.detail == "the request is not one this job may make [service_tier (unknown key)]"


# #810-T15
def test_a_refused_header_is_recorded_by_its_name() -> None:
    family = MESSAGES
    r = rig(family, streamed(family))
    headers = r.headers(("anthropic-beta", "something-new-2099-01-01"))
    sink = r.post(headers=headers)
    assert sink.status == 403
    assert b"something-new" not in sink.everything()
    failure = r.ledger.failure
    assert failure is not None
    assert failure.detail == "the request is not one this job may make [header anthropic-beta]"


# #810-T16
def test_a_refusal_of_the_capability_names_nothing_and_ends_nothing() -> None:
    family = MESSAGES
    r = rig(family, streamed(family))
    sink = r.post(headers=r.headers(capability="not-the-capability"))
    assert sink.status == 401
    assert r.ledger.failure is None


# -- the readers that sit behind an opaque conversation must survive any shape --


# #810-T17
@pytest.mark.parametrize("family", list(WireFamily))
def test_the_last_user_text_never_raises_on_a_shape_nobody_expected(family: WireFamily) -> None:
    holder = HOLDER[family]
    odd: list[Any] = [
        [{"role": "user", "content": {"a": 1}}],
        [{"role": "user", "content": [None, 1, "x", [], {"type": "text", "text": 5}]}],
        [{"role": "user", "content": 5}],
        [{"role": "user", "parts": "nope"}],
        [{"role": "user", "parts": [None, {"text": None}, {"thought": 1}]}],
        [{"role": "user", "type": 5, "content": [{"type": "input_text"}]}],
        [{}],
        [],
        [{"role": ["user"], "content": "x"}],
    ]
    for conversation in odd:
        result = last_user_text(family, {holder: conversation})
        assert result is None or isinstance(result, str)
    assert last_user_text(family, {holder: "not a list"}) is None
    assert last_user_text(family, {}) is None


# #810-T18
def test_the_last_user_text_of_a_replayed_turn_is_still_the_users_text_only() -> None:
    document = {"messages": _assistant_turn_as_the_engine_replays_it()}
    assert last_user_text(MESSAGES, document) is None
    document["messages"].append(
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "toolu_01A", "content": "RESULT"},
                {"type": "text", "text": "answer now", "cache_control": {"type": "ephemeral"}},
            ],
        }
    )
    assert last_user_text(MESSAGES, document) == "answer now"


# #810-T19
def test_check_body_returns_the_one_output_cap_of_a_body_with_an_opaque_conversation() -> None:
    document = captured(MESSAGES)
    document["messages"] = _assistant_turn_as_the_engine_replays_it()
    assert check_body(MESSAGES, document, ALLOWANCE) == ALLOWANCE
    assert MODEL  # the support module's model is the one the rig pins
