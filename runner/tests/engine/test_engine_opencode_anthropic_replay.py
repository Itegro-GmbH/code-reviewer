# SPDX-License-Identifier: LicenseRef-Proprietary

"""The pinned OpenCode replays what a real Anthropic answer states, through the production proxy.

The first live Implementer run made one good call and was refused at the second: the SDK sends the
`caller` of a `tool_use` block back, and the proxy walked the message and did not know it. The
fakes never stated one, so no test could see it. The Messages fake now speaks the real stream
(`ping`, a thinking block with its `signature_delta`, `caller: {"type": "direct"}` on `tool_use`,
`service_tier`, the nested `cache_creation`, a `message_delta` that repeats the input fields), and
this test walks the whole loop through the real engine: a thinking block followed by parallel tool
calls, a tool that fails (`is_error`), and an image a tool returns.
Every call must reach the provider, and the ledger must hold them all. (Compaction is off on the
Dynamic path, and the Implementer's compaction has its own engine test, `#764-R2`, which runs on the
same real-shaped fake.)
"""

import base64
import json
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fakes.wire.formats import Turn
from opencode_native import MINIMAL_ENTRY, Provider
from opencode_passthrough import passthrough_engine

pytestmark = [pytest.mark.engine]

THINKING = "Let me look at the files."
# A one pixel PNG: what a tool hands the model when it reads an image file.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _loop(export: Path) -> list[Turn]:
    (export / "logo.png").write_bytes(PNG)
    return [
        Turn(
            tool="glob",
            args={"pattern": "**/*.py"},
            thinking=THINKING,
            also=(
                ("grep", {"pattern": "def "}),
                ("read", {"filePath": str(export / "src" / "app.py")}),
            ),
        ),
        Turn(tool="read", args={"filePath": str(export / "src" / "missing.py")}, thinking=THINKING),
        Turn(tool="read", args={"filePath": str(export / "logo.png")}, thinking=THINKING),
        Turn(tool="grep", args={"pattern": "query"}, thinking=THINKING),
        Turn(text='{"findings": [], "summary": "done"}', thinking=THINKING),
    ]


def _blocks(body: dict[str, Any], role: str) -> list[dict[str, Any]]:
    return [
        block
        for message in body["messages"]
        if message["role"] == role and isinstance(message["content"], list)
        for block in message["content"]
    ]


@pytest.fixture(scope="module")
def walked(tmp_path_factory: pytest.TempPathFactory):  # type: ignore[no-untyped-def]
    scratch = tmp_path_factory.mktemp("replay")
    provider = Provider(
        "messages",
        id="acme-replay",
        model="acme-claude-9",
        entry={**MINIMAL_ENTRY, "reasoning": True},
        script=_loop,
    )
    with passthrough_engine(scratch, [provider]) as engine:
        outcome = engine.turn("acme-replay", "acme-claude-9")
        yield engine, outcome


# #810-E01
def test_the_loop_the_real_engine_replays_after_a_real_shaped_answer_is_relayed_whole(
    walked: Any,
) -> None:
    engine, outcome = walked
    assert outcome.http_status == 200
    assert all(step.error is None for step in outcome.assistants), outcome.assistants
    front = engine.front("acme-replay")
    assert front.ledger.failure is None
    assert len(outcome.records) == 5
    assert front.ledger.usage("acme-claude-9").ai_calls == 5


# #810-E02
def test_the_second_request_carries_the_thinking_block_and_the_caller_the_engine_sends_back(
    walked: Any,
) -> None:
    _, outcome = walked
    second = outcome.records[1].body
    assistant = _blocks(second, "assistant")
    assert [block["type"] for block in assistant] == [
        "thinking",
        "tool_use",
        "tool_use",
        "tool_use",
    ]
    assert assistant[0]["thinking"] == THINKING and assistant[0]["signature"] == "sig-1"
    assert [block["caller"] for block in assistant[1:]] == [{"type": "direct"}] * 3
    # The parallel calls are answered together, in one user message.
    results = _blocks(second, "user")
    assert [block["type"] for block in results if block["type"] == "tool_result"] == [
        "tool_result"
    ] * 3


# #810-E03
def test_a_tool_that_fails_comes_back_as_an_error_result_and_is_relayed(walked: Any) -> None:
    _, outcome = walked
    third = outcome.records[2].body
    failed = [block for block in _blocks(third, "user") if block.get("is_error") is True]
    assert len(failed) == 1


# #810-E04
def test_an_image_a_tool_returns_reaches_the_provider(walked: Any) -> None:
    _, outcome = walked
    fourth = json.dumps(outcome.records[3].body)
    assert '"type": "image"' in fourth
