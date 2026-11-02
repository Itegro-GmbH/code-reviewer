# SPDX-License-Identifier: LicenseRef-Proprietary

"""The model door's process (#745, step 3): what it reads, what it serves, what it reports.

The door is the real code on a real loopback socket; the provider is a script. The questions are
the ones that make it a door: the key goes to the provider and to nobody else, the agent's bearer
is the only way in, the cost limit refuses before the provider is asked, the ledger is reported on
the pipe and nothing secret is ever written to it, and the door ends when it is told to or when
Control is gone."""

import json
import time
from collections.abc import Callable
from typing import Any

import pytest
from door_support import (
    CAPABILITY,
    post,
    request_body,
    run_door_here,
    scripted_provider,
    start_document,
)
from native_job_support import API_KEY
from passthrough_support import ScriptedUpstream, streamed

from code_reviewer_runner.dynamic_review.budget import BudgetLedger
from code_reviewer_runner.dynamic_review.passthrough.families import spec_of
from code_reviewer_runner.implementer.door.protocol import REFUSALS
from code_reviewer_runner.implementer.door.service import DoorRefused, parse_start
from code_reviewer_runner.implementer.door.status import parse_status
from code_reviewer_runner.implementer.session import COST_LIMIT_DETAIL

from door_support import FAMILY  # isort: skip

assert BudgetLedger  # the ledger is what the status lines are made from


def statuses(lines: list[dict[str, Any]]) -> list[Any]:
    parsed = [parse_status(line) for line in lines if line["t"] == "status"]
    assert all(status is not None for status in parsed), "every status line is one the reader takes"
    return parsed


# #745-T01
def test_the_door_serves_a_call_with_the_bearer_and_the_provider_gets_the_real_key() -> None:
    door = run_door_here()
    assert door.lines[0] == {"t": "ready"}

    status, body = post(door.url)

    assert status == 200 and body
    sent = door.upstream.requests[0]
    key_header = spec_of(FAMILY).key_header
    assert sent.headers[key_header] == API_KEY, "the provider is asked with the key of the job"
    assert API_KEY.encode() not in body, "the agent never sees it, in no answer"
    assert CAPABILITY not in {str(value) for value in sent.headers.values()}
    door.end_of_input()
    door.wait()


# #745-T01
def test_a_caller_without_the_bearer_gets_nothing_and_the_provider_is_not_asked() -> None:
    door = run_door_here()

    wrong, _ = post(door.url, capability="not-the-capability-0123456789abcdef")
    none, _ = post(door.url, capability=None)

    assert wrong in (401, 403) and none in (401, 403)
    assert door.upstream.requests == []
    door.end_of_input()
    door.wait()


# #745-T02
def test_the_cost_limit_refuses_the_call_before_the_provider_is_asked() -> None:
    document = start_document(max_cost=0.000001)
    door = run_door_here(document=json.dumps(document))

    status, _ = post(door.url)

    assert status >= 400
    assert door.upstream.requests == [], "no money is spent on a call that is over the limit"
    door.end_of_input()
    door.wait()
    final = statuses(door.lines)[-1]
    assert final.final is True
    assert final.failure is not None
    assert final.failure.code == "dynamic_budget_exceeded"
    assert final.failure.detail == COST_LIMIT_DETAIL
    assert final.model_used is False


# #745-T02
def test_the_ledger_is_reported_on_the_pipe_while_the_door_runs_and_finally_when_it_stops() -> None:
    door = run_door_here()
    post(door.url)
    post(door.url)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not any(
        line["t"] == "status" and line["modelUsed"] and not line["final"] for line in door.lines
    ):
        time.sleep(0.02)

    door.send(json.dumps({"op": "stop"}) + "\n")
    assert door.wait() == 0

    reported = statuses(door.lines)
    final = reported[-1]
    assert final.final is True
    assert final.model_used is True and final.open_calls == 0
    assert final.usage["aiCalls"] == 2
    assert final.usage["costUsd"] is not None and final.usage["costUsd"] > 0
    assert len(final.model_calls) == 2, "the model calls of the trace come with the final status"
    assert any(not status.final and status.model_used for status in reported), "and live before"
    assert [status.seq for status in reported] == sorted(status.seq for status in reported)


def _wait_for_status(
    door: Any, matches: Callable[[dict[str, Any]], bool], seconds: float = 3.0
) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if any(line["t"] == "status" and matches(line) for line in list(door.lines)):
            return True
        time.sleep(0.01)
    return False


# #745-T02
def test_the_status_is_said_when_a_call_is_reserved_and_settled_not_when_the_door_next_looks() -> (
    None
):
    seen: list[bool] = []
    holder: list[Any] = []

    def at_the_provider() -> None:
        # The call is open and about to leave: the door has already said so.
        seen.append(_wait_for_status(holder[0], lambda line: line["openCalls"] == 1))

    upstream = ScriptedUpstream(streamed(FAMILY, 1), on_send=at_the_provider)
    # The door looks at its ledger once in 30 seconds: only the ledger's own changes can be heard.
    door = run_door_here(upstream, poll=30.0)
    holder.append(door)

    status, _ = post(door.url)

    assert status == 200
    assert seen == [True], "the reservation was reported before the provider was asked"
    assert _wait_for_status(door, lambda line: line["modelUsed"] and line["openCalls"] == 0), (
        "and the settled call at once: a door killed right after the call still has it booked"
    )
    door.end_of_input()
    door.wait()


# #745-T02
def test_a_refusal_the_ledger_records_is_said_at_once_too() -> None:
    document = start_document(max_cost=0.000001)
    door = run_door_here(document=json.dumps(document), poll=30.0)

    post(door.url)

    assert _wait_for_status(door, lambda line: line["failure"] is not None)
    door.end_of_input()
    door.wait()


# #745-T02
def test_nothing_secret_is_written_to_the_pipe() -> None:
    door = run_door_here()
    post(door.url)
    door.end_of_input()
    door.wait()

    printed = json.dumps(door.lines)
    assert API_KEY not in printed
    assert CAPABILITY not in printed
    assert "sk-" not in printed


# #745-T03
def test_the_door_ends_when_control_is_gone() -> None:
    door = run_door_here()

    door.end_of_input()

    assert door.wait() == 0, "the end of stdin is the end of the reason for the key to be here"
    assert statuses(door.lines)[-1].final is True


# #745-T03
def test_the_door_stops_serving_when_it_ends() -> None:
    door = run_door_here()
    door.end_of_input()
    door.wait()

    with pytest.raises(OSError):
        post(door.url)


@pytest.mark.parametrize(
    "document",
    [
        "not json",
        "[]",
        json.dumps({**start_document(), "version": 2}),
        json.dumps({**start_document(), "extra": 1}),
        json.dumps({**start_document(), "capability": "short"}),
        json.dumps({**start_document(), "listenPort": 80}),
        json.dumps({**start_document(), "listenPort": 40000}),
        json.dumps({**start_document(), "deadlineSeconds": 0}),
        json.dumps({**start_document(), "environment": {"HOME": "/"}}),
    ],
)
# #745-T04
def test_a_start_document_that_is_not_exactly_one_is_refused_with_a_word_only(
    document: str,
) -> None:
    with pytest.raises(DoorRefused) as refusal:
        parse_start(document)

    assert refusal.value.reason in REFUSALS
    assert API_KEY not in str(refusal.value)


# #745-T04
def test_a_model_access_the_job_parser_would_refuse_is_refused_by_the_door() -> None:
    document = start_document()
    document["modelAccess"]["modelEntry"]["upstreamBaseUrl"] = "https://api.evil.example/v1"

    door = run_door_here(document=json.dumps(document))

    assert door.refused
    assert door.lines[0] == {"t": "refused", "reason": "model_access_invalid"}
    assert door.wait() == 2
    assert door.upstream.requests == []
    assert "evil" not in json.dumps(door.lines), "a refusal says a word and never a value"


# #745-T04
def test_a_refusal_never_prints_the_start_document() -> None:
    door = run_door_here(document=json.dumps({**start_document(), "listenPort": 80}))

    assert door.lines == [{"t": "refused", "reason": "start_invalid"}]
    assert door.wait() == 2


# #745-T02
def test_the_door_serves_the_output_cap_the_entry_pins() -> None:
    door = run_door_here(scripted_provider(1))

    status, _ = post(door.url, request_body(max_tokens=10_000_000))

    assert status >= 400, "a request above the cap of the model's entry is refused at the door"
    assert door.upstream.requests == []
    door.end_of_input()
    door.wait()
