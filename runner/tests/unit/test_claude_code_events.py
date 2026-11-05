# SPDX-License-Identifier: LicenseRef-Proprietary

"""#856: what the Claude Code adapter makes of the `stream-json` output of `claude -p` (shapes of
2.1.311, captured in the R0 spike #853): the step records of the live view, the end of the turn and
the cost figure that is an estimate. Pure: no process, no network."""

import json
from decimal import Decimal
from typing import Any

from code_reviewer_runner.implementer.claude_code.events import (
    ClaudeEvents,
    LineSplitter,
    parse_result,
)
from code_reviewer_runner.implementer.step_records import StepConverter
from code_reviewer_runner.redaction import Redactor

SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"
USAGE: dict[str, Any] = {
    "input_tokens": 1010,
    "output_tokens": 1,
    "cache_creation_input_tokens": 59,
    "cache_read_input_tokens": 301,
}


def start(message_id: str) -> dict[str, Any]:
    return {
        "type": "stream_event",
        "session_id": SESSION,
        "event": {"type": "message_start", "message": {"id": message_id, "usage": USAGE}},
    }


def block(message_id: str, content: dict[str, Any], stamp: str) -> dict[str, Any]:
    return {
        "type": "assistant",
        "session_id": SESSION,
        "timestamp": stamp,
        "message": {"id": message_id, "role": "assistant", "content": [content], "usage": USAGE},
    }


def delta(output_tokens: int, reason: str) -> dict[str, Any]:
    return {
        "type": "stream_event",
        "session_id": SESSION,
        "event": {
            "type": "message_delta",
            "delta": {"stop_reason": reason},
            "usage": {**USAGE, "output_tokens": output_tokens},
        },
    }


def tool_result(call: str, text: str, *, is_error: bool, stamp: str) -> dict[str, Any]:
    content = {"type": "tool_result", "tool_use_id": call, "content": text, "is_error": is_error}
    return {
        "type": "user",
        "session_id": SESSION,
        "timestamp": stamp,
        "message": {"role": "user", "content": [content]},
    }


def a_run() -> list[dict[str, Any]]:
    """A thought and a read, a refused edit, the answer."""
    return [
        {"type": "system", "subtype": "init", "session_id": SESSION},
        start("msg_1"),
        block(
            "msg_1", {"type": "thinking", "thinking": "Read it first."}, "2026-11-04T21:35:55.880Z"
        ),
        block(
            "msg_1",
            {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": "/w/a"}},
            "2026-11-04T21:35:55.881Z",
        ),
        delta(21, "tool_use"),
        tool_result("toolu_1", "1\tline", is_error=False, stamp="2026-11-04T21:35:55.905Z"),
        start("msg_2"),
        block(
            "msg_2",
            {"type": "tool_use", "id": "toolu_2", "name": "Edit", "input": {"file_path": "/w/a"}},
            "2026-11-04T21:35:55.937Z",
        ),
        delta(22, "tool_use"),
        tool_result("toolu_2", "needs approval", is_error=True, stamp="2026-11-04T21:35:55.983Z"),
        start("msg_3"),
        block("msg_3", {"type": "text", "text": "Done."}, "2026-11-04T21:35:56.050Z"),
        delta(24, "end_turn"),
        {"type": "result", "subtype": "success", "session_id": SESSION, "total_cost_usd": 0.01},
    ]


def records_of(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    adapter = ClaudeEvents(SESSION)
    converter = StepConverter(SESSION, Redactor([]))
    found: list[dict[str, Any]] = []
    for event in events:
        for engine_event in adapter.convert(event):
            record = converter.convert(engine_event)
            if record is not None:
                found.append(record.as_json())
    return found


# #856-T01
def test_claude_code_events_make_the_records_of_the_live_view() -> None:
    records = records_of(a_run())

    assert [(r["kind"], r["partId"], r.get("status")) for r in records] == [
        ("reasoning", "msg_1.1", None),
        ("tool", "toolu_1", "running"),
        ("step", "msg_1.step", None),
        ("tool", "toolu_1", "completed"),
        ("tool", "toolu_2", "running"),
        ("step", "msg_2.step", None),
        ("tool", "toolu_2", "error"),
        ("text", "msg_3.1", None),
        ("step", "msg_3.step", None),
    ]


# #856-T01
def test_the_tokens_of_a_step_are_those_of_the_message_delta() -> None:
    steps = [r for r in records_of(a_run()) if r["kind"] == "step"]

    assert [s["tokens"]["output"] for s in steps] == [21, 22, 24]
    assert steps[0]["tokens"] == {
        "input": 1010,
        "output": 21,
        "reasoning": 0,
        "cacheRead": 301,
        "cacheWrite": 59,
    }


# #856-T01
def test_a_failed_tool_has_its_error_text_and_no_output_is_recorded() -> None:
    tools = {(r["partId"], r["status"]): r for r in records_of(a_run()) if r["kind"] == "tool"}

    assert tools["toolu_2", "error"]["error"] == "needs approval"
    assert all("1\tline" not in str(record) for record in tools.values())


# #856-T01
def test_an_event_of_another_kind_makes_no_record() -> None:
    events: list[dict[str, Any]] = [
        {"type": "system", "subtype": "status"},
        {"type": "rate_limit_event"},
        {"type": "user", "message": {"role": "user", "content": "plain text, no blocks"}},
        {"type": "assistant", "message": "not an object"},
        {"type": "stream_event", "event": "not an object"},
    ]

    assert records_of(events) == []


# #856-T02
def test_the_line_splitter_joins_chunks_and_gives_whole_json_lines_only() -> None:
    splitter = LineSplitter()
    first, second = json.dumps({"type": "a"}), json.dumps({"type": "b"})
    data = f"{first}\nnot json at all\n{second}\n".encode()

    found = splitter.feed(data[:7]) + splitter.feed(data[7:30]) + splitter.feed(data[30:])

    assert found == [{"type": "a"}, {"type": "b"}]
    assert splitter.ignored == 1


# #856-T02
def test_the_line_splitter_gives_up_a_line_that_is_too_long_and_goes_on() -> None:
    splitter = LineSplitter(max_line_bytes=64)

    found = splitter.feed(b'{"type": "' + b"x" * 200 + b'"}\n{"type": "ok"}\n')

    assert found == [{"type": "ok"}]
    assert splitter.ignored == 1


# #856-T02
def test_the_line_splitter_keeps_the_last_line_without_a_newline_for_finish() -> None:
    splitter = LineSplitter()

    assert splitter.feed(b'{"type": "result"}') == []
    assert splitter.finish() == [{"type": "result"}]


def a_result(**changes: Any) -> dict[str, Any]:
    document: dict[str, Any] = {
        "type": "result",
        "subtype": "success",
        "is_error": False,
        "result": "All done.",
        "session_id": SESSION,
        "total_cost_usd": 0.0150285,
        "terminal_reason": "completed",
        "num_turns": 4,
        "permission_denials": [],
        "modelUsage": {"claude-sonnet-4-5": {"costUSD": 0.0150285, "costBasis": "list"}},
    }
    document.update(changes)
    return document


# #856-T03
def test_a_list_priced_total_is_the_estimate_of_a_turn() -> None:
    result = parse_result(a_result())

    assert result.ok
    assert result.text == "All done."
    assert result.session_id == SESSION
    assert result.estimated_cost_usd == Decimal("0.0150285")


# #856-T03
def test_a_total_that_is_not_list_priced_is_unknown_never_a_number() -> None:
    unknown = parse_result(
        a_result(
            total_cost_usd=0.0198,
            modelUsage={"made-up": {"costUSD": 0.0198, "costBasis": "unknown"}},
        )
    )
    mixed = parse_result(
        a_result(
            modelUsage={
                "claude-sonnet-4-5": {"costBasis": "list"},
                "made-up": {"costBasis": "unknown"},
            }
        )
    )
    none_at_all = parse_result(a_result(modelUsage={}))
    no_total = parse_result({k: v for k, v in a_result().items() if k != "total_cost_usd"})
    not_a_number = parse_result(a_result(total_cost_usd="0.01"))
    flag = parse_result(a_result(total_cost_usd=True))

    assert [
        r.estimated_cost_usd for r in (unknown, mixed, none_at_all, no_total, not_a_number, flag)
    ] == [None] * 6


# #856-T03
def test_a_turn_that_ended_on_its_budget_is_a_failed_turn_with_its_reason() -> None:
    result = parse_result(
        a_result(subtype="error_max_budget_usd", is_error=True, terminal_reason="budget_exhausted")
    )

    assert not result.ok
    assert result.subtype == "error_max_budget_usd"
    assert result.budget_exhausted
    assert result.estimated_cost_usd == Decimal("0.0150285")


# #856-T04
def test_an_empty_session_volume_is_told_from_any_other_failure() -> None:
    # What Claude Code 2.1.304 prints (the engine test pins it on the real program): the sentence
    # is in `errors`, the `result` text is empty.
    missing = parse_result(
        a_result(
            subtype="error_during_execution",
            is_error=True,
            result="",
            errors=["No conversation found with session ID: 5b6c"],
            total_cost_usd=0,
            modelUsage={},
        )
    )
    in_text = parse_result(
        a_result(is_error=True, result="No conversation found with session ID: 5")
    )
    other = parse_result(a_result(is_error=True, result="Not logged in · Please run /login"))

    assert missing.missing_conversation and in_text.missing_conversation
    assert not other.missing_conversation
    # Claude Code says `success` with `is_error` true for a device that is not logged in.
    assert other.not_logged_in and not other.ok


# #856-T03
def test_a_result_that_is_not_an_object_or_has_odd_fields_is_still_a_failed_turn() -> None:
    odd = parse_result({"type": "result", "result": 5, "session_id": 7, "permission_denials": "x"})

    assert not odd.ok
    assert odd.text == ""
    assert odd.session_id is None
    assert odd.permission_denials == 0
