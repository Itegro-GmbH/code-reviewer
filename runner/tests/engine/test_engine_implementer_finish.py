# SPDX-License-Identifier: LicenseRef-Proprietary

"""The finish tool against the real, pinned OpenCode (#843).

The two doors the agent has to hand in its result, each driven by a scripted model that first hands
in a wrong result and then a right one: the MCP tool `submit_result` (a stdio server the engine
starts from its config, `config.finish_mcp_block`) and the command `factory-submit` through the
engine's bash tool. What these tests prove is what only the real engine can: that it starts the
server, offers the tool to the model with the schema made from the result schema, sends the model
the refusal as an error result, and runs the command. The check itself is the unit tests'
(`test_finish_tool.py`). The provider is the strict scripted fake of `fakes/wire` behind the key
swapping relay; nothing talks beyond loopback.
"""

import json
import sys
from collections.abc import Callable, Generator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from fakes.wire.formats import Turn
from fakes.wire.relay import KeySwapRelay
from fakes.wire.upstream import ScriptedUpstream
from opencode_native import (
    BASE_PATH,
    DEFAULT_IDS,
    DUMMY_KEY,
    REAL_KEY,
    NativeEngine,
    Provider,
    Running,
    _Engine,  # pyright: ignore[reportPrivateUsage]
    engine_config,
    make_export,
    provider_block,
)

from code_reviewer_runner.implementer import finish_tool
from code_reviewer_runner.implementer.config import (
    FINISH_MCP_SERVER,
    finish_mcp_block,
    finish_permissions,
    permission_block,
)

pytestmark = pytest.mark.engine

SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["summary", "verdict"],
    "properties": {
        "summary": {"type": "string", "description": "What was done."},
        "verdict": {"type": "string", "enum": ["done", "partial"]},
    },
}
WRONG = {"summary": 5, "verdict": "great"}
RIGHT = {"summary": "Added the retry.", "verdict": "done"}
TOOL = f"{FINISH_MCP_SERVER}_{finish_tool.TOOL_NAME}"


@dataclass
class Finish:
    engine: NativeEngine
    upstream: ScriptedUpstream
    result: Path
    command: Path


def command_line(command: Path, payload: Any) -> str:
    return f"printf '%s' '{json.dumps(payload)}' | {command}"


@contextmanager
def finish_engine(
    scratch: Path, make_script: Callable[[Path], list[Turn]]
) -> Generator[Finish]:
    """One engine whose agent has the finish tool, and a model that plays the script made for the
    path of the command."""
    schema_file = scratch / "result-schema.json"
    schema_file.write_text(json.dumps(SCHEMA), encoding="utf-8")
    result = scratch / "result.json"
    # The way the container finds the command and the files is its own (fixed paths); a test has
    # to say where they are.
    wrapper = scratch / "factory-submit"
    wrapper.write_text(
        f"#!/bin/sh\nFACTORY_RESULT_SCHEMA={schema_file} FACTORY_RESULT_FILE={result} "
        f'exec {sys.executable} -I {finish_tool.__file__} "$@"\n',
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    provider = Provider("chat")
    export = make_export(scratch)
    with ExitStack() as stack:
        upstream = stack.enter_context(
            ScriptedUpstream("chat", make_script(wrapper), provider.model_id, real_key=REAL_KEY)
        )
        relay = stack.enter_context(
            KeySwapRelay("chat", upstream.url, dummy_key=DUMMY_KEY, real_key=REAL_KEY)
        )
        block = provider_block(provider, relay.url)
        config = engine_config({provider.provider_id: block}, f"{provider.provider_id}/{provider.model_id}")
        config["mcp"] = finish_mcp_block(
            command=[sys.executable, "-I", finish_tool.__file__, "mcp"],
            environment={
                "FACTORY_RESULT_SCHEMA": str(schema_file),
                "FACTORY_RESULT_FILE": str(result),
            },
        )
        config["permission"] = {**permission_block(), **finish_permissions()}
        process = _Engine(config, export, scratch / "home", relay.url, None)
        stack.callback(process.stop)
        running = {provider.provider_id: Running(provider, upstream, relay)}
        yield Finish(NativeEngine(process, running), upstream, result, wrapper)


def tool_names(body: dict[str, Any]) -> list[str]:
    return sorted(t["function"]["name"] for t in body.get("tools", []))


def tool_results(body: dict[str, Any]) -> list[str]:
    return [m["content"] for m in body["messages"] if m["role"] == "tool"]


# #843-E01
def test_the_real_engine_offers_the_mcp_tool_and_the_model_hands_in_a_wrong_result_then_a_right_one(
    tmp_path: Path,
) -> None:
    def script(_: Path) -> list[Turn]:
        return [Turn(tool=TOOL, args=WRONG), Turn(tool=TOOL, args=RIGHT), Turn(text="Done.")]

    with finish_engine(tmp_path, script) as finish:
        ids = DEFAULT_IDS["chat"]
        outcome = finish.engine.turn(*ids)

        assert outcome.http_status == 200
        calls = [r.body for r in outcome.records if r.body.get("tools")]
        assert TOOL in tool_names(calls[0]), tool_names(calls[0])
        offered = next(t for t in calls[0]["tools"] if t["function"]["name"] == TOOL)["function"]
        assert offered["parameters"]["additionalProperties"] is False
        assert offered["parameters"]["properties"]["verdict"]["enum"] == ["done", "partial"]
        assert "Rejected" in tool_results(calls[1])[-1] and "/verdict" in tool_results(calls[1])[-1]
        assert "accepted" in tool_results(calls[2])[-1]
        assert json.loads(finish.result.read_text(encoding="utf-8")) == RIGHT


# #843-E02
def test_the_real_engine_runs_the_command_and_the_model_reads_its_refusal(tmp_path: Path) -> None:
    def script(command: Path) -> list[Turn]:
        return [
            Turn(tool="bash", args={"command": command_line(command, payload), "description": "hand in"})
            for payload in (WRONG, RIGHT)
        ] + [Turn(text="Done.")]

    with finish_engine(tmp_path, script) as finish:
        outcome = finish.engine.turn(*DEFAULT_IDS["chat"])

        assert outcome.http_status == 200
        calls = [r.body for r in outcome.records if r.body.get("tools")]
        assert "Rejected" in tool_results(calls[1])[-1] and "/verdict" in tool_results(calls[1])[-1]
        assert "accepted" in tool_results(calls[2])[-1]
        assert json.loads(finish.result.read_text(encoding="utf-8")) == RIGHT
