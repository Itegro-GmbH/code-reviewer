# SPDX-License-Identifier: LicenseRef-Proprietary

"""#853: `scripts/runner_spikes.py` pulls images, installs packages and removes containers by fixed
names, so it must refuse to run anywhere but a `spike-` VM. Its proposed mapping of Claude Code's
`stream-json` events to our step records (`ClaudeEvents`, read by the unchanged `StepConverter`) is
pinned here on a short run captured from Claude Code 2.1.311 against the strict fake."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "runner_spikes.py"
SESSION = "d847dcf5-e741-4252-98b0-d73cbc39f2c0"


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("runner_spikes", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["runner_spikes"] = module
    spec.loader.exec_module(module)
    return module


spikes = load_script()

USAGE: dict[str, Any] = {
    "input_tokens": 1010,
    "output_tokens": 1,
    "cache_creation_input_tokens": 59,
    "cache_read_input_tokens": 301,
}


def assistant(message_id: str, block: dict[str, Any], stamp: str) -> dict[str, Any]:
    return {
        "type": "assistant",
        "session_id": SESSION,
        "timestamp": stamp,
        "message": {"id": message_id, "role": "assistant", "content": [block], "usage": USAGE},
    }


def result_of(call: str, text: str, *, is_error: bool, stamp: str) -> dict[str, Any]:
    block = {"type": "tool_result", "tool_use_id": call, "content": text, "is_error": is_error}
    return {
        "type": "user",
        "session_id": SESSION,
        "timestamp": stamp,
        "message": {"role": "user", "content": [block]},
    }


def message_delta(output_tokens: int, reason: str) -> dict[str, Any]:
    return {
        "type": "stream_event",
        "session_id": SESSION,
        "event": {
            "type": "message_delta",
            "delta": {"stop_reason": reason},
            "usage": {**USAGE, "output_tokens": output_tokens},
        },
    }


def a_run() -> list[dict[str, Any]]:
    """A thought and a read, a refused edit, the answer: the shapes Claude Code 2.1.311 prints with
    `--output-format stream-json --verbose --include-partial-messages`."""
    return [
        {"type": "system", "subtype": "init", "session_id": SESSION},
        {
            "type": "stream_event",
            "session_id": SESSION,
            "event": {"type": "message_start", "message": {"id": "msg_1", "usage": USAGE}},
        },
        assistant(
            "msg_1",
            {"type": "thinking", "thinking": "Read it first.", "signature": "s"},
            "2026-11-04T21:35:55.880Z",
        ),
        assistant(
            "msg_1",
            {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": "/w/a"}},
            "2026-11-04T21:35:55.881Z",
        ),
        message_delta(21, "tool_use"),
        result_of("toolu_1", "1\tline", is_error=False, stamp="2026-11-04T21:35:55.905Z"),
        {
            "type": "stream_event",
            "session_id": SESSION,
            "event": {"type": "message_start", "message": {"id": "msg_2", "usage": USAGE}},
        },
        assistant(
            "msg_2",
            {"type": "tool_use", "id": "toolu_2", "name": "Edit", "input": {"file_path": "/w/a"}},
            "2026-11-04T21:35:55.937Z",
        ),
        message_delta(22, "tool_use"),
        result_of("toolu_2", "needs approval", is_error=True, stamp="2026-11-04T21:35:55.983Z"),
        {
            "type": "stream_event",
            "session_id": SESSION,
            "event": {"type": "message_start", "message": {"id": "msg_3", "usage": USAGE}},
        },
        assistant("msg_3", {"type": "text", "text": "Done."}, "2026-11-04T21:35:56.050Z"),
        message_delta(24, "end_turn"),
        {"type": "result", "subtype": "success", "session_id": SESSION, "total_cost_usd": 0.01},
    ]


def test_a_host_that_is_no_spike_vm_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(spikes.socket, "gethostname", lambda: "devbox-1")
    monkeypatch.delenv("FOLLOW_UP_SPIKE_I_AM_ON_A_SPIKE_VM", raising=False)
    monkeypatch.setattr(sys, "argv", ["runner_spikes.py", "s1"])

    with pytest.raises(SystemExit) as refused:
        spikes.main()

    assert "spike-" in str(refused.value)


def test_claude_code_events_make_the_records_of_the_live_view() -> None:
    records = [record.as_json() for record in spikes.step_records(a_run())]

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
    assert [r["seq"] for r in records] == list(range(1, 10))


def test_the_tokens_of_a_step_are_those_of_the_message_delta_not_of_the_assistant_event() -> None:
    steps = [r.as_json() for r in spikes.step_records(a_run()) if r.kind == "step"]

    assert [s["tokens"]["output"] for s in steps] == [21, 22, 24]
    assert [s["reason"] for s in steps] == ["tool_use", "tool_use", "end_turn"]
    assert steps[0]["tokens"] == {
        "input": 1010,
        "output": 21,
        "reasoning": 0,
        "cacheRead": 301,
        "cacheWrite": 59,
    }


def test_a_failed_tool_carries_its_error_text_and_a_finished_one_no_output() -> None:
    tools = {
        (r.part_id, r.status): r.as_json() for r in spikes.step_records(a_run()) if r.kind == "tool"
    }

    assert tools["toolu_2", "error"]["error"] == "needs approval"
    assert "error" not in tools["toolu_1", "completed"]
    assert all("1\tline" not in str(record) for record in tools.values())


def test_the_finish_tool_rejects_what_the_schema_does_not_allow() -> None:
    assert spikes.validate_result({"summary": "done", "files": ["a"]}) is None
    assert "unknown field" in spikes.validate_result({"summary": "done", "extra": 1})
    assert "summary" in spikes.validate_result({"summary": 5})
    assert "array of strings" in spikes.validate_result({"summary": "x", "files": [1]})
    assert spikes.validate_result([]) == "the result must be an object"
