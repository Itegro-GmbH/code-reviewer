# SPDX-License-Identifier: LicenseRef-Proprietary

"""The finish tool's check of a result (#843): the same rules as the app's `checkResultValue`
(held by the shared vectors), the bounds applied before anything is parsed, and the two doors the
agent has to it, the command `factory-submit` and the MCP tool `submit_result`."""

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from code_reviewer_runner.implementer import finish_tool
from code_reviewer_runner.implementer.finish_tool import (
    MAX_RESULT_BYTES,
    check_schema,
    check_value,
    handle_message,
    parse_result,
    problem_sentence,
    scan_bounds,
    serve,
    submit,
    tool_definition,
)

VECTORS = json.loads(
    (Path(__file__).resolve().parents[3] / "contracts" / "result-check-vectors.json").read_text(
        encoding="utf-8"
    )
)

FINDINGS: dict[str, Any] = {
    "type": "object",
    "required": ["findings"],
    "properties": {
        "findings": {
            "type": "array",
            "maxItems": 20,
            "items": {
                "type": "object",
                "required": ["type", "name"],
                "properties": {
                    "type": {"type": "string", "enum": ["bug", "risk", "nit"]},
                    "name": {"type": "string", "maxLength": 120},
                    "description": {"type": "string", "description": "What is wrong."},
                },
            },
        }
    },
}
RIGHT = {"findings": [{"type": "bug", "name": "Lease", "description": "x"}]}
WRONG = {"findings": [{"type": "critical", "name": 3}]}


# #843-T40
@pytest.mark.parametrize("vector", VECTORS["schemas"], ids=lambda v: v["name"])
def test_the_schema_is_judged_as_the_app_judges_it(vector: dict[str, Any]) -> None:
    assert (check_schema(vector["schema"]) == []) is vector["valid"]


# #843-T40
@pytest.mark.parametrize("vector", VECTORS["values"], ids=lambda v: v["name"])
def test_the_value_is_checked_as_the_app_checks_it(vector: dict[str, Any]) -> None:
    found = sorted(f"{i.path} {i.code}" for i in check_value(vector["schema"], vector["value"]))

    assert found == sorted(f"{path} {code}" for path, code in vector["issues"])


# #843-T41
def test_the_check_lists_the_choices_where_a_name_was_wrong() -> None:
    issues = check_value(FINDINGS, WRONG)

    wrong = next(i for i in issues if i.path == "/findings/0/type")
    assert wrong.available == ("bug", "risk", "nit")


# #843-T41
def test_the_check_stops_listing_at_the_cap_however_many_keys_the_value_has() -> None:
    value = {f"field{i}": i for i in range(50_000)}
    started = time.monotonic()

    issues = check_value(FINDINGS, value)

    assert len(issues) <= finish_tool.ERRORS_COLLECT_MAX
    assert time.monotonic() - started < 1.5


# #843-T42
def test_a_file_over_the_size_bound_is_refused_before_it_is_parsed() -> None:
    raw = b'{"findings": [], "x": "' + b"a" * MAX_RESULT_BYTES + b'"}'

    assert scan_bounds(raw) == "too_large"
    assert parse_result(FINDINGS, raw).problem == "too_large"


# #843-T42
def test_two_million_keys_cost_nothing_because_the_size_bound_comes_first() -> None:
    raw = b"{" + b",".join(b'"k%d":1' % i for i in range(2_000_000)) + b"}"
    started = time.monotonic()

    parsed = parse_result(FINDINGS, raw)

    assert parsed.problem == "too_large"
    assert time.monotonic() - started < 0.1


# #843-T42
def test_nesting_deeper_than_any_schema_allows_is_refused_without_parsing() -> None:
    raw = b"[" * 100_000 + b"]" * 100_000

    assert scan_bounds(raw) == "too_deep"
    assert parse_result(FINDINGS, raw).problem == "too_deep"


# #843-T42
def test_more_values_than_the_bound_are_refused() -> None:
    raw = b'{"findings": [' + b",".join([b"1"] * 25_000) + b"]}"

    assert len(raw) < MAX_RESULT_BYTES
    assert scan_bounds(raw) == "too_many_values"


# #843-T42
def test_the_values_are_counted_as_the_app_counts_them_to_the_edge() -> None:
    # The root, the list and the entries: 20,000 values are within the bound, 20,001 are not.
    edge = b'{"findings": [' + b",".join([b"1"] * 19_998) + b"]}"
    over = b'{"findings": [' + b",".join([b"1"] * 19_999) + b"]}"
    empties = b'{"a": {}, "b": [], "c": [[], {}]}'

    assert scan_bounds(edge) is None
    assert scan_bounds(over) == "too_many_values"
    assert scan_bounds(empties) is None


# #843-T42
def test_brackets_and_commas_inside_a_text_are_not_counted() -> None:
    text = "[" * 5000 + "," * 5000 + '\\"' + "{" * 5000
    raw = json.dumps({"findings": [], "t": text}).encode()

    assert scan_bounds(raw) is None


# #843-T42
@pytest.mark.parametrize("raw", [b"", b"nope", b'{"a": 1,}', b"\xff\xfe", b'{"findings": NaN}'])
def test_what_is_not_json_is_not_json(raw: bytes) -> None:
    assert parse_result(FINDINGS, raw).problem == "not_json"


# #843-T42
def test_a_right_result_is_returned_as_data() -> None:
    parsed = parse_result(FINDINGS, json.dumps(RIGHT).encode())

    assert parsed.problem is None and parsed.value == RIGHT


# #843-T43
def test_a_wrong_result_is_refused_with_every_problem_and_the_way_to_fix_it() -> None:
    parsed = parse_result(FINDINGS, json.dumps(WRONG).encode())

    text = problem_sentence(parsed)
    assert parsed.value is None and parsed.problem == "invalid"
    assert "/findings/0/name" in text and "/findings/0/type" in text
    assert "bug, risk, nit" in text
    assert text.endswith("call the tool again.")


# #843-T43
def test_a_refusal_tells_the_first_problems_and_counts_the_rest() -> None:
    value = {"findings": [{"type": "bug", "name": "ok"}], **{f"x{i}": 1 for i in range(40)}}
    text = problem_sentence(parse_result(FINDINGS, json.dumps(value).encode()))

    assert text.count("\n- ") == 21
    assert "and 20 more problems" in text


# #843-T44
def test_submit_writes_a_right_result_and_leaves_a_wrong_one_out(tmp_path: Path) -> None:
    path = tmp_path / "result.json"

    refused, said = submit(FINDINGS, json.dumps(WRONG).encode(), str(path))
    assert refused is False and "Rejected" in said and not path.exists()

    accepted, said = submit(FINDINGS, json.dumps(RIGHT).encode(), str(path))
    assert accepted is True and "accepted" in said
    assert json.loads(path.read_text(encoding="utf-8")) == RIGHT
    assert [p.name for p in tmp_path.iterdir()] == ["result.json"], "no scratch file is left"


# #843-T44
def test_a_second_accepted_result_replaces_the_first(tmp_path: Path) -> None:
    path = tmp_path / "result.json"
    submit(FINDINGS, json.dumps(RIGHT).encode(), str(path))

    submit(FINDINGS, json.dumps({"findings": []}).encode(), str(path))

    assert json.loads(path.read_text(encoding="utf-8")) == {"findings": []}


# #843-T45
def test_the_tool_is_made_from_the_schema_with_closed_objects() -> None:
    schema = dict(FINDINGS, description="What the review found.")

    tool = tool_definition(schema)

    assert tool["name"] == "submit_result"
    assert "What the review found." in tool["description"]
    parameters = tool["inputSchema"]
    assert parameters["additionalProperties"] is False
    items = parameters["properties"]["findings"]["items"]
    assert items["additionalProperties"] is False
    assert items["properties"]["description"]["description"] == "What is wrong."
    assert "additionalProperties" not in FINDINGS, "the schema itself is not changed"


def call(name: str, arguments: Any, ident: int = 7) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": ident,
        "method": "tools/call",
        "params": {"name": name, "arguments": arguments},
    }


# #843-T46
def test_the_mcp_server_answers_the_handshake_and_lists_one_tool(tmp_path: Path) -> None:
    path = str(tmp_path / "result.json")
    hello = handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18"},
        },
        FINDINGS,
        path,
    )
    assert hello is not None
    assert hello["result"]["protocolVersion"] == "2025-06-18"
    assert hello["result"]["capabilities"] == {"tools": {"listChanged": False}}
    assert (
        handle_message({"jsonrpc": "2.0", "method": "notifications/initialized"}, FINDINGS, path)
        is None
    )
    listed = handle_message({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, FINDINGS, path)
    assert listed is not None
    assert [t["name"] for t in listed["result"]["tools"]] == ["submit_result"]
    assert handle_message({"jsonrpc": "2.0", "id": 3, "method": "ping"}, FINDINGS, path) == {
        "jsonrpc": "2.0",
        "id": 3,
        "result": {},
    }


# #843-T46
def test_a_protocol_version_it_does_not_know_gets_the_newest() -> None:
    answer = handle_message(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "1999-01-01"},
        },
        FINDINGS,
        "/nowhere",
    )

    assert answer is not None
    assert answer["result"]["protocolVersion"] == finish_tool.PROTOCOL_VERSIONS[0]


# #843-T47
def test_a_wrong_call_is_an_error_result_and_the_right_call_is_accepted(tmp_path: Path) -> None:
    path = tmp_path / "result.json"

    wrong = handle_message(call("submit_result", WRONG), FINDINGS, str(path))
    assert wrong is not None
    assert wrong["result"]["isError"] is True
    assert "/findings/0/type" in wrong["result"]["content"][0]["text"]
    assert not path.exists()

    right = handle_message(call("submit_result", RIGHT), FINDINGS, str(path))
    assert right is not None
    assert right["result"]["isError"] is False
    assert json.loads(path.read_text(encoding="utf-8")) == RIGHT


# #843-T47
@pytest.mark.parametrize("arguments", [None, [], "text", 5])
def test_arguments_that_are_no_object_are_refused(arguments: Any, tmp_path: Path) -> None:
    answer = handle_message(call("submit_result", arguments), FINDINGS, str(tmp_path / "r.json"))

    assert answer is not None and answer["result"]["isError"] is True


# #843-T47
def test_another_tool_and_another_method_are_protocol_errors() -> None:
    other = handle_message(call("rm_rf", {}), FINDINGS, "/nowhere")
    method = handle_message(
        {"jsonrpc": "2.0", "id": 9, "method": "resources/list"}, FINDINGS, "/nowhere"
    )

    assert other is not None and other["error"]["code"] == -32602
    assert method is not None and method["error"]["code"] == -32601
    assert handle_message([], FINDINGS, "/nowhere") == {
        "jsonrpc": "2.0",
        "id": None,
        "error": {"code": -32600, "message": "invalid request"},
    }


# #843-T47
def test_serve_answers_line_by_line_and_survives_garbage(tmp_path: Path) -> None:
    incoming = iter(
        [
            "not json\n",
            "\n",
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"}) + "\n",
            json.dumps(call("submit_result", RIGHT, 2)) + "\n",
        ]
    )
    sent: list[str] = []

    serve(lambda: next(incoming, ""), sent.append, FINDINGS, str(tmp_path / "result.json"))

    answers = [json.loads(line) for line in sent]
    assert answers[0]["error"]["code"] == -32700
    assert answers[1]["id"] == 1
    assert answers[2]["result"]["isError"] is False


def run_command(
    tmp_path: Path, stdin: bytes, *arguments: str, schema: object = FINDINGS
) -> subprocess.CompletedProcess[bytes]:
    schema_file = tmp_path / "schema.json"
    schema_file.write_text(json.dumps(schema), encoding="utf-8")
    return subprocess.run(
        [sys.executable, "-I", finish_tool.__file__, *arguments],
        input=stdin,
        capture_output=True,
        timeout=30,
        env={
            "FACTORY_RESULT_SCHEMA": str(schema_file),
            "FACTORY_RESULT_FILE": str(tmp_path / "result.json"),
        },
        check=False,
    )


# #843-T48
def test_the_command_rejects_with_exit_code_2_and_accepts_with_0(tmp_path: Path) -> None:
    refused = run_command(tmp_path, json.dumps(WRONG).encode())
    assert refused.returncode == 2
    assert b"/findings/0/type" in refused.stderr and refused.stdout == b""
    assert not (tmp_path / "result.json").exists()

    accepted = run_command(tmp_path, json.dumps(RIGHT).encode())
    assert accepted.returncode == 0
    assert b"accepted" in accepted.stdout
    assert json.loads((tmp_path / "result.json").read_text(encoding="utf-8")) == RIGHT


# #843-T48
def test_the_command_reads_at_most_the_bound_of_its_input(tmp_path: Path) -> None:
    done = run_command(tmp_path, b"[" + b"1," * MAX_RESULT_BYTES + b"1]")

    assert done.returncode == 2 and b"larger than" in done.stderr


# #843-T48
def test_the_command_says_so_when_it_has_no_valid_schema(tmp_path: Path) -> None:
    done = run_command(tmp_path, b"{}", schema={"type": "string"})

    assert done.returncode == 1 and b"cannot be read" in done.stderr


# #843-T48
def test_the_command_explains_itself(tmp_path: Path) -> None:
    done = run_command(tmp_path, b"", "--help")

    assert done.returncode == 0 and b"factory-submit" in done.stdout


# #843-T49
def test_the_mcp_mode_of_the_command_speaks_over_standard_input_and_output(tmp_path: Path) -> None:
    lines = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-11-25"},
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        call("submit_result", WRONG, 3),
        call("submit_result", RIGHT, 4),
    ]

    done = run_command(tmp_path, ("\n".join(json.dumps(m) for m in lines) + "\n").encode(), "mcp")

    answers = [json.loads(line) for line in done.stdout.decode().splitlines()]
    assert done.returncode == 0
    assert [a["id"] for a in answers] == [1, 2, 3, 4]
    assert answers[2]["result"]["isError"] is True
    assert answers[3]["result"]["isError"] is False
    assert json.loads((tmp_path / "result.json").read_text(encoding="utf-8")) == RIGHT
