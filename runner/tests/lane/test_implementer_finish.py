# SPDX-License-Identifier: LicenseRef-Proprietary

"""The finish tool on a real Docker daemon (#843): the real agent image with the pinned OpenCode,
the real reader that reads the result file, the production session, against a scripted model.

What these prove that the engine suite (`tests/engine/test_engine_implementer_finish.py`) and the
unit tests cannot: that the result directory is mounted in the agent's container and in the reader
(the Subpath `result` of the work volume), that the program written into `/etc/code-reviewer` runs
under the image's own `python3`, that the real OpenCode finds the MCP server and the command on the
agent's `PATH`, and that the result of the turn is the file as it is at the end (a write after an
accepted result counts). That Control reads it only once the agent's container is gone is held by
the session (`_collect_result`) and its integration tests, where the order of the calls is
recorded; a lane cannot observe it without a race."""

import json
from pathlib import Path
from typing import Any

from fakes.wire.formats import Turn
from lane_support import bash, commit, lane_turn, says, write_file

from code_reviewer_runner.implementer.prompts import RESULT_REMINDER_PROMPT
from code_reviewer_runner.result import ErrorCode

SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["summary", "verdict"],
    "properties": {
        "summary": {"type": "string", "description": "What was done."},
        "verdict": {"type": "string", "enum": ["done", "partial"]},
    },
}
WRONG = {"summary": 5, "verdict": "great"}
RIGHT = {"summary": "Added hello.txt.", "verdict": "done"}
TOOL = "finish_submit_result"


def submit_by_command(payload: Any) -> Turn:
    return bash(f"printf '%s' '{json.dumps(payload)}' | factory-submit")


def tool_names(request: dict[str, Any]) -> list[str]:
    return [tool["name"] for tool in request["tools"]]


# #843-E01
def test_the_real_engine_offers_the_mcp_tool_and_the_result_it_accepts_ends_the_turn(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "hello.txt"),
            commit("Add hello"),
            Turn(tool=TOOL, args=WRONG),
            Turn(tool=TOOL, args=RIGHT),
            says("Done."),
        ]

    with lane_turn(tmp_path, script, result_schema=SCHEMA) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert result.agent_result == RIGHT
        assert TOOL in tool_names(turned.requests[0])
        assert result.pushed and [c.subject for c in result.commits] == ["Add hello"]
        assert len(turned.messages) == 1, "a result was handed in: no reminder"


# #843-E02
def test_the_command_is_on_the_agents_path_and_its_refusal_reaches_the_model(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "hello.txt"),
            commit("Add hello"),
            submit_by_command(WRONG),
            submit_by_command(RIGHT),
            says("Done."),
        ]

    with lane_turn(tmp_path, script, result_schema=SCHEMA) as turned:
        result = turned.result

        assert result.ok, (result.error_code, result.error_detail, result.notes)
        assert result.agent_result == RIGHT
        assert "Rejected" in json.dumps(turned.requests[-1])


# #843-E03
def test_an_agent_that_hands_in_nothing_is_reminded_once_and_the_turn_ends_no_result(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "hello.txt"),
            commit("Add hello"),
            says("Done, I think."),
            says("Still done."),  # the answer to the reminder
        ]

    with lane_turn(tmp_path, script, result_schema=SCHEMA) as turned:
        result = turned.result

        assert result.error_code is ErrorCode.NO_RESULT, (result.error_detail, result.notes)
        assert result.agent_result is None
        assert len(turned.messages) == 2 and turned.messages[1][1] == RESULT_REMINDER_PROMPT
        assert result.pushed, "what the agent committed arrives all the same"


# #843-E04
def test_a_file_the_agent_changes_after_it_was_accepted_is_judged_as_it_is_at_the_end(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "hello.txt"),
            commit("Add hello"),
            Turn(tool=TOOL, args=RIGHT),
            bash("echo 'not json' > /work/result/result.json"),
            says("Done."),
            says("Still done."),  # the answer to the reminder
        ]

    with lane_turn(tmp_path, script, result_schema=SCHEMA) as turned:
        result = turned.result

        assert result.error_code is ErrorCode.NO_RESULT, (result.error_detail, result.notes)
        assert "not_json" in (result.error_detail or "")
        assert result.agent_result is None
