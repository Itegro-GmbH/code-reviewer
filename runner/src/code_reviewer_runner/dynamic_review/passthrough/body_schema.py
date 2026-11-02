# SPDX-License-Identifier: LicenseRef-Proprietary

"""The closed schema of a request body per wire family (#550, opened for the conversation in #810).

The engine is hostile: an untrusted model, steered by untrusted repository content, writes what it
sends. The proxy guards what protects **money, the key and the way out**, and leaves the
conversation alone:

- **Closed, because it changes what is paid or where data goes.** The top-level keys of the body
  (`mcp_servers`, `container`, `service_tier`, `context_management`, `speed`, `inference_geo`,
  routing fields, `n`, anything unknown), case sensitively; the keys of the few nested option
  objects (`thinking`, `tool_choice`, `stream_options`, `generationConfig`, ...); **tools: function
  tools only** (Chat and Responses `type: function`; Messages without a `type`, or `custom`; Google
  `functionDeclarations`), so no server tool (web search, code execution, computer use, MCP) ever
  runs at the provider's price; `n` and `candidateCount` exactly 1, `store` `false`; `stream`
  `true`; exactly one spelling of the output cap, within the job's allowance; a number is finite and
  at most 2^53; no `cache_control.ttl` on a tool.
- **Opaque, because it is the engine's and the provider's business.** The conversation (`messages`
  of Chat and Messages, `input` of Responses, `contents` of Google), the system prompt (Messages
  `system`, Google `systemInstruction`) and the schema of a tool are checked only for being an array
  of objects (an object, for the instruction). What is inside (block types, `thinking` and its
  signature, `tool_use` with its `caller`, `tool_result`, images, citations, `cache_control` on any
  block) is not walked: the provider rejects what is invalid, and the SDK of the pinned engine adds
  fields the capture of one run never showed (the `caller` of #810 was the first). This is a
  deliberate decision of the owner (#810): the earlier closed walk refused a healthy turn at its
  second call. A part that makes the provider fetch a URL, or a one-hour cache write, is therefore
  no longer refused here; the price book prices the write the provider states, and a write it has
  no price for is an unknown cost (`pricing.py`).

The walk only checks. The body that is forwarded is the bytes that arrived. A refusal carries the
**path** of what failed (`NotAllowed.path`: `service_tier`, `tools[2].type`; never a value, a key
name only when it is short and plain, else `<key>`), so that the next key the engine sends is found
in one run (it reaches the log of the job through the recorded failure). What the engine sends
beyond the closed sets fails closed as `request_not_allowed`, and the key joins the set when a live
capture shows it is the engine's (docs/spike/544-passthrough.md, section 7).
"""

import math
import re
from collections.abc import Callable, Collection, Mapping
from functools import lru_cache
from typing import Any, Final

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily, spec_of

# A key of a body is chosen by an untrusted engine: it is named in a log only when it is short and
# plain, and a path stays short.
_SAFE_NAME: Final = re.compile(r"[A-Za-z0-9_.\-]{1,40}")
_PLACEHOLDER: Final = "<key>"
_MAX_PATH: Final = 120
UNKNOWN_KEY: Final = "unknown key"
MISSING_KEY: Final = "missing key"
INVALID_VALUE: Final = "invalid value"
OUTPUT_CAP: Final = "output cap"


class NotAllowed(Exception):
    """The body is not one the engine sends. Carries where, and never a value of the body."""

    def __init__(self, reason: str = INVALID_VALUE) -> None:
        super().__init__(reason)
        self.reason = reason
        # The path from the innermost key outward: the combinators add a segment as it unwinds.
        self._segments: list[str] = []

    def within(self, segment: str) -> "NotAllowed":
        self._segments.append(segment)
        return self

    @property
    def path(self) -> str:
        """`tools[2].type (invalid value)`: where it failed and why, nothing the body said."""
        text = ""
        for segment in reversed(self._segments):
            text += segment if segment.startswith("[") or not text else f".{segment}"
        text = text[:_MAX_PATH] or "body"
        return f"{text} ({self.reason})"


def _name(key: object) -> str:
    return key if isinstance(key, str) and _SAFE_NAME.fullmatch(key) else _PLACEHOLDER


Check = Callable[[Any], None]
_LARGEST_NUMBER: Final = 2**53


def _no() -> NotAllowed:
    return NotAllowed()


def text(value: Any) -> None:
    if not isinstance(value, str):
        raise _no()


def boolean(value: Any) -> None:
    if not isinstance(value, bool):
        raise _no()


def number(value: Any) -> None:
    # A boolean is an int in Python and no number in JSON.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _no()
    # An int too large for a float would make `isfinite` raise; no option takes a number that big.
    if isinstance(value, int):
        if abs(value) > _LARGEST_NUMBER:
            raise _no()
    elif not math.isfinite(value):
        raise _no()


def count(value: Any) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _no()


def mapping(value: Any) -> None:
    """An object the proxy does not look into: a tool schema, a tool's arguments, a message."""
    if not isinstance(value, dict):
        raise _no()


def null(value: Any) -> None:
    if value is not None:
        raise _no()


def literal(*allowed: Any) -> Check:
    def check(value: Any) -> None:
        # `True == 1` in Python: the type has to be the same as well.
        if not any(value == item and type(value) is type(item) for item in allowed):
            raise _no()

    return check


def bounded(maximum: int, minimum: int = 1) -> Check:
    def check(value: Any) -> None:
        if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
            raise _no()

    return check


def array(item: Check) -> Check:
    def check(value: Any) -> None:
        if not isinstance(value, list):
            raise _no()
        elements: list[Any] = value  # pyright: ignore[reportUnknownVariableType]
        for index, element in enumerate(elements):
            try:
                item(element)
            except NotAllowed as refusal:
                raise refusal.within(f"[{index}]") from None

    return check


def either(*options: Check) -> Check:
    def check(value: Any) -> None:
        for option in options:
            try:
                option(value)
            except NotAllowed:
                continue
            return
        raise _no()

    return check


def obj(fields: Mapping[str, Check], required: Collection[str] = ()) -> Check:
    """An object with exactly these keys (case sensitive), the `required` ones present."""

    def check(value: Any) -> None:
        if not isinstance(value, dict):
            raise _no()
        document: dict[str, Any] = value  # pyright: ignore[reportUnknownVariableType]
        for name in document:
            if name not in fields:
                raise NotAllowed(UNKNOWN_KEY).within(_name(name))
        for name in required:
            if name not in document:
                raise NotAllowed(MISSING_KEY).within(name)
        for name, item in document.items():
            try:
                fields[name](item)
            except NotAllowed as refusal:
                raise refusal.within(name) from None

    return check


# The conversation, a system prompt and the like: an array of objects, and nothing inside is read.
objects = array(mapping)
# A message or block the engine may build as a plain string as well (a system prompt).
objects_or_text = either(text, objects)


_CACHE_CONTROL: Final = obj({"type": literal("ephemeral")}, ("type",))
_SAMPLING: Final = {"temperature": number, "top_p": number, "top_k": number}


# -- OpenAI Chat -----------------------------------------------------------------------------------


def _chat(allowance: int) -> Check:
    function = obj(
        {"name": text, "description": text, "parameters": mapping, "strict": boolean}, ("name",)
    )
    tool = obj(
        {"type": literal("function"), "function": function, "cache_control": _CACHE_CONTROL},
        ("type", "function"),
    )
    choice = either(
        literal("auto", "none", "required"),
        obj(
            {"type": literal("function"), "function": obj({"name": text}, ("name",))},
            ("type", "function"),
        ),
    )
    return obj(
        {
            "model": text,
            "messages": objects,
            "tools": array(tool),
            "tool_choice": choice,
            "stream": literal(True),
            "stream_options": obj({"include_usage": boolean}),
            # OpenRouter asks for its usage (and cost) this way instead of `stream_options`.
            "usage": obj({"include": literal(True)}, ("include",)),
            "max_tokens": bounded(allowance),
            "max_completion_tokens": bounded(allowance),
            "n": literal(1),
            **_SAMPLING,
        },
        ("model", "messages", "stream"),
    )


# -- OpenAI Responses ------------------------------------------------------------------------------


def _responses(allowance: int) -> Check:
    tool = obj(
        {
            "type": literal("function"),
            "name": text,
            "description": text,
            "parameters": mapping,
            "strict": boolean,
        },
        ("type", "name", "parameters"),
    )
    choice = either(
        literal("auto", "none", "required"),
        obj({"type": literal("function"), "name": text}, ("type", "name")),
    )
    return obj(
        {
            "model": text,
            "input": objects,
            "instructions": text,
            "tools": array(tool),
            "tool_choice": choice,
            "stream": literal(True),
            "store": literal(False),
            "prompt_cache_key": text,
            "include": array(literal("reasoning.encrypted_content")),
            "reasoning": obj({"effort": text, "summary": text}),
            "text": obj({"verbosity": text}),
            "parallel_tool_calls": boolean,
            "max_output_tokens": bounded(allowance),
            "temperature": number,
            "top_p": number,
        },
        ("model", "input", "stream"),
    )


# -- Anthropic Messages ----------------------------------------------------------------------------


def _messages(allowance: int) -> Check:
    tool = obj(
        {
            # Without a type, or `custom`: a function tool. Every other type is a server tool.
            "type": literal("custom"),
            "name": text,
            "description": text,
            "input_schema": mapping,
            "eager_input_streaming": boolean,
            "cache_control": _CACHE_CONTROL,
        },
        ("name", "input_schema"),
    )
    choice = obj(
        {
            "type": literal("auto", "any", "none", "tool"),
            "name": text,
            "disable_parallel_tool_use": boolean,
        },
        ("type",),
    )
    thinking = obj(
        {
            "type": literal("adaptive", "enabled", "disabled"),
            "display": literal("omitted", "summarized"),
            "budget_tokens": bounded(allowance),
            "block_binding": obj({"prefix_mismatch_behavior": text}),
        },
        ("type",),
    )
    return obj(
        {
            "model": text,
            "max_tokens": bounded(allowance),
            "system": objects_or_text,
            "messages": objects,
            "tools": array(tool),
            "tool_choice": choice,
            "thinking": thinking,
            "stream": literal(True),
            **_SAMPLING,
        },
        ("model", "messages", "stream"),
    )


# -- Google ----------------------------------------------------------------------------------------


def _google(allowance: int) -> Check:
    declaration = obj(
        {"name": text, "description": text, "parameters": mapping, "parametersJsonSchema": mapping},
        ("name",),
    )
    tool = obj({"functionDeclarations": array(declaration)}, ("functionDeclarations",))
    config = obj(
        {
            "maxOutputTokens": bounded(allowance),
            "temperature": number,
            "topP": number,
            "topK": number,
            "candidateCount": literal(1),
            "thinkingConfig": obj(
                {
                    "includeThoughts": boolean,
                    "thinkingLevel": text,
                    "thinkingBudget": bounded(allowance, 0),
                }
            ),
        },
        ("maxOutputTokens",),
    )
    tool_config = obj(
        {
            "functionCallingConfig": obj(
                {"mode": literal("AUTO", "ANY", "NONE"), "allowedFunctionNames": array(text)},
                ("mode",),
            )
        },
        ("functionCallingConfig",),
    )
    return obj(
        {
            "contents": objects,
            "systemInstruction": mapping,
            "generationConfig": config,
            "tools": array(tool),
            "toolConfig": tool_config,
        },
        ("contents", "generationConfig"),
    )


_BUILD: Final = {
    WireFamily.OPENAI_CHAT: _chat,
    WireFamily.OPENAI_RESPONSES: _responses,
    WireFamily.ANTHROPIC_MESSAGES: _messages,
    WireFamily.GOOGLE: _google,
}


@lru_cache(maxsize=32)
def _schema(family: WireFamily, allowance: int) -> Check:
    return _BUILD[family](allowance)


def check_body(family: WireFamily, document: dict[str, Any], allowance: int) -> int:
    """Walk `document` against the closed schema of `family`; return the output cap it asks for.

    Raises `NotAllowed`. Exactly one spelling of the cap may be present.
    """
    _schema(family, allowance)(document)
    found: list[Any] = []
    paths = spec_of(family).output_caps
    for path in paths:
        node: Any = document
        for key in path:
            node = node.get(key) if isinstance(node, dict) else None  # pyright: ignore[reportUnknownMemberType, reportUnknownVariableType]
        if node is not None:
            found.append(node)  # pyright: ignore[reportUnknownArgumentType]
    if len(found) != 1:
        # Absent, or two spellings of the same cap: named by its first spelling.
        refusal = NotAllowed(OUTPUT_CAP)
        for key in reversed(paths[0]):
            refusal.within(key)
        raise refusal
    return int(found[0])
