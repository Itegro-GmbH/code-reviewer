# SPDX-License-Identifier: LicenseRef-Proprietary

"""What the agent's model calls look like on the wire and what the ledger makes of them (#745, step
4): the cases of #764 that the deleted real-engine test file proved and that still mean something
with the agent in a container of its own, through the real door. T09: prompt caching stays on (the
marks the engine puts on a Claude request reach the provider as it wrote them, on every call; the
provider replays its own prefix; the ledger counts what the provider states, cache reads and writes
included, and prices it with the book). T10: usage and call trace of the kind are recorded and valid
against the contract."""

import json
from fractions import Fraction
from pathlib import Path
from typing import Any, cast

import pytest
from fake_llm import real_anthropic_usage
from fakes.llm.anthropic_cache import PromptCache
from fakes.wire.formats import Turn
from jsonschema import Draft202012Validator
from lane_support import bash, commit, lane_turn, says, write_file
from native_full_job import BOOK

from code_reviewer_runner.dynamic_review.passthrough.families import WireFamily
from passthrough_expect import usage_expected
from usage_calc import expected_cost

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
SCHEMA = json.loads((CONTRACTS / "runner-api.v1.json").read_text(encoding="utf-8"))


def marked_blocks(body: dict[str, Any]) -> int:
    """How many blocks of a Messages request carry a `cache_control` mark."""
    count = sum(1 for block in body.get("system", []) if "cache_control" in block)
    for message in body["messages"]:
        content: Any = message["content"]
        if isinstance(content, list):
            blocks = cast("list[dict[str, Any]]", content)
            count += sum(1 for block in blocks if "cache_control" in block)
    return count


def accepts(definition: str, document: Any) -> bool:
    validator = Draft202012Validator(
        {"$schema": SCHEMA["$schema"], "$ref": f"#/$defs/{definition}", "$defs": SCHEMA["$defs"]}
    )
    return bool(validator.is_valid(document))  # pyright: ignore[reportUnknownMemberType]


# #764-T09
def test_prompt_caching_stays_on_the_marks_reach_the_provider_and_the_ledger_counts_the_cache(
    tmp_path: Path,
) -> None:
    def script(repo: Path) -> list[Turn]:
        return [
            write_file(repo, "a.txt"),
            bash("cat a.txt"),
            commit("Add a"),
            says("done"),
        ]

    with lane_turn(tmp_path, script) as turned:
        result = turned.result
        assert result.ok, (result.error_code, result.error_detail)
        bodies = turned.requests
        assert len(bodies) == 4

        # The marks the stock engine puts on a Claude request reach the provider as it wrote them,
        # on every call: nothing of the runner or the door removes them (and they add none).
        for body in bodies:
            assert marked_blocks(body) >= 1
            assert not any("cache_control" in tool for tool in body["tools"])
        # Replayed through the cache rules of the docs (the fake of `fakes/llm`), the run reads its
        # own earlier prefix from the second call on, and no request is rejected.
        cache = PromptCache()
        usages = [
            cache.usage(body, real_anthropic_usage(output_tokens=10), minimum=256)
            for body in bodies
        ]
        assert usages[0]["cache_read_input_tokens"] == 0
        assert usages[0]["cache_creation_input_tokens"] > 0
        reads = [usage["cache_read_input_tokens"] for usage in usages]
        assert all(later > 0 for later in reads[1:]) and reads == sorted(reads)

        # The ledger counts what the provider stated, cache reads and writes included, and prices
        # it with the book: the independent calculator agrees to the last digit.
        total = Fraction(0)
        prompt = 0
        tool_calls = 0
        for position, record in enumerate(turned.upstream.records, start=1):
            body: Any = record.body
            has_tools = isinstance(body, dict) and bool(cast("dict[str, Any]", body).get("tools"))
            if has_tools:
                tool_calls += 1
            stated = usage_expected(
                tool_calls if has_tools else 100 + position, WireFamily.ANTHROPIC_MESSAGES
            )
            prompt += stated.prompt_tokens
            cost = expected_cost(
                BOOK,
                prompt=stated.prompt_tokens,
                completion=stated.completion_tokens,
                read=stated.cache_read,
                write_5m=stated.cache_write_5m,
                write_1h=stated.cache_write_1h,
            )
            assert cost is not None
            total += cost
        assert result.usage.ai_calls == len(turned.upstream.records)
        assert result.usage.prompt_tokens == prompt
        assert result.usage.cost_usd == pytest.approx(float(total), rel=1e-9)


# #764-T10
def test_usage_and_call_trace_are_recorded_for_the_kind_and_valid_against_the_contract(
    tmp_path: Path,
) -> None:
    with lane_turn(
        tmp_path, lambda repo: [write_file(repo, "a.txt"), commit("Add a"), says("done")]
    ) as turned:
        result = turned.result
        usage = result.usage.to_json()
        trace = usage["callTrace"]

        assert result.ok, (result.error_code, result.error_detail)
        assert accepts("RunnerUsage", usage)
        assert accepts("RunnerCallTrace", trace)
        assert usage["aiCalls"] == len(turned.upstream.records) >= 3
        assert usage["costUsd"] is not None and usage["costUsd"] > 0
        # The trace names the tools of the review (`read`, `grep`, `glob`); the contract has no
        # name for `write` and `bash` yet, so they are counted as `other` (a follow-up).
        names = [call["name"] for call in trace["toolCalls"]]
        assert names == ["other", "other"], "the tools the agent called, as names only"
        assert trace["modelCalls"], "every model call is in the trace"
        assert accepts("ImplementerResult", result.implementer_block())
        assert "hello" not in json.dumps(trace) and "a.txt" not in json.dumps(trace)
