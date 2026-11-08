# SPDX-License-Identifier: LicenseRef-Proprietary

"""No part of a conversation may make the provider fetch a URL (#950).

The conversation is opaque to the proxy on purpose (#810, `body_schema.py`): the engine's SDK adds
fields no list would keep up with. One thing in it is a way out, though. A message part that names
a URL (an image or a document by URL, a Google `fileUri`) makes the **provider** request that URL,
and a hostile agent can put what it has read into the URL's path or query: an exfiltration past the
egress rule of the network door, which looks at host names the agent's own container reaches.

So the proxy refuses such a part, whatever the family, and lets inline content through (base64, a
`data:` URI). The engine does not need a URL part: it reads a file of the work tree itself and sends
its bytes inline. The refusal is the same stable `request_not_allowed` as any other closed key, with
a path (`messages[3].content[1].source (url source)`), and like every refusal it ends the run.

This is a deny-walk of shapes, not a closed schema of the conversation: it looks for the few keys
that name something the provider would fetch, wherever they stand, and reads nothing else (a text,
a thinking block, a tool result, a `cache_control` on any block are not looked at). Free-form
positions the provider never fetches from are skipped: the arguments of a tool call
(`tool_use.input`, Google's `functionCall.args`, `functionResponse.response`) are the agent's own
JSON and may hold any key, a URL included.

Server tools that fetch for the model (web fetch, web search, MCP servers) are not here: the closed
tool schema (`body_schema.py`) already refuses everything but function tools, and `mcp_servers` is
an unknown key.
"""

from collections.abc import Mapping
from typing import Any, Final, cast

from code_reviewer_runner.dynamic_review.passthrough.body_schema import NotAllowed, safe_name
from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily

URL_SOURCE: Final = "url source"

# The parts of the body that hold what the provider reads as content, per family.
_HOLDERS: Final = {
    WireFamily.OPENAI_CHAT: ("messages",),
    WireFamily.OPENAI_RESPONSES: ("input",),
    WireFamily.ANTHROPIC_MESSAGES: ("system", "messages"),
    WireFamily.GOOGLE: ("contents", "systemInstruction"),
}
# A key whose value is a URL, or an object with a `url` (OpenAI Chat `image_url: {url}`, Responses
# `input_image.image_url`, `input_file.file_url`, and the `*_url` parts of the compatible
# providers). A `data:` URI is inline content and passes.
_URL_KEYS: Final = frozenset(
    {"image_url", "video_url", "audio_url", "file_url", "document_url", "input_audio_url"}
)
# Google's `fileData.fileUri` (and the snake case the REST API reads as well): a Files API URI, a
# `gs://` object, a YouTube or any other URL. None of them is inline.
_FILE_URI_KEYS: Final = frozenset({"fileUri", "file_uri"})
# The agent's own JSON: skipped, never read.
_FREE_FORM_KEYS: Final = frozenset({"args", "response", "arguments"})
_TOOL_CALL_TYPES: Final = frozenset({"tool_use", "server_tool_use", "mcp_tool_use"})


def _is_inline(url: object) -> bool:
    return isinstance(url, str) and url.lstrip()[:5].lower() == "data:"


def _names_a_url(value: Any) -> bool:
    """Whether the value of a `*_url` key points at something other than inline content."""
    if isinstance(value, dict):
        value = cast("dict[str, Any]", value).get("url")
    return not _is_inline(value) and value not in (None, "")


def _walk(node: Any) -> None:
    """Raise `NotAllowed(URL_SOURCE)` for the first fetching part below `node`."""
    if isinstance(node, list):
        for index, element in enumerate(cast("list[Any]", node)):
            try:
                _walk(element)
            except NotAllowed as refusal:
                raise refusal.within(f"[{index}]") from None
        return
    if not isinstance(node, dict):
        return
    part = cast("Mapping[str, Any]", node)
    skipped: frozenset[str] = _FREE_FORM_KEYS
    if part.get("type") in _TOOL_CALL_TYPES:
        skipped = skipped | {"input"}
    for key, value in part.items():
        if key in skipped:
            continue
        if _fetches(key, value):
            raise NotAllowed(URL_SOURCE).within(safe_name(key))
        try:
            _walk(value)
        except NotAllowed as refusal:
            raise refusal.within(safe_name(key)) from None


def _fetches(key: str, value: Any) -> bool:
    if key in _URL_KEYS:
        return _names_a_url(value)
    if key in _FILE_URI_KEYS:
        return value not in (None, "")
    # Anthropic: `source: {"type": "url", "url": ...}` on an image or a document (and on any block
    # a later API version gives one).
    if key != "source" or not isinstance(value, dict):
        return False
    return cast("dict[str, Any]", value).get("type") == "url"


def refuse_url_parts(family: WireFamily, document: Mapping[str, Any]) -> None:
    """Raise `NotAllowed` when the conversation of `document` has a part the provider would fetch.

    Reads only; a shape it does not expect is passed over. Deep nesting raises `RecursionError`,
    which the admission turns into the same refusal as for a body it cannot parse.
    """
    for holder in _HOLDERS[family]:
        try:
            _walk(document.get(holder))
        except NotAllowed as refusal:
            raise refusal.within(holder) from None
