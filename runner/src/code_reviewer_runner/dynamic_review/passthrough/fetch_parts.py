# SPDX-License-Identifier: LicenseRef-Proprietary

"""No part of a conversation may make the provider fetch a URL (#950).

The conversation is opaque to the proxy on purpose (#810, `body_schema.py`): the engine's SDK adds
fields no list would keep up with. One thing in it is a way out, though. A message part that names
a URL (an image or a document by URL, a Google `fileUri`) makes the **provider** request that URL,
and a hostile agent can put what it has read into the URL's path or query: an exfiltration past the
egress rule of the network door, which looks at host names the agent's own container reaches.

So the proxy refuses such a part, whatever the family, and lets inline content through (bare
base64, a `data:` URI). The engine does not need a URL part: it reads a file of the work tree
itself and sends its bytes inline. The refusal is the same stable `request_not_allowed` as any
other closed key, with a path (`messages[3].content[1].source (url source)`), and like every
refusal it ends the run.

This is a deny-walk of shapes, not a closed schema of the conversation: it looks for the keys that
name something the provider would fetch, wherever they stand, and reads nothing else (a text, a
thinking block, a tool result, a `cache_control` on any block are not looked at). Three kinds of
key:

- the known ones, refused with any value but inline content (`image_url`, `file_url`, `fileUri`,
  ...);
- `file_data` (OpenAI Chat `file`, Responses and xAI `input_file`), which is inline content by
  contract and which OpenRouter fetches when it is a URL: refused when it has a URL scheme, passed
  as bare base64 or a `data:` URI;
- any other key that spells `url` or `uri` at its end (case, `_` and `-` ignored), so a part of a
  provider or a later API version that no list kept up with is caught: refused when its value (or
  the `url` in its value) has a URL scheme other than `data:`.

Positions that echo what a provider said, and are not requests, are skipped (`citations`,
`annotations`, `url_citation`; a `search_result`'s `source` string does not end in `url`). So are
the free-form positions the provider never fetches from: the arguments of a tool call
(`tool_use.input`, Google's `functionCall.args`, `functionResponse.response`, the `arguments` of a
Chat or Responses call), which are the agent's own JSON and may hold any key, a URL included. These
are skipped only at their parent (an `args` that is not a function call's is read like any other
key).

Server tools that fetch for the model (web fetch, web search, MCP servers) are not here: the closed
tool schema (`body_schema.py`) already refuses everything but function tools, and `mcp_servers` is
an unknown key.
"""

import re
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
# Keys are compared in their normal form: lower case, without `_` and `-` (`Image_Url` is
# `imageurl`).
#
# A key whose value is a URL, or an object with a `url` (OpenAI Chat `image_url: {url}`, Responses
# `input_image.image_url`, `input_file.file_url`, and the `*_url` parts of the compatible
# providers). A `data:` URI is inline content and passes; so does nothing else.
_URL_KEYS: Final = frozenset(
    {"imageurl", "videourl", "audiourl", "fileurl", "documenturl", "inputaudiourl"}
)
# Google's `fileData.fileUri` (and the snake case the REST API reads as well): a Files API URI, a
# `gs://` object, a YouTube or any other URL. None of them is inline.
_FILE_URI_KEYS: Final = frozenset({"fileuri"})
# Inline content by contract (base64 or a `data:` URI); a provider that fetches it when it names a
# URL (OpenRouter) is a way out. Google's `file_data` is an object and is walked into.
_FILE_DATA_KEYS: Final = frozenset({"filedata"})
# What a provider said and the engine sends back; not a request to fetch anything.
_ECHO_KEYS: Final = frozenset({"citations", "annotations", "urlcitation"})
_TOOL_CALL_TYPES: Final = frozenset({"tool_use", "server_tool_use", "mcp_tool_use"})
# The agent's own JSON, per parent: skipped, never read.
_CALL_PARENTS: Final = frozenset({"functioncall", "function"})
_RESULT_PARENTS: Final = frozenset({"functionresponse"})
_SCHEME: Final = re.compile(r"[\x00-\x20]*([A-Za-z][A-Za-z0-9+.\-]*):")


def _normal(key: str) -> str:
    return key.lower().replace("_", "").replace("-", "")


def _has_scheme(value: object) -> bool:
    """Whether a string starts with a URL scheme other than `data:` (case and spaces ignored)."""
    found = _SCHEME.match(value) if isinstance(value, str) else None
    return found is not None and found.group(1).lower() != "data"


def _is_inline(url: object) -> bool:
    return isinstance(url, str) and url.lstrip()[:5].lower() == "data:"


def _names_a_url(value: Any) -> bool:
    """Whether the value of a known `*_url` key points at something other than inline content."""
    if isinstance(value, dict):
        value = cast("dict[str, Any]", value).get("url")
    return not _is_inline(value) and value not in (None, "")


def _holds_a_scheme(value: Any) -> bool:
    """A string with a URL scheme, or an object whose `url` or `uri` is one."""
    if isinstance(value, dict):
        return any(
            _normal(name) in ("url", "uri") and _has_scheme(inner)
            for name, inner in cast("dict[str, Any]", value).items()
        )
    return _has_scheme(value)


def _is_free_form(key: str, parent: str, kind: object) -> bool:
    if key in ("args", "arguments"):
        return _normal(parent) in _CALL_PARENTS or kind == "function_call"
    if key == "response":
        return _normal(parent) in _RESULT_PARENTS
    return key == "input" and kind in _TOOL_CALL_TYPES


def _walk(node: Any, parent: str = "") -> None:
    """Raise `NotAllowed(URL_SOURCE)` for the first fetching part below `node`."""
    if isinstance(node, list):
        for index, element in enumerate(cast("list[Any]", node)):
            try:
                _walk(element, parent)
            except NotAllowed as refusal:
                raise refusal.within(f"[{index}]") from None
        return
    if not isinstance(node, dict):
        return
    part = cast("Mapping[str, Any]", node)
    kind = part.get("type")
    for key, value in part.items():
        if _normal(key) in _ECHO_KEYS or _is_free_form(key, parent, kind):
            continue
        if _fetches(key, value):
            raise NotAllowed(URL_SOURCE).within(safe_name(key))
        try:
            _walk(value, key)
        except NotAllowed as refusal:
            raise refusal.within(safe_name(key)) from None


def _fetches(key: str, value: Any) -> bool:
    name = _normal(key)
    if name in _URL_KEYS:
        return _names_a_url(value)
    if name in _FILE_URI_KEYS:
        return value not in (None, "")
    if name in _FILE_DATA_KEYS:
        return _has_scheme(value)
    if name.endswith(("url", "uri")):
        return _holds_a_scheme(value)
    # Anthropic: `source: {"type": "url", "url": ...}` on an image or a document (and on any block
    # a later API version gives one).
    if name != "source" or not isinstance(value, dict):
        return False
    kind = cast("dict[str, Any]", value).get("type")
    return isinstance(kind, str) and kind.strip().lower() == "url"


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
