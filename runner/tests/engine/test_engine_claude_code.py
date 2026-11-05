# SPDX-License-Identifier: LicenseRef-Proprietary

"""The Claude Code adapter against the real, pinned Claude Code (#856): the command line and the
environment the runner starts it with, the events it prints, the finish tool through its real MCP
client, a resumed session and what a repository cannot change. The provider is the strict scripted
fake of `fakes/wire` behind a made-up key; nothing talks beyond loopback, no model, no
subscription. What the unit tests cannot prove is what only the real program does (the adapter's
own logic is theirs: `test_claude_code_*.py`)."""

import json
import sys
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest
from claude_code_support import (
    FAKE_KEY,
    SESSION,
    Turn,
    Workplace,
    claude_binary,
    provider,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Turn as Scripted
from fakes.wire.upstream import ScriptedUpstream

from code_reviewer_runner.implementer.claude_code.command import SessionChoice
from code_reviewer_runner.implementer.claude_code.events import ClaudeEvents
from code_reviewer_runner.implementer.step_records import StepConverter
from code_reviewer_runner.redaction import Redactor

pytestmark = pytest.mark.engine

SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["summary"],
    "properties": {"summary": {"type": "string", "description": "What was done."}},
}


@contextmanager
def served(*script: Scripted) -> Generator[tuple[ScriptedUpstream, str]]:
    with provider(list(script)) as fake:
        yield fake, fake.url


def records_of(turn: Turn) -> list[dict[str, Any]]:
    adapter = ClaudeEvents(SESSION)
    converter = StepConverter(SESSION, Redactor([FAKE_KEY]))
    found: list[dict[str, Any]] = []
    for event in turn.events:
        for engine_event in adapter.convert(event):
            record = converter.convert(engine_event)
            if record is not None:
                found.append(record.as_json())
    return found


def test_the_pinned_executable_is_there() -> None:
    assert claude_binary().is_file()


# #856-T30
def test_a_turn_is_headless_free_inside_the_sandbox_and_ends_with_a_priced_result(
    tmp_path: Path,
) -> None:
    place = Workplace(tmp_path)
    with served(
        Scripted(
            thinking="Read first.", tool="Read", args={"file_path": str(place.repo / "notes.txt")}
        ),
        Scripted(tool="Bash", args={"command": "echo hi > out.txt", "description": "write"}),
        Scripted(text="All done."),
    ) as (fake, url):
        turn = place.run(url, "Fix the bug in notes.txt")

    assert turn.returncode == 0 and turn.ignored == 0
    assert turn.init["permissionMode"] == "bypassPermissions"
    assert turn.init["apiKeySource"] == "ANTHROPIC_API_KEY"
    assert (place.repo / "out.txt").read_text() == "hi\n"
    kinds = [(r["kind"], r.get("status")) for r in records_of(turn)]
    assert ("reasoning", None) in kinds and ("text", None) in kinds
    assert [k for k in kinds if k[0] == "tool"] == [
        ("tool", "running"),
        ("tool", "completed"),
        ("tool", "running"),
        ("tool", "completed"),
    ]
    assert sum(1 for k in kinds if k[0] == "step") == 3
    assert turn.result.ok and turn.result.text == "All done."
    assert turn.result.estimated_cost_usd is not None and turn.result.estimated_cost_usd > 0
    # The rules of the workplace are part of the system prompt, the prompt is the user's message.
    first: Any = fake.records[0].body
    assert "Rules of this workplace" in json.dumps(first["system"])


# #856-T31
def test_the_finish_tool_is_a_real_tool_whose_refusal_the_agent_sees_and_corrects(
    tmp_path: Path,
) -> None:
    place = Workplace(tmp_path, SCHEMA)
    with served(
        Scripted(tool="mcp__finish__submit_result", args={"summary": 5}),
        Scripted(tool="mcp__finish__submit_result", args={"summary": "done"}),
        Scripted(text="Handed in."),
    ) as (fake, url):
        turn = place.run(url, "Do it and hand in the result")

    assert turn.result.ok
    assert place.result_file.read_text() == '{"summary": "done"}'
    submits = [r for r in records_of(turn) if r["kind"] == "tool" and r["status"] != "running"]
    assert [r["status"] for r in submits] == ["error", "completed"]
    assert "summary" in submits[0]["error"]
    # `ENABLE_TOOL_SEARCH=false`: the first request has the tool with its schema, no search first.
    first: Any = fake.records[0].body
    tools = {t["name"]: t for t in first["tools"]}
    assert "mcp__finish__submit_result" in tools
    assert tools["mcp__finish__submit_result"]["input_schema"]["required"] == ["summary"]


# #856-T32
def test_a_second_message_resumes_the_session_and_the_provider_gets_the_whole_history(
    tmp_path: Path,
) -> None:
    place = Workplace(tmp_path)
    with served(
        Scripted(tool="Read", args={"file_path": str(place.repo / "notes.txt")}),
        Scripted(text="First answer."),
        Scripted(text="Second answer."),
    ) as (fake, url):
        first = place.run(url, "Read the notes")
        second = place.run(url, "Now go on", session=SessionChoice.resume(SESSION))

    assert first.result.ok and second.result.ok
    assert second.result.session_id == SESSION == first.result.session_id
    last: Any = fake.records[-1].body
    assert len(last["messages"]) >= 4, "the history of the first turn travelled with the second"
    assert second.result.text == "Second answer."


# #856-T33
def test_a_session_that_does_not_exist_is_told_apart_and_costs_no_model_call(
    tmp_path: Path,
) -> None:
    place = Workplace(tmp_path)
    with served(Scripted(text="never asked")) as (fake, url):
        turn = place.run(url, "go on", session=SessionChoice.resume(SESSION))

    assert turn.returncode != 0 and turn.result.missing_conversation
    assert fake.records == []


# #856-T34
def test_without_a_login_nothing_is_sent_and_the_turn_says_so(tmp_path: Path) -> None:
    place = Workplace(tmp_path)
    with served(Scripted(text="never asked")) as (fake, url):
        turn = place.run(url, "go", logged_in=False)

    assert turn.result.not_logged_in and fake.records == []


# #856-T35
def test_a_budget_ends_the_turn_after_the_call_that_crosses_it(tmp_path: Path) -> None:
    place = Workplace(tmp_path)
    with served(
        Scripted(tool="Read", args={"file_path": str(place.repo / "notes.txt")}),
        Scripted(tool="Read", args={"file_path": str(place.repo / "notes.txt")}),
        Scripted(text="too late"),
    ) as (fake, url):
        turn = place.run(url, "Read twice", max_budget_usd="0.0001")

    assert turn.returncode != 0 and turn.result.budget_exhausted
    assert len(fake.records) < 3


MARKER_COMMAND = "touch {marker}"


# #856-T36
def test_what_the_repository_holds_is_data_its_hooks_and_servers_are_not_run(
    tmp_path: Path,
) -> None:
    place = Workplace(tmp_path)
    hook_marker, server_marker = tmp_path / "hook-ran", tmp_path / "server-ran"
    (place.repo / ".claude").mkdir()
    (place.repo / ".claude" / "settings.json").write_text(
        json.dumps(
            {
                "hooks": {
                    "SessionStart": [
                        {"hooks": [{"type": "command", "command": f"touch {hook_marker}"}]}
                    ]
                }
            }
        )
    )
    (place.repo / ".mcp.json").write_text(
        json.dumps(
            {
                "mcpServers": {
                    "repo": {
                        "type": "stdio",
                        "command": "/bin/sh",
                        "args": ["-c", f"touch {server_marker}; sleep 5"],
                    }
                }
            }
        )
    )
    with served(Scripted(text="ok")) as (_, url):
        turn = place.run(url, "go")

    assert turn.result.ok
    assert not hook_marker.exists() and not server_marker.exists()
    assert turn.init["mcp_servers"] == []

    # The control: with the settings of the repository and its servers allowed, the same files do
    # run, so the test above can fail.
    with served(Scripted(text="ok")) as (_, url):
        control = place.run(
            url,
            "go",
            session=SessionChoice.new("9d3f1c52-7a0e-4d57-8c33-5b6c1f0a2e11"),
            setting_sources="user,project,local",
        )

    assert control.result.ok
    assert hook_marker.exists() or [s["name"] for s in control.init["mcp_servers"]] == ["repo"]
