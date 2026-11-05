# SPDX-License-Identifier: LicenseRef-Proprietary

"""The finish tool (#843): how an agent hands in its result, and how Control checks it.

One file, standard library only, no import of this package, because it runs in two places:

* **in the agent's container**, where Control writes it next to the engine's configuration as
  `factory-submit`. As a command (`factory-submit`, the JSON on standard input) and as a stdio MCP
  server (`factory-submit mcp`, the tool `submit_result`) it checks what the agent hands in against
  the result schema of the turn and either refuses it with every problem listed (the agent corrects
  and calls again) or writes it to the result file. That check is fast feedback and nothing more:
  everything in the container is the agent's, the file included.
* **in Control**, which imports the same functions to check the file once the container is gone
  (`parse_result`). The result is data of an untrusted writer: its size is bounded **before** it is
  parsed (a value of two million keys costs about a second to check), its nesting and its number of
  values are bounded by a scan that does not build anything, and only then it is parsed and checked
  against the schema with the rules of the app's `checkResultValue`
  (`app/src/workflows/result-schema.ts`). `contracts/result-check-vectors.v1.json` holds both to the
  same answers.

The format of a result schema is `contracts/result-schema.v1.json`: fields are strings (optionally
one of a list of names), numbers, whole numbers, booleans, lists and objects; every object is
closed.
"""

import json
import math
import os
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any, NamedTuple, cast

TOOL_NAME = "submit_result"
COMMAND_NAME = "factory-submit"

# Where the container finds them. The agent can change both files and its environment; Control
# checks again.
SCHEMA_PATH = "/etc/code-reviewer/result-schema.json"
RESULT_PATH = "/work/result/result.json"
SCHEMA_VARIABLE = "FACTORY_RESULT_SCHEMA"
RESULT_VARIABLE = "FACTORY_RESULT_FILE"

# The bounds of a result, applied to the bytes before anything is parsed. A result is data for the
# steps after this one, not a report: 256 KiB is far more than the fields of any schema need.
MAX_RESULT_BYTES = 256 * 1024
# Levels of lists and objects the format allows (`RESULT_DEPTH_MAX`), with room to spare: a value
# deeper than this cannot fit any schema.
MAX_VALUE_DEPTH = 8
# Values in all (list entries, fields, nested lists and objects).
MAX_VALUE_ITEMS = 20_000

# The format's own bounds (`app/src/workflows/limits.ts`).
RESULT_DEPTH_MAX = 4
RESULT_PROPERTIES_MAX = 50
RESULT_PROPERTIES_TOTAL_MAX = 100
RESULT_ENUM_VALUES_MAX = 50
RESULT_ENUM_VALUE_MAX_LENGTH = 200
RESULT_DESCRIPTION_MAX_LENGTH = 500
STRING_MAX_LENGTH_DEFAULT = 10_000
STRING_MAX_LENGTH_LIMIT = 100_000
LIST_MAX_ITEMS_DEFAULT = 100
LIST_MAX_ITEMS_LIMIT = 1000
ERRORS_COLLECT_MAX = 250
# How many problems a refusal tells the agent, and how long a piece of its own text it repeats.
ERRORS_SHOWN = 20
ECHO_MAX_LENGTH = 64
SAFE_INTEGER = 2**53 - 1

_FIELD_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
_NODE_KEYS: dict[str, tuple[str, ...]] = {
    "string": ("type", "description", "maxLength", "enum"),
    "number": ("type", "description"),
    "integer": ("type", "description"),
    "boolean": ("type", "description"),
    "array": ("type", "description", "items", "maxItems"),
    "object": ("type", "description", "properties", "required", "additionalProperties"),
}

# What `scan_bounds` says.
TOO_LARGE = "too_large"
TOO_DEEP = "too_deep"
TOO_MANY_VALUES = "too_many_values"
NOT_JSON = "not_json"


class Issue(NamedTuple):
    """One problem: the JSON pointer into the value (or the schema), a stable code, a sentence."""

    path: str
    code: str
    message: str
    available: tuple[str, ...] = ()


# -- small helpers ----------------------------------------------------------------------------


def _clip(text: str) -> str:
    return text if len(text) <= ECHO_MAX_LENGTH else text[:ECHO_MAX_LENGTH] + "…"


def _shown(text: str) -> str:
    return f"'{_clip(text)}'"


def _pointer(base: str, *segments: str | int) -> str:
    out = base
    for segment in segments:
        out += "/" + _clip(str(segment)).replace("~", "~0").replace("/", "~1")
    return out


def _type_name(value: object) -> str:
    if value is None:
        return "null"
    if isinstance(value, list):
        return "a list"
    if isinstance(value, dict):
        return "an object"
    if isinstance(value, str):
        return "a text"
    if isinstance(value, bool):
        return "true/false"
    return "a number"


def _issue(path: str, code: str, message: str, available: Sequence[str] = ()) -> Issue:
    return Issue(path, code, message, tuple(_clip(name) for name in available[:20]))


def _order(path: str) -> list[tuple[int, int, str]]:
    segments = [] if path == "" else path[1:].split("/")
    return [(0, int(s), "") if s.isdigit() else (1, 0, s) for s in segments]


def _sorted(issues: list[Issue]) -> list[Issue]:
    return sorted(issues, key=lambda found: (_order(found.path), found.code))


def _as_object(value: object) -> dict[str, Any] | None:
    return cast("dict[str, Any]", value) if isinstance(value, dict) else None


def _as_list(value: object) -> list[Any] | None:
    return cast("list[Any]", value) if isinstance(value, list) else None


def _is_number(value: object) -> bool:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    try:
        return math.isfinite(float(value))
    except OverflowError:
        return False


def _is_safe_integer(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return abs(value) <= SAFE_INTEGER
    return (
        isinstance(value, float)
        and math.isfinite(value)
        and value.is_integer()
        and (abs(value) <= SAFE_INTEGER)
    )


# -- the schema ---------------------------------------------------------------------------------


def check_schema(schema: object) -> list[Issue]:
    """The problems of a result schema (`contracts/result-schema.v1.json`), none when it is valid.
    The app has checked the schema before it reaches a job; this is for the runner, which does not
    take a schema it does not understand, and for the container's copy."""
    issues: list[Issue] = []
    fields = 0

    def add(path: str, code: str, message: str) -> None:
        if len(issues) < ERRORS_COLLECT_MAX:
            issues.append(_issue(path, code, message))

    def node(raw: object, path: str, depth: int) -> None:
        value = _as_object(raw)
        if value is None:
            add(path, "wrong_type", 'A field schema is an object like {"type": "string"}.')
            return
        kind = value.get("type")
        if not isinstance(kind, str) or kind not in _NODE_KEYS:
            add(_pointer(path, "type"), "invalid_value", "The type is not one the format has.")
            return
        for key in value:
            if key not in _NODE_KEYS[kind]:
                add(_pointer(path, key), "unknown_field", f"{_shown(str(key))} is not a keyword.")
        text = value.get("description")
        if text is not None and (
            not isinstance(text, str) or len(text) > RESULT_DESCRIPTION_MAX_LENGTH
        ):
            add(_pointer(path, "description"), "invalid_value", "The description is a short text.")
        if kind == "string":
            _string_node(value, path)
        elif kind == "array":
            _array_node(value, path, depth)
        elif kind == "object":
            _object_node(value, path, depth)

    def whole(value: object, low: int, high: int) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high

    def _string_node(value: dict[str, Any], path: str) -> None:
        cap = value.get("maxLength")
        if cap is not None and not whole(cap, 1, STRING_MAX_LENGTH_LIMIT):
            add(_pointer(path, "maxLength"), "invalid_value", "maxLength is out of range.")
        raw_names = value.get("enum")
        if raw_names is None:
            return
        names = _as_list(raw_names)
        if (
            names is None
            or not 1 <= len(names) <= RESULT_ENUM_VALUES_MAX
            or len(set(map(str, names))) != len(names)
            or not all(
                isinstance(name, str) and 1 <= len(name) <= RESULT_ENUM_VALUE_MAX_LENGTH
                for name in names
            )
        ):
            add(_pointer(path, "enum"), "invalid_value", "enum is a list of different names.")

    def _array_node(value: dict[str, Any], path: str, depth: int) -> None:
        cap = value.get("maxItems")
        if cap is not None and not whole(cap, 1, LIST_MAX_ITEMS_LIMIT):
            add(_pointer(path, "maxItems"), "invalid_value", "maxItems is out of range.")
        if "items" not in value:
            add(_pointer(path, "items"), "missing_field", "An array needs items.")
        elif depth + 1 > RESULT_DEPTH_MAX:
            add(_pointer(path, "items"), "nesting_too_deep", "The schema nests too deep.")
        else:
            node(value["items"], _pointer(path, "items"), depth + 1)

    def _object_node(value: dict[str, Any], path: str, depth: int) -> None:
        nonlocal fields
        if value.get("additionalProperties") not in (None, False):
            add(_pointer(path, "additionalProperties"), "invalid_value", "Objects are closed.")
        if depth > RESULT_DEPTH_MAX:
            add(path, "nesting_too_deep", "The schema nests too deep.")
            return
        properties = _as_object(value.get("properties"))
        if properties is None or not 1 <= len(properties) <= RESULT_PROPERTIES_MAX:
            add(_pointer(path, "properties"), "invalid_value", "An object needs 1 to 50 fields.")
            return
        fields += len(properties)
        for name, child in properties.items():
            if _FIELD_NAME.fullmatch(name) is None:
                add(_pointer(path, "properties", str(name)), "invalid_value", "Not a field name.")
                continue
            node(child, _pointer(path, "properties", name), depth + 1)
        raw_required = value.get("required")
        if raw_required is None:
            return
        required = _as_list(raw_required)
        if (
            required is None
            or len(set(map(str, required))) != len(required)
            or not all(isinstance(name, str) and name in properties for name in required)
        ):
            add(
                _pointer(path, "required"),
                "required_field_unknown",
                "required lists names of properties, each once.",
            )

    root = _as_object(schema)
    if root is None:
        return [_issue("", "wrong_type", "A result schema is an object.")]
    if root.get("type") != "object":
        return [
            _issue("/type", "invalid_value", 'The root of a result schema is "type": "object".')
        ]
    node(root, "", 1)
    if fields > RESULT_PROPERTIES_TOTAL_MAX:
        add("", "result_schema_too_large", "The schema has more than 100 fields in all.")
    return _sorted(issues)


# -- the value ------------------------------------------------------------------------------------


def check_value(schema: Mapping[str, Any], value: object) -> list[Issue]:
    """The problems of `value` against `schema`, none when it fits. The rules of `checkResultValue`
    in the app: every object is closed, a string or a list that sets no cap gets the default, a
    number is finite and a whole number is a safe integer. The value is untrusted: the list stops
    at `ERRORS_COLLECT_MAX` and the unknown keys of an object are looked at only while it is not
    full."""
    issues: list[Issue] = []

    def full() -> bool:
        return len(issues) >= ERRORS_COLLECT_MAX

    def add(path: str, code: str, message: str, available: Sequence[str] = ()) -> None:
        issues.append(_issue(path, code, message, available))

    def check(node: Mapping[str, Any], at: object, path: str) -> None:
        if full():
            return
        kind = node["type"]
        if kind == "string":
            if not isinstance(at, str):
                add(path, "wrong_type", f"Expected a string, got {_type_name(at)}.")
                return
            limit = node.get("maxLength", STRING_MAX_LENGTH_DEFAULT)
            if len(at) > limit:
                add(path, "limit_exceeded", f"The text is {len(at)} characters; at most {limit}.")
            names = node.get("enum")
            if names is not None and at not in names:
                add(path, "invalid_value", "Not one of the allowed values.", names)
        elif kind == "number":
            if not _is_number(at):
                add(path, "wrong_type", f"Expected a number, got {_type_name(at)}.")
        elif kind == "integer":
            if not _is_safe_integer(at):
                add(path, "wrong_type", f"Expected a whole number, got {_type_name(at)}.")
        elif kind == "boolean":
            if not isinstance(at, bool):
                add(path, "wrong_type", f"Expected true or false, got {_type_name(at)}.")
        elif kind == "array":
            items = _as_list(at)
            if items is None:
                add(path, "wrong_type", f"Expected a list, got {_type_name(at)}.")
                return
            limit = node.get("maxItems", LIST_MAX_ITEMS_DEFAULT)
            if len(items) > limit:
                add(path, "limit_exceeded", f"The list has {len(items)} entries; at most {limit}.")
            for index, item in enumerate(items[: limit + 1]):
                check(node["items"], item, _pointer(path, index))
        else:
            check_object(node, at, path)

    def check_object(node: Mapping[str, Any], at: object, path: str) -> None:
        given = _as_object(at)
        if given is None:
            add(path, "wrong_type", f"Expected an object, got {_type_name(at)}.")
            return
        properties: Mapping[str, Mapping[str, Any]] = node["properties"]
        required = set(node.get("required", ()))
        for name, child in properties.items():
            if name in given:
                check(child, given[name], _pointer(path, name))
            elif name in required:
                add(
                    _pointer(path, name),
                    "missing_field",
                    f"The required field {_shown(name)} is missing.",
                )
        for key in given:
            if full():
                return
            if key not in properties:
                add(
                    _pointer(path, key),
                    "unknown_field",
                    f"{_shown(key)} is not a field of the result.",
                    list(properties),
                )

    check(schema, value, "")
    return _sorted(issues)


# -- the bytes ------------------------------------------------------------------------------------

_JSON_SPACE = frozenset(b" \t\n\r")
_BACKSLASH, _QUOTE, _COMMA = 0x5C, 0x22, 0x2C
_OPENERS = frozenset(b"[{")
_CLOSERS = frozenset(b"]}")


def scan_bounds(raw: bytes) -> str | None:
    """Whether `raw` is within the bounds of a result, found without parsing it: its size, how deep
    its lists and objects nest, and how many values it holds (the root, every entry and field, every
    list and object: what the app counts too). None when it is. One pass over the bytes that keeps
    three numbers and two flags and builds nothing: a backslash in a text skips one byte and a quote
    ends it, so a hostile file costs what its size costs (a pattern for the texts backtracks, and an
    unclosed text of escaped quotes cost minutes).

    The values are counted from the structure: one for the root, one for each comma, and one for
    each list or object that is not empty (the commas of a container count its entries but one). A
    container is empty when only white space lies between its brackets."""
    if len(raw) > MAX_RESULT_BYTES:
        return TOO_LARGE
    depth = 0
    values = 1
    empty = (
        False  # the last thing seen, white space apart, is the bracket that opened the container
    )
    in_text = False
    escaped = False
    for byte in raw:
        if in_text:
            if escaped:
                escaped = False
            elif byte == _BACKSLASH:
                escaped = True
            elif byte == _QUOTE:
                in_text = False
            continue
        if byte in _JSON_SPACE:
            continue
        if byte in _OPENERS:
            depth += 1
            if depth > MAX_VALUE_DEPTH:
                return TOO_DEEP
            empty = True
            continue
        if byte in _CLOSERS:
            depth -= 1
            if not empty:
                values += 1
        elif byte == _COMMA:
            values += 1
        elif byte == _QUOTE:
            in_text = True
        empty = False
        if values > MAX_VALUE_ITEMS:
            return TOO_MANY_VALUES
    return None


class Parsed(NamedTuple):
    """What `parse_result` made of the bytes of a result: the value when it is in bounds, JSON and
    fits the schema; else `problem` (a word: a bound, `not_json`, or `invalid`) and the issues."""

    value: dict[str, Any] | None
    problem: str | None
    issues: tuple[Issue, ...] = ()


def _refuse_constant(name: str) -> object:
    raise ValueError(name)


def parse_result(schema: Mapping[str, Any], raw: bytes) -> Parsed:
    """Bounds first, then JSON, then the schema. Nothing about `raw` is trusted, and nothing of it
    is repeated in the answer except pieces of keys and enum names, cut to the length of a name."""
    bound = scan_bounds(raw)
    if bound is not None:
        return Parsed(None, bound)
    try:
        value = json.loads(raw.decode("utf-8"), parse_constant=_refuse_constant)
    except (ValueError, RecursionError):
        return Parsed(None, NOT_JSON)
    issues = check_value(schema, value)
    if issues:
        return Parsed(None, "invalid", tuple(issues))
    try:
        # Half a surrogate pair written as an escape is JSON but no text: it cannot be written to
        # the file or kept by the app.
        json.dumps(value, ensure_ascii=False).encode("utf-8")
    except UnicodeEncodeError:
        return Parsed(None, NOT_JSON)
    return Parsed(value, None)


def problem_sentence(parsed: Parsed) -> str:
    """The refusal for the agent: every problem (the first `ERRORS_SHOWN`) with its pointer."""
    if parsed.problem == TOO_LARGE:
        return f"Rejected: the result is larger than {MAX_RESULT_BYTES // 1024} KiB."
    if parsed.problem == TOO_DEEP:
        return f"Rejected: the result nests lists and objects deeper than {MAX_VALUE_DEPTH} levels."
    if parsed.problem == TOO_MANY_VALUES:
        return f"Rejected: the result holds more than {MAX_VALUE_ITEMS} values."
    if parsed.problem == NOT_JSON:
        return "Rejected: the result is not valid JSON."
    lines = ["Rejected: the result does not fit the required shape."]
    for found in parsed.issues[:ERRORS_SHOWN]:
        where = found.path or "(the result itself)"
        names = f" Allowed: {', '.join(found.available)}." if found.available else ""
        lines.append(f"- {where}: {found.message}{names}")
    if len(parsed.issues) > ERRORS_SHOWN:
        lines.append(f"- and {len(parsed.issues) - ERRORS_SHOWN} more problems.")
    lines.append("Fix every problem and call the tool again.")
    return "\n".join(lines)


# -- what the agent sees --------------------------------------------------------------------------


def tool_definition(schema: Mapping[str, Any]) -> dict[str, Any]:
    """The tool made from the schema: its name, a description and the parameters (the schema itself,
    which is a subset of JSON Schema; the objects are closed explicitly)."""
    purpose = schema.get("description")
    return {
        "name": TOOL_NAME,
        "description": (
            "Hand in the final result of your task. Call it when the work is done: it checks "
            "the result against the required shape and answers with the problems to fix, "
            "or accepts it. Calling it again replaces an accepted result."
            + (f" The result: {purpose}" if isinstance(purpose, str) and purpose else "")
        ),
        "inputSchema": _closed(schema),
    }


def _closed(node: Mapping[str, Any]) -> dict[str, Any]:
    made: dict[str, Any] = dict(node)
    if node.get("type") == "object":
        made["additionalProperties"] = False
        made["properties"] = {name: _closed(child) for name, child in node["properties"].items()}
    elif node.get("type") == "array":
        made["items"] = _closed(node["items"])
    return made


# -- the submission -------------------------------------------------------------------------------


def write_result(path: str, raw: bytes) -> None:
    """Replace the result file in one step (a reader never sees half a file)."""
    scratch = f"{path}.tmp-{os.getpid()}"
    with open(scratch, "wb") as handle:
        handle.write(raw)
    os.replace(scratch, path)


def submit(schema: Mapping[str, Any], raw: bytes, path: str) -> tuple[bool, str]:
    """Check what the agent handed in and, when it fits, write it. The answer is the sentence the
    agent reads either way."""
    parsed = parse_result(schema, raw)
    if parsed.value is None:
        return False, problem_sentence(parsed)
    # Written as it was parsed, so the file holds JSON and nothing else.
    write_result(path, json.dumps(parsed.value, ensure_ascii=False).encode("utf-8"))
    return True, (
        "Result accepted. You do not need to call this again unless you change the result; "
        "finish your work and end your turn."
    )


def _load_schema(environment: Mapping[str, str]) -> dict[str, Any]:
    with open(environment.get(SCHEMA_VARIABLE, SCHEMA_PATH), "rb") as handle:
        schema = json.loads(handle.read())
    if check_schema(schema):
        raise ValueError("the result schema is not valid")
    return schema


# -- the MCP server -------------------------------------------------------------------------------

# The revisions of the protocol the server answers to; a client that asks for another gets the
# newest and decides for itself.
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SERVER_NAME = "factory"


def handle_message(
    message: object, schema: Mapping[str, Any], result_path: str
) -> dict[str, Any] | None:
    """One JSON-RPC message of a stdio MCP client; the answer, or None for a notification."""
    request = _as_object(message)
    if request is None:
        return _error(None, -32600, "invalid request")
    ident = request.get("id")
    method = request.get("method")
    arguments = _as_object(request.get("params")) or {}
    if "id" not in request:
        return None  # a notification (`notifications/initialized`, `notifications/cancelled`)
    if method == "initialize":
        asked = arguments.get("protocolVersion")
        version = asked if asked in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return _reply(
            ident,
            {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": "1"},
            },
        )
    if method == "ping":
        return _reply(ident, {})
    if method == "tools/list":
        return _reply(ident, {"tools": [tool_definition(schema)]})
    if method == "tools/call":
        if arguments.get("name") != TOOL_NAME:
            return _error(ident, -32602, "unknown tool")
        given = arguments.get("arguments")
        raw = json.dumps(given if isinstance(given, dict) else None).encode("utf-8")
        accepted, text = submit(schema, raw, result_path)
        return _reply(ident, {"content": [{"type": "text", "text": text}], "isError": not accepted})
    return _error(ident, -32601, "method not found")


def _reply(ident: object, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": ident, "result": result}


def _error(ident: object, code: int, text: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": ident, "error": {"code": code, "message": text}}


def serve(
    lines: Callable[[], str],
    write: Callable[[str], None],
    schema: Mapping[str, Any],
    result_path: str,
) -> None:
    """Newline-delimited JSON-RPC until the client closes its end."""
    while line := lines():
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except ValueError:
            answer: dict[str, Any] | None = _error(None, -32700, "parse error")
        else:
            answer = handle_message(message, schema, result_path)
        if answer is not None:
            write(json.dumps(answer))


# -- the command ----------------------------------------------------------------------------------

USAGE = (
    "usage: factory-submit < result.json\n"
    "Reads your final result as JSON on standard input, checks it against the required shape and\n"
    "records it. Exit code 0: accepted. Exit code 2: rejected, the problems are listed on\n"
    "standard error; fix them and run it again.\n"
)


def _send(text: str) -> None:
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def main(argv: Sequence[str], environment: Mapping[str, str] | None = None) -> int:
    env = os.environ if environment is None else environment
    if any(argument in ("-h", "--help") for argument in argv):
        sys.stdout.write(USAGE)
        return 0
    try:
        schema = _load_schema(env)
    except (OSError, ValueError):
        sys.stderr.write("factory-submit: the result schema of this task cannot be read\n")
        return 1
    result_path = env.get(RESULT_VARIABLE, RESULT_PATH)
    if argv[:1] == ["mcp"]:
        serve(sys.stdin.readline, _send, schema, result_path)
        return 0
    raw = sys.stdin.buffer.read(MAX_RESULT_BYTES + 1)
    try:
        accepted, text = submit(schema, raw, result_path)
    except OSError:
        sys.stderr.write("factory-submit: the result could not be recorded\n")
        return 1
    (sys.stdout if accepted else sys.stderr).write(f"factory-submit: {text}\n")
    return 0 if accepted else 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
